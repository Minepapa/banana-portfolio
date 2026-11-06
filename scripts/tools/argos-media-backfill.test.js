import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyBackfill, formatPlan, planBackfill } from './argos-media-backfill.mjs';

// 가상 파일 이름·내용(공개 저장소).
const sha = (text) => createHash('sha256').update(text).digest('hex');
const OLD = new Date('2040-01-02T03:04:05Z');

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'argos-backfill-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const put = (rel, text) => {
    mkdirSync(join(root, rel, '..'), { recursive: true });
    writeFileSync(join(root, rel), text);
    utimesSync(join(root, rel), OLD, OLD);
  };
  const indexPath = join(root, 'archive-index.jsonl');
  return { root, put, indexPath };
}

test('해시가 먼저: 손으로 복사한 것·보관된 것·휴지통 것은 이미 있음, 이름만 같으면 복사하지 않고 보여 준다', async (t) => {
  const { root, put, indexPath } = fixture(t);
  put('Inbox-Argos/Camera/a.jpg', 'A');        // Inbox에 다른 이름으로 이미 손 복사됨
  put('Inbox/Camera/a-copy.jpg', 'A');
  put('Inbox-Argos/Camera/b.jpg', 'B');        // 보관됨(색인 id = sha 앞 16자)
  put('Inbox-Argos/Calls/c.m4a', 'C');         // 휴지통에 있음
  put('Trash/2040-01-03/Calls/c.m4a', 'C');
  put('Inbox-Argos/Screenshots/d.jpg', 'D-new'); // 이름 같고 내용 다름
  put('Inbox/Screenshots/d.jpg', 'D-old');
  put('Inbox-Argos/Recordings/e.m4a', 'E');    // 새 녹음 → 복사
  put('Inbox-Argos/KakaoTalkMovie/f.mp4', 'F'); // 새 카톡 동영상 → 복사
  put('Inbox-Argos/KakaoTalkMovie/f (2).mp4', 'F'); // 같은 내용 사본은 한 번만
  writeFileSync(indexPath, `${JSON.stringify({ id: sha('B').slice(0, 16), kind: 'Camera', inboxPath: 'Inbox/Camera/zz.jpg' })}\n`);

  const items = await planBackfill({ mediaRoot: root, indexPath });
  const verdicts = Object.fromEntries(items.map((item) => [item.source, item.verdict]));
  assert.deepEqual(verdicts, {
    'Inbox-Argos/Camera/a.jpg': 'present',
    'Inbox-Argos/Camera/b.jpg': 'present',
    'Inbox-Argos/Calls/c.m4a': 'present',
    'Inbox-Argos/Screenshots/d.jpg': 'conflict',
    'Inbox-Argos/Recordings/e.m4a': 'copy',
    'Inbox-Argos/KakaoTalkMovie/f.mp4': 'copy',
    'Inbox-Argos/KakaoTalkMovie/f (2).mp4': 'present',
  });
  assert.match(formatPlan(items), /Screenshots: 이미 있음 0 · 복사 대상 0 · 이름 같고 내용 다름 1/);

  // 미리보기는 아무것도 쓰지 않는다.
  assert.equal(existsSync(join(root, 'Inbox', 'Recordings')), false);

  const results = await applyBackfill(items, { mediaRoot: root });
  assert.deepEqual(results.map((row) => row.outcome), ['copied', 'copied']);
  assert.equal(readFileSync(join(root, 'Inbox/Recordings/e.m4a'), 'utf8'), 'E');
  assert.equal(statSync(join(root, 'Inbox/Recordings/e.m4a')).mtimeMs, OLD.getTime(), '수정 시각 유지');
  assert.equal(readFileSync(join(root, 'Inbox/Screenshots/d.jpg'), 'utf8'), 'D-old', '기존 파일 그대로');
  assert.equal(readFileSync(join(root, 'Inbox-Argos/Recordings/e.m4a'), 'utf8'), 'E', '원본 그대로');
  assert.deepEqual(readdirSync(join(root, 'Inbox/KakaoTalkMovie')), ['f.mp4'], '원래 이름으로 한 번만, 임시 파일 없음');
  const log = readFileSync(join(root, 'Inbox-Argos/.backfill.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(log.length, 2);
  assert.equal(log[0].sha256, sha('E'));

  // 다시 돌리면 전부 이미 있음(반복해도 중복이 생기지 않는다).
  const again = await planBackfill({ mediaRoot: root, indexPath });
  assert.equal(again.filter((item) => item.verdict === 'copy').length, 0);
});

test('적용 직전에 Inbox에 같은 이름 다른 내용이 생기면 덮어쓰지 않고 실패로 기록한다', async (t) => {
  const { root, put, indexPath } = fixture(t);
  put('Inbox-Argos/Camera/g.jpg', 'G');
  writeFileSync(indexPath, '');
  const items = await planBackfill({ mediaRoot: root, indexPath });
  put('Inbox/Camera/g.jpg', 'other');
  const [row] = await applyBackfill(items, { mediaRoot: root });
  assert.match(row.outcome, /^failed/);
  assert.equal(readFileSync(join(root, 'Inbox/Camera/g.jpg'), 'utf8'), 'other');
  assert.deepEqual(readdirSync(join(root, 'Inbox/Camera')), ['g.jpg']);
});
