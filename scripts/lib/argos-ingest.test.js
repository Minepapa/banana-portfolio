import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { createArgosIngest, readArgosConfig, tokenMatches } from './argos-ingest.mjs';
import { VAULT_REL } from './vault-paths.mjs';

const NOW = new Date('2026-10-23T12:00:00Z');
const h = (s) => createHash('sha256').update(s).digest('hex');
const event = (n, extra = {}) => ({
  id: `id-${n}`, hash: h(`e${n}`), type: 'location.point_recorded', source: 'location',
  occurred_at: NOW.getTime() - n * 60_000, payload: { lat: 37.5, lon: 126.9, acc: 10 }, ...extra,
});
const tempRoot = (t) => {
  const root = mkdtempSync(join(tmpdir(), 'argos-ingest-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
};
const archive = (root, date) =>
  readFileSync(join(root, VAULT_REL.argosEvents, date.slice(0, 4), `${date}.jsonl`), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

test('받은 이벤트를 KST 날짜 파일에 보관하고 ack한다(권한 600)', (t) => {
  const root = tempRoot(t);
  const ingest = createArgosIngest({ root, now: () => NOW });
  // 15:30Z = KST 00:30 다음 날 — 날짜 경계는 KST
  const late = event(1, { occurred_at: Date.parse('2026-10-22T15:30:00Z') });
  const result = ingest.ingest({ protocol: 1, device: 'argos-s23', events: [event(0), late] });
  assert.equal(result.status, 200);
  assert.deepEqual(result.json.acked.sort(), [event(0).hash, late.hash].sort());
  assert.deepEqual(result.json.rejected, []);
  const [record] = archive(root, '2026-10-23').filter((r) => r.hash === event(0).hash);
  assert.equal(record.device, 'argos-s23');
  assert.equal(record.received_at, NOW.getTime());
  assert.deepEqual(record.payload, event(0).payload);
  assert.equal(archive(root, '2026-10-23').length, 2);
  const file = join(root, VAULT_REL.argosEvents, '2026', '2026-10-23.jsonl');
  assert.equal(statSync(file).mode & 0o777, 0o600);
});

test('같은 hash는 다시 쓰지 않고 ack한다 — 재전송·재시작 모두', (t) => {
  const root = tempRoot(t);
  const first = createArgosIngest({ root, now: () => NOW });
  first.ingest({ protocol: 1, events: [event(0)] });
  assert.deepEqual(first.ingest({ protocol: 1, events: [event(0), event(0)] }).json.acked, [event(0).hash]);
  // 프로세스 재시작: 보관 파일에서 hash를 다시 읽는다
  const restarted = createArgosIngest({ root, now: () => NOW });
  assert.deepEqual(restarted.ingest({ protocol: 1, events: [event(0)] }).json.acked, [event(0).hash]);
  assert.equal(archive(root, '2026-10-23').length, 1);
});

test('잘못된 이벤트는 그 건만 거부하고 나머지는 보관한다', (t) => {
  const root = tempRoot(t);
  const ingest = createArgosIngest({ root, now: () => NOW });
  const result = ingest.ingest({ protocol: 1, events: [
    event(0),
    event(1, { hash: 'nothex' }),
    event(2, { type: 'Bad Type' }),
    event(3, { occurred_at: 0 }),
    event(4, { payload: [1, 2] }),
    event(5, { payload: { body: 'x'.repeat(300 * 1024) } }),
  ] });
  assert.deepEqual(result.json.acked, [event(0).hash]);
  assert.deepEqual(result.json.rejected.map((r) => r.reason), ['bad_hash', 'bad_type', 'bad_occurred_at', 'bad_payload', 'too_large']);
});

test('시계가 의심스러운 이벤트도 표시만 붙여 보관하고 ack한다(폰 영구 격리 방지)', (t) => {
  const root = tempRoot(t);
  const future = event(7, { occurred_at: NOW.getTime() + 2 * 86_400_000 });
  const result = createArgosIngest({ root, now: () => NOW }).ingest({ protocol: 1, events: [future] });
  assert.deepEqual(result.json.acked, [future.hash]);
  const [record] = archive(root, '2026-10-25');
  assert.equal(record.clock_suspect, true);
});

test('잘린 마지막 줄 뒤에 새 기록이 붙지 않는다', (t) => {
  const root = tempRoot(t);
  const dir = join(root, VAULT_REL.argosEvents, '2026');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '2026-10-23.jsonl'), '{"hash":"cut', { mode: 0o600 });
  createArgosIngest({ root, now: () => NOW }).ingest({ protocol: 1, events: [event(0)] });
  const lines = readFileSync(join(dir, '2026-10-23.jsonl'), 'utf8').split('\n').filter(Boolean);
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[1]).hash, event(0).hash);
});

test('요청 형식 오류와 과다 건수는 배치 단위로 막는다', (t) => {
  const ingest = createArgosIngest({ root: tempRoot(t), now: () => NOW });
  assert.equal(ingest.ingest({ protocol: 2, events: [] }).status, 400);
  assert.equal(ingest.ingest({ protocol: 1 }).status, 400);
  assert.equal(ingest.ingest({ protocol: 1, events: Array.from({ length: 501 }, (_, i) => event(i)) }).status, 413);
});

test('기록 실패면 아무것도 ack하지 않는다', (t) => {
  const root = tempRoot(t);
  // Events 자리에 파일을 두어 mkdir을 실패시킨다
  mkdirSync(join(root, '95_Etna'), { recursive: true });
  writeFileSync(join(root, VAULT_REL.argosEvents), 'not a dir');
  const result = createArgosIngest({ root, now: () => NOW }).ingest({ protocol: 1, events: [event(0)] });
  assert.equal(result.status, 500);
  assert.equal(result.json.acked, undefined);
});

test('규칙: 폴더가 없으면 빈 목록, 있으면 yaml만 해시와 함께, 경로 이탈은 거부', (t) => {
  const root = tempRoot(t);
  const ingest = createArgosIngest({ root, now: () => NOW });
  assert.deepEqual(ingest.rules('/rules/manifest').json, []);
  const dir = join(root, VAULT_REL.argosRules);
  mkdirSync(join(dir, 'integrations'), { recursive: true });
  writeFileSync(join(dir, 'notifications.yaml'), 'version: 1\n');
  writeFileSync(join(dir, 'integrations', 'x.yaml'), 'version: 1\n');
  writeFileSync(join(dir, 'README.md'), 'not served');
  const manifest = ingest.rules('/rules/manifest').json;
  assert.deepEqual(manifest.map((f) => f.name).sort(), ['integrations/x.yaml', 'notifications.yaml']);
  assert.equal(manifest.find((f) => f.name === 'notifications.yaml').sha256, h('version: 1\n'));
  assert.equal(ingest.rules('/rules/notifications.yaml').buffer.toString(), 'version: 1\n');
  assert.equal(ingest.rules('/rules/../secret.yaml').status, 400);
  assert.equal(ingest.rules('/rules/%2e%2e%2fsecret.yaml').status, 400);
  assert.equal(ingest.rules('/rules/README.md').status, 400);
  assert.equal(ingest.rules('/rules/missing.yaml').status, 404);
  assert.equal(ingest.rules('/rules/%E0%A4%A').status, 400);
  // 중간 폴더가 규칙 폴더 밖을 가리키는 링크면 따라가지 않는다
  const outside = join(root, 'outside');
  mkdirSync(outside);
  writeFileSync(join(outside, 'leak.yaml'), 'secret: 1\n');
  symlinkSync(outside, join(dir, 'linked'));
  assert.equal(ingest.rules('/rules/linked/leak.yaml').status, 404);
  // BOM이 있어도 원본 바이트 그대로라 manifest hash와 같다
  writeFileSync(join(dir, 'bom.yaml'), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('version: 1\n')]));
  const bom = ingest.rules('/rules/manifest').json.find((f) => f.name === 'bom.yaml');
  assert.equal(createHash('sha256').update(ingest.rules('/rules/bom.yaml').buffer).digest('hex'), bom.sha256);
});

test('설정 파일: 없으면 꺼짐, 권한·링크·짧은 토큰은 거부', (t) => {
  const root = tempRoot(t);
  const path = join(root, 'argos.json');
  assert.equal(readArgosConfig(path), null);
  writeFileSync(path, JSON.stringify({ token: randomBytes(24).toString('base64url') }), { mode: 0o644 });
  assert.throws(() => readArgosConfig(path), /600/);
  chmodSync(path, 0o600);
  assert.ok(readArgosConfig(path).token);
  symlinkSync(path, join(root, 'link.json'));
  assert.throws(() => readArgosConfig(join(root, 'link.json')), /링크/);
  writeFileSync(path, JSON.stringify({ token: 'short' }), { mode: 0o600 });
  assert.throws(() => readArgosConfig(path), /토큰/);
});

test('토큰 비교는 길이가 달라도 안전하게 거짓', () => {
  assert.equal(tokenMatches('abc', 'abc'), true);
  assert.equal(tokenMatches('abcd', 'abc'), false);
  assert.equal(tokenMatches(undefined, 'abc'), false);
});
