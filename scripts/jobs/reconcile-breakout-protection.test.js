import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isKrxPreMarketWindow, isPriceSeriesStale, tradingDayFillCheckWindow, latestConfirmedHigh, processPosition,
} from './reconcile-breakout-protection.mjs';

test('isKrxPreMarketWindow: 평일 08:35 KST KRX 시가단일가 안', () => {
  assert.equal(isKrxPreMarketWindow(new Date('2026-09-24T23:35:00Z')), true); // 9/25 금 08:35 KST
});
test('isKrxPreMarketWindow: 08:30 시작 전은 false', () => {
  assert.equal(isKrxPreMarketWindow(new Date('2026-09-24T23:29:00Z')), false);
});
test('isKrxPreMarketWindow: 09:00 정규장 개시부터는 false', () => {
  assert.equal(isKrxPreMarketWindow(new Date('2026-09-25T00:00:00Z')), false);
});
test('isKrxPreMarketWindow: 토요일 08:35는 false', () => {
  assert.equal(isKrxPreMarketWindow(new Date('2026-09-25T23:35:00Z')), false);
});

// 2026-09-29 2차 코드리뷰 HIGH 지적 — 07:00 캐시 잡 실패나 이 잡 자체의 실행
// 공백으로 latestTradingDate가 너무 오래되면 checkOrderFill 조회창·원장 날짜를
// 신뢰하면 안 된다.
test('isPriceSeriesStale: null이면 항상 stale', () => {
  assert.equal(isPriceSeriesStale(null, new Date('2026-09-29T23:35:00Z')), true);
});
// now=2026-09-29T23:35:00Z는 KST로 2026-09-30 08:35(isKrxPreMarketWindow 테스트와
// 동일 관례) — "오늘"의 KST 날짜는 2026-09-30이다.
test('isPriceSeriesStale: 전날(정상적인 하루치 지연)은 stale 아님', () => {
  assert.equal(isPriceSeriesStale('2026-09-29', new Date('2026-09-29T23:35:00Z')), false);
});
test('isPriceSeriesStale: 실제 KRX 최장 연휴 수준(2017년 추석, 14일 이내)은 stale 아님', () => {
  assert.equal(isPriceSeriesStale('2026-09-16', new Date('2026-09-29T23:35:00Z')), false);
});
test('isPriceSeriesStale: 15일 이상 벌어지면 stale', () => {
  assert.equal(isPriceSeriesStale('2026-09-14', new Date('2026-09-29T23:35:00Z')), true);
});
test('isPriceSeriesStale: 캐시 날짜가 미래(시계 꼬임 등)면 stale', () => {
  assert.equal(isPriceSeriesStale('2026-10-01', new Date('2026-09-29T23:35:00Z')), true);
});

test('tradingDayFillCheckWindow: latestTradingDate가 있으면 그 날짜 KST 정오를 쓴다', () => {
  const d = tradingDayFillCheckWindow('2026-09-25', new Date('2026-09-29T23:35:00Z'));
  assert.equal(d.toISOString(), '2026-09-25T03:00:00.000Z');
});
test('tradingDayFillCheckWindow: latestTradingDate가 없으면 fallback을 그대로 쓴다', () => {
  const fallback = new Date('2026-09-29T23:35:00Z');
  assert.equal(tradingDayFillCheckWindow(null, fallback), fallback);
});

test('latestConfirmedHigh: entryDate 이후 구간의 최댓값(기존 highSinceEntry 포함)', () => {
  const series = { dates: ['2026-09-20', '2026-09-21', '2026-09-22'], highs: [9000, 11000, 10500] };
  const position = { entryDate: '2026-09-21', highSinceEntry: 10800 };
  assert.equal(latestConfirmedHigh(position, series), 11000);
});
test('latestConfirmedHigh: 시세 캐시가 없으면 null(추정 안 함)', () => {
  assert.equal(latestConfirmedHigh({ entryDate: '2026-09-21', highSinceEntry: 10000 }, null), null);
});

const now = new Date('2026-09-29T23:35:00Z');
const priceSeries = {
  dates: ['2026-09-28', '2026-09-29'],
  highs: [10000, 12400],
  closes: [10000, 12000],
  lows: [9800, 11800],
};

function makePosition(overrides = {}) {
  return {
    code: '000001', name: '테스트종목', entryDate: '2026-09-20', entryPrice: 10000,
    quantity: 10, investedWon: 100000, highSinceEntry: 10000, stopPrice: 9200,
    stopLossPct: 0.08, partialSold: false, profitOrderApplicable: true,
    stopOrderNo: '1001', stopOrderOrgNo: 'org',
    ...overrides,
  };
}

function makeHarness(overrides = {}) {
  const calls = [];
  const overriddenDeps = typeof overrides.deps === 'function' ? overrides.deps(calls) : overrides.deps;
  const deps = {
    checkOrderFill: async (params) => { calls.push(['fill', params.odno]); return null; },
    reviseKrOrder: async (params) => { calls.push(['revise', params]); return { orderNo: 'revised' }; },
    placeKrOrder: async (params) => {
      calls.push(['place', params]);
      return params.marketOrder ? { orderNo: 'market-1', orgNo: 'market-org' } : { orderNo: 'stop-1', orgNo: 'stop-org' };
    },
    patchFrontmatterFileSafely: async (filepath, patch) => { calls.push(['patch', filepath, patch]); return true; },
    loadPriceSeries: () => priceSeries,
    recordLedgerFileIfNew: (record) => { calls.push(['ledger', record]); return true; },
    buildExecutionRecord: (execution) => ({ type: 'execution', execution }),
    buildProfitRecord: (execution, entryPrice, realizedProfit) => ({ type: 'profit', execution, entryPrice, realizedProfit }),
    ...overriddenDeps,
  };
  const ctx = {
    token: 'token', appkey: 'appkey', appsecret: 'appsecret', cano: 'cano', acntPrdtCd: 'product',
    dryRun: false, gatesAllowOrder: () => true, isKillSwitchHalted: () => false,
    ...overrides.ctx,
  };
  return { calls, deps, ctx };
}

async function runPosition({ position = makePosition(), holding = { code: '000001', qty: 10 }, cancelableOrders = [], harness = makeHarness() } = {}) {
  const result = await processPosition({
    filepath: '/not-a-real-position-file.md', position, holding, cancelableOrders, now, deps: harness.deps, ctx: harness.ctx,
  });
  return { ...harness, position, result };
}

test('processPosition: pending 부분익절 confirm 뒤 원장 기록 후 손절을 재등록한다', async () => {
  const harness = makeHarness({
    deps: (calls) => ({ checkOrderFill: async (params) => {
      calls.push(['fill', params.odno]);
      return { fullyFilled: true, filledQty: 5, avgFillPrice: 12400, remainingQty: 0, orderNo: 'market-1' };
    } }),
  });
  const { calls, result } = await runPosition({
    position: makePosition({ quantity: 5, investedWon: 50000, partialSold: true, partialExitPendingOrderNo: 'market-1', partialExitPendingOrgNo: 'market-org', partialExitPendingQty: 5 }),
    holding: { code: '000001', qty: 5 }, harness,
  });
  assert.equal(result.urgent, false);
  assert.deepEqual(calls.map(([kind]) => kind), ['fill', 'ledger', 'ledger', 'patch', 'place', 'patch']);
  assert.equal(calls[4][1].marketOrder, undefined);
});

test('processPosition: pending 부분익절 review도 긴급 표시 후 손절 재등록까지 진행한다', async () => {
  const { calls, result } = await runPosition({
    position: makePosition({ quantity: 5, investedWon: 50000, partialSold: true, partialExitPendingOrderNo: 'market-1', partialExitPendingQty: 5 }),
    holding: { code: '000001', qty: 5 },
  });
  assert.equal(result.urgent, true);
  assert.deepEqual(calls.map(([kind]) => kind), ['fill', 'place', 'patch']);
});

test('processPosition: 3R 최초 도달과 손절 부재면 시장가 매도 뒤 손절을 등록하고 pending을 기록한다', async () => {
  const { calls } = await runPosition();
  assert.deepEqual(calls.filter(([kind]) => kind === 'place').map(([, params]) => params.marketOrder === true ? 'market' : 'stop'), ['market', 'stop']);
  const patch = calls.find(([kind]) => kind === 'patch')[2];
  assert.equal(patch.quantity, 5);
  assert.equal(patch.partialSold, true);
  assert.equal(patch.partialExitPendingOrderNo, 'market-1');
});

test('processPosition: 닫힌 주문 게이트에서는 주문 없이 긴급 보고한다', async () => {
  const harness = makeHarness({ ctx: { gatesAllowOrder: () => false } });
  const { calls, result } = await runPosition({ harness });
  assert.equal(result.urgent, true);
  assert.match(result.reports.join('\n'), /체결모드 섀도우 — 주문 안 냄/);
  assert.equal(calls.some(([kind]) => kind === 'place' || kind === 'revise'), false);
});

test('processPosition: 닫힌 게이트에서 킬스위치와 섀도우 보고를 구분한다', async () => {
  const halted = await runPosition({ harness: makeHarness({
    ctx: { gatesAllowOrder: () => false, isKillSwitchHalted: () => true },
  }) });
  const shadow = await runPosition({ harness: makeHarness({
    ctx: { gatesAllowOrder: () => false, isKillSwitchHalted: () => false },
  }) });
  assert.equal(halted.result.urgent, true);
  assert.equal(shadow.result.urgent, true);
  assert.deepEqual(halted.result.reports, ['테스트종목: 킬스위치 활성 — 주문 안 냄(오늘 무보호 상태로 남음)']);
  assert.deepEqual(shadow.result.reports, ['테스트종목: 체결모드 섀도우 — 주문 안 냄(오늘 무보호 상태로 남음)']);
  assert.equal(halted.calls.some(([kind]) => kind === 'place' || kind === 'revise'), false);
  assert.equal(shadow.calls.some(([kind]) => kind === 'place' || kind === 'revise'), false);
});

test('processPosition: pending 매도 abandon 후 10주로 원복하고 같은 실행에서 재주문한다', async () => {
  const harness = makeHarness({ deps: (calls) => ({ checkOrderFill: async (params) => {
    calls.push(['fill', params.odno]);
    return { canceled: true, filledQty: 0, remainingQty: 5, orderNo: 'market-1' };
  } }) });
  const { calls, result } = await runPosition({
    position: makePosition({ quantity: 5, investedWon: 50000, partialSold: true, partialExitPendingOrderNo: 'market-1', partialExitPendingOrgNo: 'market-org', partialExitPendingQty: 5 }),
    holding: { code: '000001', qty: 10 }, harness,
  });
  assert.deepEqual(calls.map(([kind]) => kind), ['fill', 'patch', 'place', 'place', 'patch']);
  assert.deepEqual(calls[1][2], {
    quantity: 10, investedWon: 100000, partialSold: false, protectionStatus: 'failed',
    partialExitPendingOrderNo: null, partialExitPendingOrgNo: null, partialExitPendingQty: null,
    updatedAt: now.toISOString(),
  });
  assert.equal(calls[2][1].quantity, 5);
  assert.equal(calls[2][1].marketOrder, true);
  assert.equal(calls[3][1].quantity, 5);
  assert.equal(calls[3][1].marketOrder, undefined);
  assert.equal(result.urgent, true);
  assert.equal(result.reports.length, 2);
  assert.match(result.reports[0], /미체결 5주 수량 원복\(완료→10주\)/);
  assert.match(result.reports[1], /3R 부분익절 완료\(5주 매도/);
});

test('processPosition: pending 매도 partialFill 후 체결 2주를 기록하고 8주 손절을 등록한다', async () => {
  const harness = makeHarness({ deps: (calls) => ({ checkOrderFill: async (params) => {
    calls.push(['fill', params.odno]);
    return { canceled: true, filledQty: 2, avgFillPrice: 12400, remainingQty: 3, orderNo: 'market-1' };
  } }) });
  const { calls, result } = await runPosition({
    position: makePosition({ quantity: 5, investedWon: 50000, partialSold: true, partialExitPendingOrderNo: 'market-1', partialExitPendingOrgNo: 'market-org', partialExitPendingQty: 5 }),
    holding: { code: '000001', qty: 8 }, harness,
  });
  assert.deepEqual(calls.map(([kind]) => kind), ['fill', 'ledger', 'ledger', 'patch', 'place', 'patch']);
  assert.deepEqual(calls.slice(1, 3).map(([, record]) => record.type), ['execution', 'profit']);
  assert.equal(calls[3][2].quantity, 8);
  assert.equal(calls[3][2].investedWon, 80000);
  assert.equal(calls[3][2].partialSold, true);
  assert.equal(calls[3][2].protectionStatus, 'failed');
  assert.equal(calls[4][1].quantity, 8);
  assert.equal(calls[4][1].marketOrder, undefined);
  assert.equal(result.urgent, true);
  assert.equal(result.reports.length, 2);
  assert.doesNotMatch(result.reports[0], /undefined/);
  assert.match(result.reports[0], /2\/5주만 체결/);
  assert.match(result.reports[0], /체결된 2주는 원장 기록 완료, 미체결 3주 수량 원복\(완료→8주\)/);
  assert.match(result.reports[1], /새 손절 등록 완료/);
});

test('processPosition: 시세 캐시가 14일 넘게 오래되면 모든 후속 작업을 중단한다', async () => {
  const harness = makeHarness({ deps: (calls) => ({ loadPriceSeries: () => {
    calls.push(['load']);
    return { ...priceSeries, dates: ['2026-09-14'] };
  } }) });
  const { calls, result } = await runPosition({ harness });
  assert.deepEqual(calls.map(([kind]) => kind), ['load']);
  assert.equal(result.urgent, true);
  assert.equal(result.reports.length, 1);
  assert.match(result.reports[0], /확정 시세 캐시가 너무 오래됨/);
});

test('processPosition: 기록과 KIS 보유수량이 다르면 review로 중단한다', async () => {
  const { calls, result } = await runPosition({ holding: { code: '000001', qty: 9 } });
  assert.deepEqual(calls, []);
  assert.equal(result.urgent, true);
  assert.deepEqual(result.reports, ['테스트종목: 보유수량 불일치(기록 10, KIS 9) — 확인 필요']);
});

test('processPosition: 시장가 매도 접수 후 손절 등록 실패를 pending과 failed로 기록한다', async () => {
  const harness = makeHarness({ deps: (calls) => ({ placeKrOrder: async (params) => {
    calls.push(['place', params]);
    if (!params.marketOrder) throw new Error('손절 등록 실패');
    return { orderNo: 'market-1', orgNo: 'market-org' };
  } }) });
  const { calls, result } = await runPosition({ harness });
  assert.deepEqual(calls.map(([kind]) => kind), ['place', 'place', 'patch']);
  assert.equal(calls[1][1].marketOrder, undefined);
  assert.equal(calls[2][2].quantity, 5);
  assert.equal(calls[2][2].partialSold, true);
  assert.equal(calls[2][2].protectionStatus, 'failed');
  assert.equal(calls[2][2].partialExitPendingOrderNo, 'market-1');
  assert.equal(calls[2][2].partialExitPendingOrgNo, 'market-org');
  assert.equal(calls[2][2].partialExitPendingQty, 5);
  assert.equal(result.urgent, true);
  assert.equal(result.reports.length, 1);
  assert.match(result.reports[0], /5주 매도는 확정됐으나 잔여 5주 신규 손절 실패/);
});

test('processPosition: 필수 배선 오류는 어떤 스텁도 실행하기 전에 reject한다', async () => {
  for (const [breakWiring, expected] of [
    [(harness) => { delete harness.deps.patchFrontmatterFileSafely; }, /deps\.patchFrontmatterFileSafely/],
    [(harness) => { delete harness.ctx.isKillSwitchHalted; }, /ctx\.isKillSwitchHalted/],
    [(harness) => { harness.ctx.dryRun = 'false'; }, /ctx\.dryRun/],
  ]) {
    const harness = makeHarness({ deps: (calls) => ({ loadPriceSeries: () => {
      calls.push(['load']);
      return priceSeries;
    } }) });
    breakWiring(harness);
    await assert.rejects(runPosition({ harness }), expected);
    assert.deepEqual(harness.calls, []);
  }
});

test('processPosition: dry-run은 주문·파일·원장을 건드리지 않고 미리보기만 보고한다', async () => {
  const harness = makeHarness({ ctx: { dryRun: true } });
  const { calls, result } = await runPosition({ harness });
  assert.equal(calls.some(([kind]) => ['place', 'revise', 'patch', 'ledger'].includes(kind)), false);
  assert.match(result.reports.join('\n'), /드라이런/);
});

test('processPosition: 전량 손절 체결만 원장·청산 patch를 남기고 미확인은 긴급으로 보류한다', async () => {
  const confirmedHarness = makeHarness({
    deps: (calls) => ({ checkOrderFill: async () => {
      calls.push(['fill', '1001']);
      return { fullyFilled: true, filledQty: 10, avgFillPrice: 9200, orderNo: '1001' };
    } }),
  });
  const confirmed = await runPosition({ holding: null, harness: confirmedHarness });
  assert.deepEqual(confirmed.calls.map(([kind]) => kind), ['fill', 'ledger', 'ledger', 'patch']);
  assert.equal(confirmed.calls[3][2].status, '청산');

  const unresolved = await runPosition({ holding: null });
  assert.equal(unresolved.result.urgent, true);
  assert.equal(unresolved.calls.some(([kind]) => kind === 'ledger' || kind === 'patch'), false);
});
