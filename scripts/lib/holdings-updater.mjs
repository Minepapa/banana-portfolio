// 체결(매수·매도) → State/Holdings 반영 — 순수 함수(구현계획서 Phase 8).
// docs/ARCHITECTURE-V2.md "체결 기록 권위 소스" 절의 원칙("State는 항상 실제 체결량
// 그대로")을 실제로 수행하는 로직. Phase 2가 의도적으로 미뤄둔 부분("보유종목갱신...
// Phase 8·9로 이관") — 여기서 마저 연결한다.
//
// 매수: 같은 (계좌,종목)에 기존 보유가 있으면 가중평균으로 합친다(오너 확정, 2026-08-05
// — v1 useTradeSync와 동일 방식). 새 로트 파일을 따로 안 만드는 이유: State는 "현재값만"
// 원칙이라 계좌당 종목 하나엔 파일 하나가 맞다(Phase 7 마이그레이션이 시트 행 그대로
// 옮기며 로트별로 파일을 나눈 건 "과거 이력을 손실 없이 옮기는" 그 상황에서만 유효했던
// 예외 — 이 이후로는 이 갱신기가 항상 단일 파일로 수렴시킨다).
//
// 매도: 평단가는 그대로 두고 수량·투자금만 비례 축소, 실현손익을 별도로 계산해 돌려준다
// (호출부가 Facts/Ledger/Profits에 기록). 매도수량이 보유수량을 초과하면(데이터 불일치 —
// 예: 이전 매수 체결 하나를 놓쳤을 가능성) **추정으로 밀어붙이지 않는다** — ADR 0003
// "폴백 금지" 원칙과 동일하게, warning을 반환하고 호출부가 그 보유는 건드리지 않은 채
// 사람에게 플래그한다.
const EPS = 1e-6;

// 여러 로트 파일(Phase 7 마이그레이션이 시트 행 그대로 옮기며 계좌당 종목 하나에 여러
// 파일을 만든 경우, 예: 위탁 삼성전자 40주@50,450원 + 30주@54,700원 2파일)을 하나로
// 합친다. **독립 코드리뷰(oh-my-claudecode:code-reviewer) 지적으로 추가(2026-08-05)** —
// 원래 update-holdings-from-executions.mjs가 (계좌,종목)키로 Map을 만들 때 나중 로트가
// 앞 로트를 조용히 덮어써서, 그 종목에 새 체결이 들어오면 한쪽 로트가 통째로 유실되고
// 파일도 중복 카운트되는 심각한 버그가 있었다(Phase 7의 로트유실 사고와 같은 클래스가
// 다른 자리에서 재발). 이 함수를 실행 시작 시 항상 먼저 돌려 계좌당 종목 하나 = 파일
// 하나 불변식을 세운 뒤에만 체결을 적용한다.
//
// curPrice는 로트마다 다를 이유가 없다(같은 종목의 같은 시점 시세) — 있으면 첫 로트
// 값을 그대로 쓰고 evalAmount·profitAmount·profitPct를 합산 qty·invest 기준으로
// 재계산한다. 하나라도 null이면 전부 null(가격 새로고침 전이라 알 수 없음 — 추정 안 함).
export function consolidateLots(lots) {
  if (lots.length <= 1) return lots[0] ?? null;
  const qty = lots.reduce((s, h) => s + h.qty, 0);
  const invest = lots.reduce((s, h) => s + h.invest, 0);
  const avgPrice = qty > 0 ? invest / qty : 0;
  const allHaveCurPrice = lots.every((h) => h.curPrice != null);
  const curPrice = allHaveCurPrice ? lots[0].curPrice : null;
  const evalAmount = curPrice != null ? curPrice * qty : null;
  const profitAmount = evalAmount != null ? evalAmount - invest : null;
  const profitPct = profitAmount != null && invest > 0 ? (profitAmount / invest) * 100 : null;
  return {
    ...lots[0],
    qty, invest, avgPrice, curPrice, evalAmount, profitAmount, profitPct,
  };
}

export function applyBuy(existingHolding, exec) {
  const buyInvest = exec.price * exec.quantity;
  if (!existingHolding) {
    return {
      account: exec.account, assetClass: exec.assetClass ?? '', name: exec.stockName,
      ticker: exec.stockCode ?? '', market: '',
      avgPrice: exec.price, qty: exec.quantity, invest: buyInvest,
      curPrice: null, evalAmount: null, profitAmount: null, profitPct: null,
      isCashLike: false,
    };
  }
  const newQty = existingHolding.qty + exec.quantity;
  const newInvest = existingHolding.invest + buyInvest;
  return {
    ...existingHolding,
    avgPrice: newInvest / newQty,
    qty: newQty,
    invest: newInvest,
  };
}

// 반환: { updatedHolding, realizedProfit, closed, warning }
// - warning이 있으면 updatedHolding은 null이고 호출부는 아무것도 쓰지 않는다(데이터 불일치
//   상태에서 잘못된 값을 State에 남기지 않기 위함 — 원인 규명 전까지 이전 값 그대로 유지).
// - closed:true면 updatedHolding이 null이지만 warning은 없다 — 정상적으로 전량 매도됨,
//   호출부가 그 보유 파일을 삭제해야 한다는 신호.
export function applySell(existingHolding, exec) {
  if (!existingHolding) {
    return { updatedHolding: null, realizedProfit: null, closed: false, warning: `매도 체결인데 보유 기록이 없음: ${exec.account ?? '(계좌미상)'} ${exec.stockName}` };
  }
  if (exec.quantity > existingHolding.qty + EPS) {
    return {
      updatedHolding: null, realizedProfit: null, closed: false,
      warning: `매도수량(${exec.quantity})이 보유수량(${existingHolding.qty})을 초과 — ${existingHolding.account} ${existingHolding.name}, 이전 매수 체결 누락 가능성`,
    };
  }
  const realizedProfit = (exec.price - existingHolding.avgPrice) * exec.quantity;
  const newQty = existingHolding.qty - exec.quantity;
  if (newQty <= EPS) {
    return { updatedHolding: null, realizedProfit, closed: true, warning: null };
  }
  return {
    updatedHolding: { ...existingHolding, qty: newQty, invest: newQty * existingHolding.avgPrice },
    realizedProfit, closed: false, warning: null,
  };
}
