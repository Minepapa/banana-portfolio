import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setNhRateLimitForTests } from './nhplug.mjs';
import {
  getTotalTransaction, getDepositWithdrawal, filterDividendRows, reconstructForeignRpLots,
} from './nhplug-common.mjs';

setNhRateLimitForTests(Infinity);

const mockFetchWithHeaders = (responses) => {
  let i = 0;
  return async () => {
    const r = responses[Math.min(i++, responses.length - 1)];
    const headerMap = r.responseHeaders || {};
    return {
      ok: r.ok !== false,
      status: r.status ?? 200,
      text: async () => JSON.stringify(r.body),
      headers: { get: (name) => headerMap[name] ?? null },
    };
  };
};

test('getTotalTransaction: 단일 페이지(연속조회 없음)면 그대로 rows 반환, truncated:false', async () => {
  const fetchImpl = mockFetchWithHeaders([
    { body: { rsp_cd: '00166', Output_0: [{ trd_dt: '20260901', trd_amt: 1000 }] }, responseHeaders: {} },
  ]);
  const { rows, truncated } = await getTotalTransaction({ token: 't', actNo: '1', iqrStaDt: '20260901', iqrEndDt: '20260901', fetchImpl });
  assert.equal(rows.length, 1);
  assert.equal(truncated, false);
});

test('getTotalTransaction: 연속조회(00218) → cts로 이어받아 두 페이지 rows를 합쳐 반환', async () => {
  const fetchImpl = mockFetchWithHeaders([
    { body: { rsp_cd: '00218', Output_0: [{ trd_dt: '20260901' }] }, responseHeaders: { cts: 'C1', cts_flag: 'Y' } },
    { body: { rsp_cd: '00166', Output_0: [{ trd_dt: '20260902' }] }, responseHeaders: {} },
  ]);
  const { rows, truncated } = await getTotalTransaction({ token: 't', actNo: '1', iqrStaDt: '20260901', iqrEndDt: '20260930', fetchImpl });
  assert.deepEqual(rows.map((r) => r.trd_dt), ['20260901', '20260902']);
  assert.equal(truncated, false);
});

test('getTotalTransaction: maxPages 도달하면 truncated:true(무한루프 방지, 조용한 누락 방지)', async () => {
  // 매 페이지가 계속 연속조회를 요구하는 상황을 흉내 — 응답이 하나뿐이면 mockFetchWithHeaders가
  // 마지막 응답을 계속 재사용하므로 자연히 "항상 00218"이 된다.
  const fetchImpl = mockFetchWithHeaders([
    { body: { rsp_cd: '00218', Output_0: [{ trd_dt: '20260901' }] }, responseHeaders: { cts: 'ALWAYS', cts_flag: 'Y' } },
  ]);
  const { rows, truncated } = await getTotalTransaction({ token: 't', actNo: '1', iqrStaDt: '20260901', iqrEndDt: '20260930', fetchImpl, maxPages: 3 });
  assert.equal(rows.length, 3);
  assert.equal(truncated, true);
});

test('[막아야 함] getTotalTransaction: 연속조회 신호는 왔는데 cts 헤더가 없으면 더 못 가지만, 이건 데이터가 더 있는데 못 받은 것과 같으므로 truncated:true(2026-09-19 코드리뷰 HIGH — 예전엔 false로 반환해 "완전한 데이터"로 오판시켰음)', async () => {
  const fetchImpl = mockFetchWithHeaders([
    { body: { rsp_cd: '00218', Output_0: [{ trd_dt: '20260901' }] }, responseHeaders: {} },
  ]);
  const { rows, truncated } = await getTotalTransaction({ token: 't', actNo: '1', iqrStaDt: '20260901', iqrEndDt: '20260930', fetchImpl });
  assert.equal(rows.length, 1);
  assert.equal(truncated, true);
});

test('getDepositWithdrawal: 기본 동작(단일 페이지)', async () => {
  const fetchImpl = mockFetchWithHeaders([
    { body: { rsp_cd: '00166', Output_0: [{ trd_dt: '20260901', trd_amt: 500 }] }, responseHeaders: {} },
  ]);
  const { rows } = await getDepositWithdrawal({ token: 't', actNo: '1', iqrStaDt: '20260901', iqrEndDt: '20260901', fetchImpl });
  assert.equal(rows.length, 1);
});

test('filterDividendRows: "배당"·"분배" 키워드가 적요코드에 있는 항목만 통과', () => {
  const rows = [
    { sps_cd_krl_anm: '배당금' },
    { sps_cd_krl_anm: '외화배당금입금' },
    { sps_cd_krl_anm: 'ETF분배금입금' },
    { sps_cd_krl_anm: '코스피매도' },
    { sps_cd_krl_anm: '대체출금' },
  ];
  const dividends = filterDividendRows(rows);
  assert.equal(dividends.length, 3);
});

test('filterDividendRows: 빈 입력·필드 없는 행도 안전하게 처리', () => {
  assert.deepEqual(filterDividendRows(null), []);
  assert.deepEqual(filterDividendRows([{}]), []);
});

test('[막아야 함] filterDividendRows: "배당소득세"·"배당금출금"은 입금이 아니라 세금/출금이라 제외(2026-09-19 코드리뷰 LOW — Vault엔 입금 레코드만 있어 그대로 두면 오탐 경고가 됨)', () => {
  const rows = [{ sps_cd_krl_anm: '배당소득세' }, { sps_cd_krl_anm: '배당금출금' }, { sps_cd_krl_anm: '배당금' }];
  const dividends = filterDividendRows(rows);
  assert.deepEqual(dividends.map((r) => r.sps_cd_krl_anm), ['배당금']);
});

// 2026-09-19 실계좌 재현 — 오너가 NH 앱 스크린샷으로 직접 반증한 실제 사례:
// 8/26에 이전 로트(652.47)가 만기로 롤오버(매도+동액 매수)되고, 9/4에 별개의
// 신규 로트(5353.15)가 열려, 현재 총 보유수량은 두 로트 합계(6005.62)다.
test('reconstructForeignRpLots: 실계좌 재현 — 롤오버(매도+동액 매수)와 별개 신규 로트를 합쳐 정확한 총액 산출', () => {
  const rows = [
    { trd_dt: '20260826', sps_cd_krl_anm: '외화RP매도', trd_amt: 652.47, trd_af_bnc_qty: 0, cur_cd: 'USD', iem_nm: '자유약정형' },
    { trd_dt: '20260826', sps_cd_krl_anm: '외화RP매수', trd_amt: 652.47, trd_af_bnc_qty: 652.47, cur_cd: 'USD', iem_nm: '자유약정형' },
    { trd_dt: '20260904', sps_cd_krl_anm: '외화RP매수', trd_amt: 5353.15, trd_af_bnc_qty: 5353.15, cur_cd: 'USD', iem_nm: '자유약정형' },
  ];
  const { lots, total, currency } = reconstructForeignRpLots(rows);
  assert.equal(lots.length, 2);
  assert.equal(total, 6005.62);
  assert.equal(currency, 'USD');
});

// 2026-09-19 실계좌 400일 전수 조회로 발견 — 매도금액(trd_amt)은 이자가 붙어 매수원금과 다르다.
// 2026-11-03부터는 trd_amt가 아니라 trd_qty(판 원금, 정수 내림)로 로트를 찾는다 — 이자와 무관하게 맞는다.
test('[막아야 함] reconstructForeignRpLots: 매도금액에 이자가 붙어도 원금(trd_qty)으로 맞는 로트를 닫음', () => {
  const rows = [
    { trd_dt: '20260101', sps_cd_krl_anm: '외화RP매수', trd_qty: 1000, trd_amt: 1000.4, cur_cd: 'USD' },
    { trd_dt: '20260201', sps_cd_krl_anm: '외화RP매수', trd_qty: 2000, trd_amt: 2000.7, cur_cd: 'USD' },
    { trd_dt: '20260301', sps_cd_krl_anm: '외화RP매도', trd_qty: 1000, trd_amt: 1003.02, trd_af_bnc_qty: 0, cur_cd: 'USD' },
  ];
  const { lots, total, unmatchedSells } = reconstructForeignRpLots(rows);
  assert.deepEqual(lots.map((l) => l.amount), [2000.7]);
  assert.equal(total, 2000.7);
  assert.deepEqual(unmatchedSells, []);
});

// 2026-09-19 코드리뷰 MEDIUM 지적 — 같은 날짜 안에서 "매수"가 배열상 "매도"보다
// 먼저 오면(API 응답 순서가 어느 쪽일지 문서화 안 됨), 빈 큐 상태(창 시작 경계일)
// 에서 그 매수가 로트를 열고 바로 그 매도가 자기 자신을 닫아버려 과소계상된다.
// trd_dt만 보는 정렬이면 안정정렬 특성상 입력 순서 그대로 유지돼 이 버그가 난다 —
// 매도를 매수보다 먼저 처리하는 동률 규칙으로 입력 순서와 무관하게 정확해야 한다.
test('[막아야 함] reconstructForeignRpLots: 같은 날짜에 매수가 매도보다 배열상 먼저 와도(API 응답 순서 무관) 매도를 먼저 처리해 과소계상 안 함', () => {
  const rows = [
    // 입력 순서가 위 "실계좌 재현" 테스트와 반대(매수가 먼저) — 빈 큐에서 시작.
    { trd_dt: '20260826', sps_cd_krl_anm: '외화RP매수', trd_amt: 652.47, cur_cd: 'USD', iem_nm: '자유약정형' },
    { trd_dt: '20260826', sps_cd_krl_anm: '외화RP매도', trd_amt: 652.47, cur_cd: 'USD', iem_nm: '자유약정형' },
  ];
  const { lots, total } = reconstructForeignRpLots(rows);
  assert.equal(lots.length, 1); // 매도가 먼저 처리(no-op)된 뒤 매수가 로트를 열어야 함
  assert.equal(total, 652.47);
});

test('reconstructForeignRpLots: 조회기간 시작 이전에 열린 로트의 매도는 매칭할 열린 로트가 없어 조용히 무시(원금을 더한 적 없으니 뺄 것도 없음)', () => {
  const rows = [
    { trd_dt: '20260101', sps_cd_krl_anm: '외화RP매도', trd_amt: 999, trd_af_bnc_qty: 0, cur_cd: 'USD' },
  ];
  const { lots, total } = reconstructForeignRpLots(rows);
  assert.equal(lots.length, 0);
  assert.equal(total, 0);
});

test('reconstructForeignRpLots: 매수한 뒤 완전히 매도되면 열린 로트 없음(정상 청산)', () => {
  const rows = [
    { trd_dt: '20260101', sps_cd_krl_anm: '외화RP매수', trd_qty: 1000, trd_amt: 1000, cur_cd: 'USD' },
    { trd_dt: '20260201', sps_cd_krl_anm: '외화RP매도', trd_qty: 1000, trd_amt: 1001.5, trd_af_bnc_qty: 0, cur_cd: 'USD' },
  ];
  const { lots, total } = reconstructForeignRpLots(rows);
  assert.equal(lots.length, 0);
  assert.equal(total, 0);
});

test('[막아야 함] reconstructForeignRpLots: cur_cd가 없는(원화) 행은 로트 구성에서 제외(함수명이 "Foreign"인데 원화 RP가 섞이면 무의미한 합계가 됨)', () => {
  const rows = [
    { trd_dt: '20260101', sps_cd_krl_anm: '원화RP매수', trd_amt: 999999, cur_cd: '' },
    { trd_dt: '20260201', sps_cd_krl_anm: '외화RP매수', trd_amt: 100, cur_cd: 'USD' },
  ];
  const { lots, total, currency } = reconstructForeignRpLots(rows);
  assert.equal(lots.length, 1);
  assert.equal(total, 100);
  assert.equal(currency, 'USD');
});

test('reconstructForeignRpLots: 빈 입력이면 로트 없음·총액 0', () => {
  assert.deepEqual(reconstructForeignRpLots([]), { lots: [], total: 0, currency: null, unmatchedSells: [] });
  assert.deepEqual(reconstructForeignRpLots(null), { lots: [], total: 0, currency: null, unmatchedSells: [] });
});

// 2026-11-03 실사고 재현(숫자는 가상, 패턴은 실계좌 2026-10 그대로) — 옛 FIFO는 ① 부분 매도에 로트 전체를
// 닫고 ② 실제로 판 로트가 아니라 가장 오래된 로트를 닫아 장부가 부분 매도 잔량만큼 적게 나왔다.
const rp = (trd_dt, side, trd_qty, trd_amt, trd_af_bnc_qty) => ({
  trd_dt, sps_cd_krl_anm: `외화RP${side}`, trd_qty, trd_amt, trd_af_bnc_qty, cur_cd: 'USD', iem_nm: '자유약정형',
});

test('[막아야 함] reconstructForeignRpLots: 부분 매도는 판 로트의 금액을 잔량으로 바꾸고, 가장 오래된 로트가 아니라 원금+잔량이 맞는 로트를 고른다', () => {
  const rows = [
    rp('20261002', '매수', 5000, 5000.5, 5000.5), // 로트 B
    rp('20261008', '매수', 1500, 1500.2, 1500.2), // 로트 C
    rp('20261026', '매도', 600, 601, 900.9), // C 일부 매도: 600 + 900.9 ≈ 1500.2
    rp('20261029', '매수', 4000, 4000.1, 4000.1), // 로트 D(새 돈)
    rp('20261030', '매도', 5000, 5011, 0), // B 만기
    rp('20261030', '매수', 5011, 5011, 5011), // 롤오버 E
  ];
  const { lots, total, unmatchedSells } = reconstructForeignRpLots(rows);
  assert.deepEqual(lots.map((l) => [l.openedDate, l.amount]), [['20261008', 900.9], ['20261029', 4000.1], ['20261030', 5011]]);
  assert.ok(Math.abs(total - (900.9 + 4000.1 + 5011)) < 1e-9);
  assert.deepEqual(unmatchedSells, []);
});

test('[막아야 함] reconstructForeignRpLots: 같은 로트를 당일 사고팔면(원금·금액 동일, 매수가 먼저) 열린 로트로 남기지 않는다', () => {
  const rows = [
    rp('20260301', '매수', 2000, 2000.3, 2000.3),
    rp('20260306', '매수', 1300, 1300.8, 1300.8),
    rp('20260306', '매도', 1300, 1300.8, 0),
  ];
  const { lots, unmatchedSells } = reconstructForeignRpLots(rows);
  assert.deepEqual(lots.map((l) => l.amount), [2000.3]);
  assert.deepEqual(unmatchedSells, []);
});

test('[막아야 함] reconstructForeignRpLots: 창 시작 경계의 롤오버(조회 전 로트 매도 + 이자 붙은 새 매수)는 새 로트를 닫지 않고 짝 없는 매도로 돌려준다', () => {
  const rows = [
    rp('20260826', '매수', 652, 652.47, 652.47),
    rp('20260826', '매도', 651, 652.47, 0), // 조회 전 로트(651.x)의 만기 — 새 매수와 원금이 다르다
  ];
  const { lots, total, unmatchedSells } = reconstructForeignRpLots(rows);
  assert.equal(lots.length, 1);
  assert.equal(total, 652.47);
  assert.deepEqual(unmatchedSells.map((u) => [u.trd_dt, u.reason]), [['20260826', 'no-lot']]);
});

test('reconstructForeignRpLots: 원금이 같은 로트가 둘이면 먼저 연 로트를 닫는다', () => {
  const rows = [
    rp('20260101', '매수', 1000, 1000.2, 1000.2),
    rp('20260110', '매수', 1000, 1000.6, 1000.6),
    rp('20260201', '매도', 1000, 1002, 0),
  ];
  const { lots } = reconstructForeignRpLots(rows);
  assert.deepEqual(lots.map((l) => l.openedDate), ['20260110']);
});

test('[막아야 함] reconstructForeignRpLots: 허용 오차 밖이면 아무 로트도 닫지 않고 짝 없는 매도로 돌려준다', () => {
  const rows = [
    rp('20260101', '매수', 1000, 1000.2, 1000.2),
    rp('20260201', '매도', 700, 701, 0), // 700 + 0 은 어떤 로트와도 1.5 USD 안에서 안 맞는다
  ];
  const { lots, unmatchedSells } = reconstructForeignRpLots(rows);
  assert.equal(lots.length, 1);
  assert.deepEqual(unmatchedSells.map((u) => u.reason), ['no-lot']);
});

test('[막아야 함] reconstructForeignRpLots: 원금(trd_qty)이 없는 매도는 추정하지 않고 missing-qty로 돌려준다', () => {
  const rows = [
    rp('20260101', '매수', 1000, 1000.2, 1000.2),
    { trd_dt: '20260201', sps_cd_krl_anm: '외화RP매도', trd_amt: 1002, trd_af_bnc_qty: 0, cur_cd: 'USD' },
  ];
  const { lots, unmatchedSells } = reconstructForeignRpLots(rows);
  assert.equal(lots.length, 1);
  assert.deepEqual(unmatchedSells.map((u) => u.reason), ['missing-qty']);
});

test('reconstructForeignRpLots: 쉼표가 든 문자열 숫자도 읽는다(API는 문자열로 줄 수 있음)', () => {
  const rows = [
    rp('20260101', '매수', '5,353', '5,353.15', '5,353.15'),
    rp('20260201', '매도', '1,000', '1,001.00', '4,353.80'),
  ];
  const { lots } = reconstructForeignRpLots(rows);
  assert.deepEqual(lots.map((l) => l.amount), [4353.8]);
});

test('[막아야 함] reconstructForeignRpLots: 잔량 필드가 없는 매도는 전량으로 추정하지 않고 missing-remaining으로 돌려준다', () => {
  const rows = [
    rp('20260101', '매수', 1000, 1000.2, 1000.2),
    { trd_dt: '20260201', sps_cd_krl_anm: '외화RP매도', trd_qty: 1000, trd_amt: 1002, cur_cd: 'USD' },
  ];
  const { lots, unmatchedSells } = reconstructForeignRpLots(rows);
  assert.equal(lots.length, 1);
  assert.deepEqual(unmatchedSells.map((u) => u.reason), ['missing-remaining']);
});

test('[막아야 함] reconstructForeignRpLots: 금액을 못 읽은 매수는 조용히 버리지 않고 buy-missing-amt로 돌려준다', () => {
  const rows = [{ trd_dt: '20260101', sps_cd_krl_anm: '외화RP매수', trd_qty: 1000, trd_amt: '', cur_cd: 'USD' }];
  const { lots, unmatchedSells } = reconstructForeignRpLots(rows);
  assert.equal(lots.length, 0);
  assert.deepEqual(unmatchedSells.map((u) => u.reason), ['buy-missing-amt']);
});

test('reconstructForeignRpLots: 같은 로트를 두 번 부분 매도하면 잔량이 다시 잔량으로 바뀐다', () => {
  const rows = [
    rp('20260101', '매수', 3000, 3000.4, 3000.4),
    rp('20260110', '매도', 1000, 1000.5, 2000.6),
    rp('20260120', '매도', 500, 500.2, 1500.7),
  ];
  const { lots, unmatchedSells } = reconstructForeignRpLots(rows);
  assert.deepEqual(lots.map((l) => l.amount), [1500.7]);
  assert.deepEqual(unmatchedSells, []);
});

test('reconstructForeignRpLots: 허용 오차 경계 — 차이 1.5는 맞고 1.6은 안 맞는다', () => {
  const at = reconstructForeignRpLots([rp('20260101', '매수', 1001, 1001.5, 1001.5), rp('20260201', '매도', 1000, 1002, 0)]);
  assert.equal(at.lots.length, 0);
  const over = reconstructForeignRpLots([rp('20260101', '매수', 1001, 1001.6, 1001.6), rp('20260201', '매도', 1000, 1002, 0)]);
  assert.equal(over.lots.length, 1);
  assert.deepEqual(over.unmatchedSells.map((u) => u.reason), ['no-lot']);
});

test('reconstructForeignRpLots: 합계는 센트 단위로 반올림한다', () => {
  const { total } = reconstructForeignRpLots([rp('20260101', '매수', 0, 0.1, 0.1), rp('20260102', '매수', 0, 0.2, 0.2)]);
  assert.equal(total, 0.3);
});
