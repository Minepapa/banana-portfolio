import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { createArgosMedia, MAX_MEDIA_CHUNK } from './argos-media.mjs';

const NOW = new Date('2026-10-24T03:00:00Z');
const sha = (b) => createHash('sha256').update(b).digest('hex');
const tempRoot = (t) => {
  const root = mkdtempSync(join(tmpdir(), 'argos-media-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
};
const q = (o) => new URLSearchParams(Object.fromEntries(Object.entries(o).map(([k, v]) => [k, String(v)])));
const put = (media, params, bytes) => media.upload(q(params), Readable.from([bytes]), String(bytes.length));

test('두 조각으로 나눠 올리면 해시를 확인하고 Inbox-Argos/종류/원래 이름으로 둔다', async (t) => {
  const root = tempRoot(t);
  const media = createArgosMedia({ root, now: () => NOW });
  const file = randomBytes(5000);
  const base = { kind: 'Calls', name: '통화 미네, 나의 우주 🥰_261024_120000.m4a', size: file.length, sha256: sha(file) };

  assert.deepEqual((await media.status(q(base))).json, { state: 'absent', received: 0 });
  const first = await put(media, { ...base, offset: 0 }, file.subarray(0, 3000));
  assert.deepEqual(first.json, { state: 'partial', received: 3000 });
  // 이어받기: 상태가 받은 만큼을 알려 준다
  assert.deepEqual((await media.status(q(base))).json, { state: 'partial', received: 3000 });
  const second = await put(media, { ...base, offset: 3000 }, file.subarray(3000));
  assert.equal(second.status, 200);
  assert.equal(second.json.state, 'complete');

  const stored = join(root, 'Inbox-Argos', 'Calls', base.name);
  assert.deepEqual(readFileSync(stored), file);
  assert.equal(statSync(stored).mode & 0o777, 0o600);
  assert.equal(readdirSync(join(root, 'Inbox-Argos', '.parts')).length, 0);
  assert.deepEqual((await media.status(q(base))).json, { state: 'complete', received: file.length });
  // 병행 기간: 기존 Syncthing 폴더(Media/Inbox)는 건드리지 않는다
  assert.equal(existsSync(join(root, 'Inbox')), false);
  const manifest = readFileSync(join(root, 'Inbox-Argos', '.manifest.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(manifest[0].path, join('Calls', base.name));
  assert.equal(manifest[0].at, NOW.toISOString());
});

test('재시작해도 manifest로 완료를 기억하고, 순서가 어긋난 조각은 409로 받은 만큼을 알려 준다', async (t) => {
  const root = tempRoot(t);
  const file = randomBytes(2000);
  const base = { kind: 'Camera', name: '20261024_120000.jpg', size: file.length, sha256: sha(file) };
  const media = createArgosMedia({ root, now: () => NOW });
  await put(media, { ...base, offset: 0 }, file.subarray(0, 500));
  const skipped = await put(media, { ...base, offset: 1000 }, file.subarray(1000));
  assert.equal(skipped.status, 409);
  assert.equal(skipped.json.received, 500);
  await put(media, { ...base, offset: 500 }, file.subarray(500));
  const restarted = createArgosMedia({ root, now: () => NOW });
  assert.equal((await restarted.status(q(base))).json.state, 'complete');
  // 이미 완료된 파일을 다시 보내도 덮어쓰지 않고 완료로 답한다
  const again = await put(restarted, { ...base, offset: 0 }, file);
  assert.equal(again.json.state, 'complete');
});

test('해시가 틀리면 조각을 버리고 422, 같은 이름의 다른 파일은 덮어쓰지 않고 (2)로 둔다', async (t) => {
  const root = tempRoot(t);
  const media = createArgosMedia({ root, now: () => NOW });
  const file = randomBytes(1000);
  const bad = await put(media, { kind: 'Camera', name: 'a.jpg', size: 1000, sha256: sha(Buffer.from('other')), offset: 0 }, file);
  assert.equal(bad.status, 422);
  assert.equal(bad.json.error, 'hash_mismatch');
  assert.equal(readdirSync(join(root, 'Inbox-Argos', '.parts')).length, 0);

  const one = randomBytes(800);
  const two = randomBytes(900);
  await put(media, { kind: 'Camera', name: 'a.jpg', size: one.length, sha256: sha(one), offset: 0 }, one);
  const conflict = await put(media, { kind: 'Camera', name: 'a.jpg', size: two.length, sha256: sha(two), offset: 0 }, two);
  assert.equal(conflict.json.stored, join('Camera', 'a (2).jpg'));
  assert.deepEqual(readFileSync(join(root, 'Inbox-Argos', 'Camera', 'a.jpg')), one);
  assert.deepEqual(readFileSync(join(root, 'Inbox-Argos', 'Camera', 'a (2).jpg')), two);
});

test('같은 바이트가 이미 그 이름으로 있으면 하나만 남긴다', async (t) => {
  const root = tempRoot(t);
  const file = randomBytes(600);
  mkdirSync(join(root, 'Inbox-Argos', 'Recordings'), { recursive: true });
  writeFileSync(join(root, 'Inbox-Argos', 'Recordings', '미네.m4a'), file);
  const media = createArgosMedia({ root, now: () => NOW });
  const result = await put(media, { kind: 'Recordings', name: '미네.m4a', size: file.length, sha256: sha(file), offset: 0 }, file);
  assert.equal(result.json.stored, join('Recordings', '미네.m4a'));
  assert.deepEqual(readdirSync(join(root, 'Inbox-Argos', 'Recordings')), ['미네.m4a']);
});

test('경로 조각·모르는 종류·잘못된 크기·큰 조각·길이 불일치는 거부하고 조각 파일을 늘리지 않는다', async (t) => {
  const root = tempRoot(t);
  const media = createArgosMedia({ root, now: () => NOW });
  const file = randomBytes(100);
  const ok = { kind: 'Camera', name: 'x.jpg', size: 100, sha256: sha(file), offset: 0 };
  for (const [patch, error] of [
    [{ name: '../x.jpg' }, 'bad_name'], [{ name: 'a/b.jpg' }, 'bad_name'], [{ name: '.hidden' }, 'bad_name'],
    [{ kind: 'Documents' }, 'bad_kind'], [{ size: 0 }, 'bad_size'], [{ sha256: 'zz' }, 'bad_sha256'], [{ offset: 100 }, 'bad_offset'],
  ]) {
    const result = await put(media, { ...ok, ...patch }, file);
    assert.equal(result.status, 400, JSON.stringify(patch));
    assert.equal(result.json.error, error);
  }
  const big = await media.upload(q({ ...ok, size: MAX_MEDIA_CHUNK * 2 }), Readable.from([]), String(MAX_MEDIA_CHUNK + 1));
  assert.equal(big.status, 413);
  const past = await put(media, { ...ok, size: 50 }, file);
  assert.equal(past.json.error, 'past_end');
  // 선언한 길이보다 짧게 끊긴 본문: 받은 만큼 되돌린다
  const short = await media.upload(q(ok), Readable.from([file.subarray(0, 40)]), '100');
  assert.equal(short.status, 409); // 다시 보내면 되는 일: 폰이 영구 보류하지 않게 409
  assert.equal((await media.status(q(ok))).json.received, 0);
  const long = await media.upload(q(ok), Readable.from([file, file]), '100');
  assert.equal(long.json.error, 'body_overflow');
  assert.equal((await media.status(q(ok))).json.received, 0);
});

test('폰이 보낸 원래 수정 시각을 파일에 남긴다(보관 잡이 날짜를 mtime으로 정하는 파일 대비)', async (t) => {
  const root = tempRoot(t);
  const media = createArgosMedia({ root, now: () => NOW });
  const file = randomBytes(300);
  const mtime = Date.parse('2026-10-20T08:15:00Z');
  await put(media, { kind: 'Recordings', name: 'r.m4a', size: 300, sha256: sha(file), offset: 0, mtime }, file);
  assert.equal(statSync(join(root, 'Inbox-Argos', 'Recordings', 'r.m4a')).mtimeMs, mtime);
  // 고장 난 시계(2000년 이전): 파일은 받고 시각만 버린다
  const odd = randomBytes(300);
  const broken = await put(media, { kind: 'Recordings', name: 'x.m4a', size: 300, sha256: sha(odd), offset: 0, mtime: 5 }, odd);
  assert.equal(broken.json.state, 'complete');
});

test('같은 바이트라도 종류·이름이 다르면 각각 둔다(Syncthing처럼)', async (t) => {
  const root = tempRoot(t);
  const media = createArgosMedia({ root, now: () => NOW });
  const file = randomBytes(400);
  await put(media, { kind: 'Camera', name: 'p.jpg', size: 400, sha256: sha(file), offset: 0 }, file);
  const second = await put(media, { kind: 'KakaoTalk', name: 'k.jpg', size: 400, sha256: sha(file), offset: 0 }, file);
  assert.equal(second.json.stored, join('KakaoTalk', 'k.jpg'));
  assert.deepEqual(readFileSync(join(root, 'Inbox-Argos', 'KakaoTalk', 'k.jpg')), file);
  assert.deepEqual(readFileSync(join(root, 'Inbox-Argos', 'Camera', 'p.jpg')), file);
});

test('7일 넘게 멈춘 조각은 시작할 때 버리고, manifest 끝이 깨져 있어도 다음 줄은 온전하다', async (t) => {
  const root = tempRoot(t);
  mkdirSync(join(root, 'Inbox-Argos', '.parts'), { recursive: true });
  const old = join(root, 'Inbox-Argos', '.parts', `${'a'.repeat(64)}-10.part`);
  writeFileSync(old, Buffer.alloc(5));
  const longAgo = new Date(NOW.getTime() - 8 * 86_400_000);
  utimesSync(old, longAgo, longAgo);
  writeFileSync(join(root, 'Inbox-Argos', '.manifest.jsonl'), '{"kind":"Camera","name":"broken');
  const media = createArgosMedia({ root, now: () => NOW });
  assert.equal(existsSync(old), false);
  const file = randomBytes(100);
  await put(media, { kind: 'Camera', name: 'n.jpg', size: 100, sha256: sha(file), offset: 0 }, file);
  const lines = readFileSync(join(root, 'Inbox-Argos', '.manifest.jsonl'), 'utf8').trim().split('\n');
  assert.equal(JSON.parse(lines.at(-1)).name, 'n.jpg');
  assert.equal((await createArgosMedia({ root, now: () => NOW }).status(q({ kind: 'Camera', name: 'n.jpg', size: 100, sha256: sha(file) }))).json.state, 'complete');
});

test('바이트를 다 받았는데 놓이지 못한 조각은 다음 status에서 마무리한다', async (t) => {
  const root = tempRoot(t);
  const file = randomBytes(700);
  const base = { kind: 'Camera', name: 'stuck.jpg', size: 700, sha256: sha(file) };
  mkdirSync(join(root, 'Inbox-Argos', '.parts'), { recursive: true });
  writeFileSync(join(root, 'Inbox-Argos', '.parts', `${base.sha256}-700.part`), file);
  const media = createArgosMedia({ root, now: () => NOW });
  const result = await media.status(q(base));
  assert.equal(result.json.state, 'complete');
  assert.deepEqual(readFileSync(join(root, 'Inbox-Argos', 'Camera', 'stuck.jpg')), file);
});
