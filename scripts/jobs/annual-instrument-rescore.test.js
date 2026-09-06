import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getYearLabel, shouldRunThisYear, evaluateRescoreCandidate, buildRescorePrompt } from './annual-instrument-rescore.mjs';

test('getYearLabel: YYYY 문자열', () => {
  assert.equal(getYearLabel(new Date(2027, 0, 2)), '2027');
});

test('shouldRunThisYear: 1월 1~3일 평일이고 올해 미실행이면 true', () => {
  // 2027-01-04는 월요일(평일)이 아니라 실제 1~3일 범위 안의 평일을 고른다 — 2026-01-01은 목요일.
  assert.equal(shouldRunThisYear(new Date(2026, 0, 1), '2025'), true);
});

test('shouldRunThisYear: 1월 4일 이후면 false', () => {
  assert.equal(shouldRunThisYear(new Date(2026, 0, 4), '2025'), false);
});

test('shouldRunThisYear: 1월이 아니면 false', () => {
  assert.equal(shouldRunThisYear(new Date(2026, 3, 2), '2025'), false);
});

test('shouldRunThisYear: 주말이면 false', () => {
  // 2028-01-01은 토요일
  assert.equal(shouldRunThisYear(new Date(2028, 0, 1), '2027'), false);
});

test('shouldRunThisYear: 올해 이미 실행됐으면 false', () => {
  assert.equal(shouldRunThisYear(new Date(2026, 0, 1), '2026'), false);
});

function score(name, composite, axes = {}, dataGaps = []) {
  return { name, composite, axes, dataGaps };
}

test('evaluateRescoreCandidate: 격차가 임계값 이상이면 재검토 필요', () => {
  const held = score('A', 50);
  const ranked = [score('B', 65), score('A', 50)];
  const r = evaluateRescoreCandidate(held, ranked, 10);
  assert.equal(r.needsReview, true);
  assert.equal(r.scoreDelta, 15);
  assert.equal(r.bestAlternative.name, 'B');
});

test('evaluateRescoreCandidate: 격차가 임계값 미만이면 재검토 불필요', () => {
  const held = score('A', 50);
  const ranked = [score('B', 55), score('A', 50)];
  const r = evaluateRescoreCandidate(held, ranked, 10);
  assert.equal(r.needsReview, false);
  assert.equal(r.scoreDelta, 5);
});

test('evaluateRescoreCandidate: 보유 종목이 스코어링 불가(composite null)면 비교 자체를 안 함', () => {
  const held = score('A', null);
  const ranked = [score('B', 90)];
  const r = evaluateRescoreCandidate(held, ranked, 10);
  assert.equal(r.needsReview, false);
  assert.match(r.reason, /데이터 부족/);
});

test('evaluateRescoreCandidate: 순위 목록에 자기 자신만 있으면(대안 없음) 재검토 불필요', () => {
  const held = score('A', 50);
  const ranked = [score('A', 50)];
  const r = evaluateRescoreCandidate(held, ranked, 10);
  assert.equal(r.needsReview, false);
  assert.match(r.reason, /대안 없음/);
});

test('evaluateRescoreCandidate: 순위 목록의 최상위가 자기 자신이면 그 다음 대안과 비교', () => {
  const held = score('A', 50);
  const ranked = [score('A', 90), score('B', 65)]; // A가 1위지만 그건 held 본인 — B와 비교해야 함
  const r = evaluateRescoreCandidate(held, ranked, 10);
  assert.equal(r.bestAlternative.name, 'B');
  assert.equal(r.scoreDelta, 15);
});

test('evaluateRescoreCandidate: 대안 후보 중 composite null인 항목은 건너뛰고 다음 유효 후보와 비교', () => {
  const held = score('A', 50);
  const ranked = [score('B', null), score('C', 70)];
  const r = evaluateRescoreCandidate(held, ranked, 10);
  assert.equal(r.bestAlternative.name, 'C');
});

test('evaluateRescoreCandidate: 보유·대안의 데이터 부족축 구성이 다르면 공정비교 불가로 재검토 안 함(2026-09-06 코드리뷰 지적 — 다른 축 개수로 계산된 점수를 직접 빼면 안 됨)', () => {
  const held = score('A', 50, {}, ['expenseRatio']); // 보유는 보수율 데이터 없음(3축 점수)
  const ranked = [score('B', 90, {}, [])]; // 대안은 4축 전부 있음
  const r = evaluateRescoreCandidate(held, ranked, 10);
  assert.equal(r.needsReview, false);
  assert.match(r.reason, /축 구성 불일치/);
});

test('evaluateRescoreCandidate: 데이터 부족축 구성이 같으면(둘 다 완전하거나 둘 다 같은 축 결측) 정상 비교', () => {
  const held = score('A', 50, {}, ['trackingError']);
  const ranked = [score('B', 90, {}, ['trackingError'])]; // 같은 축이 둘 다 결측 — 공정 비교 가능
  const r = evaluateRescoreCandidate(held, ranked, 10);
  assert.equal(r.needsReview, true);
  assert.equal(r.scoreDelta, 40);
});

test('buildRescorePrompt: 위탁 계좌는 세금·회전비용 고려 문구, 연금저축은 계좌 내 교체 문구', () => {
  const heldScore = score('A', 50, { expenseRatio: 40 }, ['trackingError']);
  const bestAlternative = score('B', 65, { expenseRatio: 90 });
  const wtPrompt = buildRescorePrompt({ account: '위탁', assetClass: '국내주식', heldScore, bestAlternative, scoreDelta: 15 });
  assert.match(wtPrompt, /양도소득세/);
  const pensionPrompt = buildRescorePrompt({ account: '연금저축', assetClass: '국내주식', heldScore, bestAlternative, scoreDelta: 15 });
  assert.match(pensionPrompt, /계좌 내 교체/);
  assert.doesNotMatch(pensionPrompt, /양도소득세/);
});

test('buildRescorePrompt: 데이터 부족축·점수·JSON 출력 계약이 전부 포함', () => {
  const heldScore = score('A', 50, { expenseRatio: 40 }, ['trackingError']);
  const bestAlternative = score('B', 65, { expenseRatio: 90 });
  const prompt = buildRescorePrompt({ account: '위탁', assetClass: '국내주식', heldScore, bestAlternative, scoreDelta: 15 });
  assert.match(prompt, /데이터 부족축: trackingError/);
  assert.match(prompt, /15\.0점/);
  assert.match(prompt, /"verdict":"유지 또는 교체"/);
});
