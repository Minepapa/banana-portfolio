import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import { createReceiver, createLocationStore, validHost, readConfig } from './owntracks-receiver.mjs';
import { VAULT_REL } from '../lib/vault-paths.mjs';

test('Tailscale 범위만 운영 host로 허용', () => {
  assert.equal(validHost('100.64.0.1'), true);
  assert.equal(validHost('100.127.255.254'), true);
  assert.equal(validHost('100.128.0.1'), false);
  assert.equal(validHost('0.0.0.0'), false);
  assert.equal(validHost('100.64..1'), false);
  assert.equal(validHost('127.0.0.1'), false);
  assert.equal(validHost('127.0.0.1', { allowLoopback: true }), true);
});

test('설정 파일 없음·권한·host 오류를 거부한다', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'd89-config-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'owntracks.json');
  assert.throws(() => readConfig(path), /없음/);
  writeFileSync(path, JSON.stringify({ host: '0.0.0.0', port: 8088, username: 'x', password: randomBytes(16).toString('base64url') }), { mode: 0o644 });
  assert.throws(() => readConfig(path), /600/);
  chmodSync(path, 0o600);
  assert.throws(() => readConfig(path), /설정 값/);
  symlinkSync(path, join(root, 'link.json'));
  assert.throws(() => readConfig(join(root, 'link.json')), /링크/);
});

test('수신 서버 인증·경로·본문·중복·헬스 제한', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'd89-server-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const config = { host: '127.0.0.1', username: 'test', password: randomBytes(16).toString('base64url') };
  let healthCalls = 0;
  const server = createReceiver({ config, store: createLocationStore({ root }), allowLoopback: true,
    now: () => new Date('2026-10-09T03:00:00Z'), health: async () => { healthCalls += 1; } });
  assert.deepEqual([server.requestTimeout, server.headersTimeout, server.maxConnections], [15_000, 10_000, 20]);
  const auth = `Basic ${Buffer.from(`${config.username}:${config.password}`).toString('base64')}`;
  const post = (path, body, authorization = auth, headers = {}) => new Promise((resolve) => {
    const request = Readable.from([Buffer.from(body)]);
    request.method = 'POST'; request.url = path; request.headers = { authorization, ...headers };
    const response = { headersSent: false, writeHead(status) { this.status = status; this.headersSent = true; },
      end() { resolve({ status: this.status }); } };
    server.emit('request', request, response);
  });
  assert.equal((await post('/other', '{}')).status, 404);
  assert.equal((await post('/pub', '{}', 'Basic wrong')).status, 401);
  assert.equal((await post('/pub', '{')).status, 400);
  assert.equal((await post('/pub', '{}', auth, { 'content-length': String(65 * 1024) })).status, 413);
  assert.equal((await post('/pub', 'x'.repeat(65 * 1024))).status, 413);
  assert.equal((await post('/pub', JSON.stringify({ _type: 'transition' }))).status, 200);
  assert.equal((await post('/pub', JSON.stringify({ _type: 'location', lat: 91, lon: 34, tst: 1 }))).status, 400);
  const point = { _type: 'location', tst: Date.parse('2026-10-09T03:00:00Z') / 1000, lat: 12, lon: 34, acc: 10, tid: 'aa', vel: 'bad', batt: Infinity };
  assert.equal((await post('/pub', JSON.stringify({ ...point, tst: point.tst - 31 * 86_400 }))).status, 400);
  assert.equal((await post('/pub', JSON.stringify(point))).status, 200);
  assert.equal((await post('/pub', JSON.stringify(point))).status, 200);
  assert.equal((await post('/pub', JSON.stringify({ ...point, tst: point.tst + 60, tid: 'long', vel: 2.5, batt: 50 }))).status, 200);
  assert.equal(healthCalls, 1);
  const date = new Date(point.tst * 1000 + 9 * 3_600_000).toISOString().slice(0, 10);
  const lines = readFileSync(join(root, VAULT_REL.location, date.slice(0, 4), `${date}.jsonl`), 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);
  assert.deepEqual(JSON.parse(lines[0]), { tst: point.tst, lat: 12, lon: 34, acc: 10, tid: 'aa' });
  assert.deepEqual(JSON.parse(lines[1]), { tst: point.tst + 60, lat: 12, lon: 34, acc: 10, vel: 2.5, batt: 50 });
});

test('허용된 환경에서 127.0.0.1 임의 포트로 HTTP 왕복', async (t) => {
  const config = { host: '127.0.0.1', username: 'u', password: randomBytes(16).toString('base64url') };
  const server = createReceiver({ config, allowLoopback: true, store: async () => true,
    health: async () => {} });
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  } catch (error) {
    // 일부 샌드박스는 loopback bind도 금지한다. 같은 요청 경로는 위 in-memory 시험이 실행한다.
    if (error.code !== 'EPERM') throw error;
    t.diagnostic('샌드박스가 127.0.0.1 listen을 거부하여 HTTP 왕복을 실행할 수 없음');
    return;
  }
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/pub`, {
      method: 'POST', headers: { Authorization: `Basic ${Buffer.from(`${config.username}:${config.password}`).toString('base64')}` }, body: JSON.stringify({ _type: 'transition' }),
    });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), '[]');
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test('스트림 초과 응답을 끝낸 뒤 연결을 닫고 Content-Length 초과는 읽지 않는다', async () => {
  const config = { host: '127.0.0.1', username: 'u', password: 'p' };
  const server = createReceiver({ config, allowLoopback: true, store: () => { throw new Error('저장 금지'); } });
  const authorization = `Basic ${Buffer.from('u:p').toString('base64')}`;
  const send = (request, completion = 'finish') => new Promise((resolve) => {
    const events = [];
    request.method = 'POST'; request.url = '/pub';
    request.headers = { authorization, ...request.headers };
    request.socket = { destroy: () => { events.push('close'); resolve(events); } };
    const response = new EventEmitter();
    response.writeHead = (status) => { response.status = status; };
    response.setHeader = () => {};
    response.end = () => { events.push(`response ${response.status}`); setImmediate(() => response.emit(completion)); };
    server.emit('request', request, response);
  });
  let reads = 0;
  const oversizedHeader = new Readable({ read() { reads += 1; this.push(null); } });
  oversizedHeader.headers = { 'content-length': String(65 * 1024) };
  assert.deepEqual(await send(oversizedHeader), ['response 413', 'close']);
  assert.equal(reads, 0);
  const oversizedStream = Readable.from([Buffer.alloc(65 * 1024)]);
  assert.deepEqual(await send(oversizedStream), ['response 413', 'close']);
  assert.deepEqual(await send(Readable.from([Buffer.alloc(65 * 1024)]), 'close'), ['response 413', 'close']);
});
