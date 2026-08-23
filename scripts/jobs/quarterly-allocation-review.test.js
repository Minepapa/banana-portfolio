import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  getQuarterLabel, shouldRunToday, buildRecentAllocationProposalsSummary, buildQuarterlyReviewPrompt,
} from './quarterly-allocation-review.mjs';

test('getQuarterLabel: 월별로 올바른 분기 라벨', () => {
  assert.equal(getQuarterLabel(new Date('2026-01-15')), '2026-Q1');
  assert.equal(getQuarterLabel(new Date('2026-03-31')), '2026-Q1');
  assert.equal(getQuarterLabel(new Date('2026-04-01')), '2026-Q2');
  assert.equal(getQuarterLabel(new Date('2026-07-02')), '2026-Q3');
  assert.equal(getQuarterLabel(new Date('2026-10-03')), '2026-Q4');
  assert.equal(getQuarterLabel(new Date('2026-12-31')), '2026-Q4');
});

test('shouldRunToday: 분기시작월 1일(평일)이고 이번 분기 미실행이면 true', () => {
  // 2026-04-01은 수요일
  assert.equal(shouldRunToday(new Date('2026-04-01T09:00:00'), null), true);
});

test('shouldRunToday: 이번 분기 이미 실행됐으면 false', () => {
  assert.equal(shouldRunToday(new Date('2026-04-01T09:00:00'), '2026-Q2'), false);
});

test('shouldRunToday: 분기시작월이 아니면 false', () => {
  assert.equal(shouldRunToday(new Date('2026-05-01T09:00:00'), null), false);
});

test('shouldRunToday: 4일 이후면 false(1~3일만 대상)', () => {
  assert.equal(shouldRunToday(new Date('2026-04-04T09:00:00'), null), false);
});

test('shouldRunToday: 주말이면 false(다음 평일로 자연히 넘어감)', () => {
  // 2026-08-23 기준 다음 분기시작월(10월) 1일은 목요일이라 주말 케이스를 직접
  // 만들기 위해 1월 1일이 일요일인 해를 고른다(2027-01-01은 금요일이라 다른 예시 사용)
  // — 2023-01-01은 일요일(검증된 실제 달력)이므로 shouldRunToday 로직 자체(요일 계산)만
  // 테스트, 실제 연도는 무관.
  const sunday = new Date('2023-01-01T09:00:00'); // 실제 일요일
  assert.equal(sunday.getDay(), 0);
  assert.equal(shouldRunToday(sunday, null), false);
});

test('buildRecentAllocationProposalsSummary: 자산분배 트랙만, 퀀트는 제외', () => {
  const now = new Date('2026-08-23T00:00:00.000Z');
  const proposals = [
    { track: '자산분배', side: '매수', assetKey: 'A', status: '승인', createdAt: '2026-08-01T00:00:00.000Z' },
    { track: '퀀트', side: '매수', assetKey: 'B', status: '승인', createdAt: '2026-08-01T00:00:00.000Z' },
  ];
  const text = buildRecentAllocationProposalsSummary(proposals, now);
  assert.match(text, /A/);
  assert.doesNotMatch(text, /B/);
});

test('buildRecentAllocationProposalsSummary: 1분기(95일) 이전 것은 제외', () => {
  const now = new Date('2026-08-23T00:00:00.000Z');
  const proposals = [
    { track: '자산분배', side: '매수', assetKey: 'OLD', status: '승인', createdAt: '2026-01-01T00:00:00.000Z' },
  ];
  const text = buildRecentAllocationProposalsSummary(proposals, now);
  assert.equal(text, '(최근 1분기 생성된 자산분배 트랙 제안 없음)');
});

test('buildQuarterlyReviewPrompt: 목표비중·제안이력·거시지표가 전부 포함되고 재조회 금지 문구가 있다', () => {
  const prompt = buildQuarterlyReviewPrompt({
    targetAllocation: { 채권: 20, 금: 10, 달러: 10, 국내주식: 30, 해외주식: 30 },
    recentProposalsText: '(없음)',
    macro: '  VIX: 15.13',
  });
  assert.match(prompt, /채권: 20%/);
  assert.match(prompt, /달러: 10%/);
  assert.match(prompt, /VIX: 15\.13/);
  assert.match(prompt, /재조회·추정 금지/);
  assert.match(prompt, /아테나/);
});
