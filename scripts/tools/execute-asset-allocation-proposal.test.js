import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterExecutableProposals, selectCashPool } from './execute-asset-allocation-proposal.mjs';
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
