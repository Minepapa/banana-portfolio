import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRecentProposalsSummary, buildThemisPrompt } from './themis-risk-review.mjs';

test('buildRecentProposalsSummary: 7일 이내 생성분만 포함, 오래된 건 제외', () => {
  const now = new Date('2026-08-23T00:00:00.000Z');
  const proposals = [
    { track: '퀀트', side: '매수', assetKey: '005930', quantity: 10, status: '승인', reason: '팩터 1위', createdAt: '2026-08-20T00:00:00.000Z' },
    { track: '자산분배', side: '매수', assetKey: 'QQQ', quantity: 2, status: '대기', reason: '', createdAt: '2026-08-01T00:00:00.000Z' },
  ];
  const text = buildRecentProposalsSummary(proposals, now);
  assert.match(text, /005930/);
  assert.doesNotMatch(text, /QQQ/);
});

test('buildRecentProposalsSummary: 최근 7일 생성분이 없으면 명시적으로 없음 표시', () => {
  const now = new Date('2026-08-23T00:00:00.000Z');
  const text = buildRecentProposalsSummary([], now);
  assert.equal(text, '(최근 7일 생성된 제안 없음)');
});

test('buildRecentProposalsSummary: 생성일 오름차순 정렬', () => {
  const now = new Date('2026-08-23T00:00:00.000Z');
  const proposals = [
    { track: '퀀트', side: '매수', assetKey: 'B', quantity: 1, status: '대기', createdAt: '2026-08-22T00:00:00.000Z' },
    { track: '퀀트', side: '매수', assetKey: 'A', quantity: 1, status: '대기', createdAt: '2026-08-21T00:00:00.000Z' },
  ];
  const text = buildRecentProposalsSummary(proposals, now);
  assert.ok(text.indexOf(' A ') < text.indexOf(' B '));
});

test('buildThemisPrompt: 주입된 사실 3종을 모두 포함하고 재조회 금지 문구가 있다', () => {
  const prompt = buildThemisPrompt({ macro: '  VIX: 15.13', jobsText: '  daily-asset-allocation-check: OK', recentProposalsText: '(없음)' });
  assert.match(prompt, /VIX: 15\.13/);
  assert.match(prompt, /daily-asset-allocation-check: OK/);
  assert.match(prompt, /재조회·추정 금지/);
  assert.match(prompt, /테미스/);
});
