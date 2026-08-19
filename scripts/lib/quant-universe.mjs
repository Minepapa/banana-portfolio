// 퀀트 트랙 유니버스·유동성 필터 — 순수 함수(구현계획서 Phase 9).
// docs/ARCHITECTURE-V2.md "유니버스·유동성·종목수·포지션 사이징" 절 그대로.
//
// ⚠️ 공식 코스피200·코스닥150 지수 구성종목이 아니라 시가총액 상위 200(코스피)+150
// (코스닥) 종목으로 근사한다(오너 확정, 2026-08-07) — KRX Data Marketplace(2026-08-19
// 전환 후 소스)에도 지수 구성종목(멤버십) API가 없음을 카탈로그 전체 실사로 확정
// 확인했다(docs/DATA-SOURCES.md) — 이 근사 자체는 소스를 바꿔도 해소되지 않는 트레이드
// 오프. 유동성이 강한 대형주 위주 지수라 시가총액 근사가 실질적으로 크게 다르지 않지만,
// 완전히 동일하지는 않다(업종배분 등 KRX의 추가 선정기준 제외).
//
// 2026-08-19: 후보군 산출을 FinanceDataReader(Python, `fdr-universe.py`)에서
// KRX Data Marketplace API 직접 호출(`krx-universe.mjs`, Node)로 교체 — Python/SSL
// 우회 의존성이 완전히 사라졌고, 거래대금이 종가×거래량 근사가 아니라 KRX가 직접
// 집계한 실제값(ACC_TRDVAL)으로 바뀌었다. `fdr-universe.py`는 당분간 파일만 남겨두되
// (historical-universe.py는 별개 — 상장폐지종목 포함 백테스트 전용이라 이 교체 범위 밖,
// 계속 FDR 사용) 이 경로에서는 더 이상 호출하지 않는다.
import { fetchKrxUniverse } from './krx-universe.mjs';

export const LIQUIDITY_MIN_KRW = 3_000_000_000; // 일평균 거래대금 30억원(오너 확정)
export const UNIVERSE_N_KOSPI = 200;
export const UNIVERSE_N_KOSDAQ = 150;
export const LIQUIDITY_LOOKBACK_DAYS = 20;

// candidates: fetchKrxUniverse 출력 배열({ Code, Name, Marcap, avgTradingValue }).
// avgTradingValue가 null(데이터 부족·조회실패)이면 **추정하지 않고 제외**한다 — 유동성을
// 모르는 종목을 "통과"로 잘못 넘기는 것보다 "이번 달은 후보에서 빠짐"이 안전하다.
export function filterByLiquidity(candidates, minKrw = LIQUIDITY_MIN_KRW) {
  return candidates.filter((c) => c.avgTradingValue != null && c.avgTradingValue >= minKrw);
}

// KRX Data Marketplace API로 유니버스 조회. 반환 shape은 기존(fdr-universe.py 시절)과
// 동일하게 유지 — quant-ranking.mjs·marketcap-ranking.mjs 등 하위 소비자 무변경.
export async function fetchQuantUniverse({
  nKospi = UNIVERSE_N_KOSPI, nKosdaq = UNIVERSE_N_KOSDAQ, liquidityDays = LIQUIDITY_LOOKBACK_DAYS,
} = {}) {
  return fetchKrxUniverse({ nKospi, nKosdaq, liquidityDays });
}
