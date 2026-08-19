// KRX Data Marketplace API 클라이언트 — 일별 배치 시세·기본정보 조회 전용(거래소 원천
// 데이터, Naver 스크래핑·yfinance·FDR 근사치보다 정확 — docs/DATA-SOURCES.md 참고).
// 인증: .env KRX_API_KEY(scripts/lib/auth.mjs loadEnv()로 로드 — DART_API_KEY와 동일 관례,
// 호출측 진입점이 loadEnv()를 먼저 불러야 process.env에 채워진다).

const BASE_URL = 'https://data-dbg.krx.co.kr/svc/apis';
// ⚠️ "-dbg"가 붙어있지만 실제 운영 호스트다(2026-08-19 KRX 개발명세서 PDF로 확정 —
// data.krx.co.kr·openapi.krx.co.kr 등 다른 후보는 전부 404, curl 실측). 비거래일(주말·
// 공휴일·데이터 미발행 당일)은 에러가 아니라 {"OutBlock_1":[]} 빈 배열로 온다(실측 확인,
// HTTP 200) — 호출측이 빈 배열을 "휴장일/미발행"으로 스킵 처리하면 된다.

// 단건 조회 — category(예: 'sto'|'idx'|'etp'|'gen') + API_ID(예: 'stk_bydd_trd') +
// params(예: {basDd:'20260818'}) → OutBlock_1 배열. 인증키 없으면 즉시 실패(추정 안 함).
export async function fetchKrx(category, apiId, params, { apiKey = process.env.KRX_API_KEY, fetchImpl = fetch } = {}) {
  if (!apiKey) throw new Error('KRX_API_KEY 미설정');
  const q = new URLSearchParams(params);
  const res = await fetchImpl(`${BASE_URL}/${category}/${apiId}?${q}`, { headers: { AUTH_KEY: apiKey } });
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
export async function fetchTradingDaySeries(fetchOneDay, days, { maxScanDays, delayMs = 120, startDate = new Date() } = {}) {
  const budget = maxScanDays ?? days * 2 + 15;
  const out = [];
  let d = new Date(startDate);
  let scanned = 0;
  while (out.length < days && scanned < budget) {
    const dow = d.getDay();
    if (dow !== 0 && dow !== 6) {
      const basDd = ymd(d);
      const rows = await fetchOneDay(basDd);
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
