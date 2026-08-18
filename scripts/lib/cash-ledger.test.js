import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeCashDelta, settleCash, resolveNhCashAnchor, resolvePensionCashLedger, resolveDesignatedCashBalance } from './cash-ledger.mjs';

test('[막아야 함/v1 버그 재현 방지] computeCashDelta: 기준점과 같은 날 오후에 생긴 거래도 정밀 타임스탬프로 정확히 포함', () => {
  // v1 버그 재현: 기준점(NH 알림)이 "2026-08-04 09:00:00"에 왔고, 같은 날 오후
  // "2026-08-04 15:00:00"에 배당이 들어왔다. v1은 날짜만 비교해서(둘 다 08-04) 이
  // 배당을 델타에서 빠뜨렸다. v2는 전체 타임스탬프로 비교해 정확히 포함해야 한다.
  const delta = computeCashDelta({
    anchorTs: '2026-08-04 09:00:00',
    flows: [{ ts: '2026-08-04 15:00:00', amount: 50000 }],
  });
  assert.equal(delta, 50000);
});

test('computeCashDelta: 기준점 이전(같은 날 포함) 거래는 이미 반영된 것으로 보고 제외', () => {
  const delta = computeCashDelta({
    anchorTs: '2026-08-04 09:00:00',
    flows: [
      { ts: '2026-08-04 08:00:00', amount: 100000 }, // 기준점보다 이전 — 제외
      { ts: '2026-08-04 09:00:00', amount: 999999 }, // 기준점과 동일 시각 — 제외(이미 반영됨)
      { ts: '2026-08-04 09:00:01', amount: 30000 },  // 1초 뒤 — 포함
    ],
  });
  assert.equal(delta, 30000);
});

test('computeCashDelta: 여러 계좌 뒤섞인 flows에서 amount 부호(+입금성/-출금성) 그대로 합산', () => {
  const delta = computeCashDelta({
    anchorTs: '2026-08-01 00:00:00',
    flows: [
      { ts: '2026-08-02 10:00:00', amount: 500000 },  // 배당
      { ts: '2026-08-03 10:00:00', amount: -300000 }, // 매수
      { ts: '2026-08-04 10:00:00', amount: 200000 },  // 매도대금
    ],
  });
  assert.equal(delta, 400000);
});

test('computeCashDelta: flows·anchorTs 없으면 0(터지지 않음)', () => {
  assert.equal(computeCashDelta({ anchorTs: null, flows: [{ ts: '2026-08-04', amount: 1 }] }), 0);
  assert.equal(computeCashDelta({ anchorTs: '2026-08-04', flows: null }), 0);
  assert.equal(computeCashDelta({ anchorTs: '2026-08-04', flows: [] }), 0);
});

test('settleCash: 양수는 그대로, 음수는 0 클램프+negative 플래그(raw는 보존)', () => {
  assert.deepEqual(settleCash(1000000, -300000), { cash: 700000, raw: 700000, negative: false });
  assert.deepEqual(settleCash(100000, -390600), { cash: 0, raw: -290600, negative: true });
  assert.deepEqual(settleCash(null, null), { cash: 0, raw: 0, negative: false });
});

test('resolveNhCashAnchor: 최신 알림이 있으면 항상 그걸 기준점으로(수동 폴백 불필요 — 4계좌 전부 실알림 있음)', () => {
  const r = resolveNhCashAnchor({ stored: { base: 100, baseTs: '2026-08-01 00:00:00', source: '자동' }, latestAlarm: { balance: 999999, ts: '2026-08-10 09:00:00' } });
  assert.deepEqual(r, { base: 999999, baseTs: '2026-08-10 09:00:00', source: '자동' });
});

test('resolveNhCashAnchor: 알림이 한 번도 없었으면 기존 저장값 유지(마이그레이션 스냅샷 등)', () => {
  const r = resolveNhCashAnchor({ stored: { base: 1164516, baseTs: '2026-08-13', source: '이관' }, latestAlarm: null });
  assert.deepEqual(r, { base: 1164516, baseTs: '2026-08-13', source: '이관' });
});

test('resolveNhCashAnchor: 저장값도 알림도 없으면(완전 최초) base null', () => {
  const r = resolveNhCashAnchor({ stored: null, latestAlarm: null });
  assert.equal(r.base, null);
});

test('resolvePensionCashLedger: 배당·매도(+)와 매수(-)를 합산해 잔고 계산 — 어제 사고의 정확한 수정', () => {
  // 2026-08-16 실사고 재현: 배당 25건이 들어왔는데(합계 96만원) 그 돈으로 이미 직접
  // 매수한 것(합계 80만원)은 안 빠져서 962,000원 전액이 "미투자 현금"으로 잘못 잡혔다.
  // 이제는 매수도 델타에 포함(음수)돼 실제 남은 돈만 계산된다.
  const r = resolvePensionCashLedger({
    flows: [
      { ts: '2026-08-04 10:00:00', amount: 962000 },   // 배당 누적
      { ts: '2026-08-04 15:00:00', amount: -800000 },  // 그 돈으로 직접 매수
    ],
  });
  assert.equal(r.cash, 162000); // 이제 정확히 남은 돈만 미투자 현금으로 잡힘
});

test('resolvePensionCashLedger: 매수만 있고 그만큼 배당이 없으면(과거 이월 자금 사용) 0 클램프+경고', () => {
  const r = resolvePensionCashLedger({ flows: [{ ts: '2026-08-04', amount: -100000 }] });
  assert.deepEqual(r, { cash: 0, raw: -100000, negative: true });
});

test('resolvePensionCashLedger: flows 없으면 0', () => {
  assert.deepEqual(resolvePensionCashLedger({ flows: [] }), { cash: 0, raw: 0, negative: false });
});

test('resolveDesignatedCashBalance: 위탁+금현물 합산(오너 확정 — 금현물 대기현금은 위탁과 합쳐 취급)', () => {
  assert.equal(resolveDesignatedCashBalance({ wtCash: 1164516, goldCash: 538637 }), 1703153);
});

test('resolveDesignatedCashBalance: null/undefined 안전(터지지 않음)', () => {
  assert.equal(resolveDesignatedCashBalance({ wtCash: null, goldCash: undefined }), 0);
  assert.equal(resolveDesignatedCashBalance({}), 0);
});
