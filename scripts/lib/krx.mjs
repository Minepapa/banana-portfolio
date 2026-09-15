// KRX Data Marketplace API 클라이언트 — 일별 배치 시세·기본정보 조회 전용(거래소 원천
// 데이터, Naver 스크래핑·yfinance·FDR 근사치보다 정확 — docs/DATA-SOURCES.md 참고).
// 인증: .env KRX_API_KEY(scripts/lib/auth.mjs loadEnv()로 로드).
import { loadEnv } from './auth.mjs';
import { fetchRetry } from './fetch-retry.mjs';

const BASE_URL = 'https://data-dbg.krx.co.kr/svc/apis';
const REQUEST_TIMEOUT_MS = 15_000;

// 재시도+타임아웃 기본 fetchImpl(2026-09-15 신설) — 이 파일 자신이 164~170행에 적어둔
// 대로 "KRX 서버가 긴 연속 호출 도중 연결을 끊는 사례"가 실측 확인돼 있는데,
// fetchIndexCloseSeriesInRange 신설로 한 번의 백필이 수천 건 순차호출을 낼 수 있게 되면서
// (코드리뷰 지적) 이 노출이 커졌다. fetchRetry(429/5xx+네트워크오류 지수백오프 재시도)를
// 기본값으로 채택 + 매 시도마다 독립된 15초 타임아웃(AbortSignal.timeout, 재시도 전체가
// 아니라 시도 1회당 — 재시도할수록 예산이 눌리지 않게). 테스트는 fetchImpl을 직접
// 주입하므로 영향 없음.
async function defaultFetchImpl(url, opts) {
  return fetchRetry(url, opts, {
    fetchImpl: (u, o) => fetch(u, { ...o, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }),
  });
}
// ⚠️ "-dbg"가 붙어있지만 실제 운영 호스트다(2026-08-19 KRX 개발명세서 PDF로 확정 —
// data.krx.co.kr·openapi.krx.co.kr 등 다른 후보는 전부 404, curl 실측). 비거래일(주말·
// 공휴일·데이터 미발행 당일)은 에러가 아니라 {"OutBlock_1":[]} 빈 배열로 온다(실측 확인,
// HTTP 200) — 호출측이 빈 배열을 "휴장일/미발행"으로 스킵 처리하면 된다.

// 단건 조회 — category(예: 'sto'|'idx'|'etp'|'gen') + API_ID(예: 'stk_bydd_trd') +
// params(예: {basDd:'20260818'}) → OutBlock_1 배열. 인증키 없으면 즉시 실패(추정 안 함).
//
// ⚠️ loadEnv() 자체 호출(2026-09-15 신설) — 원래는 "호출측 진입점이 loadEnv()를
// 먼저 불러야 한다"는 관례였는데(update-holdings-prices.mjs가 이 관례를 지킨 예),
// index-price-cache.mjs를 KRX API로 마이그레이션하면서 그 관례를 몰랐던(또는
// 안 지켜도 되던 FDR 시절 그대로 남아있던) 새 호출측 5~6곳이 전부 즉시 크래시했다
// (daily-breakout-signal-scan.mjs 등, KRX_API_KEY가 필요해진 줄도 모르고 있었음).
// loadEnv()는 idempotent+저렴(auth.mjs의 모듈스코프 가드로 두 번째 호출부터는 파일
// I/O 자체를 스킵 — 2026-09-15 코드리뷰 지적으로 실제로 그렇게 만듦, 이전엔 매
// 호출마다 동기 readFileSync가 반복돼 대량호출 시 이벤트루프 블록 우려가 있었다)라,
// 매번 호출측이 기억해야 하는 대신 이 함수 자신이 보장하는 쪽으로 바꿔 이 실패
// 클래스를 구조적으로 없앤다.
export async function fetchKrx(category, apiId, params, { apiKey, fetchImpl = defaultFetchImpl } = {}) {
  if (!apiKey) loadEnv();
  const key = apiKey ?? process.env.KRX_API_KEY;
  if (!key) throw new Error('KRX_API_KEY 미설정');
  const q = new URLSearchParams(params);
  const res = await fetchImpl(`${BASE_URL}/${category}/${apiId}?${q}`, { headers: { AUTH_KEY: key } });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { throw new Error(`KRX API 응답 파싱 실패(${category}/${apiId}): ${text.slice(0, 200)}`); }
  if (!res.ok) throw new Error(`KRX API HTTP ${res.status}(${category}/${apiId}): ${json?.respMsg || text.slice(0, 200)}`);
  if (!Array.isArray(json.OutBlock_1)) throw new Error(`KRX API 응답 이상(OutBlock_1 없음, ${category}/${apiId}): ${text.slice(0, 200)}`);
  return json.OutBlock_1;
}

// Date → "YYYYMMDD"(KRX basDd 파라미터 형식). 순수함수 — 테스트 가능.
export function ymd(d) {
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// startDate에서 과거로 하루씩 걸어가며 "실제 거래일" 데이터만 days건 모은다. 주말(토·일)은
// API를 아예 호출하지 않고 건너뛰고, 평일인데도 빈 배열이 오면(공휴일·데이터 미발행) 그
// 날도 스킵한다 — 둘 다 결과 목록엔 안 남지만 "평일 호출" 쪽만 scanned 예산을 소모한다
// (주말은 API 호출 자체가 없어 예산 대상이 아님). fetchOneDay(basDd:string) => rows(배열,
// 빈 배열=비거래일) 을 주입받는다(네트워크와 분리 — 테스트는 mock으로). 과거→현재 순 반환.
//
// ⚠️ 평일 빈 응답 재시도(2026-09-06 신설) — 공휴일 캘린더가 없어(order-gate.mjs
// checkMarketOpen과 동일 한계) "진짜 휴장일"과 "KRX 서버 측 일시적 미발행"을 코드로
// 구분할 방법이 없었다. 실사고로 발견: themis-risk-review.mjs(07:00)와 weekly-
// report.mjs(08:00)가 같은 일요일 아침 1시간 간격으로 이 함수를 호출했는데 5거래일
// 변화율이 서로 크게 달랐다(Log/DevRequests/2026-09-06-weekly-report-facts-불일치-
// 버그.md) — 유력한 설명은 특정 과거 거래일 하나가 한쪽 호출 시점엔 KRX 서버에서
// 일시적으로 빈 응답이었다가 다른 쪽 호출 시점엔 정상 발행돼 있어, "5거래일 전"
// 기준점 자체가 실행마다 하루씩 밀렸다는 것. 빈 응답을 받으면 짧게 기다렸다가 그
// 날짜로 한 번 더 확인한다 — 진짜 휴장일이면 재시도해도 여전히 비어있고(정상,
// scanned만 소모), 일시적 문제였다면 대부분 해소된다.
export async function fetchTradingDaySeries(fetchOneDay, days, {
  maxScanDays, delayMs = 120, startDate = new Date(), emptyRetryDelayMs = 500,
} = {}) {
  const budget = maxScanDays ?? days * 2 + 15;
  const out = [];
  let d = new Date(startDate);
  let scanned = 0;
  while (out.length < days && scanned < budget) {
    const dow = d.getDay();
    if (dow !== 0 && dow !== 6) {
      const basDd = ymd(d);
      let rows = await fetchOneDay(basDd);
      if (!(rows && rows.length)) {
        if (emptyRetryDelayMs > 0) await sleep(emptyRetryDelayMs);
        rows = await fetchOneDay(basDd);
      }
      if (rows && rows.length) out.push({ basDd, rows });
      scanned++;
      if (delayMs > 0 && scanned < budget && out.length < days) await sleep(delayMs);
    }
    d = new Date(d.getTime() - 86400000);
  }
  return out.reverse();
}

// 주식 일별매매정보(sto 카테고리) API ID — 시장별.
export const STOCK_API = { KOSPI: 'stk_bydd_trd', KOSDAQ: 'ksq_bydd_trd' };
// 지수 일별시세정보(idx 카테고리) API ID — 시리즈별.
export const INDEX_API = { KOSPI: 'kospi_dd_trd', KOSDAQ: 'kosdaq_dd_trd' };

export function fetchStockDaily(market, basDd, opts) {
  return fetchKrx('sto', STOCK_API[market], { basDd }, opts);
}

// ETF 일별매매정보(etp 카테고리) — ⚠️ ETF는 sto/{stk,ksq}_bydd_trd(유가증권/코스닥
// 일별매매정보)에 안 섞여 있다(2026-08-19 실측 확인: stk_bydd_trd 942종목 중 TIGER·
// KODEX·ACE·PLUS·KoAct 매칭 0건 — KRX가 "주식"과 "증권상품(ETF/ETN/ELW)"을 카탈로그
// 상 별도 카테고리로 분리해뒀다). 개별종목 시세 조회에서 ETF를 놓치면 조용히 실패가
// 아니라 "이 종목은 KOSPI/KOSDAQ 어디에도 없다"는 잘못된 결론(throw)이 나므로, KR
// 종목 시세를 찾을 땐 반드시 이 함수도 같이 조회해야 한다(krx-price-cache.mjs 참고).
export function fetchEtfDaily(basDd, opts) {
  return fetchKrx('etp', 'etf_bydd_trd', { basDd }, opts);
}

export function fetchIndexDaily(market, basDd, opts) {
  return fetchKrx('idx', INDEX_API[market], { basDd }, opts);
}

// indexNm(예: '코스피'·'코스닥' — idx/{kospi,kosdaq}_dd_trd 한 날짜분 응답의 IDX_NM 필드와
// 정확히 일치해야 함, 계열 안에 코스피200 등 파생지수가 다건 섞여 있어 정확매칭 필요)의
// 최근 days거래일 종가 시계열(과거→현재)을 뽑는다. Naver·yfinance ^KS11/^KQ11 대비 당일
// 반영 지연이 없다(2026-08-19 docs/DATA-SOURCES.md 카탈로그 마이그레이션).
export async function fetchIndexCloses(market, indexNm, days, opts = {}) {
  const series = await fetchTradingDaySeries((basDd) => fetchIndexDaily(market, basDd, opts), days, opts);
  const closes = [];
  for (const { rows } of series) {
    const row = rows.find((r) => r.IDX_NM === indexNm);
    // Number('')===0 함정 방어 — 값 없는 지수 행(예: "코스피 (외국주포함)")이 빈 문자열로
    // 옴(2026-08-19 실측), 빈 문자열은 진짜 0과 구분해 스킵한다.
    if (!row || String(row.CLSPRC_IDX ?? '').trim() === '') continue;
    const v = Number(row.CLSPRC_IDX);
    if (Number.isFinite(v)) closes.push(v);
  }
  return closes;
}

// startDate~endDate("YYYY-MM-DD") 사이 지수 종가 시계열(날짜+값 쌍)을 정확한 구간으로
// 뽑는다 — fetchIndexCloses는 "오늘 기준 최근 N거래일"만 지원해 장기 백테스트 벤치마크
// (임의 과거 구간)엔 못 쓴다(2026-09-15 신설, index-price-cache.mjs가 FinanceDataReader
// 의존을 KRX 공식 API로 교체하며 필요해짐 — docs/DATA-SOURCES.md §5는 이 대체를
// "미실행 후보"로만 올려뒀었다, "전환 완료"가 아니었음. 이 마이그레이션은 그 후보를
// 실제로 실행에 옮긴 것 + FDR 값 자체는 KRX와 독립대조해 동일함을 확인, 정확도
// 문제가 아니라 소스 일관성/지연이슈 제거 목적. docs/DATA-SOURCES.md §4에 반영).
// 날짜 문자열을 정오(T12:00:00) 기준으로 Date 파싱 — 자정 기준으로 하면 시스템
// 타임존이 UTC보다 뒤일 때 하루 밀려 요일판정이 틀어질 수 있어(assertDateStrings류
// 함정과 동일 클래스) 정오로 여유를 둔다.
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function fetchIndexCloseSeriesInRange(market, indexNm, startDate, endDate, opts = {}) {
  if (!DATE_RE.test(startDate) || !DATE_RE.test(endDate)) {
    throw new Error(`fetchIndexCloseSeriesInRange: startDate/endDate는 "YYYY-MM-DD" 형식이어야 함(받은 값: ${JSON.stringify(startDate)}, ${JSON.stringify(endDate)})`);
  }
  if (startDate > endDate) {
    throw new Error(`fetchIndexCloseSeriesInRange: startDate(${startDate})가 endDate(${endDate})보다 나중일 수 없음`);
  }
  const start = new Date(`${startDate}T12:00:00`);
  const end = new Date(`${endDate}T12:00:00`);
  const calendarDays = Math.max(1, Math.round((end - start) / 86400000)) + 1;
  const estTradingDays = Math.ceil((calendarDays * 5) / 7) + 15; // 공휴일 여유
  const raw = await fetchTradingDaySeries((basDd) => fetchIndexDaily(market, basDd, opts), estTradingDays, {
    ...opts, startDate: end, maxScanDays: calendarDays + 30,
  });
  const out = [];
  for (const { basDd, rows } of raw) {
    const date = `${basDd.slice(0, 4)}-${basDd.slice(4, 6)}-${basDd.slice(6, 8)}`;
    if (date < startDate) continue; // estTradingDays가 넉넉해 startDate보다 이전 것도 섞여 들어올 수 있음
    const row = rows.find((r) => r.IDX_NM === indexNm);
    if (!row || String(row.CLSPRC_IDX ?? '').trim() === '') continue;
    const close = Number(row.CLSPRC_IDX);
    if (Number.isFinite(close)) out.push({ date, close });
  }
  return out;
}

const numOrNull = (v) => (String(v ?? '').trim() === '' ? null : (Number.isFinite(Number(v)) ? Number(v) : null));

// isuNms(ETF 종목명 배열, etp/etf_bydd_trd 응답의 ISU_NM과 정확히 일치)의 최근
// days거래일 시계열을 종목별로 한 번에 뽑는다 — 종가·NAV·거래대금·추적지수 종가
// (scripts/lib/instrument-scoring.mjs의 유동성·NAV괴리율·추적오차·수익률 스코어링
// 입력). 실측(2026-09-06, KODEX 200): ACC_TRDVAL=거래대금(원), NAV=순자산가치,
// IDX_IND_NM=추적 지수명, OBJ_STKPRC_IDX=그 지수 종가 — 같은 행에 다 있어 별도
// 지수매핑표가 필요 없다. fetchIndexCloses와 동일하게 Number('')===0 함정 방어(값
// 없는 필드는 빈 문자열로 옴).
//
// ⚠️ 종목별로 나눠 호출(fetchEtfSeries)하면 매번 같은 날짜들을 처음부터 다시
// 스캔한다(days=252 기준 종목당 최대 ~250회 HTTP 호출) — 코드리뷰 지적(2026-09-06)
// 으로 발견한 실측 병목(자산군 하나 스코어링에 분 단위 소요, KRX 서버가 긴 연속
// 호출 도중 연결을 끊는 사례도 실제로 확인됨). 이 함수는 날짜별 원본 응답(rows)을
// 한 번만 받아 그 안에서 여러 ISU_NM을 동시에 찾는다 — 네트워크 호출 횟수가
// O(종목수 × days)에서 O(days)로 준다. rankAssetClassUniverse가 한 자산군의 KRX
// 후보 전체를 이걸로 한 번에 조회한다.
export async function fetchEtfSeriesForNames(isuNms, days, opts = {}) {
  const series = await fetchTradingDaySeries((basDd) => fetchEtfDaily(basDd, opts), days, opts);
  const out = Object.fromEntries(isuNms.map((n) => [n, []]));
  for (const { basDd, rows } of series) {
    for (const isuNm of isuNms) {
      const row = rows.find((r) => r.ISU_NM === isuNm);
      if (!row) continue;
      const close = numOrNull(row.TDD_CLSPRC);
      if (close === null) continue;
      out[isuNm].push({
        basDd, close,
        nav: numOrNull(row.NAV),
        accTrdVal: numOrNull(row.ACC_TRDVAL),
        idxClose: numOrNull(row.OBJ_STKPRC_IDX),
        idxName: row.IDX_IND_NM || null,
      });
    }
  }
  return out;
}

// 종목 하나만 필요할 때의 얇은 래퍼(기존 호출부·테스트 호환 유지).
export async function fetchEtfSeries(isuNm, days, opts = {}) {
  const result = await fetchEtfSeriesForNames([isuNm], days, opts);
  return result[isuNm];
}

// 금현물(1kg 단위 상품, 원/g 단가) 최근 거래일 종가 — NH 금현물 계좌(KIS·DART 어디에도
// 종목코드가 없는 실물자산이라 다른 수단이 없음)의 시세 원천. 실측(2026-08-19): 이
// 상품의 TDD_CLSPRC는 원/g 단가로 온다(보유 평단가와 자릿수·단위 정합 확인됨,
// docs/DATA-SOURCES.md 참고). KRX는 일별 배치라 당일 데이터는 장마감 후에나 발행되므로
// fetchTradingDaySeries로 최근 1거래일을 찾을 때까지 워크백한다 — 실패하면 throw
// (다른 소스로 폴백 없음, feedback-no-silent-fallback 원칙).
export const GOLD_ISU_NM = '금 99.99_1kg';

export async function fetchGoldClose(opts = {}) {
  const series = await fetchTradingDaySeries(
    (basDd) => fetchKrx('gen', 'gold_bydd_trd', { basDd }, opts),
    1,
    { maxScanDays: 10, ...opts },
  );
  if (!series.length) throw new Error('KRX 금 시세 조회 실패 — 최근 거래일 데이터 없음(휴장 연속·API 이상 확인 필요)');
  const row = series[0].rows.find((r) => r.ISU_NM === GOLD_ISU_NM);
  if (!row || String(row.TDD_CLSPRC ?? '').trim() === '') throw new Error(`KRX 금 시세 응답에 "${GOLD_ISU_NM}" 종가 없음`);
  const price = Number(row.TDD_CLSPRC);
  if (!Number.isFinite(price)) throw new Error(`KRX 금 시세 파싱 실패: ${row.TDD_CLSPRC}`);
  return { price, basDd: series[0].basDd };
}
