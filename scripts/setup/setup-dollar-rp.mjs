/**
 * 달러RP 앵커+델타(모델 X) 셋업 — 1회 실행
 *
 * 1) 달러기준 시트 보장 + 위탁 시드(736 USD, 오늘 기준)
 * 2) 위탁!8 외화 RP 행을 USD 관리 구조로 재구성
 *      D8=USD잔액(736) · C8/F8='설정'!B2(라이브 환율) · E8/H8=수식(원화)
 *
 * 사용법:  node scripts/setup/setup-dollar-rp.mjs
 *          node scripts/setup/setup-dollar-rp.mjs --dry-run
 */

import { getToken, getRange, appendValues, setValues, ensureSheet } from '../lib/sheets-common.mjs';

const DRY_RUN = process.argv.includes('--dry-run');
const DOLLAR_BASE_SHEET = '달러기준';
const DOLLAR_BASE_HEADER = ['계좌', '기준USD', '기준일', '갱신시각'];
const SEED_USD = 736;
const TAB = '위탁';
const ROW = 8; // 외화 RP 표시행

const todayKST = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
const nowStr = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Seoul' });

async function main() {
  const token = await getToken(null, { allowBrowser: false });

  // 1) 달러기준 시트 + 시드
  if (!DRY_RUN) await ensureSheet(token, DOLLAR_BASE_SHEET, DOLLAR_BASE_HEADER);
  const baseRows = await getRange(token, `${DOLLAR_BASE_SHEET}!A2:D`).catch(() => []);
  const hasWits = baseRows.some(r => String(r[0] ?? '').trim() === TAB);
  if (!hasWits) {
    console.log(`달러기준 시드: [${TAB}, ${SEED_USD}, ${todayKST}, ${nowStr}]`);
    if (!DRY_RUN) await appendValues(token, `${DOLLAR_BASE_SHEET}!A2`, [[TAB, SEED_USD, todayKST, nowStr]]);
  } else {
    console.log(`달러기준 ${TAB} 행 이미 존재 — 시드 skip`);
  }

  // 2) 위탁!8 재구성 (C8:I8). A8=달러 / B8=외화 RP 는 유지(건드리지 않음)
  const row = [['=\'설정\'!B2', SEED_USD, '=D8*C8', '=\'설정\'!B2', '=H8-E8', '=D8*F8', '=IF(E8=0,0,G8/E8)']];
  console.log(`위탁!C${ROW}:I${ROW} = C='설정'!B2 · D=${SEED_USD} · E=D*C · F='설정'!B2 · G=H-E · H=D*F · I=G/E`);
  if (!DRY_RUN) await setValues(token, `${TAB}!C${ROW}:I${ROW}`, row);

  console.log(DRY_RUN ? '\n(드라이런 — 쓰기 없음)' : '\n✅ 달러RP 셋업 완료');
}

main().catch(e => { console.error('\n❌ 오류:', e.message); process.exit(1); });
