import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldCheck, shouldCheckStatus, checkProgressField, checkStatusField, CANONICAL_PROGRESS_VALUES, CANONICAL_STATUS_VALUES } from './vault-progress-guard.mjs';

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

test('shouldCheckStatus: 상태 표준 대상 경로만 검사', () => {
  assert.equal(shouldCheckStatus('Log/Implementation/x.md'), true);
  assert.equal(shouldCheckStatus('Log/DevRequests/x.md'), true);
  assert.equal(shouldCheckStatus('Log/Strategy/x.md'), true);
  assert.equal(shouldCheckStatus('Decisions/Proposals/x.md'), true);
  assert.equal(shouldCheckStatus('Decisions/Profile/x.md'), true);
  assert.equal(shouldCheckStatus('Knowledge/API/x.md'), true);
  assert.equal(shouldCheckStatus('Log/Sessions/x.md'), false);
  assert.equal(shouldCheckStatus('State/JobHealth/x.md'), false);
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

test('checkStatusField: Implementation은 status와 progress가 같은 생명주기여야 통과', () => {
  for (const value of CANONICAL_STATUS_VALUES.lifecycle) {
    assert.equal(checkStatusField({ status: value, progress: value }, 'Log/Implementation/x.md'), null);
  }
  assert.match(checkStatusField({ status: '완료', progress: '진행중' }, 'Log/Implementation/x.md'), /status.*progress/);
});

test('checkStatusField: DevRequest와 Strategy는 각 집합 밖의 값을 경고', () => {
  assert.equal(checkStatusField({ status: '완료' }, 'Log/DevRequests/x.md'), null);
  assert.equal(checkStatusField({ status: '실행대기' }, 'Log/Strategy/x.md'), null);
  assert.match(checkStatusField({ status: '완료 — 커밋됨' }, 'Log/DevRequests/x.md'), /자유서술/);
});

test('checkStatusField: 제안·성향 Decision은 도메인 집합만 허용', () => {
  assert.equal(checkStatusField({ status: '체결' }, 'Decisions/Proposals/x.md'), null);
  assert.equal(checkStatusField({ status: '확정' }, 'Decisions/Profile/x.md'), null);
  assert.match(checkStatusField({ status: '완료' }, 'Decisions/Proposals/x.md'), /자유서술/);
});

test('checkStatusField: Knowledge는 status가 있으면 Knowledge 집합만 허용하고 없으면 통과', () => {
  assert.equal(checkStatusField({}, 'Knowledge/Topics/x.md'), null);
  assert.equal(checkStatusField({ status: '활성' }, 'Knowledge/API/x.md'), null);
  assert.match(checkStatusField({ status: '완료' }, 'Knowledge/API/x.md'), /자유서술/);
});
