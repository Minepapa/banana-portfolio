import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeCashDelta, settleCash, resolveCashAnchor, resolveDesignatedCashBalance, findCashBalance } from './cash-ledger.mjs';

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

test('[실사고 재현/2026-08-16] settleCash+computeCashDelta: 배당(+)만 세고 그 돈으로 재투자한 매수(-)를 안 빼면 잔고가 부풀려짐 — 반드시 양방향', () => {
  // 배당 25건 합계 96만원이 들어왔는데 그 돈으로 이미 직접 매수한 것(80만원)을 안 빼서
  // 962,000원 전액이 "미투자 현금"으로 잘못 잡혔던 사고. 매수도 델타에 포함(음수)해야
  // 실제 남은 돈만 계산된다 — 연금저축·IRP처럼 앵커가 0원(마이그레이션 직후 등)인
  // 계좌에서도 이 계산 방식은 동일하다(2026-08-18 설계통합 — 계좌별 특수 함수 없앰).
  const delta = computeCashDelta({
    anchorTs: '2026-08-01 00:00:00',
    flows: [
      { ts: '2026-08-04 10:00:00', amount: 962000 },   // 배당 누적
      { ts: '2026-08-04 15:00:00', amount: -800000 },  // 그 돈으로 직접 매수
    ],
  });
  assert.equal(settleCash(0, delta).cash, 162000); // 이제 정확히 남은 돈만 미투자 현금으로 잡힘
});

test('resolveCashAnchor: 최신 CashEvent가 있으면 항상 그걸 기준점으로(자동 알림·수동 스냅샷 구분 없음, 2026-08-18 설계통합)', () => {
  const r = resolveCashAnchor({ stored: { base: 100, baseTs: '2026-08-01 00:00:00', source: '자동' }, latestEvent: { balance: 999999, ts: '2026-08-10 09:00:00' } });
  assert.deepEqual(r, { base: 999999, baseTs: '2026-08-10 09:00:00', source: '자동' });
});

test('resolveCashAnchor: CashEvent가 한 번도 없었으면 기존 저장값 유지(마이그레이션 스냅샷 등)', () => {
  const r = resolveCashAnchor({ stored: { base: 1164516, baseTs: '2026-08-13', source: '이관' }, latestEvent: null });
  assert.deepEqual(r, { base: 1164516, baseTs: '2026-08-13', source: '이관' });
});

test('resolveCashAnchor: 저장값도 CashEvent도 없으면(완전 최초) base null', () => {
  const r = resolveCashAnchor({ stored: null, latestEvent: null });
  assert.equal(r.base, null);
});

// [핵심 안전장치] 2026-09-03, code-reviewer 지적 — 마이그레이션 3단계 롤백 함정
// 재현. 위탁·CMA처럼 CashEvent 파싱이 중단된 계좌는 latestEvent가 중단 시점에
// 영구 동결된다 — stored(직접 API로 매일 갱신)가 latestEvent보다 최신이면
// stored를 우선해야, 실수로 이 계좌를 되돌렸을 때 동결된 옛 앵커로 기준점이
// 튀어 예수금이 이중반영되는 사고를 막을 수 있다.
test('[핵심 안전장치] resolveCashAnchor: stored가 latestEvent보다 최신이면 stored 우선(동결된 옛 CashEvent에 안 밀림)', () => {
  const r = resolveCashAnchor({
    stored: { base: 5797267, baseTs: '2026-09-03 16:08:00', source: 'NH API 직접조회' },
    latestEvent: { balance: 1234567, ts: '2026-08-19 10:00:00' },
  });
  assert.deepEqual(r, { base: 5797267, baseTs: '2026-09-03 16:08:00', source: 'NH API 직접조회' });
});

test('resolveCashAnchor: latestEvent가 stored보다 최신이면 기존대로 latestEvent 우선(회귀 방지)', () => {
  const r = resolveCashAnchor({
    stored: { base: 100, baseTs: '2026-08-01 00:00:00', source: '자동' },
    latestEvent: { balance: 200, ts: '2026-08-02 00:00:00' },
  });
  assert.deepEqual(r, { base: 200, baseTs: '2026-08-02 00:00:00', source: '자동' });
});

test('resolveDesignatedCashBalance: 위탁+금현물 합산(오너 확정 — 금현물 대기현금은 위탁과 합쳐 취급)', () => {
  assert.equal(resolveDesignatedCashBalance({ wtCash: 1164516, goldCash: 538637 }), 1703153);
});

test('resolveDesignatedCashBalance: null/undefined 안전(터지지 않음)', () => {
  assert.equal(resolveDesignatedCashBalance({ wtCash: null, goldCash: undefined }), 0);
  assert.equal(resolveDesignatedCashBalance({}), 0);
});

// findCashBalance(2026-08-30 이전 — new-cash-allocation.mjs에 있던 것을 여기로 옮김,
// 코드리뷰 지적: report-facts.mjs가 "그 계좌 현금이 뭔지"를 독립적으로 재구현하려다
// 이 정의와 갈라질 뻔했다 — 이제 이 함수 하나만 모든 소비자가 공유한다).

test('findCashBalance: 예수금 보유(isCashLike, name="예수금")의 evalAmount를 그대로 반환', () => {
  const holdings = [
    { account: '위탁', name: '예수금', isCashLike: true, evalAmount: 1164516 },
    { account: '위탁', name: 'SK하이닉스', assetClass: '국내주식', evalAmount: 17200000 },
  ];
  assert.equal(findCashBalance(holdings, '위탁'), 1164516);
});

test('findCashBalance: 그 계좌 예수금 보유가 없으면 null(0으로 추정 안 함)', () => {
  assert.equal(findCashBalance([{ account: 'ISA', name: '예수금', isCashLike: true, evalAmount: 1000 }], '위탁'), null);
});

test('findCashBalance: 이름이 "예수금"이 아니면(예: 외화RP) isCashLike=true여도 안 잡힘 — 정확일치만', () => {
  const holdings = [{ account: '위탁', name: '외화 RP', isCashLike: true, assetClass: '달러', evalAmount: 892846 }];
  assert.equal(findCashBalance(holdings, '위탁'), null);
});
