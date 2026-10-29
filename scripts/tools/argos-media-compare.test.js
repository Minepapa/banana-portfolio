import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compareMediaInboxes, formatReport } from './argos-media-compare.mjs';

const NOW = Date.parse('2026-10-24T03:00:00Z');
const DAY = 86_400_000;

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'argos-compare-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const born = new Map();
  const put = (dir, name, bytes, { bornDaysAgo = 0, mtimeDaysAgo = 0 } = {}) => {
    mkdirSync(join(root, dir), { recursive: true });
    const path = join(root, dir, name);
    writeFileSync(path, Buffer.alloc(bytes));
    const at = new Date(NOW - mtimeDaysAgo * DAY);
    utimesSync(path, at, at);
    born.set(`${bytes}:${at.getTime()}:${name}`, NOW - bornDaysAgo * DAY);
  };
  // birthtime stand-in keyed by size+mtime (unique per file in these fixtures)
  const bornAt = (st) => [...born.entries()].find(([k]) => k.startsWith(`${st.size}:${Math.round(st.mtimeMs)}:`))?.[1] ?? 0;
  return { root, put, bornAt };
}

test('맥에 최근 생긴 Syncthing 파일 중 아르고스에 없거나 크기·시각이 다른 것을 찾는다', (t) => {
  const { root, put, bornAt } = fixture(t);
  put('Inbox/Camera', 'a.jpg', 10);
  put('Inbox/Camera', 'b.jpg', 11);
  put('Inbox/Camera/sub', 'moved.jpg', 12, { mtimeDaysAgo: 40 }); // 옛 수정 시각이지만 최근에 맥에 생김(하위 폴더)
  put('Inbox/Camera', 'old.jpg', 13, { bornDaysAgo: 30, mtimeDaysAgo: 30 }); // 기간 밖
  put('Trash/2026-10-23/Calls', 'trashed.m4a', 14); // 보관 잡이 휴지통으로 옮긴 것도 Syncthing이 받은 것
  put('Inbox/Calls', 'c.m4a', 20);
  put('Inbox/Recordings', 't.m4a', 21);
  put('Inbox-Argos/Camera', 'a.jpg', 10);
  put('Inbox-Argos/Calls', 'c.m4a', 19);
  put('Inbox-Argos/Recordings', 't.m4a', 21, { mtimeDaysAgo: 2 }); // 업로드 시각으로 남은 경우
  put('Inbox-Argos/Calls', 'only.m4a', 5);
  put('Inbox-Argos/Calls', 'c (2).m4a', 6);   // 원래 이름이 있으니 충돌 사본
  put('Inbox-Argos/Calls', 'x (2).m4a', 7);   // 원래 이름이 없으니 진짜 파일
  put('Inbox-Argos/.parts', 'p.part', 1);
  put('Inbox/Screenshots', 's.jpg', 30);
  put('Inbox-Argos/Screenshots', 's.jpg', 31);      // 같은 이름의 다른 파일이 먼저 옴
  put('Inbox-Argos/Screenshots', 's (2).jpg', 30);  // Syncthing 파일과 같은 바이트는 사본 이름으로

  const report = compareMediaInboxes({ root, sinceMs: NOW - 7 * DAY, bornAt });
  const camera = report.find((r) => r.kind === 'Camera');
  assert.deepEqual(camera.missing.sort(), ['b.jpg', 'moved.jpg']);
  const calls = report.find((r) => r.kind === 'Calls');
  assert.deepEqual(calls.missing, ['trashed.m4a']);
  assert.deepEqual(calls.sizeDiff, ['c.m4a']);
  assert.deepEqual(calls.argosOnly.sort(), ['only.m4a', 'x (2).m4a']);
  assert.deepEqual(report.find((r) => r.kind === 'Recordings').timeDiff, ['t.m4a']);
  assert.deepEqual(report.find((r) => r.kind === 'Screenshots').sizeDiff, []);
  const text = formatReport(report, 7);
  assert.match(text, /Camera: Syncthing 3 · 아르고스 1 · 빠짐 2/);
  assert.match(text, /빠짐·불일치 5건 — 전환하지 않는다/);
});

test('폴더가 없으면 0으로 보고 빠짐 0이면 그렇게 말한다', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'argos-compare-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const report = compareMediaInboxes({ root, sinceMs: 0 });
  assert.equal(report.length, 6);
  assert.match(formatReport(report, 7), /결론: 빠짐 0/);
});
