#!/usr/bin/env node
/**
 * 시트 전체 백업 — launchd run.sh 가 매일 호출(무인).
 * 모든 탭의 값을 타임스탬프 JSON 으로 덤프해 리포 밖(~/banana-portfolio-backups)에 보관.
 * 자산 데이터(보유종목·예수금·월별잔고 등)가 단일 시트에 모여 있어, 동기화/편집 사고 시
 * 되돌릴 수 있는 스냅샷이 필요하다. 90일 초과분은 자동 정리(디스크 무한 증가 방지).
 * 사용: node scripts/jobs/backup-sheet.mjs [token]
 */
import { mkdirSync, writeFileSync, readdirSync, statSync, unlinkSync } from 'fs';
import { join } from 'path';
import { getToken, SHEET_ID, nowKST, todayKST } from '../lib/sheets-common.mjs';

const API = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}`;
const BACKUP_DIR = `${process.env.HOME}/banana-portfolio-backups`;
const RETAIN_DAYS = 90;
const tokenArg = process.argv[2];

// 시트 전체를 한 번의 batchGet 으로 가져온다(탭별 개별 호출 대비 라운드트립·쿼터 절약).
async function fetchAllSheets(token) {
  const meta = await fetch(`${API}?fields=sheets.properties.title`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!meta.ok) throw new Error(`시트 목록 조회 실패: ${await meta.text()}`);
  const titles = ((await meta.json()).sheets || []).map(s => s.properties.title);
  if (titles.length === 0) throw new Error('탭이 하나도 없음 — 백업 중단');

  const params = titles.map(t => `ranges=${encodeURIComponent(t)}`).join('&');
  const res = await fetch(`${API}/values:batchGet?${params}&valueRenderOption=UNFORMATTED_VALUE`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`batchGet 실패: ${await res.text()}`);
  const ranges = (await res.json()).valueRanges || [];

  const sheets = {};
  titles.forEach((title, i) => { sheets[title] = ranges[i]?.values || []; });
  return { titles, sheets };
}

// 백업 디렉터리에서 RETAIN_DAYS 초과 파일 삭제. 실패해도 백업 자체는 성공으로 둔다.
function pruneOld() {
  const cutoff = Date.now() - RETAIN_DAYS * 24 * 3600_000;
  let removed = 0;
  for (const f of readdirSync(BACKUP_DIR)) {
    if (!f.startsWith('banana-') || !f.endsWith('.json')) continue;
    const full = join(BACKUP_DIR, f);
    try {
      if (statSync(full).mtimeMs < cutoff) { unlinkSync(full); removed++; }
    } catch { /* 개별 파일 정리 실패는 무시 */ }
  }
  return removed;
}

async function main() {
  const token = await getToken(tokenArg?.trim() || null, { allowBrowser: false });
  mkdirSync(BACKUP_DIR, { recursive: true });

  const { titles, sheets } = await fetchAllSheets(token);
  const stamp = nowKST().replace(/[: ]/g, '-'); // YYYY-MM-DD-HH-mm
  const file = join(BACKUP_DIR, `banana-${stamp}.json`);
  const payload = { savedAt: nowKST(), date: todayKST(), spreadsheetId: SHEET_ID, sheets };
  writeFileSync(file, JSON.stringify(payload), 'utf8');

  let pruned = 0;
  try { pruned = pruneOld(); } catch (e) { console.error('정리 실패(무시):', e.message); }

  console.log(`💾 백업 완료: ${file} (탭 ${titles.length}개, 오래된 파일 ${pruned}개 정리)`);
}

main().catch(e => { console.error('❌ 백업 실패:', e.message); process.exit(1); });
