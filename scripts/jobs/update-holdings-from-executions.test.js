import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickUnprocessedExecutions } from './update-holdings-from-executions.mjs';

const f = (parsed) => ({ filepath: '/x', content: '', parsed });

test('pickUnprocessedExecutions: legacy(Phase 7 마이그레이션) 제외 — 이미 스냅샷에 반영됨', () => {
  const files = [f({ legacy: true, tradeDate: '2026-01-01' }), f({ tradeDate: '2026-01-02' })];
  const r = pickUnprocessedExecutions(files);
  assert.equal(r.length, 1);
  assert.equal(r[0].parsed.tradeDate, '2026-01-02');
});

test('pickUnprocessedExecutions: holdingsApplied 이미 true인 것 제외 — 재처리 방지', () => {
  const files = [f({ holdingsApplied: true, tradeDate: '2026-01-01' }), f({ tradeDate: '2026-01-02' })];
  const r = pickUnprocessedExecutions(files);
  assert.equal(r.length, 1);
});

test('pickUnprocessedExecutions: tradeDate 오름차순 정렬(가중평균 순서가 중요)', () => {
  const files = [f({ tradeDate: '2026-03-01' }), f({ tradeDate: '2026-01-01' }), f({ tradeDate: '2026-02-01' })];
  const r = pickUnprocessedExecutions(files);
  assert.deepEqual(r.map((x) => x.parsed.tradeDate), ['2026-01-01', '2026-02-01', '2026-03-01']);
});
