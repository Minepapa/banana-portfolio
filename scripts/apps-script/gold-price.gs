/**
 * 현재가 자동 갱신 — Google Apps Script
 *
 * [트리거 설정]
 *   함수: updateAllPrices | 시간 기반 | 1시간마다
 *
 * [갱신 항목]
 *   위탁!F7      ← 국내 금 시세 (KRX Data Marketplace 금시장 일별매매정보, 2026-08-19
 *                  네이버 HTML 스크래핑에서 대체 — 사전에 스크립트 속성에 KRX_API_KEY
 *                  등록 필요, fetchGoldPrice() 주석 참고)
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

// ── 금 시세 (KRX Data Marketplace, 2026-08-19 — 네이버 HTML 안티스크래핑 파싱 대체) ──
// 기존엔 네이버 goldDetail 페이지의 <span class="noX">(자릿수별 CSS 클래스로 렌더링하는
// 안티스크래핑 구조)를 역조립해서 가격을 뽑아냈다 — 부서지기 쉽고(마크업 바뀌면 즉시
// 파싱 실패) 공식 출처도 아니었다. KRX Data Marketplace의 "금시장 일별매매정보"
// (gen/gold_bydd_trd)가 정확히 같은 상품("금 99.99_1kg")을 공식 거래소 원천으로 제공함을
// 실측 확인(2026-08-19, docs/DATA-SOURCES.md) — TDD_CLSPRC가 원/g 단가로 온다(실측:
// 199,950 — 보유 평단가 208,473원/g와 같은 자릿수대, 단위 정합 확인됨).
//
// ⚠️ KRX는 일별 배치라 당일 데이터는 장마감 후에나 발행된다(장중에 오늘 날짜로 조회하면
// 빈 배열) — 발행 전이거나 휴장일이면 하루씩 과거로 물러나며 최대 5거래일 전까지
// 찾는다(이건 "다른 소스로 폴백"이 아니라 이 API 고유의 배치 발행 타이밍을 감안한
// 정상 재시도 — banana-portfolio-v2의 feedback-no-silent-fallback 원칙과 무관: 실패하면
// throw만 하고, 절대 네이버 등 다른 소스로 조용히 넘어가지 않는다).
//
// [사전 설정] KRX_API_KEY를 이 Apps Script 프로젝트의 스크립트 속성에 등록해야 한다:
//   프로젝트 설정(⚙️) > 스크립트 속성 > 속성 추가 → 이름: KRX_API_KEY, 값: <발급받은 키>
//   (banana-portfolio-v2 리포 .env의 KRX_API_KEY와 같은 값 — 코드에 직접 넣지 않는다)
function ymd_(d) {
  return Utilities.formatDate(d, 'Asia/Seoul', 'yyyyMMdd');
}

function fetchGoldPrice() {
  const apiKey = PropertiesService.getScriptProperties().getProperty('KRX_API_KEY');
  if (!apiKey) throw new Error('KRX_API_KEY 스크립트 속성 미설정 — 프로젝트 설정 > 스크립트 속성에서 등록 필요');

  const opts = { muteHttpExceptions: true, headers: { AUTH_KEY: apiKey } };
  let d = new Date();
  for (let i = 0; i < 5; i++) {
    const basDd = ymd_(d);
    const url = 'https://data-dbg.krx.co.kr/svc/apis/gen/gold_bydd_trd?basDd=' + basDd;
    const res = UrlFetchApp.fetch(url, opts);
    if (res.getResponseCode() !== 200) {
      throw new Error('KRX API 오류: HTTP ' + res.getResponseCode() + ' — ' + res.getContentText('UTF-8').substring(0, 200));
    }
    const json = JSON.parse(res.getContentText('UTF-8'));
    const rows = json.OutBlock_1 || [];
    const row  = rows.filter(function (r) { return r.ISU_NM === '금 99.99_1kg'; })[0];
    if (row && row.TDD_CLSPRC) {
      const price = parseInt(String(row.TDD_CLSPRC).replace(/,/g, ''), 10);
      Logger.log('[OK] KRX 금 99.99_1kg 종가(' + basDd + '): ' + price + '원/g');
      return price;
    }
    d.setDate(d.getDate() - 1); // 당일 미발행/휴장일 — 하루 전으로(다른 소스 폴백 아님)
  }
  throw new Error('KRX 금 시세 조회 실패 — 최근 5거래일 모두 데이터 없음(API 이상·장기 휴장 여부 확인 필요)');
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
  writeCell('위탁', 'F7', price);
  Logger.log('✅ 금 ' + price.toLocaleString() + '원/g → 위탁!F7');
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
