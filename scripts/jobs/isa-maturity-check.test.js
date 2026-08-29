import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeMaturityDate, hasReachedMaturity, shouldSend, buildIsaMaturityPrompt } from './isa-maturity-check.mjs';

const kstDateStr = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(d);

test('computeMaturityDate: 개설일 + 3년', () => {
  const d = computeMaturityDate('2025-04-06');
  assert.equal(kstDateStr(d), '2028-04-06');
});

test('computeMaturityDate: 윤년 2/29 개설도 예외 없이 처리(JS Date가 3/1로 자연 이월)', () => {
  const d = computeMaturityDate('2024-02-29');
  // 2027년은 평년이라 2/29가 없음 — Date가 3/1로 자연히 넘김
  assert.equal(kstDateStr(d), '2027-03-01');
});

test('hasReachedMaturity: 만기일 당일이면 true(당일 포함)', () => {
  const maturity = new Date('2028-04-06T00:00:00+09:00');
  assert.equal(hasReachedMaturity(new Date('2028-04-06T00:00:00+09:00'), maturity), true);
});

test('hasReachedMaturity: 만기일 이전이면 false', () => {
  const maturity = new Date('2028-04-06T00:00:00+09:00');
  assert.equal(hasReachedMaturity(new Date('2028-04-05T23:59:59+09:00'), maturity), false);
});

test('hasReachedMaturity: 만기일 이후면 true(실행 지연돼도 다음 실행에서 잡힘)', () => {
  const maturity = new Date('2028-04-06T00:00:00+09:00');
  assert.equal(hasReachedMaturity(new Date('2028-05-01T00:00:00+09:00'), maturity), true);
});

test('buildIsaMaturityPrompt: 보유내역이 프롬프트에 그대로 반영', () => {
  const isaSummary = {
    totalEval: 5_000_000,
    items: [
      { name: 'TIGER 리츠부동산인프라', assetClass: '리츠', evalAmount: 3_000_000, weightPct: 60, profitPct: 5.2 },
      { name: 'ACE 미국하이일드액티브(H)', assetClass: '채권', evalAmount: 2_000_000, weightPct: 40, profitPct: null },
    ],
  };
  const prompt = buildIsaMaturityPrompt({ isaSummary, maturityDate: new Date('2028-04-06T00:00:00+09:00') });
  assert.match(prompt, /2028-04-06/);
  assert.match(prompt, /TIGER 리츠부동산인프라/);
  assert.match(prompt, /5,000,000원/);
  assert.match(prompt, /60\.0%/);
  assert.match(prompt, /5\.2%/);
  assert.match(prompt, /ACE 미국하이일드액티브\(H\)/);
});

test('buildIsaMaturityPrompt: 보유 없으면 안내 문구', () => {
  const isaSummary = { totalEval: 0, items: [] };
  const prompt = buildIsaMaturityPrompt({ isaSummary, maturityDate: new Date('2028-04-06T00:00:00+09:00') });
  assert.match(prompt, /보유 없음/);
});

// ── shouldSend 게이트(코드리뷰 지적 — --force가 마커를 영구 오염시키는 걸 막는 핵심 로직) ──

test('shouldSend: 만기 도달 + 미발송이면 true', () => {
  const maturityDate = new Date('2028-04-06T00:00:00+09:00');
  assert.equal(shouldSend({ now: maturityDate, maturityDate, alreadyTriggered: false, force: false }), true);
});

test('shouldSend: 만기 전이면 force 없이는 false', () => {
  const maturityDate = new Date('2028-04-06T00:00:00+09:00');
  const before = new Date('2028-04-05T00:00:00+09:00');
  assert.equal(shouldSend({ now: before, maturityDate, alreadyTriggered: false, force: false }), false);
});

test('shouldSend: 이미 발송됐으면 만기 지났어도 force 없이는 false', () => {
  const maturityDate = new Date('2028-04-06T00:00:00+09:00');
  const after = new Date('2028-05-01T00:00:00+09:00');
  assert.equal(shouldSend({ now: after, maturityDate, alreadyTriggered: true, force: false }), false);
});

test('shouldSend: force면 만기 전·이미 발송됐어도 true(발송은 강제하되, 마커 기록 여부는 main()이 hasReachedMaturity로 별도 판단 — 이 함수의 책임 밖)', () => {
  const maturityDate = new Date('2028-04-06T00:00:00+09:00');
  const before = new Date('2028-04-05T00:00:00+09:00');
  assert.equal(shouldSend({ now: before, maturityDate, alreadyTriggered: true, force: true }), true);
});
