import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ALLOCATION_REFRESH_MS, findOrphanedAllocationFiles, hasHoldingsForAllocationSnapshot, writeAllocationIfChanged } from './update-allocation-from-holdings.mjs';
import { buildFrontmatter } from '../lib/vault-frontmatter.mjs';

test('hasHoldingsForAllocationSnapshot: 비어 있으면 snapshot 갱신을 성공 처리하지 않는다', () => {
  assert.equal(hasHoldingsForAllocationSnapshot([]), false);
  assert.equal(hasHoldingsForAllocationSnapshot(null), false);
  assert.equal(hasHoldingsForAllocationSnapshot([{ account: '위탁' }]), true);
});

test('findOrphanedAllocationFiles: 기대 목록에 없는 기존 파일만 골라냄', () => {
  const existing = ['위탁-채권.md', '위탁-배당주.md', '연금저축-리츠.md', '위탁-금.md'];
  const expected = ['위탁-채권.md', '위탁-금.md', '위탁-달러.md'];
  assert.deepEqual(findOrphanedAllocationFiles(existing, expected), ['위탁-배당주.md', '연금저축-리츠.md']);
});

test('findOrphanedAllocationFiles: 전부 유효하면 빈 배열(2026-08-23 배당주·리츠 제거 같은 사고 재발 방지)', () => {
  const existing = ['위탁-채권.md', '위탁-금.md'];
  const expected = ['위탁-채권.md', '위탁-금.md', '위탁-달러.md'];
  assert.deepEqual(findOrphanedAllocationFiles(existing, expected), []);
});

test('findOrphanedAllocationFiles: 빈 기존 목록이면 빈 배열', () => {
  assert.deepEqual(findOrphanedAllocationFiles([], ['위탁-채권.md']), []);
});

// 같은 내용이면 쓰지 않기(2026-11-03, ⑤). 가상 계좌·가상 값.
test('writeAllocationIfChanged: updatedAt만 다르면 1시간 안엔 안 쓰고, 비중·금액이 바뀌면 바로, 1시간 지나면 다시 쓴다', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'allocation-skip-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, '가상계좌-금.md');
  const t0 = Date.parse('2026-11-03T12:00:00Z');
  const record = (currentPct, at) => buildFrontmatter({ type: 'allocation', account: '가상계좌', assetName: '금',
    targetPct: 10, currentPct, rebalAmt: 0, tags: ['계좌/가상계좌'], updatedAt: new Date(at).toISOString() });
  assert.equal(writeAllocationIfChanged(file, record(9.5, t0), { now: t0 }), true);
  assert.equal(writeAllocationIfChanged(file, record(9.5, t0 + 10 * 60_000), { now: t0 + 10 * 60_000 }), false);
  assert.match(readFileSync(file, 'utf8'), new RegExp(new Date(t0).toISOString()));
  assert.equal(writeAllocationIfChanged(file, record(9.6, t0 + 20 * 60_000), { now: t0 + 20 * 60_000 }), true);
  const later = t0 + 20 * 60_000 + ALLOCATION_REFRESH_MS;
  assert.equal(writeAllocationIfChanged(file, record(9.6, later - 1), { now: later - 1 }), false);
  assert.equal(writeAllocationIfChanged(file, record(9.6, later), { now: later }), true);
});

test('ALLOCATION_REFRESH_MS: 올림푸스 배분 카드 낡음 기준(36시간)보다 충분히 짧게 — 상한 6시간', () => {
  assert.ok(ALLOCATION_REFRESH_MS > 0 && ALLOCATION_REFRESH_MS <= 6 * 60 * 60 * 1000);
});
