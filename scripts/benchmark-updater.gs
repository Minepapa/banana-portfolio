/**
 * benchmark-updater.gs
 * ─────────────────────────────────────────────────────────────────────────────
 * 월별잔고 시트 I열(KOSPI)·J열(S&P500) 자동 입력
 * 실행: 매월 1일 트리거 → 전월 말 최종 거래일 종가를 Yahoo Finance에서 가져와 기록
 *
 * 설치 방법:
 *   1. 구글 스프레드시트 열기
 *   2. 확장 프로그램 → Apps Script
 *   3. 이 파일 전체를 붙여넣기 (기존 내용 대체)
 *   4. 아래 SPREADSHEET_ID를 실제 ID로 교체 (URL /d/XXXX/ 부분)
 *   5. 저장(Ctrl+S) → 실행(▶) → 권한 허용
 *   6. 왼쪽 메뉴 '트리거(⏰)' → '트리거 추가'
 *      · 실행 함수: fillBenchmarkForLastMonth
 *      · 이벤트: 시간 기반 → 월별 타이머 → 매월 1일
 * ─────────────────────────────────────────────────────────────────────────────
 */

// ▼ 여기에 스프레드시트 ID를 입력하세요 (URL의 /d/ 뒤 긴 문자열)
const SPREADSHEET_ID = '1ANhZyJUm51T8HfvQ56sK-Xrli9IViKmKG462l9rLKeg';
const SHEET_NAME = '월별잔고';

// ─────────────────────────────────────────────────────────────────────────────
// 메인 함수 — 트리거로 실행됨
// ─────────────────────────────────────────────────────────────────────────────
function fillBenchmarkForLastMonth() {
  const today = new Date();

  // 전월 연·월 계산
  const targetDate  = new Date(today.getFullYear(), today.getMonth() - 1, 1);
  const targetYear  = targetDate.getFullYear();
  const targetMonth = targetDate.getMonth() + 1; // 1~12

  // 전월 말일 Date 객체 (다음 달 0일 = 전월 말일)
  const lastDay = new Date(targetYear, targetMonth, 0);

  console.log(`📅 ${targetYear}년 ${targetMonth}월 말일(${_fmt(lastDay)}) 종가 수집 시작`);

  // Yahoo Finance 종가 수집
  const kospi = fetchLastClose('^KS11', lastDay);
  const sp500 = fetchLastClose('^GSPC', lastDay);

  if (kospi === null || sp500 === null) {
    console.log('❌ 데이터 수집 실패 — Yahoo Finance 응답을 확인하세요.');
    return;
  }

  console.log(`  KOSPI: ${Math.round(kospi)}, S&P500: ${Math.round(sp500)}`);

  // 시트에서 해당 연·월 행 탐색
  const ss    = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) { console.log(`❌ 시트 "${SHEET_NAME}" 를 찾을 수 없습니다.`); return; }

  const data     = sheet.getDataRange().getValues(); // 1-indexed rows → data[i] = row i+1
  let lastYear   = 0;
  let targetRow  = -1;

  for (let i = 0; i < data.length; i++) {
    const yearNum  = parseInt(String(data[i][0] ?? '').replace(/[^0-9]/g, ''));
    if (yearNum >= 2000) lastYear = yearNum;
    const monthNum = parseInt(String(data[i][1] ?? '').replace(/[^0-9]/g, ''));
    if (lastYear === targetYear && monthNum === targetMonth) {
      targetRow = i + 1; // getRange는 1-based
      break;
    }
  }

  if (targetRow < 0) {
    console.log(`❌ ${targetYear}년 ${targetMonth}월 행을 시트에서 찾을 수 없습니다. 월별잔고 행이 존재하는지 확인하세요.`);
    return;
  }

  // 이미 값이 있으면 덮어쓰기 전에 로그 남기기
  const existI = sheet.getRange(targetRow, 9).getValue();
  const existJ = sheet.getRange(targetRow, 10).getValue();
  if (existI || existJ) {
    console.log(`  ⚠️ 기존값 덮어쓰기: I=${existI}, J=${existJ} → I=${Math.round(kospi)}, J=${Math.round(sp500)}`);
  }

  // I열(9번째 컬럼)·J열(10번째 컬럼)에 정수 종가 입력
  sheet.getRange(targetRow, 9).setValue(Math.round(kospi));
  sheet.getRange(targetRow, 10).setValue(Math.round(sp500));

  console.log(`✅ ${targetYear}-${String(targetMonth).padStart(2,'0')} (row ${targetRow}) → KOSPI ${Math.round(kospi)}, S&P500 ${Math.round(sp500)}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// 헬퍼: Yahoo Finance에서 해당 날짜 이전 최근 거래일 종가 반환
// ─────────────────────────────────────────────────────────────────────────────
function fetchLastClose(ticker, refDate) {
  try {
    const encoded = encodeURIComponent(ticker);
    // 말일 기준 ±7일 범위로 쿼리 (주말·공휴일 폴백)
    const period1 = Math.floor(new Date(refDate.getFullYear(), refDate.getMonth(), refDate.getDate() - 7).getTime() / 1000);
    const period2 = Math.floor(new Date(refDate.getFullYear(), refDate.getMonth(), refDate.getDate() + 1).getTime() / 1000);
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encoded}?interval=1d&period1=${period1}&period2=${period2}`;

    const resp = UrlFetchApp.fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      muteHttpExceptions: true,
    });

    if (resp.getResponseCode() !== 200) {
      console.log(`  HTTP ${resp.getResponseCode()} for ${ticker}`);
      return null;
    }

    const json   = JSON.parse(resp.getContentText());
    const closes = json?.chart?.result?.[0]?.indicators?.quote?.[0]?.close ?? [];
    const valid  = closes.filter(v => v !== null && v !== undefined && !isNaN(v));
    if (valid.length === 0) { console.log(`  종가 배열 비어있음: ${ticker}`); return null; }

    return valid[valid.length - 1]; // 범위 내 마지막 거래일 종가
  } catch (e) {
    console.log(`  fetchLastClose(${ticker}) 예외: ${e.message}`);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 헬퍼: Date → 'YYYY-MM-DD'
// ─────────────────────────────────────────────────────────────────────────────
function _fmt(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// 일괄 채우기: startYear-startMonth 부터 전월까지 한 번에 입력
// 예: fillAllSince(2025, 4)  → 2025-04 ~ 전월 전체 채우기
// ─────────────────────────────────────────────────────────────────────────────
function fillAllSince(startYear, startMonth) {
  const today     = new Date();
  const endYear   = today.getMonth() === 0 ? today.getFullYear() - 1 : today.getFullYear();
  const endMonth  = today.getMonth() === 0 ? 12 : today.getMonth(); // 전월 (0-based getMonth → 1-based 전월)

  const ss    = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) { console.log(`❌ 시트 "${SHEET_NAME}" 없음`); return; }

  let y = startYear, m = startMonth;
  let ok = 0, skip = 0, fail = 0;

  while (y < endYear || (y === endYear && m <= endMonth)) {
    const lastDay = new Date(y, m, 0); // 해당 월 말일

    const kospi = fetchLastClose('^KS11', lastDay);
    const sp500 = fetchLastClose('^GSPC', lastDay);

    if (kospi === null || sp500 === null) {
      console.log(`  ⚠️  ${y}-${String(m).padStart(2,'0')} 수집 실패 — 스킵`);
      fail++;
    } else {
      const row = _findRow(sheet, y, m);
      if (row < 0) {
        console.log(`  ⚠️  ${y}-${String(m).padStart(2,'0')} 시트 행 없음 — 스킵`);
        skip++;
      } else {
        sheet.getRange(row, 9).setValue(Math.round(kospi));
        sheet.getRange(row, 10).setValue(Math.round(sp500));
        console.log(`  ✅ ${y}-${String(m).padStart(2,'0')} row${row}: KOSPI ${Math.round(kospi)}, S&P ${Math.round(sp500)}`);
        ok++;
      }
    }

    // 다음 달로 이동
    m++;
    if (m > 12) { m = 1; y++; }

    // Yahoo Finance 과부하 방지 — 200ms 대기
    Utilities.sleep(200);
  }

  console.log(`\n완료: ✅ ${ok}건 성공 / ⚠️ ${skip}건 행없음 / ❌ ${fail}건 수집실패`);
}

// ─────────────────────────────────────────────────────────────────────────────
// 단일 월 수동 채우기: fillMonth(2026, 4)
// ─────────────────────────────────────────────────────────────────────────────
function fillMonth(year, month) {
  const ss    = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) { console.log(`❌ 시트 없음`); return; }

  const lastDay = new Date(year, month, 0);
  const kospi = fetchLastClose('^KS11', lastDay);
  const sp500 = fetchLastClose('^GSPC', lastDay);
  if (kospi === null || sp500 === null) { console.log('❌ 수집 실패'); return; }

  const row = _findRow(sheet, year, month);
  if (row < 0) { console.log(`❌ ${year}-${month} 행 없음`); return; }

  sheet.getRange(row, 9).setValue(Math.round(kospi));
  sheet.getRange(row, 10).setValue(Math.round(sp500));
  console.log(`✅ ${year}-${month} row${row}: KOSPI ${Math.round(kospi)}, S&P ${Math.round(sp500)}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// 내부: 시트에서 특정 연·월의 행 번호(1-based) 반환, 없으면 -1
// ─────────────────────────────────────────────────────────────────────────────
function _findRow(sheet, year, month) {
  const data = sheet.getDataRange().getValues();
  let lastYear = 0;
  for (let i = 0; i < data.length; i++) {
    const y = parseInt(String(data[i][0]??'').replace(/[^0-9]/g,''));
    if (y >= 2000) lastYear = y;
    const m = parseInt(String(data[i][1]??'').replace(/[^0-9]/g,''));
    if (lastYear === year && m === month) return i + 1;
  }
  return -1;
}
