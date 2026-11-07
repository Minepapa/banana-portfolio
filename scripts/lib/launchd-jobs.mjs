// 등록된 launchd 잡 목록 읽기 — 정본은 scripts/launchd(run.sh case문 = 잡 이름→스크립트, com.banana2.*.plist = 스케줄).
// 등록 강제 테스트(기대 주기·이름표·담당)가 같은 파싱을 쓰도록 한곳에 둔다(2026-10-30, 손 목록 대신 실제 등록 위치를 읽는다).
import { readdirSync, readFileSync } from 'node:fs';

const LAUNCHD_DIR = new URL('../launchd/', import.meta.url);

// run.sh가 디스패치하는 잡 이름(case문의 `이름) CMD=` 줄).
export function listDispatchedJobs(dir = LAUNCHD_DIR) {
  const runSh = readFileSync(new URL('run.sh', dir), 'utf8');
  return [...runSh.matchAll(/^\s*([a-z][a-z0-9-]*)\)\s+CMD=/gm)].map((m) => m[1]);
}

// plist가 있는 잡 이름(com.banana2.<이름>.plist).
export function listPlistJobs(dir = LAUNCHD_DIR) {
  return readdirSync(dir).filter((n) => /^com\.banana2\..+\.plist$/.test(n)).map((n) => n.replace(/^com\.banana2\./, '').replace(/\.plist$/, ''));
}

// 보관(폐지·정지) plist 잡 이름 — scripts/launchd/retired/. 운영 등록이 아니므로 listPlistJobs에는 안 섞는다.
// 되돌릴 때는 이 폴더에서 scripts/launchd/로 옮긴다.
export function listRetiredPlistJobs(dir = LAUNCHD_DIR) {
  const retired = new URL('retired/', dir);
  return readdirSync(retired).filter((n) => /^com\.banana2\..+\.plist$/.test(n)).map((n) => n.replace(/^com\.banana2\./, '').replace(/\.plist$/, ''));
}
