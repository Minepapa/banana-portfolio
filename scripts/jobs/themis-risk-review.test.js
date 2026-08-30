import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRecentProposalsSummary, buildThemisPrompt, buildThemisFacts } from './themis-risk-review.mjs';

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

// ── buildThemisFacts(2026-08-30 신설) — 오너 지적: Themis 메시지만 다른 부서와 달리
// 불릿 없이 숫자·판정이 한 문단에 뭉쳐 나가고 있었다. Node가 계산한 사실을 개조식
// 불릿으로 먼저 뽑아 formatFactsMessage(텔레그램 표준 구조)에 넘기기 위한 순수함수.

test('buildThemisFacts: 거시지표 각 줄이 개별 불릿으로 분리됨(뭉쳐진 문단 아님)', () => {
  const macro = '  VIX: 14.51 (5일 -9.37%, 출처 yfinance)\n  USDKRW: 1371.5 (5일 -0.97%, 출처 yfinance)';
  const facts = buildThemisFacts({ macro, jobsText: '', recentProposalsCount: 0 });
  assert.ok(facts.some((f) => f === 'VIX: 14.51 (5일 -9.37%, 출처 yfinance)'));
  assert.ok(facts.some((f) => f === 'USDKRW: 1371.5 (5일 -0.97%, 출처 yfinance)'));
});

test('buildThemisFacts: 잡상태 라인도 불릿에 포함', () => {
  const facts = buildThemisFacts({ macro: '', jobsText: '  health-watcher: OK (연속실패 0회)', recentProposalsCount: 3 });
  assert.ok(facts.some((f) => f.includes('health-watcher')));
});

test('buildThemisFacts: 최근 제안 건수가 마지막 불릿으로 포함', () => {
  const facts = buildThemisFacts({ macro: '', jobsText: '', recentProposalsCount: 5 });
  assert.equal(facts.at(-1), '최근 7일 생성된 제안: 5건');
});

test('buildThemisFacts: 빈 줄은 걸러짐', () => {
  const facts = buildThemisFacts({ macro: '  VIX: 15\n\n  DXY: 98', jobsText: '', recentProposalsCount: 0 });
  assert.ok(!facts.includes(''));
});
