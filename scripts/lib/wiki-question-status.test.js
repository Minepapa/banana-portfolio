import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ACTIVE_STATUSES, ALL_STATUSES, CLOSED_STATUSES } from './wiki-question-status.mjs';

test('질문 상태 정본: import가 없고(대시보드가 그대로 읽음), 진행·종결이 겹치지 않는다', () => {
  const src = readFileSync(new URL('./wiki-question-status.mjs', import.meta.url), 'utf8');
  assert.equal(/^\s*import[\s{]|^\s*export\s[^;]*\sfrom\s|\bimport\s*\(/m.test(src), false);
  for (const s of ACTIVE_STATUSES) assert.equal(CLOSED_STATUSES.has(s), false, s);
  assert.equal(ALL_STATUSES.size, ACTIVE_STATUSES.size + CLOSED_STATUSES.size);
});

test('질문 큐가 쓰는 상태는 모두 정본 목록에 있다', () => {
  const src = readFileSync(new URL('./wiki-question-queue.mjs', import.meta.url), 'utf8');
  const used = new Set();
  const literals = (text) => [...text.matchAll(/['"]([가-힣]+)['"]/g)].map((m) => m[1]);
  // 상태를 쓰는 자리(status: … 의 값 식, 비교 status ===/!== '…')와 상태를 계산하는 문장(const status = …;) 안의 한글 문자열.
  for (const m of src.matchAll(/status\s*:([^,}\n]+)/g)) for (const v of literals(m[1])) used.add(v);
  for (const m of src.matchAll(/status\s*(?:===|!==)\s*['"]([가-힣]+)['"]/g)) used.add(m[1]);
  for (const m of src.matchAll(/(?:const|let)\s+status\s*=([^;]+);/g)) for (const v of literals(m[1])) used.add(v);
  assert.ok(used.size >= 10, '상태 문자열을 찾지 못함(검사 무력화 방지)');
  for (const s of used) assert.ok(ALL_STATUSES.has(s), `정본에 없는 상태: ${s}`);
});
