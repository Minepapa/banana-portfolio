#!/usr/bin/env node
/**
 * 알람(카카오 원문 알림) → Vault Facts/Ledger 기록 (v2)
 *
 * v1(scripts/jobs/parse-notifications.mjs)과 같은 소스(구글시트 "알람" 탭 — Kakao-
 * Notification 안드로이드 앱이 적재)를 읽어 같은 파서(scripts/lib/notification-
 * parsers.mjs)로 해석하지만, 출력 대상이 시트 탭이 아니라 Vault Facts/Ledger다
 * (docs/ARCHITECTURE-V2.md "카카오 알림 → Vault 파싱 파이프라인" 절).
 *
 * ⚠️ 범위(2026-08-04, 구현계획서 Phase 2 — 오너 확정): 오늘은 **체결(금현물 포함)·
 * 배당만** Vault에 기록한다. 펀드적립·예수금앵커·환전은 파서는 이미 준비돼 있지만
 * (notification-parsers.mjs), 계좌 귀속·다계좌 회계·보유종목 갱신은 State/Holdings
 * 설계가 끝나는 Phase 8·9에서 마저 연결한다 — 지금 억지로 끼워 넣지 않는다(설계 없이
 * 만들면 나중에 다시 뜯어고쳐야 함).
 *
 * Ledger 하위폴더(2026-08-04, 오너 요청으로 세분화): Facts/Ledger/Executions(체결+
 * 금현물)·Dividends(배당) — 나머지 3개 폴더(FundPurchases·CashEvents·Exchanges)는
 * 그 파서가 배선되는 뒷 Phase에서 자연히 채워진다(vault-paths.mjs 참고).
 *
 * 멱등: 파일명 자체가 dedup 키(ledger-vault-writer.mjs) — 같은 이벤트를 다시 읽어도
 * 같은 파일명이 나와 existsSync만으로 중복을 걸러낸다. "알람" 시트 원문 행 정리(삭제·
 * 처리됨 표시)는 설계에서 아직 "구현 시 결정"으로 열려 있어(구현 메모 절) 이번엔 하지
 * 않는다 — 정리를 안 해도 dedup이 있어 정합성엔 문제없다(같은 행을 매번 다시 읽어도
 * 이미 기록된 이벤트는 건너뜀), 시트가 계속 자라는 비효율만 남는다.
 *
 * 사용법:
 *   node scripts/jobs/parse-notifications-to-vault.mjs            # OAuth(대화형) 또는 SA(무인)
 *   node scripts/jobs/parse-notifications-to-vault.mjs --dry-run  # 기록 대상만 출력(쓰기 없음)
 *   node scripts/jobs/parse-notifications-to-vault.mjs <TOKEN>    # 토큰 직접 전달(launchd run.sh)
 */

import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { getToken, getRange } from '../lib/sheets-common.mjs';
import { parseExecution, parseDividend, parseGoldBuy } from '../lib/notification-parsers.mjs';
import { buildExecutionRecord, buildDividendRecord } from '../lib/ledger-vault-writer.mjs';
import { writeAtomic } from '../lib/state-writer.mjs';
import { VAULT_PATHS } from '../lib/vault-paths.mjs';

const ALARM_SHEET = '알람';

// 금현물은 별도 Ledger 종류를 만들지 않고 체결(Executions)에 합류시킨다 — v1이 "금현물을
// 별도 원장으로 뒀다가 버그나서 체결내역에 통합"한 전례를 반영(vault-paths.mjs 주석 참고).
// parseGoldBuy는 체결과 필드 모양이 달라(qty/date vs quantity/tradeDate) 여기서만 맞춰준다.
function goldToExecutionEvent(g) {
  return {
    tradeDate: g.date, // 시각 정보 없음(날짜만) — buildExecutionRecord가 자동으로 000000 처리
    tradeType: g.tradeType,
    stockCode: '',
    stockName: g.stockName,
    quantity: g.qty,
    price: g.price,
    currency: 'KRW',
    broker: 'NH투자증권', // parseGoldBuy는 NH "매수 주문체결" 포맷 전용
    // ⚠️ 사실 기록(2026-08-05, 오너 확인): 자산배분상 금현물은 위탁 소속으로 취급하지만
    // (ARCHITECTURE-V2.md "원칙 2 — 계좌별 역할" 표 각주), 실제 매매는 위탁과 다른
    // 별도의 금현물 전용 계좌에서 이뤄진다. account 필드는 어차피 Phase 8·9 전까지
    // null(위 buildExecutionRecord 참고)이라 지금 당장 문제는 없지만, 나중에 계좌
    // 귀속을 실제로 구현할 때 "금현물 알림 = 위탁 계좌번호"로 섣불리 가정하면 안 된다.
  };
}

const args = process.argv.slice(2);
const explicitToken = args.find((a) => !a.startsWith('--'));
const DRY_RUN = args.includes('--dry-run');

async function main() {
  let token = explicitToken?.trim() || null;
  token = await getToken(token);

  // 오늘 실제로 쓰는 하위폴더만 미리 만든다 — 나머지 3종(FundPurchases·CashEvents·
  // Exchanges)은 그 빌더가 생기는 뒷 Phase에서 자연히 만들어진다(지금 미리 만들어도
  // 무해하지만, "이 잡이 실제로 쓰는 폴더"만 만드는 쪽이 의도를 명확히 함).
  if (!DRY_RUN) {
    mkdirSync(VAULT_PATHS.facts.ledger.executions, { recursive: true });
    mkdirSync(VAULT_PATHS.facts.ledger.dividends, { recursive: true });
  }

  const alarmRows = await getRange(token, `${ALARM_SHEET}!A2:D`);
  console.log(`📨 알람 ${alarmRows.length}행 스캔`);

  let execNew = 0, divNew = 0, skip = 0, unrecognized = 0;
  for (const r of alarmRows) {
    const body = String(r[3] ?? ''); // D: 내용
    const ts = String(r[0] ?? '');   // A: 시간
    if (!body) continue;

    const e = parseExecution(body, ts);
    if (e) {
      const { filename, content, dir } = buildExecutionRecord(e);
      const filepath = join(dir, filename);
      if (existsSync(filepath)) { skip++; continue; }
      console.log(`  + [체결] ${e.tradeDate} ${e.tradeType} ${e.stockName} ${e.quantity}주 @${e.price} (${e.broker})`);
      if (!DRY_RUN) writeAtomic(filepath, content);
      execNew++;
      continue;
    }

    const d = parseDividend(body, ts);
    if (d) {
      const { filename, content, dir } = buildDividendRecord(d);
      const filepath = join(dir, filename);
      if (existsSync(filepath)) { skip++; continue; }
      console.log(`  + [배당] ${d.date} ${d.stockName} ${d.afterTaxAmount.toLocaleString()}원`);
      if (!DRY_RUN) writeAtomic(filepath, content);
      divNew++;
      continue;
    }

    const g = parseGoldBuy(body, ts);
    if (g) {
      const { filename, content, dir } = buildExecutionRecord(goldToExecutionEvent(g));
      const filepath = join(dir, filename);
      if (existsSync(filepath)) { skip++; continue; }
      console.log(`  + [금현물] ${g.date} ${g.tradeType} ${g.stockName} ${g.qty}g @${g.price}`);
      if (!DRY_RUN) writeAtomic(filepath, content);
      execNew++;
      continue;
    }

    // 펀드적립·예수금앵커·환전일 수도, 파싱 대상이 아예 아닌 알림(광고 등)일 수도 있다
    // — 이 3종은 아직 Phase 8·9(계좌 귀속·다계좌 회계) 전이라 범위 밖, 개수만 집계.
    unrecognized++;
  }

  console.log(
    `\n✅ 완료 — 체결 +${execNew}(금현물 포함) · 배당 +${divNew} · 중복스킵 ${skip} · 범위밖/미인식 ${unrecognized}` +
    (DRY_RUN ? ' (드라이런 — 쓰기 없음)' : ''),
  );
}

main().catch((e) => { console.error('\n❌ 오류:', e.message); process.exit(1); });
