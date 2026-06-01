#!/usr/bin/env node
/**
 * 주간 리포트 → 스프레드시트 동기화 (AI 리스크 엔진과 별개, 리포트 탭 적재)
 *
 * Trading Agent 워크스페이스의 `weekly_report_YYYYMMDD.md` 파일을 스캔해,
 * `주간리포트!A2:C` 시트에 아직 없는 날짜만 append 한다(멱등).
 *
 * 두 용도로 쓰인다:
 *   1) 리포트 발행 직후 reporting 스킬이 호출 → 즉시 적재 (1차 경로)
 *   2) launchd(com.banana.report-sync)가 매일 실행 → 누락 자동 보충 (안전망)
 *
 * 시트 컬럼: A=발행일(YYYY-MM-DD) · B=요약(200자) · C=전체 본문(마크다운)
 *
 * 사용법:
 *   node scripts/sync-reports.mjs            # OAuth(대화형) 또는 SA(무인) 토큰
 *   node scripts/sync-reports.mjs --dry-run  # 적재 대상만 출력
 *   node scripts/sync-reports.mjs <TOKEN>    # 토큰 직접 전달(launchd run.sh)
 */

import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { getToken, getRange, appendValues, ensureSheet } from './lib/sheets-common.mjs';

const REPORT_SHEET = '주간리포트';
const REPORT_HEADER = ['날짜', '요약', '본문'];
const REPORT_DIR = process.env.TRADING_AGENT_DIR || '/Users/huinique/Claude/Agent/Trading Agent';
const FILE_RE = /^weekly_report_(\d{4})(\d{2})(\d{2})\.md$/;

const args = process.argv.slice(2);
const explicitToken = args.find(a => !a.startsWith('--'));
const DRY_RUN = args.includes('--dry-run');

// 리포트 본문에서 요약 200자 추출.
// 1) 명시적 "> 요약: ..." / "**요약**: ..." 라인 우선
// 2) 없으면 제목·인용·구분선·헤더·표를 제거한 첫 의미 문단 200자
function extractSummary(md) {
  const explicit = md.match(/^[>\s]*\*{0,2}\s*요약\s*[:：]\s*(.+)$/m);
  if (explicit) return explicit[1].trim().slice(0, 200);
  const body = md.split('\n')
    .filter(l => !/^\s*#/.test(l) && !/^\s*>/.test(l) && !/^[\s\-=*_]*$/.test(l) && !/^\s*\|/.test(l))
    .join(' ').replace(/\s+/g, ' ').trim();
  return body.slice(0, 200);
}

async function main() {
  let token = explicitToken?.trim() || null;
  token = await getToken(token);
  if (!DRY_RUN) await ensureSheet(token, REPORT_SHEET, REPORT_HEADER);

  // 시트에 이미 있는 발행일
  const existingRows = await getRange(token, `${REPORT_SHEET}!A2:A`);
  const existing = new Set(existingRows.map(r => String(r[0] ?? '').trim()).filter(Boolean));

  // md 파일 → {date, file} (날짜 오름차순)
  const reports = readdirSync(REPORT_DIR)
    .map(name => { const m = name.match(FILE_RE); return m ? { date: `${m[1]}-${m[2]}-${m[3]}`, file: join(REPORT_DIR, name) } : null; })
    .filter(Boolean)
    .sort((a, b) => a.date.localeCompare(b.date));

  const missing = reports.filter(r => !existing.has(r.date));
  console.log(`📋 리포트 ${reports.length}개 · 시트 적재됨 ${existing.size}개 · 누락 ${missing.length}개`);

  if (missing.length === 0) { console.log('동기화 완료 (적재할 신규 리포트 없음).'); return; }

  for (const r of missing) {
    const md = readFileSync(r.file, 'utf8');
    const summary = extractSummary(md);
    console.log(`  + ${r.date}  요약: ${summary.slice(0, 60)}...`);
    if (!DRY_RUN) await appendValues(token, `${REPORT_SHEET}!A2`, [[r.date, summary, md]]);
  }
  console.log(DRY_RUN ? '\n(드라이런 — 실제 적재 안 함)' : `\n✅ ${missing.length}건 적재 완료`);
}

main().catch(e => { console.error('\n❌ 오류:', e.message); process.exit(1); });
