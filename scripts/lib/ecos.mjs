// 한국은행 ECOS(경제통계시스템) API 클라이언트 — 국고채 금리 시계열 조회 전용.
// 인증: .env ECOS_API_KEY(auth.mjs loadEnv()로 로드 — DART_API_KEY·KRX_API_KEY와 동일 관례,
// 호출측 진입점이 loadEnv()를 먼저 불러야 process.env에 채워진다).
//
// 통계표코드·통계항목코드는 추정하지 않고 실제 API(StatisticItemList)로 확정했다
// (2026-09-12, ~/banana-vault/Knowledge/API/ECOS.md 참고) — "1.3.2.1. 시장금리(일별)"
// (817Y002) 아래 국고채 3년(010200000)·10년(010210000) 항목.

const BASE_URL = 'https://ecos.bok.or.kr/api';
export const MARKET_RATE_STAT_CODE = '817Y002';
export const GOV_BOND_ITEM_CODE = { '3Y': '010200000', '10Y': '010210000' };
const MAX_ROWS = 1000; // ECOS 요청 URL의 조회건수 범위(1~1000) — 아래 fetchEcosSeries 참고.

function ymd(d) {
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

// itemCode의 최근 daysBack일(달력일) 시계열 → { time: "YYYYMMDD", value: number }[]
// (과거→현재). yfinance 거시 티커의 "1y" 관례(yf-macro.py)와 맞추려고 기본 400일
// (주말·공휴일 빠져도 ~250거래일 이상 확보하는 여유). ECOS는 원래 거래일이 아닌
// 날짜는 응답 자체에서 빠져 있어(실측 확인) KRX처럼 거래일 스캔 루프가 필요 없다 —
// 날짜 범위 한 번 요청으로 끝난다.
//
// ⚠️ time을 버리지 않고 그대로 반환한다(2026-09-12, code-reviewer 지적 — 국고채
// 10년·3년을 각자 독립적으로 NaN 필터링하면 서로 다른 날짜가 같은 개수만큼 결측이라
// 우연히 길이가 같아지는 경우, 그 사실을 모른 채 서로 다른 날짜끼리 짝지어 스프레드를
// 계산할 위험이 있다 — 2026-08-05 코드리뷰가 미국 10Y-3M 경로에서 이미 한 번 지적한
// 것과 같은 버그 클래스. time을 유지해 fetchGovBondCloses가 실제로 같은 날짜끼리만
// 짝짓게 한다.
//
// ⚠️ 응답이 `{"RESULT":{"CODE":..., "MESSAGE":...}}` 형태면(정상 데이터 응답과 스키마
// 자체가 다름, 실측 확인 — 잘못된 통계표/항목코드·유효기간 지난 인증키 등) 에러로
// 취급해 그 메시지를 그대로 노출한다 — 조용히 빈 배열로 폴백하지 않는다(feedback-
// no-silent-fallback 원칙). rows가 빈 배열이면(RESULT 없이 정상 스키마인데 0건)도
// 마찬가지로 에러 — 400일 범위 조회에서 0건은 정상 상황이 아니다.
export async function fetchEcosSeries(itemCode, {
  statCode = MARKET_RATE_STAT_CODE, daysBack = 400, endDate = new Date(),
  apiKey = process.env.ECOS_API_KEY, fetchImpl = fetch,
} = {}) {
  if (!apiKey) throw new Error('ECOS_API_KEY 미설정');
  const start = ymd(new Date(endDate.getTime() - daysBack * 86400000));
  const end = ymd(endDate);
  const url = `${BASE_URL}/StatisticSearch/${apiKey}/json/kr/1/${MAX_ROWS}/${statCode}/D/${start}/${end}/${itemCode}`;
  const res = await fetchImpl(url);
  if (res.ok === false) throw new Error(`ECOS API HTTP ${res.status}(itemCode=${itemCode})`);
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { throw new Error(`ECOS API 응답 파싱 실패(itemCode=${itemCode}): ${text.slice(0, 200)}`); }
  if (json?.RESULT) throw new Error(`ECOS API 오류(itemCode=${itemCode}): ${json.RESULT.CODE} ${json.RESULT.MESSAGE}`);
  const search = json?.StatisticSearch;
  const rows = search?.row;
  if (!Array.isArray(rows)) throw new Error(`ECOS API 응답 이상(StatisticSearch.row 없음, itemCode=${itemCode}): ${text.slice(0, 200)}`);
  // 페이지네이션 초과 감지 — 응답이 앞쪽 MAX_ROWS건만 담고(오름차순 정렬이라 가장
  // 오래된 구간) 최신 구간이 조용히 잘릴 수 있다. daysBack이 지금보다 늘어나면
  // 발생할 수 있는 함정이라 지금 당장은 안 터져도 가드를 심어둔다.
  if (Number.isFinite(search?.list_total_count) && search.list_total_count > MAX_ROWS) {
    throw new Error(`ECOS API 응답 페이지네이션 초과(itemCode=${itemCode}, list_total_count=${search.list_total_count} > ${MAX_ROWS}) — daysBack을 줄이거나 페이지 순회 구현 필요`);
  }
  if (rows.length === 0) throw new Error(`ECOS API 응답에 데이터 없음(itemCode=${itemCode}, 기간 ${start}~${end})`);
  return rows
    .map((r) => ({ time: r.TIME, value: parseFloat(r.DATA_VALUE) }))
    .filter((r) => r.time && Number.isFinite(r.value));
}

// 국고채 10년·3년 종가를 시각(TIME) 기준으로 짝지어 반환한다 —
// computeRateSpreadSignal(macro-overlay.mjs, 미국 10Y-3M과 동일 함수 재사용)에 바로
// 넘길 수 있는 두 숫자 배열(같은 인덱스=같은 날짜가 보장됨, 각자 독립 필터링 후
// 우연히 길이만 같아지는 위험 없음).
export async function fetchGovBondCloses(opts = {}) {
  const [tenYear, threeYear] = await Promise.all([
    fetchEcosSeries(GOV_BOND_ITEM_CODE['10Y'], opts),
    fetchEcosSeries(GOV_BOND_ITEM_CODE['3Y'], opts),
  ]);
  const threeYearByTime = new Map(threeYear.map((r) => [r.time, r.value]));
  const tenYearAligned = [];
  const threeYearAligned = [];
  for (const r of tenYear) {
    if (threeYearByTime.has(r.time)) {
      tenYearAligned.push(r.value);
      threeYearAligned.push(threeYearByTime.get(r.time));
    }
  }
  return { tenYear: tenYearAligned, threeYear: threeYearAligned };
}
