// VIP펀드 실측 자산군(기존 보유파일 확인) — applyFundPurchase가 최초 매수(기존 보유
// 없음) 시 기본값으로 쓴다.
export const DEFAULT_FUND_ASSET_CLASS = '국내주식';

// 정기적립식 펀드(VIP펀드, 연금저축) 매수 이벤트를 State/Holdings 보유에 누적 반영 —
// 순수함수. holdings-updater.mjs(체결 기반 applyBuy/applySell)와 형제 관계지만, 펀드
// 매수는 항상 "쌓이기만" 하고(정기적립, 매도 없음) 이벤트 자체가 quantity·price가
// 아니라 amount(적립금)·units(그 시점 NAV로 산정된 좌수)로 구성돼 있어 별도 함수로
// 분리한다(왜 이 함수가 필요한지는 update-fund-holdings-from-purchases.mjs 헤더 참고).
//
// avgPrice는 1,000좌당 표기 관례(update-holdings-prices.mjs recomputeValuation의
// unitScale=0.001과 짝) — invest/qty*1000으로 역산해야 vip-fund.mjs가 조회하는 원시
// NAV와 같은 스케일이 된다. 실측 검증(2026-09-04): 기존 보유 invest 12,800,000원/
// qty 8,202,681좌 → (12800000/8202681)*1000 ≈ 1560.47, 기존 avgPrice(1560)와 일치.
//
// dedupKey(코드리뷰 HIGH 지적, 2026-09-04) — 호출부의 holdingsApplied 플래그(펀드
// 매수 원장 쪽)가 1차 방어지만, 보유 파일 쓰기는 성공하고 그 직후 플래그 쓰기가
// 실패/중단되면(intraday-portfolio-sync.mjs가 60초 타임아웃으로 단계를 SIGTERM
// 시킬 수 있어 이 창이 실제로 열려있음) 다음 실행에서 같은 매수가 다시 적용돼
// 200,000원이 중복 반영될 수 있다 — update-holdings-from-executions.mjs의
// appliedDedupKeys 2차 방어와 동일 원칙을 그대로 가져온다(호출부가 이미 적용된
// dedupKey면 재적용 전에 걸러야 함, 이 함수 자체는 "적용"만 담당).
//
// amount·units 유효성(코드리뷰 MEDIUM 지적) — NaN·0·음수가 그대로 들어오면 누적값이
// 조용히 깨진다(NaN은 다음 실행에서 Number(x)||0으로 0 취급돼 포지션이 사라짐) —
// 호출부가 이 검사를 지나야만 실제로 누적한다.
export function applyFundPurchase(existingHolding, purchase) {
  if (!(Number.isFinite(purchase.amount) && purchase.amount > 0 && Number.isFinite(purchase.units) && purchase.units > 0)) {
    throw new Error(`펀드 매수 금액/좌수 값이 이상함(amount=${purchase.amount}, units=${purchase.units}) — 누적 안 함`);
  }
  const existingQty = Number(existingHolding?.qty) || 0;
  const existingInvest = Number(existingHolding?.invest) || 0;
  const newQty = existingQty + purchase.units;
  const newInvest = existingInvest + purchase.amount;
  const avgPrice = newQty > 0 ? (newInvest / newQty) * 1000 : 0;
  // curPrice는 이어받고(다음 30분 시세갱신 주기가 알아서 재확인) evalAmount·
  // profitAmount·profitPct는 새 qty·invest 기준으로 즉시 재계산 — holdings-
  // updater.mjs applyBuy와 동일 원칙(매수 직후 화면이 옛 수량 기준 평가액을
  // 잠깐이라도 보여주면 안 됨).
  const curPrice = existingHolding?.curPrice ?? null;
  const evalAmount = curPrice != null ? curPrice * newQty * 0.001 : null;
  const profitAmount = evalAmount != null ? evalAmount - newInvest : null;
  const profitPct = profitAmount != null && newInvest > 0 ? (profitAmount / newInvest) * 100 : null;
  // assetClass(코드리뷰 MEDIUM 지적) — 기존 보유가 없는 최초 매수(신규 펀드 생성)면
  // 빈 문자열로 쓰면 allocation-snapshot.mjs의 POOLED_ASSET_NAMES 필터에서 조용히
  // 빠진다. 이 계좌엔 이 펀드 하나뿐이라는 전제가 이미 여러 곳(VIP_FUND_NAME 하드코딩)
  // 에 있으므로, 최초 생성 시에도 실제 이 펀드의 자산군(국내주식, 기존 보유파일 실측)을
  // 기본값으로 채운다 — 다른 펀드가 생기면 그때 일반화.
  const assetClass = existingHolding?.assetClass || DEFAULT_FUND_ASSET_CLASS;
  return {
    account: purchase.account,
    assetClass,
    name: purchase.fundName,
    ticker: existingHolding?.ticker ?? '',
    market: existingHolding?.market ?? '',
    avgPrice, qty: newQty, invest: newInvest,
    curPrice, evalAmount, profitAmount, profitPct,
    isCashLike: false,
    appliedDedupKeys: [...(existingHolding?.appliedDedupKeys ?? []), purchase.dedupKey],
  };
}

// 순수함수(코드리뷰 HIGH 지적, 2026-09-04) — FundValuation 스냅샷이 가장 최근에
// 반영된 매수보다 "더 옛날" 기준이면(예: 9/1 매수는 이미 반영됐는데 카카오 펀드평가는
// 아직 8월분만 왔을 때) drift 비교 자체가 무의미하다 — 매달 며칠간 "정상인데 불일치로
// 오탐"하는 걸 막는다(재현: 이 프로젝트가 이미 겪은 "이 필드가 간헐적으로 신뢰 불가"
// 류 오탐 패턴과 같은 클래스). 호출부는 이게 true면 checkFundValuationDrift를 아예
// 안 부른다.
export function isValuationStale(latestAppliedPurchaseDate, valuation) {
  if (!latestAppliedPurchaseDate || !valuation?.date) return false;
  return valuation.date < latestAppliedPurchaseDate;
}

// 순수함수 — FundValuation 스냅샷(카카오 정기평가 알림, 그 시점 원금)과 매수누적으로
// 계산된 보유 invest를 대조한다. 두 소스는 삼성증권이 서로 다른 메시지 템플릿을 써서
// fundName 표기가 살짝 다를 수 있어(예: "...신탁(주식)-C-Pe" vs "...증권자투자(주식)-
// C-Pe") 이름으로 매칭하지 않는다 — 호출부가 이미 "이 계좌엔 이 펀드 하나뿐"이라는
// 전제로 두 값을 직접 넘긴다(update-holdings-prices.mjs의 VIP_FUND_NAME 하드코딩과
// 동일 실용적 판단). threshold는 반올림·NAV 갱신 시차로 인한 미세 오차 허용(기본
// 1,000원) — 이보다 크게 벌어지면 매수 알림 누락 등 실제 이상 신호로 간주. 호출부는
// isValuationStale이 false일 때만 이 함수를 부를 것.
export function checkFundValuationDrift(holding, valuation, threshold = 1000) {
  if (!holding || !valuation) return null;
  const invest = Number(holding.invest) || 0;
  const principal = Number(valuation.principal) || 0;
  const diff = invest - principal;
  if (Math.abs(diff) <= threshold) return null;
  return `VIP펀드 원금 불일치 — 보유 누적 ${Math.round(invest).toLocaleString()}원 vs 카카오 펀드평가(${valuation.date}) 원금 ${Math.round(principal).toLocaleString()}원, 차이 ${Math.round(diff).toLocaleString()}원 — 매수 알림 누락·중복 가능성`;
}
