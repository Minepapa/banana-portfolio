// ledger-vault-writer.mjs 테스트 — 파일명이 멱등키 역할을 하는지, frontmatter가 올바른
// YAML 형태인지 확인.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildExecutionRecord, buildDividendRecord, buildProfitRecord, buildCashEventRecord, buildFundPurchaseRecord, buildExchangeRecord } from './ledger-vault-writer.mjs';
import { VAULT_PATHS } from './vault-paths.mjs';

const exec = (overrides = {}) => ({
  tradeDate: '2026-08-04 09:12:33',
  tradeType: '매수',
  stockCode: '005930',
  stockName: '삼성전자',
  quantity: 10,
  price: 71000,
  currency: 'KRW',
  broker: 'NH투자증권',
  ...overrides,
});

test('buildExecutionRecord: 파일명에 날짜·시각·구분·종목명이 들어간다(종류 접두사 없음 — 폴더가 이미 말해줌)', () => {
  const { filename } = buildExecutionRecord(exec());
  assert.equal(filename, '2026-08-04-091233-매수-삼성전자.md');
});

test('buildExecutionRecord: Executions 하위폴더를 가리킨다', () => {
  const { dir } = buildExecutionRecord(exec());
  assert.equal(dir, VAULT_PATHS.facts.ledger.executions);
});

test('buildExecutionRecord: 같은 이벤트는 항상 같은 파일명(멱등키 역할)', () => {
  const a = buildExecutionRecord(exec());
  const b = buildExecutionRecord(exec());
  assert.equal(a.filename, b.filename);
  assert.equal(a.dedupKey, b.dedupKey);
});

test('buildExecutionRecord: 수량이 다르면 다른 dedupKey(분할체결 구분)', () => {
  const a = buildExecutionRecord(exec({ quantity: 10 }));
  const b = buildExecutionRecord(exec({ quantity: 5 }));
  assert.notEqual(a.dedupKey, b.dedupKey);
});

test('buildExecutionRecord: frontmatter에 필수 필드와 account=null(사유 명시) 포함', () => {
  const { content } = buildExecutionRecord(exec());
  assert.match(content, /^---\n/);
  assert.match(content, /type: "execution"/);
  assert.match(content, /tradeType: "매수"/);
  assert.match(content, /stockName: "삼성전자"/);
  assert.match(content, /quantity: 10/);
  assert.match(content, /price: 71000/);
  assert.match(content, /account: null/);
  assert.match(content, /accountNote: ".*Phase 8·9.*"/);
  assert.match(content, /dedupKey: "2026-08-04 09:12:33\|매수\|삼성전자\|10"/);
});

// 실사고 회귀 테스트(2026-08-19) — parseExecution이 한국투자증권 원문에서 뽑은 acctNo를
// 이 함수가 frontmatter에 안 쓰고 버려서, IRP 계좌번호 직접매칭이 한 번도 못 타고 있었다
// (한국투자증권은 AMBIGUOUS_BROKER_CANDIDATES에도 없어 이름매칭 폴백조차 없음 — 실측:
// TIGER TDF2045 적격 매수 2건이 영구히 계좌귀속불가로 떨어짐).
test('buildExecutionRecord: acctNo가 있으면 frontmatter에 보존됨(계좌번호 직접매칭에 필요)', () => {
  const { content } = buildExecutionRecord(exec({ broker: '한국투자증권', acctNo: '43****82-29' }));
  assert.match(content, /acctNo: "43\*\*\*\*82-29"/);
});

test('buildExecutionRecord: acctNo 없으면 빈 문자열(다른 acctRaw류 필드와 동일 관례)', () => {
  const { content } = buildExecutionRecord(exec());
  assert.match(content, /acctNo: ""/);
});

test('buildExecutionRecord: 호출부가 account를 이미 알면(퀀트 트랙 등) 그 자리에서 채우고 accountNote는 null(더 이상 미룰 이유 없음)', () => {
  const { content } = buildExecutionRecord(exec({ account: '퀀트' }));
  assert.match(content, /account: "퀀트"/);
  assert.match(content, /accountNote: null/);
});

test('buildExecutionRecord: 종목명에 슬래시·콜론 등이 있어도 안전한 파일명', () => {
  const { filename } = buildExecutionRecord(exec({ stockName: 'TIGER 미국:나스닥/100' }));
  assert.doesNotMatch(filename, /[:/]/);
});

test('[보안리뷰 반영] buildExecutionRecord: tradeDate 자체가 비정상 형식(경로 구분자 포함)이어도 파일명에 슬래시가 안 남는다', () => {
  // normalizeDateTime은 형식이 안 맞는 입력을 무가공으로 돌려줄 수 있음 — datePart·
  // timePart도 sanitizeSegment를 거쳐야 한다(2026-08-05, security-review 스킬 지적).
  const { filename } = buildExecutionRecord(exec({ tradeDate: '2026/08/04 09:12:33' }));
  assert.doesNotMatch(filename, /\//);
});

test('buildExecutionRecord: 문자열 값의 큰따옴표는 이스케이프된다', () => {
  const { content } = buildExecutionRecord(exec({ stockName: '종목"이상한"이름' }));
  assert.match(content, /stockName: "종목\\"이상한\\"이름"/);
});

const div = (overrides = {}) => ({
  date: '2026-08-04',
  afterTaxAmount: 15000,
  stockName: 'TIGER 리츠부동산인프라',
  acctRaw: '',
  broker: 'NH투자증권',
  receivedTime: '09:00:00',
  uniqueKey: '09:00:00_15000',
  ...overrides,
});

test('buildDividendRecord: 파일명·dedupKey가 결정론적(파일명도 종류 접두사 없음)', () => {
  const a = buildDividendRecord(div());
  const b = buildDividendRecord(div());
  assert.equal(a.filename, b.filename);
  assert.equal(a.filename, '2026-08-04-090000-TIGER-리츠부동산인프라.md');
  assert.equal(a.dedupKey, '2026-08-04|TIGER 리츠부동산인프라|09:00:00_15000');
});

test('buildDividendRecord: Dividends 하위폴더를 가리킨다(Executions와 다른 폴더)', () => {
  const { dir } = buildDividendRecord(div());
  assert.equal(dir, VAULT_PATHS.facts.ledger.dividends);
  assert.notEqual(dir, VAULT_PATHS.facts.ledger.executions);
});

test('buildDividendRecord: 금액이 다르면(같은 시각) uniqueKey가 달라 dedupKey도 달라짐', () => {
  const a = buildDividendRecord(div({ afterTaxAmount: 15000, uniqueKey: '09:00:00_15000' }));
  const b = buildDividendRecord(div({ afterTaxAmount: 20000, uniqueKey: '09:00:00_20000' }));
  assert.notEqual(a.dedupKey, b.dedupKey);
});

test('buildDividendRecord: frontmatter에 배당 필드 포함', () => {
  const { content } = buildDividendRecord(div());
  assert.match(content, /type: "dividend"/);
  assert.match(content, /afterTaxAmount: 15000/);
  assert.match(content, /uniqueKey: "09:00:00_15000"/);
  assert.match(content, /account: null/);
});

const sellExec = (overrides = {}) => ({
  tradeDate: '2026-08-05 10:00:00', stockName: '삼성전자', quantity: 4, price: 70000, account: '위탁', ...overrides,
});

test('buildProfitRecord: account가 null이 아니다(매도 시점엔 이미 계좌 귀속 해결됨)', () => {
  const { content } = buildProfitRecord(sellExec(), 50000, (70000 - 50000) * 4);
  assert.match(content, /account: "위탁"/);
  assert.match(content, /type: "realized-profit"/);
  assert.match(content, /profit: 80000/);
  assert.match(content, /buyPrice: 50000/);
  assert.match(content, /sellPrice: 70000/);
});

test('buildProfitRecord: Profits 하위폴더를 가리킨다', () => {
  const { dir } = buildProfitRecord(sellExec(), 50000, 80000);
  assert.equal(dir, VAULT_PATHS.facts.ledger.profits);
});

test('buildProfitRecord: 파일명이 결정론적(날짜·시각·종목명·계좌)', () => {
  const a = buildProfitRecord(sellExec(), 50000, 80000);
  const b = buildProfitRecord(sellExec(), 50000, 80000);
  assert.equal(a.filename, b.filename);
  assert.equal(a.filename, '2026-08-05-100000-삼성전자-위탁-4.md');
});

test('buildProfitRecord: 같은 종목·계좌·같은 초라도 수량이 다르면(분할체결) 다른 파일명', () => {
  const a = buildProfitRecord(sellExec({ quantity: 4 }), 50000, 80000);
  const b = buildProfitRecord(sellExec({ quantity: 6 }), 50000, 80000);
  assert.notEqual(a.filename, b.filename);
});

const cashEvent = (overrides = {}) => ({
  account: '위탁', acctNo: '205-01-59***9', balance: 1234567, ts: '2026-08-18 09:00:00',
  ...overrides,
});

test('buildCashEventRecord: CashEvents 하위폴더를 가리킨다', () => {
  const { dir } = buildCashEventRecord(cashEvent());
  assert.equal(dir, VAULT_PATHS.facts.ledger.cashEvents);
});

test('buildCashEventRecord: 파일명·dedupKey가 결정론적(날짜-시각-계좌명-잔고)', () => {
  const a = buildCashEventRecord(cashEvent());
  const b = buildCashEventRecord(cashEvent());
  assert.equal(a.filename, b.filename);
  assert.equal(a.filename, '2026-08-18-090000-위탁-1234567.md');
  assert.equal(a.dedupKey, '2026-08-18 09:00:00|위탁|1234567');
});

test('[막아야 함] buildCashEventRecord: 같은 계좌·같은 초에 잔고 다른 알림 2건이 와도 파일명이 안 겹침', () => {
  const a = buildCashEventRecord(cashEvent({ balance: 100 }));
  const b = buildCashEventRecord(cashEvent({ balance: 200 }));
  assert.notEqual(a.filename, b.filename);
});

test('buildCashEventRecord: account는 파싱 시점에 이미 확정 — accountNote 지연패턴 없음', () => {
  const { content } = buildCashEventRecord(cashEvent());
  assert.match(content, /account: "위탁"/);
  assert.doesNotMatch(content, /accountNote/);
});

test('buildCashEventRecord: 같은 계좌·같은 시각이라도 잔고가 다르면(같은 초 연속 알림) 다른 dedupKey', () => {
  const a = buildCashEventRecord(cashEvent({ balance: 100 }));
  const b = buildCashEventRecord(cashEvent({ balance: 200 }));
  assert.notEqual(a.dedupKey, b.dedupKey);
});

// 2026-08-21 — v1→v2 전수감사에서 확인된 gap. 파서(parseFundBuy)는 이미 있었지만
// Vault 빌더·잡 배선이 안 돼 있었다(Phase 2엔 State/Holdings 미완성이라 의도적으로
// 미룸 — Phase 8·9 완료 후 마저 연결).
const fundBuy = (overrides = {}) => ({
  fundName: 'VIP한국형가치투자증권투자신탁', amount: 500000, nav: 1523.45, date: '2026-08-04', units: 328.185,
  ...overrides,
});

test('buildFundPurchaseRecord: FundPurchases 하위폴더를 가리킨다', () => {
  const { dir } = buildFundPurchaseRecord(fundBuy());
  assert.equal(dir, VAULT_PATHS.facts.ledger.fundPurchases);
});

test('buildFundPurchaseRecord: 파일명·dedupKey가 결정론적(날짜-펀드명-금액, 시각 정보가 원문에 없음)', () => {
  const a = buildFundPurchaseRecord(fundBuy());
  const b = buildFundPurchaseRecord(fundBuy());
  assert.equal(a.filename, b.filename);
  assert.equal(a.filename, '2026-08-04-VIP한국형가치투자증권투자신탁-500000.md');
  assert.equal(a.dedupKey, '2026-08-04|VIP한국형가치투자증권투자신탁|500000');
});

test('buildFundPurchaseRecord: 같은 펀드·같은 날이라도 금액이 다르면(분할매수) 다른 파일명', () => {
  const a = buildFundPurchaseRecord(fundBuy({ amount: 500000 }));
  const b = buildFundPurchaseRecord(fundBuy({ amount: 300000 }));
  assert.notEqual(a.filename, b.filename);
});

test('buildFundPurchaseRecord: frontmatter에 펀드 필드 포함, account는 다른 이벤트와 동일하게 지연패턴', () => {
  const { content } = buildFundPurchaseRecord(fundBuy());
  assert.match(content, /type: "fund-purchase"/);
  assert.match(content, /nav: 1523.45/);
  assert.match(content, /units: 328.185/);
  assert.match(content, /account: null/);
  assert.match(content, /accountNote: ".*Phase 8·9.*"/);
});

const exchange = (overrides = {}) => ({
  kind: '외화매수', usd: 3000, won: 4128000, date: '2026-08-04',
  ...overrides,
});

test('buildExchangeRecord: Exchanges 하위폴더를 가리킨다', () => {
  const { dir } = buildExchangeRecord(exchange());
  assert.equal(dir, VAULT_PATHS.facts.ledger.exchanges);
});

test('buildExchangeRecord: 파일명·dedupKey가 결정론적(날짜-구분-USD금액)', () => {
  const a = buildExchangeRecord(exchange());
  const b = buildExchangeRecord(exchange());
  assert.equal(a.filename, b.filename);
  assert.equal(a.filename, '2026-08-04-외화매수-3000.md');
  assert.equal(a.dedupKey, '2026-08-04|외화매수|3000');
});

test('buildExchangeRecord: 매수·매도가 같은 날 같은 USD금액이어도 kind가 다르면 다른 dedupKey', () => {
  const a = buildExchangeRecord(exchange({ kind: '외화매수' }));
  const b = buildExchangeRecord(exchange({ kind: '외화매도' }));
  assert.notEqual(a.dedupKey, b.dedupKey);
});

test('buildExchangeRecord: won이 없으면(파싱 실패 허용 필드) null로 기록', () => {
  const { content } = buildExchangeRecord(exchange({ won: null }));
  assert.match(content, /won: null/);
});
