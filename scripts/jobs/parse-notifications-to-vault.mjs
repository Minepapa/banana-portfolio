#!/usr/bin/env node
/**
 * 알람(카카오 원문 알림) → Vault Facts/Ledger 기록 (v2)
 *
 * ⚠️ 소스 전환(2026-08-22, ADR 0014) — 원래(v1 scripts/jobs/parse-notifications.mjs와
 * 동일 소스) Kakao-Notification 안드로이드 앱이 구글시트 "알람" 탭에 원문을 적재하고
 * 이 잡이 그 탭을 읽었다(ADR 0005). 안드로이드 앱을 Firestore 직접쓰기로 바꾸면서
 * (Kakao-Notification 리포 별도 변경) 이 잡도 Firestore `kakaoInbox` 컬렉션을 읽도록
 * 함께 바뀌었다 — 구글시트가 이 파이프라인에서 완전히 빠졌다. 파서(scripts/lib/
 * notification-parsers.mjs)는 원문(ts·body)만 보므로 소스가 바뀌어도 그대로 재사용.
 *
 * ⚠️ 범위 갱신(2026-08-21, v1→v2 전수 감사) — 원래(2026-08-04, Phase 2) 펀드적립·환전은
 * "State/Holdings 설계가 끝나는 Phase 8·9에서 마저 연결한다"고 범위 밖으로 미뤄뒀는데,
 * Phase 8·9가 이미 완료돼 그 전제가 채워졌다. 체결·배당처럼 별도 계좌귀속 배치가 필요할
 * 줄 알았으나(2026-08-22 재확인) 둘 다 애초에 단일 알림 소스로 스코프돼 있어 판정
 * 로직 없이 상수로 확정 가능했다 — 펀드적립은 삼성증권 알림만 파싱(=연금저축 1:1
 * 확정, account-resolver.mjs UNIQUE_BROKER_ACCOUNT와 동일 사실), 환전은 NH 알림만
 * 파싱하는데 실측 Vault 보유파일 기준 달러성 보유가 위탁에만 있어 위탁으로 확정(오너
 * 확인). account-resolver.mjs의 FUND_PURCHASE_ACCOUNT·EXCHANGE_ACCOUNT를 파싱 시점에
 * 바로 넘겨 기록한다 — 체결·배당과 달리 이 둘은 별도 후속 배치가 필요 없다.
 *
 * ⚠️ 예수금앵커(2026-08-18 추가, 오너 요청 — "예수금 관리가 정확한지 철저히 분석"):
 * v1은 기준점·거래를 날짜만 비교해 같은 날 오후 거래를 델타에서 빠뜨리는 버그가 있었다
 * (cash-ledger.mjs 헤더 주석 참고). v2는 parseCashAlarm(nh-accounts.mjs 기반 전체
 * 계좌번호 매칭)로 원문만 Facts/Ledger/CashEvents에 그대로 적재하고, 실제 잔고 계산
 * (기준점+델타)은 State 쓰기 잡(뒤 Phase)이 이 원문들을 읽어 수행한다 — 이 잡은 원문
 * 저장까지만 책임진다(cash-ledger.mjs의 계산 함수는 여기서 호출하지 않음).
 *
 * ⚠️ 마이그레이션 3단계 실측 검증 후 카카오 예수금 파싱 일부 중단(2026-09-03,
 * `Log/Strategy/2026-09-02-NH-API-우선-KIS-카카오파싱-역할축소-결정.md`) — 위탁·CMA
 * 예수금은 이제 reconcile-nh-cash.mjs(NH API 직접조회)가 State/Holdings를 직접
 * 덮어쓴다("통일 루프 깸"). update-cash-from-ledger.mjs도 이 두 계좌의 CashEvents를
 * 더 이상 안 읽어서(ALL_ACCOUNTS가 ISA·연금저축 2계좌로 축소, 2026-09-03), 계속
 * 파싱해봐야 아무도 안 읽는 죽은 데이터다 — 인식은 하되(Firestore 정리 비용 회피)
 * 장부엔 안 쓴다. 오너가 위탁 계좌 실제 예수금으로 필드 매핑을 직접 검증한 뒤 승인
 * (나무 앱 출금가능금액과 정확히 일치 확인). 금현물은 예수금도 같은 방식으로
 * 검증됐지만 이번 정리 범위엔 명시적으로 안 넣음(사유 미확인, CASH_ALARM_
 * API_EXCLUDED 참고) — ISA·연금저축은 API 대안이 없어 그대로 유지.
 *
 * Ledger 하위폴더(2026-08-04, 오너 요청으로 세분화): Facts/Ledger/Executions(체결+
 * 금현물)·Dividends(배당)·CashEvents(예수금앵커, 2026-08-18 추가)·FundPurchases(펀드적립,
 * 2026-08-21 배선)·Exchanges(환전, 2026-08-21 배선) — vault-paths.mjs 참고.
 *
 * 멱등: 파일명 자체가 dedup 키(ledger-vault-writer.mjs) — 같은 이벤트를 다시 읽어도
 * 같은 파일명이 나와 existsSync만으로 중복을 걸러낸다. Firestore `kakaoInbox` 문서는
 * 시트와 달리 "실제로 처리한"(기록·중복스킵·퀀트계좌 의도적 제외) 문서만 처리 직후
 * 삭제한다(kakao-inbox.mjs 헤더 주석 참고 — 시트는 방치해도 비용이 없었지만 Firestore
 * 읽기는 문서 수만큼 과금돼 방치하면 비용이 계속 늘어난다). ⚠️ 코드리뷰 지적(2026-08-22)
 * — 어느 파서도 못 알아본 문서(미인식·빈 본문)까지 무조건 지우면 Vault에 아무 기록도
 * 안 남긴 채 원문이 영구 유실되는 회귀였다 — 그 두 경우는 지우지 않고 컬렉션에 남긴다.
 * 위 dedup은 그래도 안전망으로 남겨둔다(삭제 타이밍이 어긋나 같은 문서가 두 번 읽혀도
 * Vault엔 한 번만 기록됨).
 *
 * 인증: Firebase Admin SDK 서비스계정 키(firestore-admin.mjs, sync-firestore-mirror.mjs와
 * 동일 키 재사용) — 구글시트 OAuth/서비스계정과 무관.
 *
 * 사용법:
 *   node scripts/jobs/parse-notifications-to-vault.mjs            # 실제로 Vault에 씀
 *   node scripts/jobs/parse-notifications-to-vault.mjs --dry-run  # 기록 대상만 출력(쓰기·삭제 없음)
 */

import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { getFirestoreAdmin } from '../lib/firestore-admin.mjs';
import { readKakaoInbox, deleteKakaoInboxDocs } from '../lib/kakao-inbox.mjs';
import { parseExecution, parseDividend, parseGoldBuy, parseCashAlarm, parseFundBuy, parseExchange } from '../lib/notification-parsers.mjs';
import { buildExecutionRecord, buildDividendRecord, buildCashEventRecord, buildFundPurchaseRecord, buildExchangeRecord } from '../lib/ledger-vault-writer.mjs';
import { writeAtomic } from '../lib/state-writer.mjs';
import { VAULT_PATHS } from '../lib/vault-paths.mjs';
import { QUANT_ACCOUNT_NO, FUND_PURCHASE_ACCOUNT, EXCHANGE_ACCOUNT } from '../lib/account-resolver.mjs';

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

const DRY_RUN = process.argv.includes('--dry-run');

// 카카오 예수금 알림을 인식은 하되 Facts/Ledger/CashEvents엔 안 쓰는 계좌
// (2026-09-03, "위탁·CMA 먼저 진행" — 위 헤더 주석 참고). export(code-reviewer
// 지적) — reconcile-nh-cash.mjs의 NH_CASH_ACCOUNTS의 부분집합이어야 한다(API로
// 직접 커버 안 되는 계좌를 실수로 여기 넣으면 그 계좌 예수금이 영구 유실) —
// nh-accounts.test.js의 구조적 가드 테스트가 이 관계를 대조한다.
export const CASH_ALARM_API_EXCLUDED = new Set(['위탁', 'CMA']);

async function main() {
  if (!DRY_RUN) {
    mkdirSync(VAULT_PATHS.facts.ledger.executions, { recursive: true });
    mkdirSync(VAULT_PATHS.facts.ledger.dividends, { recursive: true });
    mkdirSync(VAULT_PATHS.facts.ledger.cashEvents, { recursive: true });
    mkdirSync(VAULT_PATHS.facts.ledger.fundPurchases, { recursive: true });
    mkdirSync(VAULT_PATHS.facts.ledger.exchanges, { recursive: true });
  }

  const db = getFirestoreAdmin();
  const inboxDocs = await readKakaoInbox(db);
  console.log(`📨 카카오 수신함(Firestore kakaoInbox) ${inboxDocs.length}건 스캔`);

  let execNew = 0, divNew = 0, cashNew = 0, fundNew = 0, exchNew = 0, skip = 0, unrecognized = 0, quantExcluded = 0, cashApiExcluded = 0;
  // ⚠️ 코드리뷰 지적(2026-08-22, 커밋 전) — 처음엔 훑은 문서를 결과와 무관하게 전부
  // 지웠는데, 그러면 "어느 파서도 못 알아본 알림"(광고가 아니라 새 브로커 문구·아직
  // 안 만든 이벤트 타입일 수 있음)이 Vault에 아무 기록도 안 남긴 채 원문째로 영구
  // 삭제됐다 — 시트 시절엔 없던 데이터 유실 회귀(출처 추적성이 가용성보다 우선 원칙과
  // 정면 충돌). 그래서 "실제로 처리한"(기록했거나, 이미 기록돼 중복스킵했거나, 퀀트
  // 전용 계좌라 의도적으로 제외한) 문서만 지운다 — 미인식·빈 본문은 컬렉션에 남겨
  // 다음 실행에서도 계속 보이게 한다(재현 가능한 만큼만 안드로이드 필터를 이미 거친
  // 소량이라 방치 비용도 작다).
  const processedIds = [];
  for (const { id, ts, body } of inboxDocs) {
    if (!body) continue;

    const e = parseExecution(body, ts);
    if (e) {
      // 퀀트 전용 계좌 체결은 Facts/Ledger에 아예 안 쓴다(2026-08-13) — KIS API가
      // 정본이고(watch-order-fill.mjs가 이미 직접 기록), 카카오로 잡힌 건 순수 중복
      // 이라 계좌 오귀속 위험(account-resolver.mjs 참고)뿐 아니라 장부에 같은 거래가
      // 두 번 남는 것 자체가 혼란이다 — 아예 원천에서 걸러낸다.
      if (e.acctNo === QUANT_ACCOUNT_NO) { quantExcluded++; processedIds.push(id); continue; }
      const { filename, content, dir } = buildExecutionRecord(e);
      const filepath = join(dir, filename);
      if (existsSync(filepath)) { skip++; processedIds.push(id); continue; }
      console.log(`  + [체결] ${e.tradeDate} ${e.tradeType} ${e.stockName} ${e.quantity}주 @${e.price} (${e.broker})`);
      if (!DRY_RUN) writeAtomic(filepath, content);
      execNew++;
      processedIds.push(id);
      continue;
    }

    const d = parseDividend(body, ts);
    if (d) {
      const { filename, content, dir } = buildDividendRecord(d);
      const filepath = join(dir, filename);
      if (existsSync(filepath)) { skip++; processedIds.push(id); continue; }
      console.log(`  + [배당] ${d.date} ${d.stockName} ${d.afterTaxAmount.toLocaleString()}원`);
      if (!DRY_RUN) writeAtomic(filepath, content);
      divNew++;
      processedIds.push(id);
      continue;
    }

    const g = parseGoldBuy(body, ts);
    if (g) {
      const { filename, content, dir } = buildExecutionRecord(goldToExecutionEvent(g));
      const filepath = join(dir, filename);
      if (existsSync(filepath)) { skip++; processedIds.push(id); continue; }
      console.log(`  + [금현물] ${g.date} ${g.tradeType} ${g.stockName} ${g.qty}g @${g.price}`);
      if (!DRY_RUN) writeAtomic(filepath, content);
      execNew++;
      processedIds.push(id);
      continue;
    }

    const c = parseCashAlarm(body, ts);
    if (c) {
      // ⚠️ 예수금 카카오 파싱 중단(2026-09-03, 마이그레이션 3단계 실측 검증 완료 후
      // 오너 확인 — "위탁·CMA 먼저 진행") — reconcile-nh-cash.mjs(NH API 직접조회)가
      // 위탁·CMA 예수금을 State/Holdings에 직접 덮어쓰고, update-cash-from-ledger.mjs
      // 는 이제 이 두 계좌의 CashEvents를 아예 안 읽는다(ALL_ACCOUNTS가 ISA·연금저축
      // 2계좌로 축소됨, 2026-09-03). 즉 이 두 계좌의 CashEvent는 이미 완전히 죽은
      // 데이터라 계속 써봐야 아무도 안 읽는다 — 인식은 하되(Firestore 정리 비용
      // 회피) 장부엔 안 쓴다. 금현물은 예수금도 같은 잡으로 검증됐지만(오너 확인:
      // "위탁,CMA, 금현물 예수금은 맞아") 이번 정리 범위엔 명시적으로 안 들어감 —
      // 사유 미확인, 금현물 체결(iem_nm) 검증이 아직 안 끝난 것과 관련 있을 수
      // 있음. 금현물 CashEvent는 그대로 유지(update-cash-from-ledger.mjs가
      // 안 읽으므로 무해).
      if (CASH_ALARM_API_EXCLUDED.has(c.account)) { cashApiExcluded++; processedIds.push(id); continue; }
      const { filename, content, dir } = buildCashEventRecord(c);
      const filepath = join(dir, filename);
      if (existsSync(filepath)) { skip++; processedIds.push(id); continue; }
      console.log(`  + [예수금] ${c.ts} ${c.account} 잔고 ${c.balance.toLocaleString()}원`);
      if (!DRY_RUN) writeAtomic(filepath, content);
      cashNew++;
      processedIds.push(id);
      continue;
    }

    const f = parseFundBuy(body, ts);
    if (f) {
      const { filename, content, dir } = buildFundPurchaseRecord({ ...f, account: FUND_PURCHASE_ACCOUNT });
      const filepath = join(dir, filename);
      if (existsSync(filepath)) { skip++; processedIds.push(id); continue; }
      console.log(`  + [펀드적립] ${f.date} ${f.fundName} ${f.amount.toLocaleString()}원 (${f.units.toFixed(2)}좌)`);
      if (!DRY_RUN) writeAtomic(filepath, content);
      fundNew++;
      processedIds.push(id);
      continue;
    }

    const x = parseExchange(body, ts);
    if (x) {
      const { filename, content, dir } = buildExchangeRecord({ ...x, account: EXCHANGE_ACCOUNT });
      const filepath = join(dir, filename);
      if (existsSync(filepath)) { skip++; processedIds.push(id); continue; }
      console.log(`  + [환전] ${x.date} ${x.kind} USD ${x.usd.toLocaleString()}` + (x.won ? ` (${x.won.toLocaleString()}원)` : ''));
      if (!DRY_RUN) writeAtomic(filepath, content);
      exchNew++;
      processedIds.push(id);
      continue;
    }

    // 파싱 대상이 아예 아닌 알림(광고 등) — 개수만 집계, 컬렉션에서 지우지 않는다(위 주석).
    unrecognized++;
  }

  if (!DRY_RUN && processedIds.length) {
    await deleteKakaoInboxDocs(db, processedIds);
  }

  console.log(
    `\n✅ 완료 — 체결 +${execNew}(금현물 포함) · 배당 +${divNew} · 예수금앵커 +${cashNew} · ` +
    `펀드적립 +${fundNew} · 환전 +${exchNew} · ` +
    `중복스킵 ${skip} · 퀀트계좌 제외 ${quantExcluded}(KIS API가 정본) · ` +
    `위탁·CMA 예수금 제외 ${cashApiExcluded}(NH API가 정본) · 미인식 ${unrecognized} · ` +
    `수신함 정리 ${DRY_RUN ? 0 : processedIds.length}건` +
    (DRY_RUN ? ' (드라이런 — 쓰기 없음)' : ''),
  );
}

// entrypoint 가드(2026-08-22 — reconcile-irp.mjs와 동일 관례 적용) — 이제 이 파일이
// 실 Firestore를 만지므로, 나중에 이 모듈을 테스트에서 import만 해도 main()이 돌면서
// 실제 네트워크 호출이 발생하는 사고를 원천 차단한다.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error('\n❌ 오류:', e.message); process.exit(1); });
}
