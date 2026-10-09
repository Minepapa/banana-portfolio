#!/usr/bin/env node
import { createServer } from 'node:http';
import { timingSafeEqual, createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, lstatSync, appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { VAULT_REL, VAULT_PATHS } from '../lib/vault-paths.mjs';
import { buildJobHealthRecord, parseFrontmatter } from '../lib/job-health.mjs';
import { writeStateFile } from '../lib/state-writer.mjs';

export const CONFIG_PATH = process.env.OWNTRACKS_CONFIG_PATH || join(homedir(), '.config', 'banana-portfolio-v2', 'owntracks.json');
const MAX_BODY = 64 * 1024;
const kstDate = (date) => new Date(date.getTime() + 9 * 3_600_000).toISOString().slice(0, 10);
export function validHost(host, { allowLoopback = false } = {}) {
  if (allowLoopback && host === '127.0.0.1') return true;
  if (typeof host !== 'string' || !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return false;
  const octets = host.split('.');
  const parts = octets.map(Number);
  return parts.length === 4 && parts.every((part, index) => Number.isInteger(part) && part >= 0 && part <= 255 && String(part) === octets[index])
    && parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127;
}
export function readConfig(path = CONFIG_PATH) {
  let stat;
  try { stat = lstatSync(path); }
  catch (error) { if (error.code === 'ENOENT') throw new Error('OwnTracks 설정 파일 없음'); throw error; }
  if (stat.isSymbolicLink() || stat.uid !== process.getuid()) throw new Error('OwnTracks 설정 파일 소유자 또는 링크 오류');
  if (stat.mode & 0o077) throw new Error('OwnTracks 설정 파일 권한은 600이어야 합니다');
  const config = JSON.parse(readFileSync(path, 'utf8'));
  if (!validHost(config.host) || !Number.isInteger(config.port) || config.port < 1 || config.port > 65535
    || !config.username || !config.password) throw new Error('OwnTracks 설정 값 오류');
  return config;
}
const credentialsEqual = (actual, expected) => {
  return timingSafeEqual(createHash('sha256').update(actual).digest(), createHash('sha256').update(expected).digest());
};
function validPoint(point, now) {
  return point && point._type === 'location' && typeof point.lat === 'number' && Number.isFinite(point.lat) && Math.abs(point.lat) <= 90
    && typeof point.lon === 'number' && Number.isFinite(point.lon) && Math.abs(point.lon) <= 180
    && Number.isSafeInteger(point.tst) && point.tst > 0 && Math.abs(point.tst * 1000 - now.getTime()) <= 30 * 86_400_000
    && (point.acc == null || (typeof point.acc === 'number' && Number.isFinite(point.acc) && point.acc >= 0));
}
export function createLocationStore({ root = VAULT_PATHS.root } = {}) {
  return (point) => {
    const date = kstDate(new Date(point.tst * 1000));
    const path = join(root, VAULT_REL.location, date.slice(0, 4), `${date}.jsonl`);
    mkdirSync(dirname(path), { recursive: true });
    // 데이터량이 적고 단일 수신 서버만 쓰므로 날짜 파일을 읽어 중복 timestamp를 확인한다.
    if (existsSync(path) && readFileSync(path, 'utf8').split('\n').some((line) => {
      try { return JSON.parse(line).tst === point.tst; } catch { return false; }
    })) return false;
    const stored = Object.fromEntries(['tst', 'lat', 'lon', 'acc', 'vel', 'batt', 'tid']
      .filter((key) => point[key] !== undefined && (!['vel', 'batt'].includes(key) || (typeof point[key] === 'number' && Number.isFinite(point[key])))
        && (key !== 'tid' || (typeof point.tid === 'string' && point.tid.length <= 2)))
      .map((key) => [key, point[key]]));
    appendFileSync(path, `${JSON.stringify(stored)}\n`, { mode: 0o600 });
    return true;
  };
}
export async function recordReceiverHealth({ now = new Date(), root = VAULT_PATHS.root } = {}) {
  const path = join(root, VAULT_REL.jobHealth, 'owntracks-receiver.md');
  mkdirSync(dirname(path), { recursive: true });
  const prior = existsSync(path) ? parseFrontmatter(readFileSync(path, 'utf8')) : null;
  const { content } = buildJobHealthRecord({ job: 'owntracks-receiver', status: 'OK', now }, prior);
  await writeStateFile(path, content);
}
export function createReceiver({ config, store = createLocationStore(), now = () => new Date(), health = recordReceiverHealth,
  allowLoopback = false } = {}) {
  if (!validHost(config?.host, { allowLoopback })) throw new Error('OwnTracks host는 Tailscale 주소여야 합니다');
  let lastHealth = 0;
  const server = createServer(async (request, response) => {
    const send = (code, body) => {
      // 200이 아닌 응답은 상태 코드만 남긴다(좌표·인증 정보 금지). 2026-10-09 폰 연결 실패(비밀번호 오타)를 이 로그로 찾았다.
      if (code !== 200) console.log(`[owntracks] 응답 ${code}`);
      response.writeHead(code, { 'Content-Type': 'application/json' }); response.end(body);
    };
    if (request.method !== 'POST' || request.url !== '/pub') { send(404, '[]'); return; }
    const expected = `Basic ${Buffer.from(`${config.username}:${config.password}`).toString('base64')}`;
    if (!credentialsEqual(request.headers.authorization || '', expected)) {
      // 실패 이유 분류만 남긴다(비밀번호 값·길이 금지).
      const header = request.headers.authorization || '';
      let reason = '인증 헤더 없음';
      if (header.startsWith('Basic ')) {
        const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
        const user = decoded.split(':')[0];
        reason = user === config.username ? '비밀번호 불일치' : '사용자 이름 불일치';
      } else if (header) reason = 'Basic 방식 아님';
      console.log(`[owntracks] 인증 실패: ${reason}`);
      send(401, '[]'); return;
    }
    const contentLength = request.headers['content-length'];
    const tooLarge = async () => {
      const finished = response.once ? new Promise((resolve) => {
        const done = () => { response.off('finish', done); response.off('close', done); resolve(); };
        response.once('finish', done);
        response.once('close', done);
      }) : null;
      response.setHeader?.('Connection', 'close');
      send(413, '[]');
      request.pause?.();
      if (finished) await finished;
      request.socket?.destroy();
    };
    if (contentLength != null && (!/^\d+$/.test(String(contentLength)) || Number(contentLength) > MAX_BODY)) {
      await tooLarge();
      return;
    }
    let size = 0;
    const chunks = [];
    try {
      for await (const chunk of request) {
        size += chunk.length;
        if (size > MAX_BODY) { await tooLarge(); return; }
        chunks.push(chunk);
      }
      const point = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (point?._type !== 'location') { send(200, '[]'); return; }
      if (!validPoint(point, now())) { send(400, '[]'); return; }
      const saved = await store(point);
      if (saved) {
        const current = now();
        if (current.getTime() - lastHealth >= 600_000) {
          await health({ now: current });
          lastHealth = current.getTime();
        }
        console.log('[owntracks] 받은 위치 1건');
      }
      send(200, '[]');
    } catch (error) {
      // 원본 요청이나 오류 객체에는 좌표와 인증 정보가 포함될 수 있다.
      console.error('[owntracks] 수신 실패');
      if (!response.headersSent) send(error instanceof SyntaxError ? 400 : 500, '[]');
    }
  });
  // 처리 함수에 닿기 전에 끊기는 연결(HTTP 파싱 오류 등)도 오류 코드만 남긴다.
  server.on('clientError', (error, socket) => {
    console.error(`[owntracks] 연결 오류 ${error.code || 'unknown'}`);
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.maxConnections = 20;
  return server;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const config = readConfig();
    createReceiver({ config }).listen(config.port, config.host, () => console.log('[owntracks] 수신 대기'));
  } catch (error) { console.error(`[owntracks] ${error.message}`); process.exitCode = 1; }
}
