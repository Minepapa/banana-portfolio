// 워크포워드 백테스트 시뮬레이터 — 순수 함수(구현계획서 Phase 10). 실제 주식수·현금을
// 추적하는 주문 시뮬레이션이 아니라 **수익률(가중치) 기반** 시뮬레이션이다 — 팩터
// 백테스트의 표준 방식(동일가중 포트폴리오, 리밸런싱 시점마다 재구성). 실제 주문
// 시뮬레이션(호가·체결가·수수료 등)은 Phase 11 실주문 API의 몫이지 이 게이트의 목적이
// 아니다 — 여기서 검증하는 건 "OCF/P 팩터+버퍼존 재구성 규칙 자체가 유의미한
// 초과수익을 냈는가"이지 집행 디테일이 아니다.
import { computeReconstitution, BUY_RANK, SELL_RANK } from './quant-reconstitution.mjs';

// prevHoldings: Set<code>(직전 리밸런싱 시점 이후 보유). ranked: 이번 리밸런싱 시점의
// OCF/P 랭킹(quant-factor.mjs rankByOcfToPrice 결과, Code/rank 보유). 버퍼존 재구성
// 규칙은 새로 만들지 않고 Phase 9의 computeReconstitution을 그대로 재사용한다(코드
// 중복·규칙 불일치 방지 — 라이브 리컨스티튜션과 백테스트가 서로 다른 버퍼존 판정을
// 쓰면 백테스트가 검증하는 대상 자체가 실제 전략과 달라진다).
//
// computeReconstitution은 "실제 KIS 잔고"(holdings: [{code,name,qty}])를 받도록
// 설계됐으므로, 시뮬레이션의 prevHoldings(Set)를 같은 모양으로 변환해 넘긴다(qty는
// 의미 없음 — 동일가중 시뮬레이션이라 보유 여부만 씀, 1로 채움).
export function computeTargetHoldings(prevHoldings, ranked, { buyRank = BUY_RANK, sellRank = SELL_RANK } = {}) {
  const holdingsInput = [...prevHoldings].map((code) => ({ code, name: code, qty: 1 }));
  const { buys, holds } = computeReconstitution(ranked, holdingsInput, { buyRank, sellRank });
  // needsReview(보유중인데 이번 랭킹에 아예 없음)는 라이브에서는 Kairos 검토로 넘기지만,
  // 백테스트는 사람 개입이 없는 기계적 재현이라 "판단 보류"를 흉내낼 수 없다 — 매도로
  // 취급한다(랭킹에 없다 = 최소한 이 팩터 기준으로는 더 이상 근거가 없다는 뜻이라
  // 보유를 유지할 근거도 없음, 백테스트 전용 단순화 — 라이브 동작과 다름을 명시).
  return new Set([...holds.map((h) => h.code), ...buys.map((b) => b.code)]);
}

// ⚠️ historical-universe.mjs fetchPricesAt/price_at_or_before는 상장폐지 이후에도
// 마지막 거래가를 그대로 이월해 반환한다(실측 확인, 2026-08-08 — 한진해운: 폭락하는
// 구간의 가격은 정상 반영되고, 상장폐지일 이후 조회는 마지막 거래가 12원이 그대로
// 나옴). 즉 "가격 결측"은 상장폐지 자체가 아니라 애초에 그 종목의 시세를 캐싱 안
// 했거나(법인코드 매칭 실패 등) 그 날짜 이전 거래이력 자체가 없는 경우에만 발생한다 —
// 상장폐지 손실은 별도 처리 없이도 이미 구간수익률에 정상 반영됨(폭락 구간 이후엔
// computePointInTimeUniverse가 상장폐지 종목을 유니버스에서 빼 다음 리밸런싱에서
// 자연히 정리됨).
//
// holdings: Set<code>. pricesByCode: {[code]: {[date]: price}}. fromDate/toDate: 구간
// 시작/끝. 동일가중 포트폴리오의 구간수익률(보유종목 수익률의 단순평균 — 매 구간마다
// 동일가중으로 재조정된다고 가정, 표준 팩터 백테스트 관례). 가격 결측 종목은 그
// 구간에서 제외(추정 안 함) — 보유종목 전부 결측이면 null(호출측인 simulateWalkForward가
// 이 null을 "진짜 데이터 결측"과 "보유종목 자체가 없음(현금 보유)"을 구분해서 처리함).
export function computePeriodReturn(holdings, pricesByCode, fromDate, toDate) {
  const returns = [];
  for (const code of holdings) {
    const p0 = pricesByCode[code]?.[fromDate];
    const p1 = pricesByCode[code]?.[toDate];
    if (p0 == null || p1 == null || !(p0 > 0)) continue;
    returns.push((p1 - p0) / p0);
  }
  if (!returns.length) return null;
  return returns.reduce((s, r) => s + r, 0) / returns.length;
}

// rankingsByDate: { [date]: ranked[] }(historical-ranking.mjs attachHistoricalOcf +
// quant-factor.mjs rankByOcfToPrice 결과 — 호출측이 이미 계산해서 넘김, 이 함수는
// 조회하지 않음). pricesByCode: historical-universe.mjs fetchPricesAt 결과와 같은 모양
// (구간수익률 계산용 — 유동성 필터 통과 종목의 종가만 있으면 됨).
// 반환: [{date, holdings, periodReturn, dataGap}, ...] 날짜 오름차순.
//
// periodReturn 3가지 경우(코드리뷰 지적, 2026-08-08 — 원래 셋 다 null로 뭉뚱그려 있어
// "관측 없음"과 "진짜 0%"를 구분 못 했음):
//   1) i===0(첫 시점, 아직 직전 구간 없음) → null, dataGap:false
//   2) 그 구간 동안 보유종목이 아예 없었음(현금 보유) → 0(진짜 0% 수익 — 관측 결측이
//      아니라 사실이다, extractReturns가 드롭하면 안 됨)
//   3) 보유종목은 있는데 그 종목들의 가격을 못 찾음(법인코드 매칭 실패 등 진짜 데이터
//      결측 — 상장폐지 자체는 가격이 이월돼 여기 해당 안 함, computePeriodReturn 주석
//      참고) → null, dataGap:true(추정하지 않고 이 구간만 시계열에서 빠짐 — 얼마나
//      빠졌는지 호출측이 셀 수 있게 표시)
//
// 순서 주의: 각 시점에서 먼저 "직전 리밸런싱 이후 보유했던 종목"의 이번 구간 수익률을
// 계산한 다음에 그 시점 랭킹으로 재구성한다 — 재구성부터 먼저 하면 "이번에 새로 산
// 종목"이 아직 사지도 않은 구간의 수익률에 포함되는 룩어헤드 버그가 된다.
export function simulateWalkForward(rankingsByDate, pricesByCode, { buyRank = BUY_RANK, sellRank = SELL_RANK } = {}) {
  const dates = Object.keys(rankingsByDate).sort();
  const out = [];
  let holdings = new Set();
  for (let i = 0; i < dates.length; i++) {
    const date = dates[i];
    let periodReturn = null;
    let dataGap = false;
    if (i > 0) {
      if (holdings.size === 0) {
        periodReturn = 0; // 현금 보유 구간 — 관측 결측이 아니라 사실상 0%
      } else {
        periodReturn = computePeriodReturn(holdings, pricesByCode, dates[i - 1], date);
        if (periodReturn == null) dataGap = true; // 보유종목은 있는데 가격을 못 찾음 — 진짜 결측
      }
    }
    holdings = computeTargetHoldings(holdings, rankingsByDate[date], { buyRank, sellRank });
    out.push({ date, holdings: [...holdings], periodReturn, dataGap });
  }
  return out;
}

// simulateWalkForward 결과에서 periodReturn만 뽑는다(null 전부 제외 — 첫 시점의 "구간
// 없음"이든 dataGap의 "진짜 결측"이든 숫자로 넣을 수 없는 건 매한가지) — stats.mjs
// sharpeRatio/skewness/kurtosis, deflated-sharpe.mjs computeDeflatedSharpeRatio에 바로
// 넣을 수 있는 형태. 현금보유 구간의 0%는 null이 아니므로 그대로 포함된다.
export function extractReturns(simulationResult) {
  return simulationResult.map((r) => r.periodReturn).filter((r) => r != null);
}

// dataGap:true인 구간 수 — 시계열에서 얼마나 많은 구간이 "진짜 데이터 결측"으로
// 빠졌는지 호출측(백테스트 보고서)이 신뢰도 판단에 쓸 수 있게(코드리뷰 지적,
// 2026-08-08 — 조용히 드롭되기만 하면 결과 숫자만 보고는 이 사실을 알 길이 없었음).
export function countDataGaps(simulationResult) {
  return simulationResult.filter((r) => r.dataGap).length;
}

// 누적 수익률 곡선(1.0=원금 시작) — stats.mjs maxDrawdown/annualizedReturn용.
export function cumulativeReturns(returns) {
  const out = [1];
  for (const r of returns) out.push(out[out.length - 1] * (1 + r));
  return out;
}
