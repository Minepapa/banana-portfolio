/**
 * benchmark-updater.gs  (Rhino 호환 버전 — var 사용)
 * ═══════════════════════════════════════════════════════════════════
 * 월별잔고 시트 I열(KOSPI) · J열(S&P500) 자동 입력
 *
 * ┌─ 최초 1회 설정 ─────────────────────────────────────────────────
 * │ 1. 구글 스프레드시트 → 확장 프로그램 → Apps Script
 * │ 2. 이 파일 전체 붙여넣기 → 저장(Ctrl+S)
 * │ 3. 실행(▶) → fillAllSince 선택 → 권한 허용
 * │ 4. 콘솔에서 fillAllSince(2025, 4) 실행
 * │ 5. 트리거(⏰) → 추가 → fillBenchmarkForLastMonth → 월별 → 매월 1일
 * └──────────────────────────────────────────────────────────────────
 */

var SPREADSHEET_ID = '1ANhZyJUm51T8HfvQ56sK-Xrli9IViKmKG462l9rLKeg';
var SHEET_NAME     = '월별잔고';
var KOSPI_COL      = 9;   // I열
var SP500_COL      = 10;  // J열


// ═══════════════════════════════════════════════════════════════════
// [1] 트리거 함수 — 매월 1일 자동 실행 → 전월 종가 기록
// ═══════════════════════════════════════════════════════════════════
function fillBenchmarkForLastMonth() {
  var today = new Date();
  var d     = new Date(today.getFullYear(), today.getMonth() - 1, 1);
  var year  = d.getFullYear();
  var month = d.getMonth() + 1;

  console.log('▶ 트리거 실행: ' + year + '-' + _pad(month) + ' 데이터 채우기');
  _fillOne(year, month);
}


// ═══════════════════════════════════════════════════════════════════
// [2] 일괄 채우기 — 콘솔에서 직접 실행
//     예) fillAllSince(2025, 4)  → 2025-04 ~ 전월 전체
// ═══════════════════════════════════════════════════════════════════
function fillAllSince(startYear, startMonth) {
  var today    = new Date();
  var endYear  = today.getMonth() === 0 ? today.getFullYear() - 1 : today.getFullYear();
  var endMonth = today.getMonth() === 0 ? 12 : today.getMonth();

  console.log('▶ 일괄 채우기: ' + startYear + '-' + _pad(startMonth) + ' ~ ' + endYear + '-' + _pad(endMonth));
  console.log('');

  var y = startYear, m = startMonth;
  var ok = 0, rowMiss = 0, fetchFail = 0;

  while (y < endYear || (y === endYear && m <= endMonth)) {
    var result = _fillOne(y, m);
    if      (result === 'ok')      ok++;
    else if (result === 'rowMiss') rowMiss++;
    else                           fetchFail++;

    m++;
    if (m > 12) { m = 1; y++; }

    Utilities.sleep(250);
  }

  console.log('');
  console.log('완료 ── ✅ ' + ok + '건 성공  /  ⚠️ ' + rowMiss + '건 행없음  /  ❌ ' + fetchFail + '건 수집실패');
}


// ═══════════════════════════════════════════════════════════════════
// [3] 단일 월 수동 채우기
//     예) fillMonth(2026, 3)
// ═══════════════════════════════════════════════════════════════════
function fillMonth(year, month) {
  console.log('▶ 단일 채우기: ' + year + '-' + _pad(month));
  _fillOne(year, month);
}


// ═══════════════════════════════════════════════════════════════════
// 내부 공통: 한 달 채우기 → 'ok' | 'rowMiss' | 'fetchFail' 반환
// ═══════════════════════════════════════════════════════════════════
function _fillOne(year, month) {
  var lastDay = new Date(year, month, 0);

  var kospi = _fetchClose('^KS11', lastDay);
  var sp500 = _fetchClose('^GSPC', lastDay);

  if (kospi === null || sp500 === null) {
    console.log('  ❌ ' + year + '-' + _pad(month) + '  수집 실패 (Yahoo Finance)');
    return 'fetchFail';
  }

  var sheet = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName(SHEET_NAME);
  if (!sheet) {
    console.log('  ❌ 시트 "' + SHEET_NAME + '" 없음');
    return 'fetchFail';
  }

  var row = _findRow(sheet, year, month);
  if (row < 0) {
    console.log('  ⚠️  ' + year + '-' + _pad(month) + '  시트에 해당 행 없음');
    return 'rowMiss';
  }

  sheet.getRange(row, KOSPI_COL).setValue(Math.round(kospi));
  sheet.getRange(row, SP500_COL).setValue(Math.round(sp500));
  console.log('  ✅ ' + year + '-' + _pad(month) + '  row ' + row + '  KOSPI ' + Math.round(kospi) + '  S&P ' + Math.round(sp500));
  return 'ok';
}


// ═══════════════════════════════════════════════════════════════════
// Yahoo Finance: refDate 이전 마지막 거래일 종가 반환
// ═══════════════════════════════════════════════════════════════════
function _fetchClose(ticker, refDate) {
  try {
    var enc = encodeURIComponent(ticker);
    var t1  = Math.floor(new Date(refDate.getFullYear(), refDate.getMonth(), refDate.getDate() - 7).getTime() / 1000);
    var t2  = Math.floor(new Date(refDate.getFullYear(), refDate.getMonth(), refDate.getDate() + 1).getTime() / 1000);
    var url = 'https://query1.finance.yahoo.com/v8/finance/chart/' + enc + '?interval=1d&period1=' + t1 + '&period2=' + t2;

    var resp = UrlFetchApp.fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      muteHttpExceptions: true
    });

    if (resp.getResponseCode() !== 200) return null;

    var json   = JSON.parse(resp.getContentText());
    var closes = (json && json.chart && json.chart.result && json.chart.result[0] &&
                  json.chart.result[0].indicators && json.chart.result[0].indicators.quote &&
                  json.chart.result[0].indicators.quote[0] &&
                  json.chart.result[0].indicators.quote[0].close) || [];
    var valid  = closes.filter(function(v) { return v != null && !isNaN(v); });
    return valid.length > 0 ? valid[valid.length - 1] : null;

  } catch (e) {
    console.log('    _fetchClose(' + ticker + ') 예외: ' + e.message);
    return null;
  }
}


// ═══════════════════════════════════════════════════════════════════
// 시트에서 특정 연·월 행 번호(1-based) 반환, 없으면 -1
// A열 = 연도, B열 = 월
// ═══════════════════════════════════════════════════════════════════
function _findRow(sheet, year, month) {
  var data     = sheet.getDataRange().getValues();
  var lastYear = 0;

  for (var i = 0; i < data.length; i++) {
    var y = parseInt(String(data[i][0] || '').replace(/[^0-9]/g, ''));
    if (y >= 2000) lastYear = y;
    var m = parseInt(String(data[i][1] || '').replace(/[^0-9]/g, ''));
    if (lastYear === year && m === month) return i + 1;
  }
  return -1;
}


// ═══════════════════════════════════════════════════════════════════
// 유틸: 월/일 2자리 패딩
// ═══════════════════════════════════════════════════════════════════
function _pad(n) {
  return String(n).length === 1 ? '0' + String(n) : String(n);
}
