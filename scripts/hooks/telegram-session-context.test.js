import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findLatestHandoffFilename, buildLastReadMarker } from './telegram-session-context.mjs';

test('findLatestHandoffFilename: 날짜 파일명 중 최신을 고름(문자열정렬=날짜정렬)', () => {
  assert.equal(findLatestHandoffFilename(['2026-08-23.md', '2026-08-29 텔레그램 세션 인수인계.md', '2026-08-25.md']),
    '2026-08-29 텔레그램 세션 인수인계.md');
});

test('findLatestHandoffFilename: 날짜형식 아닌 파일은 무시', () => {
  assert.equal(findLatestHandoffFilename(['README.md', '2026-08-23.md', 'notes.md']), '2026-08-23.md');
});

test('findLatestHandoffFilename: 같은 날짜의 새 제목을 우선한다', () => {
  assert.equal(findLatestHandoffFilename(['2026-10-08.md', '2026-10-08 텔레그램 세션 인수인계.md']),
    '2026-10-08 텔레그램 세션 인수인계.md');
});

test('findLatestHandoffFilename: 빈 목록·매칭 없으면 null', () => {
  assert.equal(findLatestHandoffFilename([]), null);
  assert.equal(findLatestHandoffFilename(['foo.md', 'bar.md']), null);
});

test('buildLastReadMarker: 파일명·읽은 시각이 frontmatter에 남음', () => {
  const content = buildLastReadMarker({ filename: '2026-08-28.md', readAt: '2026-08-29T04:00:03.000Z' });
  assert.match(content, /filename: "2026-08-28\.md"/);
  assert.match(content, /readAt: "2026-08-29T04:00:03\.000Z"/);
});

test('buildSessionContext: 입력 규칙 표는 인수인계 유무와 무관하게 들어가고 머리말은 뺀다', async () => {
  const { buildSessionContext } = await import('./telegram-session-context.mjs');
  const rules = '---\ntype: "channel-rule"\n---\n# 입력 규칙\n| 📜 | 메모 |';
  const onlyRules = buildSessionContext({ inputRules: rules });
  assert.match(onlyRules, /^\[텔레그램 입력 규칙\]/);
  assert.match(onlyRules, /\| 📜 \| 메모 \|/);
  assert.doesNotMatch(onlyRules, /channel-rule/);
  const both = buildSessionContext({ inputRules: rules, handoff: '어제 요약', handoffName: '2026-10-09.md' });
  assert.ok(both.indexOf('[텔레그램 입력 규칙]') < both.indexOf('[므네모시네 인수인계]'));
  assert.match(both, /어제 요약/);
  assert.equal(buildSessionContext({}), '');
});
