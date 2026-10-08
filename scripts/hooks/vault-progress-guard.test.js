import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, relative } from 'node:path';
import { shouldCheck, shouldCheckStatus, checkProgressField, checkStatusField, CANONICAL_PROGRESS_VALUES, CANONICAL_STATUS_VALUES } from './vault-progress-guard.mjs';

test('Pantheon 세션의 상대경로는 세션 cwd를 기준으로 Vault 범위에 들어간다', () => {
  const pantheonRoot = '/Users/test/Pantheon';
  const vaultRoot = join(pantheonRoot, 'Mouseion');
  const filePath = join(pantheonRoot, 'Mouseion/40_Projects/banana-portfolio/Implementation/x.md');
  assert.equal(shouldCheck(relative(vaultRoot, filePath)), true);
});

test('shouldCheck: 40_Projects/banana-portfolio/Implementation/*.md만 대상 — 다른 Log 폴더·다른 확장자는 제외', () => {
  assert.equal(shouldCheck('40_Projects/banana-portfolio/Implementation/2026-09-14-예시.md'), true);
  assert.equal(shouldCheck('40_Projects/banana-portfolio/Requests/2026-09-14-예시.md'), false);
  assert.equal(shouldCheck('60_Logs/Zeus/2026/2026-09-14-예시.md'), false);
  assert.equal(shouldCheck('40_Projects/banana-portfolio/Implementation/2026-09-14-예시.txt'), false);
  assert.equal(shouldCheck(''), false);
  assert.equal(shouldCheck(null), false);
});

test('shouldCheck: 백슬래시 경로(Windows류)도 슬래시로 정규화해 판정', () => {
  assert.equal(shouldCheck('40_Projects\\banana-portfolio\\Implementation\\2026-09-14-예시.md'), true);
});

test('shouldCheckStatus: 상태 표준 대상 경로만 검사', () => {
  assert.equal(shouldCheckStatus('40_Projects/banana-portfolio/Implementation/x.md'), true);
  assert.equal(shouldCheckStatus('40_Projects/banana-portfolio/Requests/x.md'), true);
  assert.equal(shouldCheckStatus('50_Outputs/Decisions/x.md'), true);
  assert.equal(shouldCheckStatus('95_Etna/Investing/Orders/x.md'), true);
  assert.equal(shouldCheckStatus('20_Records/21_Notes/2026/x.md'), true);
  assert.equal(shouldCheckStatus('30_Wiki/34_Topics/x.md'), true);
  assert.equal(shouldCheckStatus('90_Delphi/x.md'), true);
  assert.equal(shouldCheckStatus('60_Logs/Zeus/2026/x.md'), false);
  assert.equal(shouldCheckStatus('95_Etna/Jobs/JobHealth/x.md'), false);
});

test('checkProgressField: progress 필드가 아예 없으면 경고 문자열 반환', () => {
  const msg = checkProgressField({}, '40_Projects/banana-portfolio/Implementation/x.md');
  assert.notEqual(msg, null);
  assert.match(msg, /progress: 필드가 없습니다/);
});

test('checkProgressField: progress가 빈 문자열이어도 결측과 동일 취급', () => {
  const msg = checkProgressField({ progress: '' }, '40_Projects/banana-portfolio/Implementation/x.md');
  assert.notEqual(msg, null);
});

test('checkProgressField: 캐노니컬 값은 전부 통과(null 반환)', () => {
  for (const v of CANONICAL_PROGRESS_VALUES) {
    assert.equal(checkProgressField({ progress: v }, '40_Projects/banana-portfolio/Implementation/x.md'), null);
  }
});

test('checkProgressField: 예정과 차단됨은 유효한 progress 값으로 통과 — 상태표준 재발 방지', () => {
  assert.equal(checkProgressField({ progress: '예정' }, '40_Projects/banana-portfolio/Implementation/x.md'), null);
  assert.equal(checkProgressField({ progress: '차단됨' }, '40_Projects/banana-portfolio/Implementation/x.md'), null);
});

test('checkProgressField: 캐노니컬 값 밖의 자유서술 값은 경고 문자열 반환 — 재발 방지 핵심 케이스', () => {
  const msg = checkProgressField({ progress: '부분완료 — 미해결 1건 남음' }, '40_Projects/banana-portfolio/Implementation/x.md');
  assert.notEqual(msg, null);
  assert.match(msg, /자유서술/);
});

test('checkProgressField: "완료(코드) — launchd 배선은 보류" 같은 접미사 변형도 잡음', () => {
  const msg = checkProgressField({ progress: '완료(코드) — launchd 배선은 보류' }, '40_Projects/banana-portfolio/Implementation/x.md');
  assert.notEqual(msg, null);
});

test('checkStatusField: Implementation은 status와 progress가 같은 생명주기여야 통과', () => {
  for (const value of CANONICAL_STATUS_VALUES.lifecycle) {
    assert.equal(checkStatusField({ status: value, progress: value }, '40_Projects/banana-portfolio/Implementation/x.md'), null);
  }
  assert.match(checkStatusField({ status: '완료', progress: '진행중' }, '40_Projects/banana-portfolio/Implementation/x.md'), /status.*progress/);
});

test('checkStatusField: DevRequest와 Strategy는 각 집합 밖의 값을 경고', () => {
  assert.equal(checkStatusField({ status: '완료' }, '40_Projects/banana-portfolio/Requests/x.md'), null);
  assert.equal(checkStatusField({ status: '실행대기' }, '50_Outputs/Decisions/x.md'), null);
  assert.match(checkStatusField({ status: '완료 — 커밋됨' }, '40_Projects/banana-portfolio/Requests/x.md'), /자유서술/);
});

test('checkStatusField: 제안·성향 Decision은 도메인 집합만 허용', () => {
  assert.equal(checkStatusField({ status: '체결' }, '95_Etna/Investing/Orders/x.md'), null);
  assert.equal(checkStatusField({ status: '확정' }, '20_Records/21_Notes/2026/x.md'), null);
  assert.match(checkStatusField({ status: '완료' }, '95_Etna/Investing/Orders/x.md'), /자유서술/);
});

test('checkStatusField: Knowledge는 status가 있으면 Knowledge 집합만 허용하고 없으면 통과', () => {
  assert.equal(checkStatusField({}, '30_Wiki/34_Topics/x.md'), null);
  assert.equal(checkStatusField({ status: '활성' }, '30_Wiki/34_Topics/x.md'), null);
  assert.match(checkStatusField({ status: '완료' }, '30_Wiki/34_Topics/x.md'), /자유서술/);
});
