import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeAccountAllocationSnapshot } from './allocation-snapshot.mjs';

test('computeAccountAllocationSnapshot: 위탁 계좌는 5개 목표자산군 반환(2026-08-23 배당주·리츠 삭제, 달러 10% 승격)', () => {
  const holdings = [
    { account: '위탁', assetClass: '국내주식', evalAmount: 3000 },
    { account: '위탁', assetClass: '채권', evalAmount: 2000 },
  ];
  const rows = computeAccountAllocationSnapshot(holdings, '위탁');
  assert.equal(rows.length, 5);
  const stock = rows.find((r) => r.assetName === '국내주식');
  assert.equal(stock.targetPct, 30);
  assert.equal(stock.currentPct, 60); // 3000/(3000+2000)*100
  const usd = rows.find((r) => r.assetName === '달러');
  assert.equal(usd.targetPct, 10); // 더 이상 화면표시 전용 0%가 아니라 정식 목표군
  assert.equal(usd.currentPct, 0);
});

test('computeAccountAllocationSnapshot: 위탁·연금저축·금현물은 서로 다른 계좌가 아니라 같은 합산 풀(2026-08-21 오너 확정)', () => {
  const holdings = [
    { account: '위탁', assetClass: '국내주식', evalAmount: 3000 },
    { account: '연금저축', assetClass: '채권', evalAmount: 2000 },
  ];
  const wtRows = computeAccountAllocationSnapshot(holdings, '위탁');
  const pensionRows = computeAccountAllocationSnapshot(holdings, '연금저축');
  const goldRows = computeAccountAllocationSnapshot(holdings, '금현물');
  assert.deepEqual(wtRows, pensionRows); // 어느 탭에서 봐도 같은 풀, 같은 숫자
  assert.deepEqual(wtRows, goldRows); // 금현물 탭도 CMA처럼 별도 블록이지만 풀 숫자는 동일
  assert.equal(wtRows.find((r) => r.assetName === '국내주식').currentPct, 60);
});

test('computeAccountAllocationSnapshot: 금현물 계좌 보유는 위탁·연금저축 풀에 합산됨(금99.99K 대시보드 미표시 버그 수정)', () => {
  const holdings = [
    { account: '금현물', assetClass: '금', evalAmount: 5443740 },
    { account: '연금저축', assetClass: '금', evalAmount: 5806515 },
    { account: '위탁', assetClass: '국내주식', evalAmount: 168696863 },
  ];
  const rows = computeAccountAllocationSnapshot(holdings, '위탁');
  const gold = rows.find((r) => r.assetName === '금');
  assert.equal(gold.currentPct, 6.3); // round1 반올림 — rebalance-gap.mjs의 6.25%와 근사(달러 보유가 없어 이 픽스처에선 완전히 일치)
});

test('computeAccountAllocationSnapshot: "금현물" 조회 키로도 금현물 자신의 보유가 풀에 반영됨(update-allocation-from-holdings.mjs 실제 호출 경로)', () => {
  // update-allocation-from-holdings.mjs가 실제로 하는 호출: computeAccountAllocationSnapshot(holdings, '금현물').
  // 위 테스트는 '위탁'으로만 조회했지 '금현물'으로 조회한 적이 없었다(코드리뷰 지적) — 이 테스트가 그 실제 경로를 짚는다.
  const holdings = [
    { account: '금현물', assetClass: '금', evalAmount: 5443740 },
    { account: '위탁', assetClass: '국내주식', evalAmount: 168696863 },
  ];
  const rows = computeAccountAllocationSnapshot(holdings, '금현물');
  assert.equal(rows.find((r) => r.assetName === '금').currentPct, 3.1); // 5443740/(5443740+168696863)*100
});

test('computeAccountAllocationSnapshot: 달러 보유는 분모에 포함됨 — 2026-08-23부터 rebalance-gap.mjs와 완전히 동일한 계산(예전엔 달러가 화면표시 전용이라 소폭 달랐음)', () => {
  const holdings = [
    { account: '위탁', assetClass: '국내주식', evalAmount: 9000 },
    { account: '위탁', assetClass: '달러', evalAmount: 1000 },
  ];
  const rows = computeAccountAllocationSnapshot(holdings, '위탁');
  // 달러가 분모(10000)에 포함되므로 국내주식은 100%가 아니라 90%
  assert.equal(rows.find((r) => r.assetName === '국내주식').currentPct, 90);
  assert.equal(rows.find((r) => r.assetName === '달러').currentPct, 10);
  assert.equal(rows.find((r) => r.assetName === '달러').targetPct, 10);
});

test('computeAccountAllocationSnapshot: rebalAmt는 (목표%-현재%)*총평가액/100', () => {
  const holdings = [{ account: '위탁', assetClass: '금', evalAmount: 1000 }]; // 금만 보유, 목표 10%
  const rows = computeAccountAllocationSnapshot(holdings, '위탁');
  const gold = rows.find((r) => r.assetName === '금');
  assert.equal(gold.currentPct, 100);
  // 목표10 - 현재100 = -90 → -90/100*1000 = -900(줄여야 함)
  assert.equal(gold.rebalAmt, -900);
});

test('computeAccountAllocationSnapshot: 위탁·연금저축·금현물 어디에도 보유가 없으면 전부 0%(추정 안 함)', () => {
  const rows = computeAccountAllocationSnapshot([], '위탁');
  assert.ok(rows.every((r) => r.currentPct === 0));
});

test('computeAccountAllocationSnapshot: ISA는 배당주 단일자산, 목표 100%', () => {
  const holdings = [
    { account: 'ISA', assetClass: '배당주', evalAmount: 900 },
    { account: 'ISA', assetClass: '현금', evalAmount: 100 },
  ];
  const rows = computeAccountAllocationSnapshot(holdings, 'ISA');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].assetName, '배당주');
  assert.equal(rows[0].targetPct, 100);
  assert.equal(rows[0].currentPct, 90); // 900/1000*100 — 현금 섞였으면 정직하게 드리프트 반영
});

test('computeAccountAllocationSnapshot: IRP는 TDF 단일자산, 목표 100%', () => {
  const holdings = [{ account: 'IRP', assetClass: 'TDF', evalAmount: 500 }];
  const rows = computeAccountAllocationSnapshot(holdings, 'IRP');
  assert.equal(rows[0].assetName, 'TDF');
  assert.equal(rows[0].currentPct, 100);
});

// 2026-08-22 버그 수정(오너 지적) — CMA가 SINGLE_ASSET_ACCOUNTS에 없어서 목표비중이
// 항상 0%로 나오고 있었다. CMA도 ISA·IRP와 동일하게 단일자산(현금) 목표 100%.
test('computeAccountAllocationSnapshot: CMA는 현금 단일자산, 목표 100%(2026-08-22 이전엔 누락돼 0%로 나오던 버그)', () => {
  const holdings = [{ account: 'CMA', assetClass: '현금', evalAmount: 700 }];
  const rows = computeAccountAllocationSnapshot(holdings, 'CMA');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].assetName, '현금');
  assert.equal(rows[0].targetPct, 100);
  assert.equal(rows[0].currentPct, 100);
});

test('computeAccountAllocationSnapshot: 정말 알 수 없는 계좌(퀀트 등)는 빈 배열(추정 안 함)', () => {
  assert.deepEqual(computeAccountAllocationSnapshot([], '퀀트'), []);
});

test('computeAccountAllocationSnapshot: TARGET_ALLOCATION 밖 자산군(예: 현금)은 위탁 분모·목록에 안 들어감', () => {
  const holdings = [
    { account: '위탁', assetClass: '현금', evalAmount: 100000 },
    { account: '위탁', assetClass: '금', evalAmount: 1000 },
  ];
  const rows = computeAccountAllocationSnapshot(holdings, '위탁');
  assert.equal(rows.find((r) => r.assetName === '금').currentPct, 100); // 현금은 분모에 안 섞임
  assert.ok(!rows.some((r) => r.assetName === '현금'));
});
