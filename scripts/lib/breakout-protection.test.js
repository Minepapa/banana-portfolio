import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeProtectionOrders, placeProtectionOrders, ensurePositionProtected } from './breakout-protection.mjs';
import { PROTECTION_STATUS } from './breakout-position-vault.mjs';

const basePosition = {
  entryPrice: 10000, quantity: 10, stopPrice: 9200,
  stopOrderNo: null, stopOrderOrgNo: null, profitOrderNo: null, profitOrderOrgNo: null,
  profitOrderApplicable: true,
};
const noSleep = async () => {};

// [실사고 재발방지] 2026-09-22 — SK텔레콤 87,400원 진입 × 0.92(8% 손절) = 80,408원,
// 이 가격대(50,000~200,000원) KRX 호가단위는 100원이라 KIS가 "주식주문호가단위
// 오류입니다"로 3회 재시도 전부 거부했다(포지션이 무방비로 남음). computeProtectionOrders
// 가 이제 krx-tick.mjs로 손절·익절가를 실제 호가단위에 맞춰 반올림한다.
test('computeProtectionOrders: 호가단위 보정 — 2026-09-22 SK텔레콤 실사고 재현(87,400원 진입, 8% 손절)', () => {
  const { stopOrder, profitOrder } = computeProtectionOrders(87400, 1); // 1주 → 부분익절 없음
  assert.equal(stopOrder.conditionPrice, 80400); // 80,408 → 100원 단위로 보정
  assert.equal(stopOrder.conditionPrice % 100, 0);
  assert.equal(profitOrder, null); // 1주는 부분익절 수량 0(기존 동작 그대로 — 회귀 없음)
});

test('computeProtectionOrders: 손절은 전량, 부분익절은 절반(내림)', () => {
  const { stopOrder, profitOrder } = computeProtectionOrders(10000, 15); // 15주 × 50% = 7.5 → 내림 7
  assert.equal(stopOrder.quantity, 15);
  assert.ok(Math.abs(stopOrder.conditionPrice - 9200) < 1e-6);
  assert.equal(profitOrder.quantity, 7);
  assert.ok(Math.abs(profitOrder.conditionPrice - 12400) < 1e-6);
});

test('computeProtectionOrders: 수량이 1주뿐이면 부분익절 수량이 0 → profitOrder는 null(주문 자체를 안 냄)', () => {
  const { profitOrder } = computeProtectionOrders(10000, 1);
  assert.equal(profitOrder, null);
});

// [MEDIUM 재발방지] 2026-09-19 코드리뷰 — ATR 가변손절(stopLossPct) 실전배선.
// stopLossPct가 손절가·3R 목표가 둘 다에 비례 반영되는지 직접 고정.
test('computeProtectionOrders: stopLossPct=4%면 손절가·3R목표가 둘 다 그 비율로 계산됨(8%의 절반 폭)', () => {
  const { stopOrder, profitOrder } = computeProtectionOrders(10000, 15, 0.04);
  assert.ok(Math.abs(stopOrder.conditionPrice - 9600) < 1e-6); // 10000×(1-0.04)
  assert.ok(Math.abs(profitOrder.conditionPrice - 11200) < 1e-6); // 3R = +3×4% = +12%
});

test('computeProtectionOrders: stopLossPct 생략 시 기존 STOP_LOSS_PCT(8%)와 동일(회귀 없음)', () => {
  const { stopOrder, profitOrder } = computeProtectionOrders(10000, 15);
  assert.ok(Math.abs(stopOrder.conditionPrice - 9200) < 1e-6);
  assert.ok(Math.abs(profitOrder.conditionPrice - 12400) < 1e-6);
});

test('placeProtectionOrders: 둘 다 성공하면 fullyProtected=true, 주문번호 기록', () => {
  let calls = [];
  const placeOrder = async (params) => {
    calls.push(params);
    return { orderNo: `no-${calls.length}`, orgNo: 'org-1' };
  };
  return placeProtectionOrders({ entryPrice: 10000, quantity: 10, placeOrder }).then((result) => {
    assert.equal(result.fullyProtected, true);
    assert.equal(result.stopOrder.ok, true);
    assert.equal(result.stopOrder.orderNo, 'no-1');
    assert.equal(result.profitOrder.ok, true);
    assert.equal(result.profitOrder.orderNo, 'no-2');
    assert.equal(calls.length, 2);
    assert.equal(calls[0].quantity, 10); // 손절 전량
    assert.equal(calls[1].quantity, 5); // 부분익절 절반
  });
});

test('placeProtectionOrders: 손절주문만 실패해도 부분익절은 그대로 시도(독립 시도), fullyProtected=false', async () => {
  let call = 0;
  const placeOrder = async () => {
    call += 1;
    if (call === 1) { const e = new Error('주문가능금액 부족'); e.confirmedNotSent = true; throw e; }
    return { orderNo: 'no-2', orgNo: 'org-1' };
  };
  const result = await placeProtectionOrders({ entryPrice: 10000, quantity: 10, placeOrder });
  assert.equal(result.fullyProtected, false);
  assert.equal(result.stopOrder.ok, false);
  assert.equal(result.stopOrder.confirmedNotSent, true);
  assert.equal(result.profitOrder.ok, true); // 손절 실패와 무관하게 부분익절은 시도됨
});

test('placeProtectionOrders: 수량 1주(부분익절 없음)면 profitOrder는 skipped=true로 자동 성공 취급, fullyProtected는 손절 결과에만 의존', async () => {
  const placeOrder = async () => ({ orderNo: 'no-1', orgNo: 'org-1' });
  const result = await placeProtectionOrders({ entryPrice: 10000, quantity: 1, placeOrder });
  assert.equal(result.profitOrder.skipped, true);
  assert.equal(result.fullyProtected, true);
});

test('placeProtectionOrders: KIS 응답에 주문번호가 없으면 미접수로 단정하지 않고 재시도 없이 실패 처리', async () => {
  let calls = 0;
  const result = await placeProtectionOrders({
    entryPrice: 10000, quantity: 10,
    placeOrder: async () => { calls += 1; return { orderNo: '' }; },
  });
  assert.equal(calls, 2);
  assert.equal(result.fullyProtected, false);
  assert.equal(result.stopOrder.ok, false);
  assert.equal(result.stopOrder.confirmedNotSent, false);
  assert.equal(result.profitOrder.ok, false);
  assert.equal(result.profitOrder.confirmedNotSent, false);
});

test('ensurePositionProtected: 이미 둘 다 걸려있으면 재시도 없이 즉시 protected(attempts=0)', async () => {
  const position = { ...basePosition, stopOrderNo: 's1', stopOrderOrgNo: 'org', profitOrderNo: 'p1', profitOrderOrgNo: 'org' };
  const placeOrder = async () => { throw new Error('호출되면 안 됨'); };
  const result = await ensurePositionProtected(position, { placeOrder, sleep: noSleep });
  assert.equal(result.protectionStatus, PROTECTION_STATUS.PROTECTED);
  assert.equal(result.attempts, 0);
});

test('ensurePositionProtected: 게이트가 손절 접수 후 바뀌면 3R 주문을 내지 않고 손절 번호는 보존', async () => {
  let calls = 0;
  let gateChecks = 0;
  const result = await ensurePositionProtected(basePosition, {
    placeOrder: async () => ({ orderNo: `order-${++calls}`, orgNo: 'org' }),
    beforePlaceOrder: async () => ++gateChecks === 1,
    sleep: noSleep,
  });
  assert.equal(calls, 1);
  assert.equal(gateChecks, 2);
  assert.equal(result.stopOrderNo, 'order-1');
  assert.equal(result.profitOrderNo, null);
  assert.equal(result.gateBlocked, true);
  assert.equal(result.protectionStatus, PROTECTION_STATUS.FAILED);
});

test('ensurePositionProtected: 게이트가 재시도 전에 닫히면 추가 주문 없이 종료', async () => {
  let calls = 0;
  let checks = 0;
  const placeOrder = async () => {
    calls += 1;
    const error = new Error('일시적 거부');
    error.confirmedNotSent = true;
    throw error;
  };
  const result = await ensurePositionProtected(basePosition, {
    placeOrder,
    beforePlaceOrder: async () => ++checks <= 2,
    maxAttempts: 3,
    sleep: noSleep,
  });
  assert.equal(calls, 2);
  assert.equal(checks, 3);
  assert.equal(result.gateBlocked, true);
  assert.equal(result.attempts, 2);
  assert.equal(result.protectionStatus, PROTECTION_STATUS.FAILED);
});

test('ensurePositionProtected: 이미 손절만 걸려있으면 부분익절만 재시도(손절은 다시 안 부름)', async () => {
  const position = { ...basePosition, stopOrderNo: 's1', stopOrderOrgNo: 'org' };
  let calls = 0;
  const placeOrder = async () => { calls += 1; return { orderNo: 'p1', orgNo: 'org' }; };
  const result = await ensurePositionProtected(position, { placeOrder, sleep: noSleep });
  assert.equal(calls, 1); // 부분익절 1건만 호출
  assert.equal(result.stopOrderNo, 's1'); // 기존 값 그대로 보존
  assert.equal(result.profitOrderNo, 'p1');
  assert.equal(result.protectionStatus, PROTECTION_STATUS.PROTECTED);
});

// [MEDIUM 재발방지] 2026-09-19 코드리뷰 — 부분익절 재시도 가격이 position.stopLossPct
// 를 실제로 반영하는지(4% 포지션이면 첫 시도와 재시도 둘 다 +12%가 나와야 함, 기본
// 8% 기준 +24%가 나오면 원래 포지션의 R배수 목표와 어긋난 가격으로 주문이 나가는
// 회귀). 손절 다리는 이미 걸려 있다고 두고 부분익절만 재시도시켜 가격을 직접 확인.
test('ensurePositionProtected: position.stopLossPct=4%면 부분익절 재시도 가격이 +12%(4%의 3R) — 기본 8% 기준 +24%와 다름', async () => {
  const position = { ...basePosition, stopLossPct: 0.04, stopOrderNo: 's1', stopOrderOrgNo: 'org' };
  let captured = null;
  const placeOrder = async (params) => { captured = params; return { orderNo: 'p1', orgNo: 'org' }; };
  await ensurePositionProtected(position, { placeOrder, sleep: noSleep });
  assert.ok(Math.abs(captured.conditionPrice - 11200) < 1e-6); // 10000×(1+3×0.04)
});

test('ensurePositionProtected: 첫 시도가 confirmedNotSent=true(확실히 미접수)로 실패해도 재시도로 성공하면 attempts에 반영, 시도 사이 sleep 호출', async () => {
  let calls = 0;
  let sleepCalls = 0;
  const placeOrder = async () => {
    calls += 1;
    if (calls <= 2) { const e = new Error('일시적 거부'); e.confirmedNotSent = true; throw e; } // 손절 1회, 부분익절 1회 실패(1차 시도) — "확실히 미접수"라 재시도 안전
    return { orderNo: `no-${calls}`, orgNo: 'org' };
  };
  const sleep = async () => { sleepCalls += 1; };
  const result = await ensurePositionProtected(basePosition, { placeOrder, maxAttempts: 3, sleep });
  assert.equal(result.protectionStatus, PROTECTION_STATUS.PROTECTED);
  assert.equal(result.attempts, 2);
  assert.equal(sleepCalls, 1); // 1차 실패 후 2차 시도 전 딱 한 번
});

test('ensurePositionProtected: maxAttempts 소진 후에도 실패하면(confirmedNotSent=true만 반복) protectionStatus=failed', async () => {
  const placeOrder = async () => { const e = new Error('영구 거부'); e.confirmedNotSent = true; throw e; };
  const result = await ensurePositionProtected(basePosition, { placeOrder, maxAttempts: 2, sleep: noSleep });
  assert.equal(result.protectionStatus, PROTECTION_STATUS.FAILED);
  assert.equal(result.attempts, 2);
  assert.equal(result.stopOrderNo, null);
});

// [핵심 안전장치] 코드리뷰 HIGH 지적(2026-09-13) 재발방지 — confirmedNotSent가 없는
// (실제로 접수됐을 수 있는) 실패는 절대 재시도하면 안 된다. 재시도하면 이미 나간
// 주문 위에 또 하나가 얹혀 이중 매도주문(과다매도 시도)이 될 수 있다.
test('ensurePositionProtected: confirmedNotSent 없는 애매한 실패는 그 다리만 즉시 중단(재시도 안 함) — 이중주문 방지', async () => {
  let calls = 0;
  const placeOrder = async () => { calls += 1; throw new Error('네트워크 예외(응답 불명)'); }; // confirmedNotSent 미설정
  const result = await ensurePositionProtected(basePosition, { placeOrder, maxAttempts: 3, sleep: noSleep });
  assert.equal(calls, 2, '손절 1회+부분익절 1회, 딱 그만큼만 시도하고 재시도 안 해야 함(attempts=1에서 양쪽 다 ambiguous로 종료)');
  assert.equal(result.attempts, 1);
  assert.equal(result.stopAmbiguous, true);
  assert.equal(result.profitAmbiguous, true);
  assert.equal(result.protectionStatus, PROTECTION_STATUS.FAILED);
  assert.equal(result.stopOrderNo, null);
});

test('ensurePositionProtected: 손절만 애매하게 실패하고 부분익절은 confirmedNotSent로 실패하면, 부분익절만 재시도되고 손절은 즉시 멈춤', async () => {
  let stopCalls = 0;
  let profitCalls = 0;
  const placeOrder = async ({ quantity }) => {
    // basePosition 기준 stopOrder.quantity=10(전량), profitOrder.quantity=5(절반)로 구분
    if (quantity === 10) { stopCalls += 1; throw new Error('네트워크 예외(응답 불명)'); }
    profitCalls += 1;
    if (profitCalls === 1) { const e = new Error('일시적 거부'); e.confirmedNotSent = true; throw e; }
    return { orderNo: 'p1', orgNo: 'org' };
  };
  const result = await ensurePositionProtected(basePosition, { placeOrder, maxAttempts: 3, sleep: noSleep });
  assert.equal(stopCalls, 1, '손절은 애매한 실패 후 재시도 안 해야 함');
  assert.equal(profitCalls, 2, '부분익절은 confirmedNotSent라 재시도돼 결국 성공해야 함');
  assert.equal(result.stopAmbiguous, true);
  assert.equal(result.profitAmbiguous, false);
  assert.equal(result.profitOrderNo, 'p1');
  assert.equal(result.protectionStatus, PROTECTION_STATUS.FAILED); // 손절 다리가 불명이라 전체는 여전히 failed(수동확인 필요)
});

test('ensurePositionProtected: profitOrderApplicable=false면 부분익절은 아예 시도 안 함(손절만 걸리면 protected)', async () => {
  const position = { ...basePosition, profitOrderApplicable: false };
  let calls = 0;
  const placeOrder = async () => { calls += 1; return { orderNo: 's1', orgNo: 'org' }; };
  const result = await ensurePositionProtected(position, { placeOrder, sleep: noSleep });
  assert.equal(calls, 1);
  assert.equal(result.protectionStatus, PROTECTION_STATUS.PROTECTED);
  assert.equal(result.profitOrderNo, null);
});
