import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, linkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { followPhoneDeletions, MAX_PER_RUN } from './argos-media-trash.mjs';

const NOW = Date.parse('2026-10-24T12:00:00+09:00');
const DAY = 86_400_000;
const SHA = createHash('sha256').update('argos').digest('hex');
const ID = SHA.slice(0, 16);

function setup({ receivedAt = NOW - DAY, kind = 'Camera', withArchive = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'argos-trash-'));
  const media = join(root, 'Media');
  const events = join(root, 'Events');
  mkdirSync(join(media, 'Inbox-Argos', kind), { recursive: true });
  mkdirSync(join(media, 'Archive', '2026', '10', kind), { recursive: true });
  mkdirSync(join(media, 'Inbox', kind), { recursive: true });
  mkdirSync(join(media, 'Trash'), { recursive: true });
  mkdirSync(join(events, '2026'), { recursive: true });
  writeFileSync(join(media, 'Inbox-Argos', kind, 'a.jpg'), 'argos');
  writeFileSync(join(media, 'Inbox-Argos', '.manifest.jsonl'),
    `${JSON.stringify({ kind, name: 'a.jpg', path: `${kind}/a.jpg`, size: 5, sha256: SHA, at: new Date(receivedAt).toISOString() })}\n`);
  const records = new Map();
  if (withArchive) {
    writeFileSync(join(media, 'Archive', '2026', '10', kind, 'a.jpg'), 'sync');
    linkSync(join(media, 'Archive', '2026', '10', kind, 'a.jpg'), join(media, 'Inbox', kind, 'a.jpg'));
    records.set(ID, { id: ID, kind, inboxPath: `Inbox/${kind}/a.jpg`, archivePath: `Archive/2026/10/${kind}/a.jpg` });
  }
  const written = [];
  return { root, media, events, records, written, writeIndex: async (r) => { written.push(new Map(r)); },
    statePath: join(root, 'state.json') };
}
const event = (id, type, kind = 'Camera', at = NOW - 3600_000, name = 'a.jpg') => ({ id, type, occurred_at: at, received_at: at,
  payload: { kind, name, size: '5', sha256: SHA } });
const putEvents = (env, list) => writeFileSync(join(env.events, '2026', '2026-10-24.jsonl'), `${list.map((e) => JSON.stringify(e)).join('\n')}\n`);
const run = (env, opts = {}) => followPhoneDeletions({ mediaRoot: env.media, eventsDir: env.events, statePath: env.statePath,
  loadIndex: async () => env.records, writeIndex: env.writeIndex, nowMs: NOW, ...opts });

test('보낸 지 7일 안에 폰에서 지운 사진은 Archive·아르고스 사본을 휴지통으로 옮기고 색인에서 뺀다', async () => {
  const env = setup();
  putEvents(env, [event('e1', 'media.deleted_on_phone')]);
  const r = await run(env);
  assert.equal(r.trashed, 1);
  assert.equal(existsSync(join(env.media, 'Archive/2026/10/Camera/a.jpg')), false);
  assert.equal(existsSync(join(env.media, 'Inbox-Argos/Camera/a.jpg')), false);
  assert.equal(existsSync(join(env.media, 'Inbox/Camera/a.jpg')), false, 'Syncthing Inbox의 같은 하드링크도 지운다');
  const manifest = readFileSync(join(env.media, 'Trash/2026-10-24/manifest.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(manifest[0].record.id, ID);
  assert.equal(manifest[0].reason, 'phone-deleted');
  assert.ok(existsSync(join(env.media, manifest[0].trashPath)));
  assert.ok(existsSync(join(env.media, manifest[0].argosTrashPath)));
  assert.equal(env.written.at(-1).has(ID), false);
  // 같은 이벤트는 다시 처리하지 않는다.
  assert.equal((await run(env)).trashed, 0);
});

test('폰에서 복원하면 원래 자리와 색인으로 되돌린다', async () => {
  const env = setup();
  putEvents(env, [event('e1', 'media.deleted_on_phone')]);
  await run(env);
  putEvents(env, [event('e1', 'media.deleted_on_phone'), event('e2', 'media.restored_on_phone', 'Camera', NOW - 60_000)]);
  const r = await run(env);
  assert.equal(r.restored, 1);
  assert.ok(existsSync(join(env.media, 'Archive/2026/10/Camera/a.jpg')));
  assert.ok(existsSync(join(env.media, 'Inbox-Argos/Camera/a.jpg')));
  assert.equal(env.written.at(-1).get(ID).archivePath, 'Archive/2026/10/Camera/a.jpg');
  assert.equal(readFileSync(join(env.media, 'Trash/2026-10-24/manifest.jsonl'), 'utf8'), '');
});

test('받은 지 7일이 지난 파일, 통화, 받은 기록이 없는 파일은 맥 원본을 그대로 둔다', async () => {
  const old = setup({ receivedAt: NOW - 9 * DAY });
  putEvents(old, [event('e1', 'media.deleted_on_phone')]);
  assert.equal((await run(old)).trashed, 0);
  assert.ok(existsSync(join(old.media, 'Archive/2026/10/Camera/a.jpg')));

  const call = setup({ kind: 'Calls' });
  putEvents(call, [event('e1', 'media.deleted_on_phone', 'Calls')]);
  assert.equal((await run(call)).trashed, 0);

  const unknown = setup();
  writeFileSync(join(unknown.media, 'Inbox-Argos', '.manifest.jsonl'), '');
  putEvents(unknown, [event('e1', 'media.deleted_on_phone')]);
  assert.equal((await run(unknown)).trashed, 0);
  assert.ok(existsSync(join(unknown.media, 'Archive/2026/10/Camera/a.jpg')));
});

test('한 번에 너무 많으면 아무것도 옮기지 않고 막는다', async () => {
  const env = setup();
  putEvents(env, Array.from({ length: MAX_PER_RUN + 1 }, (_, i) => event(`e${i}`, 'media.deleted_on_phone')));
  const r = await run(env);
  assert.equal(r.blocked, true);
  assert.equal(r.trashed, 0);
  assert.ok(existsSync(join(env.media, 'Archive/2026/10/Camera/a.jpg')));
});

test('dry-run은 아무것도 옮기거나 쓰지 않는다', async () => {
  const env = setup();
  putEvents(env, [event('e1', 'media.deleted_on_phone')]);
  const r = await run(env, { dryRun: true });
  assert.equal(r.trashed, 1);
  assert.ok(existsSync(join(env.media, 'Archive/2026/10/Camera/a.jpg')));
  assert.equal(existsSync(env.statePath), false);
});

test('같은 내용을 다른 이름으로도 받았으면 Archive 보관본은 남기고 지운 쪽 아르고스 사본만 옮긴다', async () => {
  const env = setup();
  writeFileSync(join(env.media, 'Inbox-Argos', 'Camera', 'b.jpg'), 'argos');
  writeFileSync(join(env.media, 'Inbox-Argos', '.manifest.jsonl'), readFileSync(join(env.media, 'Inbox-Argos', '.manifest.jsonl'), 'utf8')
    + `${JSON.stringify({ kind: 'Camera', name: 'b.jpg', path: 'Camera/b.jpg', size: 5, sha256: SHA, at: new Date(NOW - DAY).toISOString() })}\n`);
  putEvents(env, [event('e1', 'media.deleted_on_phone', 'Camera', NOW - 3600_000, 'b.jpg')]);
  const r = await run(env);
  assert.equal(r.trashed, 1);
  assert.ok(existsSync(join(env.media, 'Archive/2026/10/Camera/a.jpg')), '남은 사본의 보관본은 지킨다');
  assert.equal(existsSync(join(env.media, 'Inbox-Argos/Camera/b.jpg')), false);
  assert.ok(existsSync(join(env.media, 'Trash/2026-10-24/Argos/Camera/b.jpg')));
  assert.equal(env.written.length, 0);
});

test('복원 자리에 다른 내용이 있으면 휴지통에 두고 경보, 같은 내용이면 복원된 것으로 마무리', async () => {
  const env = setup();
  putEvents(env, [event('e1', 'media.deleted_on_phone')]);
  await run(env);
  writeFileSync(join(env.media, 'Archive/2026/10/Camera/a.jpg'), 'something else');
  putEvents(env, [event('e1', 'media.deleted_on_phone'), event('e2', 'media.restored_on_phone', 'Camera', NOW - 60_000)]);
  const r = await run(env);
  assert.equal(r.conflicts, 1);
  assert.ok(readFileSync(join(env.media, 'Trash/2026-10-24/manifest.jsonl'), 'utf8').includes('phone-deleted'), 'manifest 유지');
  // 아르고스 사본 자리는 비어 있어 되돌아갔다.
  assert.ok(existsSync(join(env.media, 'Inbox-Argos/Camera/a.jpg')));
});

test('이벤트 하나가 실패해도 앞 이벤트의 색인·상태는 저장하고 실패한 것은 다음에 다시 한다', async () => {
  const env = setup();
  // 어제 휴지통 manifest 자리를 폴더로 만들어 복원 이벤트만 읽기 오류가 나게 한다.
  mkdirSync(join(env.media, 'Trash', '2026-10-23', 'manifest.jsonl'), { recursive: true });
  const otherRestore = { ...event('e2', 'media.restored_on_phone', 'Camera', NOW - 60_000) };
  otherRestore.payload = { ...otherRestore.payload, sha256: 'cd'.repeat(32) };
  putEvents(env, [event('e1', 'media.deleted_on_phone'), otherRestore]);
  const r = await run(env);
  assert.equal(r.trashed, 1);
  assert.equal(r.failed, 1);
  assert.equal(env.written.at(-1).has(ID), false);
  const state = JSON.parse(readFileSync(env.statePath, 'utf8'));
  assert.ok(state.processed.e1);
  assert.equal(state.processed.e2, undefined);
});

test('삭제가 대량 차단돼도 복원은 처리하고, 막힌 삭제는 처리 완료로 두지 않으며, 복원보다 앞선 삭제는 취소한다', async () => {
  const env = setup();
  putEvents(env, [event('e1', 'media.deleted_on_phone')]);
  await run(env);
  const before = Array.from({ length: MAX_PER_RUN + 1 }, (_, i) => event(`d${i}`, 'media.deleted_on_phone'));
  putEvents(env, [...before, event('e2', 'media.restored_on_phone', 'Camera', NOW - 60_000)]);
  const r = await run(env);
  assert.equal(r.blocked, true);
  assert.equal(r.restored, 1);
  assert.ok(existsSync(join(env.media, 'Archive/2026/10/Camera/a.jpg')));
  // 오너가 풀어도, 그 뒤에 복원된 사진은 다시 휴지통으로 가지 않는다(복원보다 앞선 삭제는 취소).
  const again = await run(env, { allowBulk: true });
  assert.equal(again.trashed, 0);
  assert.ok(existsSync(join(env.media, 'Archive/2026/10/Camera/a.jpg')));
  assert.ok(JSON.parse(readFileSync(env.statePath, 'utf8')).processed.d0);
  // 복원 뒤에 다시 대량으로 지운 것은 막히고, 처리 완료로 남지 않는다.
  const after = Array.from({ length: MAX_PER_RUN + 1 }, (_, i) => event(`n${i}`, 'media.deleted_on_phone', 'Camera', NOW - 30_000));
  putEvents(env, after);
  const third = await run(env);
  assert.equal(third.blocked, true);
  assert.equal(JSON.parse(readFileSync(env.statePath, 'utf8')).processed.n0, undefined);
});

test('폰 시계가 늦어도 맥 수신 시각으로 7일을 잰다', async () => {
  const env = setup({ receivedAt: NOW - 8 * DAY });
  // 폰 시계는 9일 전이라지만 맥은 지금 받았다 → 늦은 쪽(지금) 기준 받은 지 8일이라 보관 유지
  putEvents(env, [{ ...event('e1', 'media.deleted_on_phone'), occurred_at: NOW - 9 * DAY, received_at: NOW }]);
  assert.equal((await run(env)).trashed, 0);
});

test('Media가 보이지 않으면 아무 이벤트도 소비하지 않고 실패한다', async () => {
  const env = setup();
  putEvents(env, [event('e2', 'media.restored_on_phone')]);
  await assert.rejects(() => run(env, { mediaRoot: join(env.root, 'missing') }));
  assert.equal(existsSync(env.statePath), false);
});

test('실패한 이벤트는 8일 조회 범위를 벗어나도 다시 읽는다', async () => {
  const env = setup();
  mkdirSync(join(env.media, 'Trash', '2026-10-23', 'manifest.jsonl'), { recursive: true });
  const old = { ...event('r1', 'media.restored_on_phone'), occurred_at: NOW - 12 * DAY, received_at: NOW - 12 * DAY };
  writeFileSync(join(env.events, '2026', '2026-10-12.jsonl'), `${JSON.stringify(old)}\n`);
  writeFileSync(env.statePath, JSON.stringify({ processed: {}, retry: { r1: '2026-10-12' } }));
  const r = await run(env);
  assert.equal(r.failed, 1, '다시 읽혀 처리 시도(이번에도 실패)');
  assert.equal(JSON.parse(readFileSync(env.statePath, 'utf8')).retry.r1, '2026-10-12');
});

test('지움 → 복원 → 다시 지움: 두 번째 삭제는 실행된다(같은 회차)', async () => {
  const env = setup();
  putEvents(env, [event('d1', 'media.deleted_on_phone', 'Camera', NOW - 3 * 3600_000),
    event('r1', 'media.restored_on_phone', 'Camera', NOW - 2 * 3600_000),
    event('d2', 'media.deleted_on_phone', 'Camera', NOW - 3600_000)]);
  const r = await run(env);
  assert.equal(r.trashed, 1);
  assert.equal(existsSync(join(env.media, 'Archive/2026/10/Camera/a.jpg')), false);
});

test('조회 범위 밖 날짜 파일에서는 다시 시도할 이벤트만 읽는다', async () => {
  const env = setup();
  const sibling = { ...event('old-d', 'media.deleted_on_phone'), occurred_at: NOW - 12 * DAY, received_at: NOW - 12 * DAY };
  const retried = { ...event('old-r', 'media.restored_on_phone'), occurred_at: NOW - 12 * DAY, received_at: NOW - 12 * DAY };
  writeFileSync(join(env.events, '2026', '2026-10-12.jsonl'), `${JSON.stringify(sibling)}\n${JSON.stringify(retried)}\n`);
  writeFileSync(env.statePath, JSON.stringify({ processed: {}, retry: { 'old-r': '2026-10-12' } }));
  const r = await run(env);
  assert.equal(r.trashed, 0, '형제 삭제 이벤트는 되살아나지 않는다');
  assert.ok(existsSync(join(env.media, 'Archive/2026/10/Camera/a.jpg')));
});

test('한 달 넘게 미뤄진 삭제는 실행하지 않는다', async () => {
  const env = setup({ receivedAt: NOW - 32 * DAY });
  putEvents(env, [{ ...event('e1', 'media.deleted_on_phone'), occurred_at: NOW - 31 * DAY, received_at: NOW - 31 * DAY }]);
  assert.equal((await run(env)).trashed, 0);
});
