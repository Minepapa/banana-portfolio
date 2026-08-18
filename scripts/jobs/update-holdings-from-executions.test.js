import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickUnprocessedExecutions, pickUnprocessedDividends } from './update-holdings-from-executions.mjs';

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

test('pickUnprocessedDividends: legacy(Phase 7 마이그레이션) 제외 — account:null로 영구 고정된 스냅샷', () => {
  const files = [f({ legacy: true, account: null, date: '2026-01-01' }), f({ account: null, date: '2026-01-02' })];
  const r = pickUnprocessedDividends(files);
  assert.equal(r.length, 1);
  assert.equal(r[0].parsed.date, '2026-01-02');
});

test('pickUnprocessedDividends: account 이미 확정된 것 제외 — 재처리 방지(holdingsApplied 대신 account 유무로 판정)', () => {
  const files = [f({ account: 'ISA', date: '2026-01-01' }), f({ account: null, date: '2026-01-02' })];
  const r = pickUnprocessedDividends(files);
  assert.equal(r.length, 1);
  assert.equal(r[0].parsed.date, '2026-01-02');
});

test('pickUnprocessedDividends: date 오름차순 정렬', () => {
  const files = [f({ account: null, date: '2026-03-01' }), f({ account: null, date: '2026-01-01' }), f({ account: null, date: '2026-02-01' })];
  const r = pickUnprocessedDividends(files);
  assert.deepEqual(r.map((x) => x.parsed.date), ['2026-01-01', '2026-02-01', '2026-03-01']);
});
