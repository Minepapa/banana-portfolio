// 파싱된 알림 이벤트(체결·배당) → Vault Facts/Ledger 기록(파일명+YAML frontmatter) 빌더.
// 순수 함수 — 실제 파일 쓰기는 호출부(scripts/jobs/parse-notifications-to-vault.mjs)가
// state-writer.mjs의 writeAtomic으로 수행한다.
//
// 파일명 자체가 멱등성 키다 — 같은 체결/배당을 다시 파싱해도 같은 파일명이 나오므로,
// 호출부는 existsSync(filepath)만으로 dedup을 판정할 수 있다(디렉토리 스캔·별도 인덱스
// 불필요). dedupKey 필드는 frontmatter에도 남겨 사람이 파일을 열어 직접 확인할 수 있게
// 한다(v1 dedup 키를 그대로 이식 — docs/ARCHITECTURE-V2.md "구현 메모" 절).
//
// 계좌 귀속(account)은 이 시점에 비워둔다 — 어느 계좌 보유종목인지 판별하려면
// State/Holdings(구현계획서 Phase 8·9)가 있어야 하는데, Phase 2는 파싱→Ledger 기록까지만
// 범위로 정했다(2026-08-04 오너 확정). accountNote로 이유를 명시해 "누락"이 아니라
// "의도적으로 다음 단계로 미룸"임을 남긴다. **폴더가 아니라 필드**로 비워두는 이유도
// 같다 — 이벤트 로그는 한번 쓰면 옮기지 않는 게 원칙이라, 나중에 확정되는 값(계좌)을
// 기준으로 폴더를 나누면 그 값이 확정될 때 파일을 옮겨야 해서 원칙과 어긋난다.
//
// 어느 Ledger 하위폴더에 쓸지는 이 모듈이 결정해 `dir`로 반환한다(2026-08-04 확정,
// 오너 요청 — 이벤트 종류별 하위폴더 분리) — 호출부가 매핑을 따로 알 필요가 없다.
import { VAULT_PATHS } from './vault-paths.mjs';
// frontmatter 빌드는 vault-frontmatter.mjs 공용 모듈 사용(2026-08-05 리팩터).
import { buildFrontmatter } from './vault-frontmatter.mjs';

function sanitizeSegment(s) {
  return String(s ?? '').trim().replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, '-');
}

const ACCOUNT_NOTE = 'Phase 8·9(State/Holdings) 이후 별도 배치로 채워짐 — Phase 2 범위 밖(2026-08-04 확정)';

// e: parseExecution()의 반환값 { tradeDate, tradeType, stockCode, stockName, quantity, price,
// currency, broker, account? }. account는 선택 필드 — 카카오 파싱 경로(자산분배 트랙)는
// 파싱 시점에 어느 계좌인지 몰라 안 넘기고(기존 그대로 null+ACCOUNT_NOTE로 폴백), 퀀트
// 트랙(watch-order-fill.mjs)처럼 호출부가 이미 계좌를 확실히 아는 경우에만 넘겨서 그
// 자리에서 바로 채운다(2026-08-13 — "나중에 채움" 각주가 필요 없는 소스까지 똑같이
// null로 남겨 혼동을 주지 않기 위함).
// 금현물도 이 함수를 그대로 쓴다(별도 함수 없음) — v1이 "금현물을 별도 원장으로 뒀다가
// 버그나서 체결내역에 통합"한 전례를 반영(폴더 하나로 합침, 위 import 주석 참고).
// ⚠️ 버그 수정(2026-08-19, 오너 제보로 발견한 배당 계좌귀속 버그를 조사하다 같은 클래스로
// 발견) — parseExecution은 한국투자증권 체결 원문에서 acctNo(예: "43****82-29")를 이미
// 정확히 뽑고 있었는데(2026-08-13 캡처 추가), 이 함수가 그 값을 frontmatter에 아예 안
// 쓰고 버리고 있었다. 그 결과 update-holdings-from-executions.mjs가 나중에 파일을 다시
// 읽을 때 exec.acctNo가 항상 undefined라 IRP 계좌번호 직접매칭(account-resolver.mjs
// KNOWN_ACCOUNT_NUMBERS)이 한 번도 발동 못 하고, 게다가 한국투자증권은 애초에
// AMBIGUOUS_BROKER_CANDIDATES에도 없어 이름매칭 폴백조차 안 타서 무조건 계좌귀속불가로
// 떨어졌다(실측: TIGER TDF2045 적격 매수 2건). 다른 필드(broker·stockCode 등)와 동일하게
// acctNo도 이제 그대로 보존한다.
export function buildExecutionRecord(e) {
  const dedupKey = `${e.tradeDate}|${e.tradeType}|${e.stockName}|${e.quantity}`;
  const datePart = e.tradeDate.slice(0, 10);
  const timePart = e.tradeDate.slice(11).replace(/:/g, '') || '000000';
  // 폴더가 이미 "체결"임을 말해주므로 파일명엔 종류 접두사를 안 붙인다 — 날짜부터
  // 시작해 옵시디언 파일목록에서 자동으로 시간순 정렬되게 한다.
  // datePart·timePart도 sanitizeSegment를 거친다(보안리뷰 지적, 2026-08-05) —
  // normalizeDateTime이 예상 형식과 안 맞는 입력을 무가공으로 돌려줄 수 있어, 나머지
  // 필드(tradeType·stockName)와 일관되게 방어한다. 지금은 알람 시트 "시간" 열(기기가
  // 생성)이 소스라 공격 경로는 없지만, 파일명 조립 규칙 전체를 균일하게 유지하는 게
  // 나중에 다른 소스가 추가돼도 안전하다.
  const filename = `${sanitizeSegment(datePart)}-${sanitizeSegment(timePart)}-${sanitizeSegment(e.tradeType)}-${sanitizeSegment(e.stockName)}.md`;
  const content = buildFrontmatter({
    type: 'execution',
    tradeDate: e.tradeDate,
    tradeType: e.tradeType,
    stockCode: e.stockCode || '',
    stockName: e.stockName,
    quantity: e.quantity,
    price: e.price,
    currency: e.currency,
    broker: e.broker,
    acctNo: e.acctNo || '',
    account: e.account ?? null,
    accountNote: e.account ? null : ACCOUNT_NOTE,
    dedupKey,
    recordedAt: new Date().toISOString(),
  });
  return { dedupKey, filename, content, dir: VAULT_PATHS.facts.ledger.executions };
}

// d: parseDividend()의 반환값 { date, afterTaxAmount, stockName, acctRaw, broker, receivedTime, uniqueKey }
export function buildDividendRecord(d) {
  const dedupKey = `${d.date}|${d.stockName}|${d.uniqueKey}`;
  const timePart = String(d.receivedTime ?? '').replace(/:/g, '') || '000000';
  const filename = `${sanitizeSegment(d.date)}-${sanitizeSegment(timePart)}-${sanitizeSegment(d.stockName)}.md`;
  const content = buildFrontmatter({
    type: 'dividend',
    date: d.date,
    stockName: d.stockName,
    afterTaxAmount: d.afterTaxAmount,
    receivedTime: d.receivedTime,
    uniqueKey: d.uniqueKey,
    broker: d.broker || '',
    acctRaw: d.acctRaw || '',
    account: null,
    accountNote: ACCOUNT_NOTE,
    dedupKey,
    recordedAt: new Date().toISOString(),
  });
  return { dedupKey, filename, content, dir: VAULT_PATHS.facts.ledger.dividends };
}

// c: parseCashAlarm()의 반환값 { account, acctNo, balance, ts }. 체결·배당과 달리
// account가 파싱 시점에 이미 확정돼 있다(nh-accounts.mjs가 계좌번호로 바로 판정) —
// "나중에 채움" accountNote 패턴이 필요 없다(2026-08-18 신설, 예수금앵커 배선).
export function buildCashEventRecord(c) {
  const dedupKey = `${c.ts}|${c.account}|${c.balance}`;
  const datePart = c.ts.slice(0, 10);
  const timePart = c.ts.slice(11).replace(/:/g, '') || '000000';
  // 잔고를 파일명에 포함(buildProfitRecord와 동일 원칙, 코드리뷰 관례 재사용) — 같은
  // 계좌가 같은 초에 알림을 2건 받으면(연속 입출금 등) 잔고 없이는 파일명이 겹쳐
  // 뒤 기록이 앞 기록을 조용히 덮어쓴다.
  const filename = `${sanitizeSegment(datePart)}-${sanitizeSegment(timePart)}-${sanitizeSegment(c.account)}-${sanitizeSegment(c.balance)}.md`;
  const content = buildFrontmatter({
    type: 'cash-event',
    ts: c.ts,
    account: c.account,
    acctNo: c.acctNo || '',
    balance: c.balance,
    dedupKey,
    recordedAt: new Date().toISOString(),
  });
  return { dedupKey, filename, content, dir: VAULT_PATHS.facts.ledger.cashEvents };
}

// f: parseFundBuy()의 반환값 { fundName, amount, nav, date, units }. 펀드 알림 원문은
// 시각이 아니라 "매수신청일"(날짜)만 주므로(notification-parsers.mjs FUND_DATE), 다른
// 빌더처럼 시각을 dedupKey에 못 넣는다 — 같은 펀드를 같은 날 다른 금액으로 두 번
// 매수하는 경우까지 감안해 금액을 넣어 구분한다(executions의 수량 포함 관례와 동일 이유).
// 2026-08-04 확정대로 Phase 2엔 없던 계좌 귀속은 이제 State/Holdings(Phase 8·9 완료,
// 2026-08-XX)가 갖춰졌지만, 펀드적립을 보유종목에 반영하는 배치 로직 자체는 아직
// 없다 — 그 배치가 생기기 전까지는 다른 이벤트와 동일하게 account:null로 원문만 남긴다.
export function buildFundPurchaseRecord(f) {
  const dedupKey = `${f.date}|${f.fundName}|${f.amount}`;
  const filename = `${sanitizeSegment(f.date)}-${sanitizeSegment(f.fundName)}-${sanitizeSegment(f.amount)}.md`;
  const content = buildFrontmatter({
    type: 'fund-purchase',
    date: f.date,
    fundName: f.fundName,
    amount: f.amount,
    nav: f.nav,
    units: f.units,
    account: null,
    accountNote: ACCOUNT_NOTE,
    dedupKey,
    recordedAt: new Date().toISOString(),
  });
  return { dedupKey, filename, content, dir: VAULT_PATHS.facts.ledger.fundPurchases };
}

// x: parseExchange()의 반환값 { kind, usd, won, date }. kind는 "외화매수"/"외화매도".
// 펀드와 같은 이유로 date만 있고 시각이 없어, usd 금액을 dedupKey에 포함해 같은 날
// 여러 건의 환전을 구분한다.
export function buildExchangeRecord(x) {
  const dedupKey = `${x.date}|${x.kind}|${x.usd}`;
  const filename = `${sanitizeSegment(x.date)}-${sanitizeSegment(x.kind)}-${sanitizeSegment(x.usd)}.md`;
  const content = buildFrontmatter({
    type: 'exchange',
    date: x.date,
    kind: x.kind,
    usd: x.usd,
    won: x.won,
    account: null,
    accountNote: ACCOUNT_NOTE,
    dedupKey,
    recordedAt: new Date().toISOString(),
  });
  return { dedupKey, filename, content, dir: VAULT_PATHS.facts.ledger.exchanges };
}

// 매도 체결로 발생한 실현손익 — holdings-updater.mjs(구현계획서 Phase 8)가 매도 적용
// 직후 호출한다. account는 여기선 null로 안 비워둔다 — 매도 자체가 계좌 귀속이 이미
// 해결된 뒤에만(account-resolver.mjs) 처리되는 단계라, 실현손익 시점엔 계좌를 이미 안다.
// e: { tradeDate, stockName, quantity, price, account }, avgPrice: 매도 직전 평단가,
// realizedProfit: holdings-updater.mjs applySell()의 계산 결과.
export function buildProfitRecord(e, avgPrice, realizedProfit) {
  const dedupKey = `${e.tradeDate}|매도|${e.stockName}|${e.quantity}|profit`;
  const datePart = e.tradeDate.slice(0, 10);
  const timePart = e.tradeDate.slice(11).replace(/:/g, '') || '000000';
  // 수량을 파일명에 포함(코드리뷰 지적, 2026-08-05) — 같은 종목·계좌를 같은 초에 분할
  // 매도(분할체결)하면 수량 없이는 파일명이 겹쳐 뒤 기록이 앞 기록을 조용히 덮어쓴다.
  const filename = `${sanitizeSegment(datePart)}-${sanitizeSegment(timePart)}-${sanitizeSegment(e.stockName)}-${sanitizeSegment(e.account)}-${sanitizeSegment(e.quantity)}.md`;
  const content = buildFrontmatter({
    type: 'realized-profit',
    date: e.tradeDate,
    stockName: e.stockName,
    quantity: e.quantity,
    buyPrice: avgPrice,
    sellPrice: e.price,
    profit: realizedProfit,
    account: e.account,
    dedupKey,
    recordedAt: new Date().toISOString(),
  });
  return { dedupKey, filename, content, dir: VAULT_PATHS.facts.ledger.profits };
}
