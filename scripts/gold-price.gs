/**
 * 현재가 자동 갱신 — Google Apps Script
 *
 * [트리거 설정]
 *   함수: updateAllPrices | 시간 기반 | 1시간마다
 *
 * [갱신 항목]
 *   위탁!F6      ← 국내 금 시세 (네이버 finance)
 *   연금저축!F15 ← VIP한국형가치투자 기준가 (vipasset.co.kr)
 */

const SHEET_ID = '1ANhZyJUm51T8HfvQ56sK-Xrli9IViKmKG462l9rLKeg';

const FETCH_OPTS = {
  muteHttpExceptions: true,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept-Language': 'ko-KR,ko;q=0.9',
  },
};

// ── 진단용 ────────────────────────────────────────────────────────────────────
function debugFundHtml() {
  const pageUrl = 'https://vipasset.co.kr/fund3/2129';
  const html    = UrlFetchApp.fetch(pageUrl, FETCH_OPTS).getContentText('UTF-8');

  // className 초기값 탐색
  const classIdx = html.search(/className\s*=|let className|var className|className:/);
  if (classIdx !== -1) {
    Logger.log('=== className 초기화 ===');
    Logger.log(html.substring(Math.max(0, classIdx - 50), classIdx + 300));
  }

  // opt2 주변 — select 옵션에서 클래스 코드 확인
  const opt2Idx = html.search(/opt2|class.*select|select.*class/i);
  if (opt2Idx !== -1) {
    Logger.log('=== opt2 / class select 주변 ===');
    Logger.log(html.substring(Math.max(0, opt2Idx - 100), opt2Idx + 500));
  }

  // opt 값별로 C-Pe 데이터 탐색 (어떤 opt가 2276을 반환하는지 확인)
  for (let opt = 1; opt <= 6; opt++) {
    const apiUrl = 'https://vipasset.co.kr/modules/page/get_fund_data.php?opt=' + opt + '&opt2=C-Pe';
    const r      = UrlFetchApp.fetch(apiUrl, FETCH_OPTS);
    const body   = r.getContentText('UTF-8');
    // standardPrice 값만 추출해서 출력
    const match  = body.match(/"standardPrice":"([\d.]+)"/);
    const lastMatch = body.match(/.*"standardPrice":"([\d.]+)"/);
    Logger.log('opt=' + opt + ' → standardPrice 첫값=' + (match ? match[1] : '없음') + ' | 응답앞100=' + body.substring(0, 100));
  }
}

// ── 금 가격 추출 ──────────────────────────────────────────────────────────────
// 네이버 안티스크래핑 구조:
//   <span class="no2">2</span><span class="no1">1</span>...
//   각 자릿수를 class="noX" (X=실제숫자)로 분리해서 렌더링
function tryParsePrice(html) {
  // <p class="no_today"> 안의 첫 번째 <em> 에서 정수 부분만 추출
  const sectionStart = html.indexOf('class="no_today"');
  if (sectionStart !== -1) {
    const emStart = html.indexOf('<em', sectionStart);
    const emEnd   = html.indexOf('</em>', emStart);
    if (emStart !== -1 && emEnd !== -1) {
      const emContent     = html.substring(emStart, emEnd);
      const beforeDecimal = emContent.split('class="jum"')[0]; // 소수점 앞만
      const digitMatches  = beforeDecimal.match(/class="no(\d)"/g) || [];
      if (digitMatches.length >= 5) {
        const priceStr = digitMatches.map(m => m.match(/no(\d)/)[1]).join('');
        const price    = parseInt(priceStr, 10);
        if (price >= 100000 && price <= 999999) {
          Logger.log('[OK] no_today span 파싱: ' + price);
          return price;
        }
      }
    }
  }
  Logger.log('[MISS] no_today 패턴 미발견');
  return null;
}

// ── 금 시세 (네이버 finance) ──────────────────────────────────────────────────
function fetchGoldPrice() {
  const res = UrlFetchApp.fetch('https://finance.naver.com/marketindex/goldDetail.naver', FETCH_OPTS);
  if (res.getResponseCode() !== 200) throw new Error('네이버 응답 오류: HTTP ' + res.getResponseCode());

  const html  = res.getContentText('EUC-KR');
  const price = tryParsePrice(html);
  if (price) return price;
  throw new Error('금 가격 파싱 실패 — tryParsePrice 확인 필요');
}

// ── VIP 펀드 기준가 (vipasset.co.kr 내부 API) ────────────────────────────────
// API: /modules/page/get_fund_data.php?opt=1&opt2=C-Pe
// 응답: [{ standardPrice: "2185.000000", date: "20260501", ... }, ...]
// 마지막 요소가 최신 기준가
function fetchVipFundPrice() {
  const url = 'https://vipasset.co.kr/modules/page/get_fund_data.php?opt=1&opt2=C-Pe';
  const res = UrlFetchApp.fetch(url, FETCH_OPTS);
  if (res.getResponseCode() !== 200) throw new Error('VIP API 오류: HTTP ' + res.getResponseCode());

  const data   = JSON.parse(res.getContentText('UTF-8'));
  // 배열은 날짜 오름차순 — 마지막 요소가 가장 최신 기준가
  const latest = data[data.length - 1];
  Logger.log('[VIP] 기준일=' + latest.date + ' standardPrice=' + latest.standardPrice);
  const price  = Math.round(parseFloat(latest.standardPrice));

  if (!price || price < 100) throw new Error('VIP 기준가 이상: ' + latest.standardPrice);
  return price;
}

// ── 시트 쓰기 헬퍼 ───────────────────────────────────────────────────────────
function writeCell(sheetName, cell, value) {
  const sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName(sheetName);
  if (!sheet) throw new Error('시트 없음: ' + sheetName);
  sheet.getRange(cell).setValue(value);
}

// ── 개별 업데이트 ─────────────────────────────────────────────────────────────
function updateGoldPrice() {
  const price = fetchGoldPrice();
  writeCell('위탁', 'F6', price);
  Logger.log('✅ 금 ' + price.toLocaleString() + '원/g → 위탁!F6');
}

function updateVipFundPrice() {
  const price = fetchVipFundPrice();
  writeCell('연금저축', 'F15', price);
  Logger.log('✅ VIP펀드 ' + price.toLocaleString() + '원 → 연금저축!F15');
}

// ── 트리거에 등록할 함수 ──────────────────────────────────────────────────────
function updateAllPrices() {
  updateGoldPrice();
  updateVipFundPrice();
}

// ── 연금저축 15행 수식 초기 설정 (1회만 실행) ────────────────────────────────
function setupPensionFundRow15() {
  const sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName('연금저축');
  sheet.getRange('D15').setValue(7914444);               // 보유 좌수
  sheet.getRange('C15').setFormula('=E15/D15*1000');     // 평균 매수 기준가 (역산)
  sheet.getRange('H15').setFormula('=D15*F15/1000');     // 평가금 (1,000좌당 기준가)
  sheet.getRange('G15').setFormula('=H15-E15');          // 수익손실
  sheet.getRange('I15').setFormula('=G15/E15*100');      // 수익률
  Logger.log('✅ 연금저축 15행 수식 설정 완료');
}
