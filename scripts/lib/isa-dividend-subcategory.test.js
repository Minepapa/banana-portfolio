import assert from 'node:assert/strict';
import test from 'node:test';
import { computeIsaSubcategorySnapshot } from './isa-dividend-subcategory.mjs';

test('ISA 배당주 매핑이 각 카테고리의 평가액을 집계한다', () => {
  const holdings = [
    { account: 'ISA', assetClass: '배당주', name: 'TIME Korea플러스배당액티브', evalAmount: 400 },
    { account: 'ISA', assetClass: '배당주', name: 'TIGER 미국배당다우존스', evalAmount: 250 },
    { account: 'ISA', assetClass: '배당주', name: 'TIGER 리츠부동산인프라', evalAmount: 200 },
    { account: 'ISA', assetClass: '배당주', name: 'ACE 미국하이일드액티브(H)', evalAmount: 150 },
    { account: 'ISA', assetClass: '배당주', name: 'PLUS 고배당주', evalAmount: 100 },
    { account: 'ISA', assetClass: '배당주', name: 'TIGER 미국배당다우존스타겟데일리커버드콜', evalAmount: 100 },
  ];
  const rows = computeIsaSubcategorySnapshot(holdings);
  assert.deepEqual(rows.map((row) => row.currentPct), [41.7, 29.2, 16.7, 12.5, 0]);
});

test('알 수 없는 ISA 배당주는 평가액을 미분류 행에 집계한다', () => {
  const rows = computeIsaSubcategorySnapshot([
    { account: 'ISA', assetClass: '배당주', name: '새 배당 ETF', evalAmount: 125 },
    { account: '위탁', assetClass: '배당주', name: 'PLUS 고배당주', evalAmount: 900 },
  ]);
  assert.equal(rows.length, 6);
  assert.deepEqual(rows[5], { assetName: '미분류', targetPct: 0, currentPct: 100, rebalAmt: -125 });
});

test('미분류 보유액이 없으면 미분류 행을 만들지 않는다', () => {
  const rows = computeIsaSubcategorySnapshot([
    { account: 'ISA', assetClass: '배당주', name: 'TIME Korea플러스배당액티브', evalAmount: 100 },
  ]);
  assert.equal(rows.length, 5);
});

test('ISA 보유가 없으면 5개 행의 비중과 금액이 유한한 0이다', () => {
  const rows = computeIsaSubcategorySnapshot([]);
  assert.equal(rows.length, 5);
  assert.ok(rows.every((row) => row.currentPct === 0 && Number.isFinite(row.currentPct)));
});

test('ISA 현금은 분모에 들어가고 서브카테고리 분자에는 들어가지 않는다', () => {
  const rows = computeIsaSubcategorySnapshot([
    { account: 'ISA', assetClass: '배당주', name: 'TIME Korea플러스배당액티브', evalAmount: 250 },
    { account: 'ISA', assetClass: '현금', name: '예수금', evalAmount: 750 },
  ]);
  assert.equal(rows[0].currentPct, 25);
  assert.equal(rows.slice(1).reduce((sum, row) => sum + row.currentPct, 0), 0);
});
