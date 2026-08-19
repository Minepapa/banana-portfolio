// 퀀트 트랙 유니버스(시가총액 상위 200(코스피)+150(코스닥) 근사) — KRX API 기반,
// fdr-universe.py(FinanceDataReader/Python) 완전 대체. 2026-08-19, docs/DATA-SOURCES.md
// 카탈로그에 따른 마이그레이션 1단계(거래대금·시가총액).
//
// ⚠️ 여전히 공식 코스피200·코스닥150 지수 구성종목이 아니라 시가총액 상위 근사다 —
// KRX Data Marketplace 카탈로그에 지수 구성종목(멤버십) API가 없음을 확정 확인했다
// (2026-08-19, 전체 서비스 목록 실사 — 업종배분 등 KRX의 추가 선정기준은 여전히 반영
// 안 됨). fdr-universe.py와 동일한 트레이드오프가 남아있다는 뜻 — 이건 그대로 승계.
//
// fdr-universe.py 대비 정확도가 개선된 지점: 거래대금이 더 이상 종가×거래량 근사가
// 아니라 KRX가 직접 집계한 실제 값(ACC_TRDVAL)이고, 보통주 판별도 fdr.StockListing()의
// 파생 컬럼 대신 KRX 원본 데이터(ISU_CD·ISU_NM)로 직접 계산한다.
import { fetchStockDaily, fetchTradingDaySeries } from './krx.mjs';

export const MIN_FILL_RATIO = 0.9;   // 시장별 요청 개수 대비 최소 확보 비율
export const MAX_NULL_RATIO = 0.2;   // 유동성 조회 실패 허용 상한(이 이상이면 시스템 장애로 간주)
export const MIN_WINDOW_RATIO = 0.9; // 거래일 수 요구치(짧은 창을 "N일 평균"으로 위장하지 않음)

// Number('')===0이라 "필드 없음/빈 문자열"과 "진짜 0"을 구분 못 하는 함정 방지(krx.mjs
// 계열 API 전반에서 값이 없는 필드가 빈 문자열로 옴, 2026-08-19 실측 — 예: 일부 지수
// 계열의 CLSPRC_IDX가 "").
const num = (v) => {
  if (v === undefined || v === null || String(v).trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

// KRX 관행상 보통주 코드는 마지막 자리가 '0'(우선주는 다른 숫자·문자). 이름 끝 "우"·"우B"
// 패턴도 이중 확인(fdr-universe.py is_common_share와 동일 판정 기준, 데이터 소스만 교체).
export function isCommonShare(code, name) {
  const c = String(code ?? '');
  const n = String(name ?? '');
  return c.endsWith('0') && !n.endsWith('우') && !n.endsWith('우B');
}

// 최신 거래일 배치(sto/{stk,ksq}_bydd_trd 한 날짜분 rows)에서 시가총액 상위 n개 보통주만
// 추출. 순수함수 — 테스트 가능. 확보량이 n*MIN_FILL_RATIO 미만이면 데이터 소스 장애로
// 의심해 즉시 실패(개별 종목 결측이 아니라 시장 전체 이상 신호이므로 조용히 넘기지 않음).
export function topByMarketCap(latestDayRows, n, market) {
  const candidates = (latestDayRows ?? [])
    .filter((r) => isCommonShare(r.ISU_CD, r.ISU_NM))
    .map((r) => ({ Code: r.ISU_CD, Name: r.ISU_NM, Marcap: num(r.MKTCAP) }))
    .filter((c) => c.Marcap != null && c.Marcap > 0);
  candidates.sort((a, b) => b.Marcap - a.Marcap);
  const got = candidates.slice(0, n);
  if (got.length < n * MIN_FILL_RATIO) {
    throw new Error(`${market ?? ''} 종목 확보 부족: 요청 ${n}, 실제 ${got.length}(데이터 소스 장애 의심)`);
  }
  return got;
}

// days(fetchTradingDaySeries 결과, 과거→현재 [{basDd, rows}])에서 code의 거래대금
// (ACC_TRDVAL) 평균. 관측일수가 days.length*MIN_WINDOW_RATIO 미만(신규상장 등으로 창
// 전체를 못 채움)이면 짧은 창을 "N일 평균"으로 위장하지 않고 null(추정 안 함). 순수함수.
export function averageTradingValue(days, code) {
  const values = [];
  for (const { rows } of days ?? []) {
    const row = rows.find((r) => r.ISU_CD === code);
    const v = row ? num(row.ACC_TRDVAL) : null;
    if (v != null) values.push(v);
  }
  if (!days?.length || values.length < days.length * MIN_WINDOW_RATIO) return null;
  return values.reduce((s, x) => s + x, 0) / values.length;
}

async function buildMarketCandidates(market, { n, liquidityDays, apiKey, fetchImpl, delayMs }) {
  const days = await fetchTradingDaySeries(
    (basDd) => fetchStockDaily(market, basDd, { apiKey, fetchImpl }),
    liquidityDays,
    { delayMs },
  );
  if (!days.length) throw new Error(`${market} 거래일 데이터를 하나도 못 가져옴(데이터 소스 장애 의심)`);
  const top = topByMarketCap(days[days.length - 1].rows, n, market);
  let nullCount = 0;
  const withLiquidity = top.map((c) => {
    const avgTradingValue = averageTradingValue(days, c.Code);
    if (avgTradingValue == null) nullCount++;
    return { ...c, avgTradingValue };
  });
  if (withLiquidity.length && nullCount / withLiquidity.length > MAX_NULL_RATIO) {
    throw new Error(
      `${market} 유동성 조회 실패율 과다: ${nullCount}/${withLiquidity.length}건 — `
      + '개별 종목 결측이 아니라 데이터 소스 전체 장애로 의심됨',
    );
  }
  return withLiquidity;
}

// fdr-universe.py의 Node/KRX 대체. 반환 shape은 fdr-universe.py와 동일하게 유지
// ([{Code, Name, Marcap, avgTradingValue}, ...]) — quant-universe.mjs·quant-ranking.mjs·
// marketcap-ranking.mjs 등 하위 소비자가 전부 이 shape에 의존하므로 그대로 보존한다.
export async function fetchKrxUniverse({
  nKospi = 200, nKosdaq = 150, liquidityDays = 20,
  apiKey = process.env.KRX_API_KEY, fetchImpl, delayMs,
} = {}) {
  const [kospi, kosdaq] = await Promise.all([
    buildMarketCandidates('KOSPI', { n: nKospi, liquidityDays, apiKey, fetchImpl, delayMs }),
    buildMarketCandidates('KOSDAQ', { n: nKosdaq, liquidityDays, apiKey, fetchImpl, delayMs }),
  ]);
  return [...kospi, ...kosdaq];
}
