#!/usr/bin/env node
// 올림푸스(맥 대시보드, 결정 `아르고스-올림푸스-도입` 3항) 상시 서버 — launchd KeepAlive 잡.
// 서버 본체는 별도 저장소 `Repos/olympus`(server/olympus-server.mjs)에 있고, 이 파일은 판테온 잡 규칙
// (run.sh·잡 상태 기록·health-watcher)에 맞춰 띄우기만 한다. 올림푸스 저장소가 v2에 묶이지 않게 한다.
// - 127.0.0.1에만 연다. 폰·태블릿은 `tailscale serve --https=8443`(tailnet 안 HTTPS)으로 들어온다.
// - 30분마다 잡 상태(95_Etna/Jobs/JobHealth)를 남긴다. 요청이 없어도 살아 있음을 알리기 위해서다.
// - 상태 detail에 올림푸스 서버의 거절 횟수(server.olympusStats(): 틀린 키·쿠키 401, Host 421)를 적는다. 없거나 깨져도 기록은 OK 그대로.
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildJobHealthRecord, parseFrontmatter } from '../lib/job-health.mjs';
import { writeStateFile } from '../lib/state-writer.mjs';
import { VAULT_PATHS, VAULT_REL } from '../lib/vault-paths.mjs';

const JOB = 'olympus-server';
const HEARTBEAT_MS = 30 * 60 * 1000;
// 형제 저장소: Repos/banana-portfolio-v2/scripts/jobs → Repos/olympus
export const OLYMPUS_SERVER_MODULE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'olympus', 'server', 'olympus-server.mjs');

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/; // 서버는 toISOString()만 넣는다

// 순수 함수: 서버 누적 거절 횟수 → 상태 detail 한 줄. 음 아닌 정수인 칸만 쓰고, 읽을 수 있는 칸이 없으면 빈 문자열.
export function formatOlympusStats(stats) {
  if (!stats || typeof stats !== 'object') return '';
  const count = (v) => (Number.isInteger(v) && v >= 0 ? v : null);
  const parts = [];
  const key = count(stats.keyRejected);
  if (key !== null) {
    const last = typeof stats.lastKeyRejectedAt === 'string' && ISO_RE.test(stats.lastKeyRejectedAt) ? stats.lastKeyRejectedAt : null;
    parts.push(`401 틀린 키 ${key}${key > 0 && last ? `(마지막 ${last})` : ''}`);
  }
  if (count(stats.cookieRejected) !== null) parts.push(`401 쿠키 ${stats.cookieRejected}`);
  if (count(stats.hostRejected) !== null) parts.push(`Host 거절 ${stats.hostRejected}`);
  return parts.length ? `서버 시작 뒤 누적: ${parts.join(' · ')}` : '';
}

// readStats: server.olympusStats 같은 함수. 없거나 던지면 detail만 비우고 OK 기록은 그대로 한다.
function statsDetail(readStats) {
  if (typeof readStats !== 'function') return '';
  try { return formatOlympusStats(readStats()); } catch { return ''; }
}

export async function recordOlympusHealth({ now = new Date(), root = VAULT_PATHS.root, readStats = null } = {}) {
  const path = join(root, VAULT_REL.jobHealth, `${JOB}.md`);
  mkdirSync(dirname(path), { recursive: true });
  const prior = existsSync(path) ? parseFrontmatter(readFileSync(path, 'utf8')) : null;
  const { content } = buildJobHealthRecord({ job: JOB, status: 'OK', detail: statsDetail(readStats), now }, prior);
  await writeStateFile(path, content);
}

async function main() {
  if (!existsSync(OLYMPUS_SERVER_MODULE)) throw new Error('올림푸스 저장소 없음(Repos/olympus)');
  const { createOlympusServer, readConfig } = await import(pathToFileURL(OLYMPUS_SERVER_MODULE).href);
  const { key, port } = readConfig();
  const server = createOlympusServer({ key });
  server.on('error', (error) => { console.error(`[olympus-server] 서버 오류 ${error.code ?? error.name}`); process.exit(1); });
  const readStats = typeof server.olympusStats === 'function' ? () => server.olympusStats() : null;
  const beat = () => recordOlympusHealth({ readStats }).catch(() => console.error('[olympus-server] 상태 기록 실패'));
  // 첫 상태 기록은 포트를 실제로 연 뒤에 — 포트 충돌로 곧 끝날 프로세스가 OK를 남기지 않게.
  server.listen(port, '127.0.0.1', () => {
    console.log(`[olympus-server] 127.0.0.1:${port} 대기`);
    beat();
    setInterval(beat, HEARTBEAT_MS);
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => { console.error(`[olympus-server] 시작 실패: ${error.message}`); process.exit(1); });
}
