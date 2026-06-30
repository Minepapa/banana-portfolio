/**
 * benchmark-updater.gs
 * ═══════════════════════════════════════════════════════════════════
 * 월별잔고 시트 I열(KOSPI) · J열(S&P500) 자동 입력
 * Yahoo Finance에서 해당 월 마지막 거래일 종가를 가져와 시트에 기록
 *
 * ┌─ 최초 1회 설정 ─────────────────────────────────────────────────
 * │ 1. 구글 스프레드시트 → 확장 프로그램 → Apps Script
 * │ 2. 이 파일 전체 붙여넣기 → 저장(Ctrl+S)
 * │ 3. 실행(▶) → fillAllSince 선택 → 권한 허용
 * │ 4. 콘솔에서 fillAllSince(2025, 4) 실행 → 과거 데이터 일괄 채우기
 * │ 5. 트리거(⏰) → 추가 → fillBenchmarkForLastMonth → 월별 → 매월 1일
 * └──────────────────────────────────────────────────────────────────
 */

// ───────── 설정 ─────────────────────────────────────────────────────
const SPREADSHEET_ID = '1ANhZyJUm51T8HfvQ56sK-Xrli9IViKmKG462l9rLKeg';
const SHEET_NAME     = '월별잔고';
const KOSPI_COL      = 9;   // I열
const SP500_COL      = 10;  // J열


// ═══════════════════════════════════════════════════════════════════
// [1] 트리거 함수 — 매월 1일 자동 실행 → 전월 종가 기록
// ═══════════════════════════════════════════════════════════════════
function fillBenchmarkForLastMonth() {
  const today = new Date();
  const d     = new Date(today.getFullYear(), today.getMonth() - 1, 1);
  const year  = d.getFullYear();
  const month = d.getMonth() + 1;

  console.log(`▶ 트리거 실행: ${year}-${_pad(month)} 데이터 채우기`);
  _fillOne(year, month);
}


// ═══════════════════════════════════════════════════════════════════
// [2] 일괄 채우기 — 콘솔에서 직접 실행
//     예) fillAllSince(2025, 4)  → 2025-04 ~ 전월 전체
// ═══════════════════════════════════════════════════════════════════
function fillAllSince(startYear, startMonth) {
  // 마지막 채울 달 = 전월
  const today    = new Date();
  const endYear  = today.getMonth() === 0 ? today.getFullYear() - 1 : today.getFullYear();
  const endMonth = today.getMonth() === 0 ? 12 : today.getMonth();

  console.log(`▶ 일괄 채우기: ${startYear}-${_pad(startMonth)} ~ ${endYear}-${_pad(endMonth)}`);
  console.log('');

  let y = startYear, m = startMonth;
  let ok = 0, rowMiss = 0, fetchFail = 0;

  while (y < endYear || (y === endYear && m <= endMonth)) {
    const result = _fillOne(y, m);
    if      (result === 'ok')       ok++;
    else if (result === 'rowMiss')  rowMiss++;
    else                            fetchFail++;

    // 다음 달
    m++;
    if (m > 12) { m = 1; y++; }

    Utilities.sleep(250); // Yahoo Finance 요청 간격
  }

  console.log('');
  console.log(`완료 ── ✅ ${ok}건 성공  /  ⚠️ ${rowMiss}건 행없음  /  ❌ ${fetchFail}건 수집실패`);
}


// ═══════════════════════════════════════════════════════════════════
// [3] 단일 월 수동 채우기 — 누락된 특정 달 보정용
//     예) fillMonth(2026, 3)
// ═══════════════════════════════════════════════════════════════════
function fillMonth(year, month) {
  console.log(`▶ 단일 채우기: ${year}-${_pad(month)}`);
  _fillOne(year, month);
}


// ═══════════════════════════════════════════════════════════════════
// 내부 공통: 한 달 채우기 → 'ok' | 'rowMiss' | 'fetchFail' 반환
// ═══════════════════════════════════════════════════════════════════
function _fillOne(year, month) {
  const lastDay = new Date(year, month, 0); // 해당 월 말일

  const kospi = _fetchClose('^KS11', lastDay);
  const sp500 = _fetchClose('^GSPC', lastDay);

  if (kospi === null || sp500 === null) {
    console.log(`  ❌ ${year}-${_pad(month)}  수집 실패 (Yahoo Finance)`);
    return 'fetchFail';
  }

  const sheet = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName(SHEET_NAME);
  if (!sheet) {
    console.log(`  ❌ 시트 "${SHEET_NAME}" 없음`);
    return 'fetchFail';
  }

  const row = _findRow(sheet, year, month);
  if (row < 0) {
    console.log(`  ⚠️  ${year}-${_pad(month)}  시트에 해당 행 없음`);
    return 'rowMiss';
  }

  sheet.getRange(row, KOSPI_COL).setValue(Math.round(kospi));
  sheet.getRange(row, SP500_COL).setValue(Math.round(sp500));
  console.log(`  ✅ ${year}-${_pad(month)}  row ${row}  KOSPI ${Math.round(kospi).toLocaleString()}  S&P ${Math.round(sp500).toLocaleString()}`);
  return 'ok';
}


// ═══════════════════════════════════════════════════════════════════
// Yahoo Finance: refDate 이전 마지막 거래일 종가 반환
// ═══════════════════════════════════════════════════════════════════
function _fetchClose(ticker, refDate) {
  try {
    const enc  = encodeURIComponent(ticker);
    // 말일 기준 ±7일 → 주말·공휴일 자동 커버
    const t1   = Math.floor(new Date(refDate.getFullYear(), refDate.getMonth(), refDate.getDate() - 7).getTime() / 1000);
    const t2   = Math.floor(new Date(refDate.getFullYear(), refDate.getMonth(), refDate.getDate() + 1).getTime() / 1000);
    const url  = `https://query1.finance.yahoo.com/v8/finance/chart/${enc}?interval=1d&period1=${t1}&period2=${t2}`;

    const resp = UrlFetchApp.fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      muteHttpExceptions: true,
    });

    if (resp.getResponseCode() !== 200) return null;

    const closes = JSON.parse(resp.getContentText())
                     ?.chart?.result?.[0]?.indicators?.quote?.[0]?.close ?? [];
    const valid  = closes.filter(v => v != null && !isNaN(v));
    return valid.length > 0 ? valid[valid.length - 1] : null;

  } catch (e) {
    console.log(`    _fetchClose(${ticker}) 예외: ${e.message}`);
    return null;
  }
}


// ═══════════════════════════════════════════════════════════════════
// 시트에서 특정 연·월 행 번호(1-based) 반환, 없으면 -1
// A열 = 연도(숫자 포함), B열 = 월(숫자 포함)
// ═══════════════════════════════════════════════════════════════════
function _findRow(sheet, year, month) {
  const data     = sheet.getDataRange().getValues();
  let   lastYear = 0;

  for (let i = 0; i < data.length; i++) {
    const y = parseInt(String(data[i][0] ?? '').replace(/[^0-9]/g, ''));
    if (y >= 2000) lastYear = y;
    const m = parseInt(String(data[i][1] ?? '').replace(/[^0-9]/g, ''));
    if (lastYear === year && m === month) return i + 1;
  }
  return -1;
}


// ═══════════════════════════════════════════════════════════════════
// 유틸: 월/일 2자리 패딩
// ═══════════════════════════════════════════════════════════════════
function _pad(n) {
  return String(n).padStart(2, '0');
}
