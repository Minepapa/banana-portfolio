import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterExecutableProposals, selectCashPool, computeOverseasCash } from './execute-asset-allocation-proposal.mjs';
import { INSTRUMENT_TYPE } from '../lib/asset-allocation-instrument-router.mjs';

test('filterExecutableProposals: quantity/proposedPrice 둘 다 있으면 통과', () => {
  const proposals = [{ id: 'a', quantity: 10, proposedPrice: 1000 }];
  assert.deepEqual(filterExecutableProposals(proposals), proposals);
});

test('filterExecutableProposals: quantity가 null이면(정성적 갭 신호) 제외', () => {
  const proposals = [{ id: 'a', quantity: null, proposedPrice: 1000 }];
  assert.deepEqual(filterExecutableProposals(proposals), []);
});

test('filterExecutableProposals: proposedPrice가 null이면 제외', () => {
  const proposals = [{ id: 'a', quantity: 10, proposedPrice: null }];
  assert.deepEqual(filterExecutableProposals(proposals), []);
});

test('filterExecutableProposals: 제외된 항목은 log 콜백으로 사유를 남긴다', () => {
  const logged = [];
  filterExecutableProposals([{ id: 'x', quantity: null, proposedPrice: null }], { log: (m) => logged.push(m) });
  assert.equal(logged.length, 1);
  assert.match(logged[0], /수량\/가격 미정/);
});

test('selectCashPool: KR_STOCK → krCash', () => {
  assert.equal(selectCashPool(INSTRUMENT_TYPE.KR_STOCK, { krCash: 1, gbCash: 2, goldCash: 3 }), 1);
});

test('selectCashPool: OVERSEAS_STOCK → gbCash', () => {
  assert.equal(selectCashPool(INSTRUMENT_TYPE.OVERSEAS_STOCK, { krCash: 1, gbCash: 2, goldCash: 3 }), 2);
});

test('selectCashPool: GOLD → goldCash', () => {
  assert.equal(selectCashPool(INSTRUMENT_TYPE.GOLD, { krCash: 1, gbCash: 2, goldCash: 3 }), 3);
});

test('selectCashPool: 알 수 없는 자산군은 throw(추측 안 함)', () => {
  assert.throws(() => selectCashPool('UNKNOWN', { krCash: 1, gbCash: 2, goldCash: 3 }));
});

test('selectCashPool: UNSUPPORTED도 throw(호출측이 이미 걸렀어야 하지만 방어)', () => {
  assert.throws(() => selectCashPool(INSTRUMENT_TYPE.UNSUPPORTED, { krCash: 1, gbCash: 2, goldCash: 3 }));
});

// ── computeOverseasCash — 2026-09-06 정정(fc_abk_amt는 매입원가였지 예수금이 아님,
// 오너 실측 스크린샷+nhplug.com 공식 문서로 확인) 회귀 방지 ──────────────────

test('computeOverseasCash: fc_dca + 수동 갱신 외화RP qty를 합산', () => {
  const holdingsIndex = new Map([['외화 rp', { qty: 6005.62 }]]);
  const r = computeOverseasCash({ gbBalanceBody: { Output_0: { fc_dca: 0 } }, holdingsIndex });
  assert.equal(r, 6005.62);
});

test('computeOverseasCash: 외화RP 보유가 아직 없으면(qty 미기록) fc_dca만', () => {
  const r = computeOverseasCash({ gbBalanceBody: { Output_0: { fc_dca: 1500 } }, holdingsIndex: new Map() });
  assert.equal(r, 1500);
});

test('computeOverseasCash: fc_abk_amt(매입원가)는 절대 안 씀 — 있어도 무시', () => {
  const holdingsIndex = new Map([['외화 rp', { qty: 0 }]]);
  const r = computeOverseasCash({
    gbBalanceBody: { Output_0: { fc_dca: 0, fc_abk_amt: 18416.2 } }, holdingsIndex,
  });
  assert.equal(r, 0);
});

test('computeOverseasCash: gbBalanceBody 자체가 없으면(조회 실패) null(0으로 추정 안 함)', () => {
  assert.equal(computeOverseasCash({ gbBalanceBody: null, holdingsIndex: new Map() }), null);
});

test('computeOverseasCash: fc_dca 파싱 실패면 null', () => {
  const r = computeOverseasCash({ gbBalanceBody: { Output_0: {} }, holdingsIndex: new Map() });
  assert.equal(r, null);
});

test('computeOverseasCash: fc_dca가 콤마 포함 문자열이어도 정상 파싱', () => {
  const holdingsIndex = new Map([['외화 rp', { qty: 100 }]]);
  const r = computeOverseasCash({ gbBalanceBody: { Output_0: { fc_dca: '1,500' } }, holdingsIndex });
  assert.equal(r, 1600);
});
