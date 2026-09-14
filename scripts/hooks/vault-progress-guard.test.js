import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldCheck, checkProgressField, CANONICAL_PROGRESS_VALUES } from './vault-progress-guard.mjs';

test('shouldCheck: Log/Implementation/*.md만 대상 — 다른 Log 폴더·다른 확장자는 제외', () => {
  assert.equal(shouldCheck('Log/Implementation/2026-09-14-예시.md'), true);
  assert.equal(shouldCheck('Log/DevRequests/2026-09-14-예시.md'), false);
  assert.equal(shouldCheck('Log/Sessions/2026-09-14-예시.md'), false);
  assert.equal(shouldCheck('Log/Implementation/2026-09-14-예시.txt'), false);
  assert.equal(shouldCheck(''), false);
  assert.equal(shouldCheck(null), false);
});

test('shouldCheck: 백슬래시 경로(Windows류)도 슬래시로 정규화해 판정', () => {
  assert.equal(shouldCheck('Log\\Implementation\\2026-09-14-예시.md'), true);
});

test('checkProgressField: progress 필드가 아예 없으면 경고 문자열 반환', () => {
  const msg = checkProgressField({}, 'Log/Implementation/x.md');
  assert.notEqual(msg, null);
  assert.match(msg, /progress: 필드가 없습니다/);
});

test('checkProgressField: progress가 빈 문자열이어도 결측과 동일 취급', () => {
  const msg = checkProgressField({ progress: '' }, 'Log/Implementation/x.md');
  assert.notEqual(msg, null);
});

test('checkProgressField: 4종 캐노니컬 값은 전부 통과(null 반환)', () => {
  for (const v of CANONICAL_PROGRESS_VALUES) {
    assert.equal(checkProgressField({ progress: v }, 'Log/Implementation/x.md'), null);
  }
});

test('checkProgressField: 4종 밖의 자유서술 값은 경고 문자열 반환 — 재발 방지 핵심 케이스', () => {
  const msg = checkProgressField({ progress: '부분완료 — 미해결 1건 남음' }, 'Log/Implementation/x.md');
  assert.notEqual(msg, null);
  assert.match(msg, /자유서술/);
});

test('checkProgressField: "완료(코드) — launchd 배선은 보류" 같은 접미사 변형도 잡음', () => {
  const msg = checkProgressField({ progress: '완료(코드) — launchd 배선은 보류' }, 'Log/Implementation/x.md');
  assert.notEqual(msg, null);
});
