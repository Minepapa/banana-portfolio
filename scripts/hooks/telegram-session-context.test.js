import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findLatestHandoffFilename, buildLastReadMarker } from './telegram-session-context.mjs';

test('findLatestHandoffFilename: 날짜 파일명 중 최신을 고름(문자열정렬=날짜정렬)', () => {
  assert.equal(findLatestHandoffFilename(['2026-08-23.md', '2026-08-29.md', '2026-08-25.md']), '2026-08-29.md');
});

test('findLatestHandoffFilename: 날짜형식 아닌 파일은 무시', () => {
  assert.equal(findLatestHandoffFilename(['README.md', '2026-08-23.md', 'notes.md']), '2026-08-23.md');
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
