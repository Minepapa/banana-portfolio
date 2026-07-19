import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pendingPreferences } from './preferencesPending.js';

// PreferenceTab.jsx·TodayTab.jsx에 중복돼 있던 '관찰'|'승격후보' 필터를 공유 유틸로 추출.

test('pendingPreferences: 관찰·승격후보만 포함', () => {
  const list = [
    { status: '관찰' }, { status: '승격후보' }, { status: '확정' }, { status: '기각' },
  ];
  const result = pendingPreferences(list);
  assert.equal(result.length, 2);
  assert.deepEqual(result.map(p => p.status).sort(), ['관찰', '승격후보']);
});

test('pendingPreferences: null/undefined는 빈 배열', () => {
  assert.deepEqual(pendingPreferences(null), []);
  assert.deepEqual(pendingPreferences(undefined), []);
});

test('pendingPreferences: 빈 배열은 빈 배열', () => {
  assert.deepEqual(pendingPreferences([]), []);
});
