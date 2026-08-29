import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findOrphanedAllocationFiles } from './update-allocation-from-holdings.mjs';

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
