#!/usr/bin/env node
/**
 * 알람(카카오 원문 알림) → Vault Facts/Ledger 기록 (v2)
 *
 * v1(scripts/jobs/parse-notifications.mjs)과 같은 소스(구글시트 "알람" 탭 — Kakao-
 * Notification 안드로이드 앱이 적재)를 읽어 같은 파서(scripts/lib/notification-
 * parsers.mjs)로 해석하지만, 출력 대상이 시트 탭이 아니라 Vault Facts/Ledger다
 * (docs/ARCHITECTURE-V2.md "카카오 알림 → Vault 파싱 파이프라인" 절).
 *
 * ⚠️ 범위 갱신(2026-08-21, v1→v2 전수 감사) — 원래(2026-08-04, Phase 2) 펀드적립·환전은
 * "State/Holdings 설계가 끝나는 Phase 8·9에서 마저 연결한다"고 범위 밖으로 미뤄뒀는데,
 * Phase 8·9가 이미 완료돼 그 전제가 채워졌다. 다만 펀드적립·환전을 보유종목에 실제
 * 반영하는 배치 로직(계좌 귀속·다계좌 회계)은 아직 별도로 없다 — 그래서 체결·배당과
 * 완전히 같은 수준으로: 원문만 Facts/Ledger에 그대로 적재(account:null + ACCOUNT_NOTE)
 * 하고, 계좌 귀속 배치는 별도 후속 작업으로 남겨둔다(이 잡의 책임은 "원문 적재"까지).
 *
 * ⚠️ 예수금앵커(2026-08-18 추가, 오너 요청 — "예수금 관리가 정확한지 철저히 분석"):
 * v1은 기준점·거래를 날짜만 비교해 같은 날 오후 거래를 델타에서 빠뜨리는 버그가 있었다
 * (cash-ledger.mjs 헤더 주석 참고). v2는 parseCashAlarm(nh-accounts.mjs 기반 전체
 * 계좌번호 매칭)로 원문만 Facts/Ledger/CashEvents에 그대로 적재하고, 실제 잔고 계산
 * (기준점+델타)은 State 쓰기 잡(뒤 Phase)이 이 원문들을 읽어 수행한다 — 이 잡은 원문
 * 저장까지만 책임진다(cash-ledger.mjs의 계산 함수는 여기서 호출하지 않음).
 *
 * Ledger 하위폴더(2026-08-04, 오너 요청으로 세분화): Facts/Ledger/Executions(체결+
 * 금현물)·Dividends(배당)·CashEvents(예수금앵커, 2026-08-18 추가)·FundPurchases(펀드적립,
 * 2026-08-21 배선)·Exchanges(환전, 2026-08-21 배선) — vault-paths.mjs 참고.
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
import { parseExecution, parseDividend, parseGoldBuy, parseCashAlarm, parseFundBuy, parseExchange } from '../lib/notification-parsers.mjs';
import { buildExecutionRecord, buildDividendRecord, buildCashEventRecord, buildFundPurchaseRecord, buildExchangeRecord } from '../lib/ledger-vault-writer.mjs';
import { writeAtomic } from '../lib/state-writer.mjs';
import { VAULT_PATHS } from '../lib/vault-paths.mjs';
import { QUANT_ACCOUNT_NO } from '../lib/account-resolver.mjs';

const ALARM_SHEET = '알람';

// 금현물은 별도 Ledger 종류를 만들지 않고 체결(Executions)에 합류시킨다 — v1이 "금현물을
// 별도 원장으로 뒀다가 버그나서 체결내역에 통합"한 전례를 반영(vault-paths.mjs 주석 참고).
// parseGoldBuy는 체결과 필드 모양이 달라(qty/date vs quantity/tradeDate) 여기서만 맞춰준다.
function goldToExecutionEvent(g) {
  return {
    // g.date는 전체 타임스탬프(2026-08-18 notification-parsers.mjs 수정 — 예전엔
    // 날짜만 남겨 cash-ledger.mjs의 델타 계산에서 날짜절삭 버그가 재발할 뻔했다).
    tradeDate: g.date,
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

  if (!DRY_RUN) {
    mkdirSync(VAULT_PATHS.facts.ledger.executions, { recursive: true });
    mkdirSync(VAULT_PATHS.facts.ledger.dividends, { recursive: true });
    mkdirSync(VAULT_PATHS.facts.ledger.cashEvents, { recursive: true });
    mkdirSync(VAULT_PATHS.facts.ledger.fundPurchases, { recursive: true });
    mkdirSync(VAULT_PATHS.facts.ledger.exchanges, { recursive: true });
  }

  const alarmRows = await getRange(token, `${ALARM_SHEET}!A2:D`);
  console.log(`📨 알람 ${alarmRows.length}행 스캔`);

  let execNew = 0, divNew = 0, cashNew = 0, fundNew = 0, exchNew = 0, skip = 0, unrecognized = 0, quantExcluded = 0;
  for (const r of alarmRows) {
    const body = String(r[3] ?? ''); // D: 내용
    const ts = String(r[0] ?? '');   // A: 시간
    if (!body) continue;

    const e = parseExecution(body, ts);
    if (e) {
      // 퀀트 전용 계좌 체결은 Facts/Ledger에 아예 안 쓴다(2026-08-13) — KIS API가
      // 정본이고(watch-order-fill.mjs가 이미 직접 기록), 카카오로 잡힌 건 순수 중복
      // 이라 계좌 오귀속 위험(account-resolver.mjs 참고)뿐 아니라 장부에 같은 거래가
      // 두 번 남는 것 자체가 혼란이다 — 아예 원천에서 걸러낸다.
      if (e.acctNo === QUANT_ACCOUNT_NO) { quantExcluded++; continue; }
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

    const c = parseCashAlarm(body, ts);
    if (c) {
      const { filename, content, dir } = buildCashEventRecord(c);
      const filepath = join(dir, filename);
      if (existsSync(filepath)) { skip++; continue; }
      console.log(`  + [예수금] ${c.ts} ${c.account} 잔고 ${c.balance.toLocaleString()}원`);
      if (!DRY_RUN) writeAtomic(filepath, content);
      cashNew++;
      continue;
    }

    const f = parseFundBuy(body, ts);
    if (f) {
      const { filename, content, dir } = buildFundPurchaseRecord(f);
      const filepath = join(dir, filename);
      if (existsSync(filepath)) { skip++; continue; }
      console.log(`  + [펀드적립] ${f.date} ${f.fundName} ${f.amount.toLocaleString()}원 (${f.units.toFixed(2)}좌)`);
      if (!DRY_RUN) writeAtomic(filepath, content);
      fundNew++;
      continue;
    }

    const x = parseExchange(body, ts);
    if (x) {
      const { filename, content, dir } = buildExchangeRecord(x);
      const filepath = join(dir, filename);
      if (existsSync(filepath)) { skip++; continue; }
      console.log(`  + [환전] ${x.date} ${x.kind} USD ${x.usd.toLocaleString()}` + (x.won ? ` (${x.won.toLocaleString()}원)` : ''));
      if (!DRY_RUN) writeAtomic(filepath, content);
      exchNew++;
      continue;
    }

    // 파싱 대상이 아예 아닌 알림(광고 등) — 개수만 집계.
    unrecognized++;
  }

  console.log(
    `\n✅ 완료 — 체결 +${execNew}(금현물 포함) · 배당 +${divNew} · 예수금앵커 +${cashNew} · ` +
    `펀드적립 +${fundNew} · 환전 +${exchNew} · ` +
    `중복스킵 ${skip} · 퀀트계좌 제외 ${quantExcluded}(KIS API가 정본) · 미인식 ${unrecognized}` +
    (DRY_RUN ? ' (드라이런 — 쓰기 없음)' : ''),
  );
}

main().catch((e) => { console.error('\n❌ 오류:', e.message); process.exit(1); });
