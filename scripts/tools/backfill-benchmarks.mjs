#!/usr/bin/env node
/**
 * 월별잔고 I/J열 벤치마크(KOSPI·S&P500) 백필/점검
 *
 * 시트 월별잔고 A:J를 읽어, 각 행의 I(KOSPI)/J(S&P500)을 yfinance 월말 종가와 비교.
 * 누락·불일치 발견 시 시트에 기록.
 *
 * 사용법:
 *   node scripts/tools/backfill-benchmarks.mjs            # 점검 + 수정
 *   node scripts/tools/backfill-benchmarks.mjs --dry-run  # 점검만 (시트 쓰기 안 함)
 *   node scripts/tools/backfill-benchmarks.mjs <TOKEN>     # OAuth 대신 토큰 직접 전달
 */

import { spawnSync } from 'child_process';
import { loadEnv, getToken, getRange, setValues } from '../lib/sheets-common.mjs';

const args = process.argv.slice(2);
const explicitToken = args.find(a => !a.startsWith('--'));
const DRY_RUN = args.includes('--dry-run');

loadEnv();

const parseNum = (v) => parseFloat(String(v ?? '').replace(/,/g, '')) || 0;
const parseInt2 = (v) => parseInt(String(v ?? '').replace(/[^0-9]/g, ''), 10);

function parseRows(values) {
  let lastYear = 0;
  return (values || []).map((r, i) => {
    const y = parseInt2(r[0]);
    if (y >= 2000) lastYear = y;
    const m = parseInt2(r[1]);
    if (!m || !lastYear) return null;
    return {
      rowIdx: i,
      year: lastYear, month: m,
      ym: lastYear * 100 + m,
      total: parseNum(r[7]),
      kospi: parseNum(r[8]),
      sp500: parseNum(r[9]),
    };
  }).filter(Boolean);
}

function fetchMonthlyCloses(startYm, endYm) {
  const py = new URL('../lib/yf-monthly-close.py', import.meta.url).pathname;
  const r = spawnSync('python3', [py, String(startYm), String(endYm), '^KS11', '^GSPC'], {
    encoding: 'utf8', timeout: 120000,
  });
  if (r.status !== 0) throw new Error(`yfinance 월말 종가 조회 실패: ${(r.stderr || '').slice(-300)}`);
  return JSON.parse(r.stdout);
}

async function main() {
  console.log('📊 월별잔고 벤치마크(KOSPI/S&P500) 점검');
  if (DRY_RUN) console.log('   (--dry-run: 시트 수정 안 함)\n');

  const token = await getToken(explicitToken);
  console.log('1. 월별잔고 데이터 조회...');
  const values = await getRange(token, '월별잔고!A2:J');
  const rows = parseRows(values);

  if (rows.length < 2) {
    console.error('❌ 월별잔고 행 부족');
    process.exit(1);
  }
  console.log(`   ${rows.length}행 (${rows[0].year}.${rows[0].month} → ${rows.at(-1).year}.${rows.at(-1).month})\n`);

  // 현재 월은 미완결이므로 제외 (전월까지만)
  const now = new Date();
  const curYm = now.getFullYear() * 100 + (now.getMonth() + 1);
  const eligible = rows.filter(r => r.ym < curYm && r.total > 0);

  if (eligible.length === 0) {
    console.log('점검 대상 없음 (모두 현재 월이거나 잔고 0)');
    return;
  }

  const startYm = eligible[0].ym;
  const endYm = eligible.at(-1).ym;

  console.log(`2. yfinance 월말 종가 조회 (${startYm} ~ ${endYm})...`);
  const ref = fetchMonthlyCloses(startYm, endYm);
  const kospiRef = ref['^KS11'] || {};
  const sp500Ref = ref['^GSPC'] || {};

  console.log(`   KOSPI ${Object.keys(kospiRef).length}개월, S&P500 ${Object.keys(sp500Ref).length}개월\n`);

  // 비교
  const TOLERANCE = 0.02; // 2% 허용 (반올림·종가 기준 차이)
  const fixes = [];

  console.log('3. 비교 결과:');
  console.log('   월     | 시트KOSPI | 실제KOSPI | 시트S&P  | 실제S&P  | 상태');
  console.log('   -------|----------|----------|---------|---------|-----');

  for (const r of eligible) {
    const ymKey = `${r.year}${String(r.month).padStart(2, '0')}`;
    const refK = kospiRef[ymKey];
    const refS = sp500Ref[ymKey];

    if (refK == null && refS == null) continue; // yfinance에 데이터 없음

    const kOk = refK != null && r.kospi > 0 && Math.abs(r.kospi - refK) / refK < TOLERANCE;
    const sOk = refS != null && r.sp500 > 0 && Math.abs(r.sp500 - refS) / refS < TOLERANCE;

    const needFix = !kOk || !sOk;
    const newK = refK != null ? Math.round(refK) : (r.kospi || '');
    const newS = refS != null ? Math.round(refS) : (r.sp500 || '');

    const status = needFix
      ? (r.kospi === 0 && r.sp500 === 0 ? '🔵 누락' : '🟡 불일치')
      : '✅';

    if (needFix || r.kospi === 0 || r.sp500 === 0) {
      const pad = (v, n) => String(v).padStart(n);
      console.log(`   ${r.year}.${String(r.month).padStart(2, '0')} | ${pad(r.kospi || '-', 8)} | ${pad(refK != null ? Math.round(refK) : '-', 8)} | ${pad(r.sp500 || '-', 7)} | ${pad(refS != null ? Math.round(refS) : '-', 7)} | ${status}`);
    }

    if (needFix) {
      fixes.push({ rowIdx: r.rowIdx, ym: `${r.year}.${String(r.month).padStart(2, '0')}`, kospi: newK, sp500: newS });
    }
  }

  if (fixes.length === 0) {
    console.log('\n✅ 모든 벤치마크 데이터 정상');
    return;
  }

  console.log(`\n수정 필요: ${fixes.length}건`);

  if (DRY_RUN) {
    console.log('(--dry-run 이므로 시트 수정 생략)');
    return;
  }

  console.log('\n4. 시트 업데이트...');
  for (const f of fixes) {
    const sheetRow = f.rowIdx + 2; // 1-based header offset
    await setValues(token, `월별잔고!I${sheetRow}:J${sheetRow}`, [[f.kospi, f.sp500]]);
    console.log(`   ✅ row ${sheetRow} (${f.ym}): KOSPI=${f.kospi} S&P=${f.sp500}`);
  }

  console.log(`\n✅ ${fixes.length}건 업데이트 완료. 앱 KPI 탭에서 알파 확인 가능.`);
}

main().catch(e => {
  console.error('\n❌ 오류:', e.message);
  process.exit(1);
});
