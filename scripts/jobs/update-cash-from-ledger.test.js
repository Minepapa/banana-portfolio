import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFlows, resolveAccountAnchor, checkDriftWarning, FROZEN_ANCHORS } from './update-cash-from-ledger.mjs';
import { computeCashDelta } from '../lib/cash-ledger.mjs';

const exec = (overrides = {}) => ({
  tradeDate: '2026-08-04 09:12:33', tradeType: '매수', stockName: '삼성전자',
  quantity: 10, price: 71000, account: '위탁',
  ...overrides,
});

const div = (overrides = {}) => ({
  date: '2026-08-04', receivedTime: '10:00:00', afterTaxAmount: 5000, account: '위탁',
  ...overrides,
});

const fundBuy = (overrides = {}) => ({
  date: '2026-08-04', fundName: 'VIP한국형가치투자증권투자신탁', amount: 500000, account: '연금저축',
  ...overrides,
});

const exchange = (overrides = {}) => ({
  date: '2026-08-04', kind: '외화매수', usd: 1000, won: 1350000, account: '위탁',
  ...overrides,
});

test('buildFlows: 체결·배당은 기존과 동일 — 매수(-)/매도(+)/배당(+)', () => {
  const flows = buildFlows('위탁', [exec({ tradeType: '매수' }), exec({ tradeType: '매도' })], [div()], [], []);
  assert.deepEqual(flows.map((f) => f.amount), [-710000, 710000, 5000]);
});

test('buildFlows: 펀드적립은 항상 현금유출(-), 시각 없어 00:00:00으로 채움', () => {
  const flows = buildFlows('연금저축', [], [], [fundBuy({ amount: 500000 })], []);
  assert.deepEqual(flows, [{ ts: '2026-08-04 00:00:00', amount: -500000 }]);
});

test('buildFlows: 펀드적립 — 다른 계좌 필터링(연금저축 전용, account-resolver.mjs FUND_PURCHASE_ACCOUNT)', () => {
  const flows = buildFlows('위탁', [], [], [fundBuy({ account: '연금저축' })], []);
  assert.deepEqual(flows, []);
});

test('buildFlows: 펀드적립 — amount가 0/비정상이면 제외', () => {
  const flows = buildFlows('연금저축', [], [], [fundBuy({ amount: 0 }), fundBuy({ amount: null })], []);
  assert.deepEqual(flows, []);
});

test('buildFlows: 환전 — 외화매수는 현금유출(-), 외화매도는 현금유입(+)', () => {
  const flows = buildFlows('위탁', [], [], [], [
    exchange({ kind: '외화매수', won: 1350000 }),
    exchange({ kind: '외화매도', won: 700000 }),
  ]);
  assert.deepEqual(flows.map((f) => f.amount), [-1350000, 700000]);
});

test('buildFlows: 환전 — 다른 계좌 필터링(위탁 전용, account-resolver.mjs EXCHANGE_ACCOUNT)', () => {
  const flows = buildFlows('ISA', [], [], [], [exchange({ account: '위탁' })]);
  assert.deepEqual(flows, []);
});

test('buildFlows: 환전 — won이 파싱 실패로 null이면 임의 환율 추정 없이 건너뜀', () => {
  const flows = buildFlows('위탁', [], [], [], [exchange({ won: null })]);
  assert.deepEqual(flows, []);
});

test('buildFlows: legacy(마이그레이션 스냅샷) 펀드적립·환전도 체결·배당과 동일하게 제외(이중계상 방지)', () => {
  const flows = buildFlows('연금저축', [], [], [fundBuy({ legacy: true })], []);
  assert.deepEqual(flows, []);
  const flows2 = buildFlows('위탁', [], [], [], [exchange({ legacy: true })]);
  assert.deepEqual(flows2, []);
});

test('buildFlows: 체결·배당·펀드적립·환전이 같은 계좌에서 함께 합산됨', () => {
  const flows = buildFlows(
    '위탁',
    [exec({ tradeType: '매도', account: '위탁' })],
    [div({ account: '위탁' })],
    [],
    [exchange({ kind: '외화매수', account: '위탁' })],
  );
  assert.deepEqual(flows.map((f) => f.amount), [710000, 5000, -1350000]);
});

// ISA 앵커 고정 설계(2026-09-11)의 짝 — cashEvents의 depositAmount(ISA 입금안내
// 전용 필드, notification-parsers.mjs parseCashAlarm)를 입금 flow(+)로 편입한다.
const cashEvent = (overrides = {}) => ({
  ts: '2026-08-04 09:00:00', account: 'ISA', balance: 300000, depositAmount: null,
  ...overrides,
});

test('[신설/2026-09-11] buildFlows: cashEvents의 depositAmount(ISA 입금)를 입금 flow(+)로 편입', () => {
  const flows = buildFlows('ISA', [], [], [], [], [cashEvent({ depositAmount: 300000 })]);
  assert.deepEqual(flows, [{ ts: '2026-08-04 09:00:00', amount: 300000 }]);
});

test('[신설/2026-09-11] buildFlows: depositAmount 없는 cashEvent(출금안내 등)는 flow에 안 들어감', () => {
  const flows = buildFlows('ISA', [], [], [], [], [cashEvent({ depositAmount: null })]);
  assert.deepEqual(flows, []);
});

test('[신설/2026-09-11] buildFlows: 다른 계좌 cashEvent는 필터링', () => {
  const flows = buildFlows('ISA', [], [], [], [], [cashEvent({ account: '위탁', depositAmount: 999999 })]);
  assert.deepEqual(flows, []);
});

// ⚠️ 배당 3건 금액(48,840·29,640·68,150원)은 2026-09-08 실사고의 실제 배당 내역
// (DevRequest 원문 — TIGER 리츠부동산인프라·ACE 미국하이일드액티브(H)·TIME Korea
// 플러스배당액티브)이다. 입금액(990,000원)·매수(50,000원)는 "입금과 배당이 같은
// 창에 섞여도 둘 다 각자 flow로 온전히 더해진다"는 것만 보이는 예시값 — 실제
// 사고의 정확한 재구성치는 아니다(그건 과거 재구성 방식이었던 max() 비교가 이미
// 실패한 지점이라 이 설계에서는 애초에 전제 자체가 다르다).
test('[배당실사고 반영/2026-09-08] buildFlows: 입금·배당·체결이 ISA 고정 앵커 위에서 함께 합산됨', () => {
  const flows = buildFlows(
    'ISA',
    [exec({ tradeType: '매수', account: 'ISA', quantity: 1, price: 50000 })],
    [
      div({ account: 'ISA', date: '2026-09-02', receivedTime: '10:00:00', afterTaxAmount: 48840 }),
      div({ account: 'ISA', date: '2026-09-02', receivedTime: '10:05:00', afterTaxAmount: 29640 }),
      div({ account: 'ISA', date: '2026-09-02', receivedTime: '10:10:00', afterTaxAmount: 68150 }),
    ],
    [], [],
    [cashEvent({ ts: '2026-09-08 09:42:32', depositAmount: 990000 })],
  );
  const total = flows.reduce((s, f) => s + f.amount, 0);
  assert.equal(total, 990000 + 48840 + 29640 + 68150 - 50000);
});

// resolveAccountAnchor — ISA 앵커 동결이 실제로 안 흔들리는지(2026-09-11 신설,
// code-reviewer 2차 지적: 이전엔 이 분기가 main() 안에만 있어 테스트가 자기영속
// 루프의 안정성을 검증 못 했음).
test('[신설/2026-09-11] resolveAccountAnchor: ISA는 더 최신 latestEvent·다른 stored가 와도 FROZEN_ANCHORS 값만 반환(동결)', () => {
  const r = resolveAccountAnchor('ISA', {
    stored: { base: 999999999, baseTs: '2026-09-10 00:00:00', source: '뭔가다른값' },
    latestEvent: { balance: 1, ts: '2026-09-20 10:00:00' }, // 훨씬 최신 NH 알림이 와도
  });
  assert.deepEqual(r, FROZEN_ANCHORS.ISA);
});

test('[신설/2026-09-11] resolveAccountAnchor: ISA는 stored·latestEvent가 둘 다 없어도(State 파일 유실) 흔들리지 않음', () => {
  const r = resolveAccountAnchor('ISA', { stored: null, latestEvent: null });
  assert.deepEqual(r, FROZEN_ANCHORS.ISA);
});

test('[신설/2026-09-11] resolveAccountAnchor: 자기 영속 — 출력을 다음 입력의 stored로 되먹여도 2회 연속 동일', () => {
  const r1 = resolveAccountAnchor('ISA', { stored: null, latestEvent: { balance: 1, ts: '2026-09-09 00:00:00' } });
  const r2 = resolveAccountAnchor('ISA', { stored: { base: r1.base, baseTs: r1.baseTs, source: r1.source }, latestEvent: { balance: 2, ts: '2026-09-10 00:00:00' } });
  assert.deepEqual(r1, r2);
});

test('resolveAccountAnchor: 동결 대상이 아닌 계좌(연금저축)는 기존 resolveCashAnchor 그대로(회귀 방지)', () => {
  const r = resolveAccountAnchor('연금저축', {
    stored: { base: 100, baseTs: '2026-08-01 00:00:00', source: '자동' },
    latestEvent: { balance: 200, ts: '2026-08-02 00:00:00' },
  });
  assert.deepEqual(r, { base: 200, baseTs: '2026-08-02 00:00:00', source: '자동' }); // latestEvent가 최신이면 채택(동결 아님)
});

// 더블카운팅 방지선 — buildFlows가 만든 입금 flow가 computeCashDelta의 anchorTs
// 필터와 실제로 맞물려 09-02 배당·09-08 09:42:32 입금(앵커 이전)은 제외되고
// 앵커 이후 flow만 더해지는지, 통합해서 확인(2026-09-11 code-reviewer 2차 지적).
test('[신설/2026-09-11] 통합: FROZEN_ANCHORS.ISA 시각 이전 cashEvent·배당은 델타에서 제외됨', () => {
  // FROZEN_ANCHORS.ISA는 오너 재확인 때마다 값·시각이 바뀔 수 있는 살아있는 상수라
  // (파일 헤더 주석 참고, 실제로 2026-09-08→2026-09-11로 이미 한 번 갱신됨) 특정
  // 실제 날짜를 하드코딩하지 않는다 — 그 앵커 시각 "1초 전/1초 후"를 동적으로
  // 계산해 경계 자체(> anchorTs)만 검증한다.
  const anchorTs = FROZEN_ANCHORS.ISA.baseTs;
  const before = new Date(new Date(`${anchorTs.replace(' ', 'T')}Z`).getTime() - 1000).toISOString().slice(0, 19).replace('T', ' ');
  const after = new Date(new Date(`${anchorTs.replace(' ', 'T')}Z`).getTime() + 1000).toISOString().slice(0, 19).replace('T', ' ');
  const flows = buildFlows(
    'ISA',
    [],
    [
      { account: 'ISA', date: before.slice(0, 10), receivedTime: before.slice(11), afterTaxAmount: 48840 }, // 앵커 이전
    ],
    [], [],
    [
      { ts: before, account: 'ISA', depositAmount: 1000000 }, // 앵커 이전
      { ts: after, account: 'ISA', depositAmount: 50000 },    // 앵커 이후 — 포함돼야 함
    ],
  );
  const delta = computeCashDelta({ anchorTs, flows });
  assert.equal(delta, 50000); // 앵커 이전 배당·입금은 제외, 앵커 이후 입금만 포함
});

// checkDriftWarning — 2026-09-11 신설 직후 실측(--dry-run)으로 오탐이 재현됐던
// 버그의 회귀 테스트. latestEvent가 앵커를 세운 바로 그 CashEvent 자신이면(그
// 이후 새 NH 알림이 아직 없는 상태) 정상적인 매수만으로도 settledCash가 항상
// latestEvent.balance보다 작아지므로, 그 경우엔 경보하면 안 된다.
test('[회귀방지/2026-09-11] checkDriftWarning: latestEvent가 앵커 시각 이하(새 정보 없음)면 정상 매수로 값이 줄어도 경보 안 함', () => {
  const w = checkDriftWarning({
    account: 'ISA',
    anchorBaseTs: FROZEN_ANCHORS.ISA.baseTs,
    latestEvent: { balance: FROZEN_ANCHORS.ISA.base, ts: FROZEN_ANCHORS.ISA.baseTs }, // 앵커 자신
    settledCash: FROZEN_ANCHORS.ISA.base - 481400, // 앵커 고정 후 매수로 줄어든 값(예시)
  });
  assert.equal(w, null);
});

test('checkDriftWarning: 앵커 이후 새 NH 알림이 왔는데 계산값이 그 하한선보다 낮으면 경보', () => {
  const w = checkDriftWarning({
    account: 'ISA',
    anchorBaseTs: '2026-09-08 16:23:37',
    latestEvent: { balance: 500000, ts: '2026-09-15 10:00:00' }, // 앵커보다 최신
    settledCash: 400000, // NH 하한선보다 낮음 — 미추적 유출 의심
  });
  assert.match(w, /🚨 ISA/);
});

test('checkDriftWarning: 앵커 이후 새 알림이 와도 계산값이 하한선 이상이면 경보 없음(정상)', () => {
  const w = checkDriftWarning({
    account: 'ISA',
    anchorBaseTs: '2026-09-08 16:23:37',
    latestEvent: { balance: 500000, ts: '2026-09-15 10:00:00' },
    settledCash: 500000,
  });
  assert.equal(w, null);
});

test('checkDriftWarning: 동결 대상 아닌 계좌(연금저축)는 항상 null', () => {
  const w = checkDriftWarning({
    account: '연금저축',
    anchorBaseTs: '2026-09-08 16:23:37',
    latestEvent: { balance: 999999999, ts: '2026-09-15 10:00:00' },
    settledCash: 0,
  });
  assert.equal(w, null);
});
