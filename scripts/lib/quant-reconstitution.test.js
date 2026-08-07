import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeReconstitution, positionBand, BUY_RANK, SELL_RANK, EQUAL_WEIGHT_KRW } from './quant-reconstitution.mjs';

const rank = (code, r, ocfToPrice = 0.05) => ({ Code: code, Name: `종목${code}`, rank: r, ocfToPrice });
const hold = (code, qty = 10) => ({ code, name: `종목${code}`, qty });

test('positionBand: 기본값(400만원 ±50%)', () => {
  assert.deepEqual(positionBand(), { min: 2_000_000, target: 4_000_000, max: 6_000_000 });
});

test('positionBand: 커스텀 기준·비율', () => {
  assert.deepEqual(positionBand(1_000_000, 0.2), { min: 800_000, target: 1_000_000, max: 1_200_000 });
});

test('computeReconstitution: 상위 10위 이내 + 미보유 → 매수', () => {
  const ranked = [rank('A', 1), rank('B', 5), rank('C', 10)];
  const { buys, sells, holds, needsReview } = computeReconstitution(ranked, []);
  assert.deepEqual(buys.map((b) => b.code), ['A', 'B', 'C']);
  assert.equal(sells.length, 0);
  assert.equal(holds.length, 0);
  assert.equal(needsReview.length, 0);
  assert.deepEqual(buys[0].band, positionBand());
});

test('computeReconstitution: 상위 10위 이내인데 이미 보유 중이면 매수목록에 안 들어가고 유지로만 분류', () => {
  const ranked = [rank('A', 1)];
  const { buys, holds } = computeReconstitution(ranked, [hold('A')]);
  assert.equal(buys.length, 0);
  assert.deepEqual(holds.map((h) => h.code), ['A']);
});

test('computeReconstitution: 보유 중 + 20위 밖 → 매도', () => {
  const ranked = [rank('A', 25)];
  const { sells, holds } = computeReconstitution(ranked, [hold('A', 7)]);
  assert.deepEqual(sells, [{ code: 'A', name: '종목A', qty: 7, rank: 25, ocfToPrice: 0.05 }]);
  assert.equal(holds.length, 0);
});

test('computeReconstitution: 보유 중 + 11~20위(버퍼존) → 유지(매도 아님)', () => {
  const ranked = [rank('A', 20)];
  const { sells, holds } = computeReconstitution(ranked, [hold('A')]);
  assert.equal(sells.length, 0);
  assert.equal(holds.length, 1);
  assert.equal(holds[0].rank, 20);
});

test('computeReconstitution: 정확히 buyRank위(10위)면 매수 포함, sellRank위(20위)면 유지(매도 아님) — 경계값', () => {
  const ranked = [rank('BUY10', 10), rank('HOLD20', 20)];
  const { buys, holds } = computeReconstitution(ranked, [hold('HOLD20')]);
  assert.deepEqual(buys.map((b) => b.code), ['BUY10']);
  assert.deepEqual(holds.map((h) => h.code), ['HOLD20']);
});

test('computeReconstitution: 보유 중인데 랭킹 결과 자체에 없으면 확인필요(매도로 추정하지 않음)', () => {
  const ranked = [rank('A', 1)];
  const { sells, needsReview } = computeReconstitution(ranked, [hold('B', 3)]);
  assert.equal(sells.length, 0);
  assert.equal(needsReview.length, 1);
  assert.equal(needsReview[0].code, 'B');
  assert.equal(needsReview[0].qty, 3);
  assert.ok(needsReview[0].reason.includes('매도로 자동 추정하지 않음'));
});

test('computeReconstitution: 보유 없음 + 랭킹만 있으면 매도·유지·확인필요 전부 빈 배열', () => {
  const ranked = [rank('A', 1), rank('B', 30)];
  const { sells, holds, needsReview } = computeReconstitution(ranked, []);
  assert.equal(sells.length, 0);
  assert.equal(holds.length, 0);
  assert.equal(needsReview.length, 0);
});

test('computeReconstitution: 랭킹 없음 + 보유만 있으면 전부 확인필요', () => {
  const { buys, sells, holds, needsReview } = computeReconstitution([], [hold('A'), hold('B')]);
  assert.equal(buys.length, 0);
  assert.equal(sells.length, 0);
  assert.equal(holds.length, 0);
  assert.equal(needsReview.length, 2);
});

test('computeReconstitution: buyRank·sellRank 커스텀 옵션 반영', () => {
  const ranked = [rank('A', 3), rank('B', 6)];
  const { buys, sells } = computeReconstitution(ranked, [hold('B')], { buyRank: 2, sellRank: 5 });
  assert.equal(buys.length, 0); // 3위는 buyRank=2 밖
  assert.deepEqual(sells.map((s) => s.code), ['B']); // 6위는 sellRank=5 밖
});

test('상수: BUY_RANK=10, SELL_RANK=20, EQUAL_WEIGHT_KRW=400만원(설계서 확정값)', () => {
  assert.equal(BUY_RANK, 10);
  assert.equal(SELL_RANK, 20);
  assert.equal(EQUAL_WEIGHT_KRW, 4_000_000);
});
