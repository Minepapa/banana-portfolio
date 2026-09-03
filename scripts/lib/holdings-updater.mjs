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

// ⚠️ 버그 수정(2026-09-04, 오너 신고 — 대시보드에 해외주식 손익이 달러 숫자에 원화
// 기호만 붙어 나옴) — Holdings 스키마 관례(update-holdings-prices.mjs recomputeValuation
// 참고)는 `avgPrice`·`curPrice`가 원어(USD 등) 그대로, `invest`·`evalAmount`는 항상
// KRW다. 그런데 이 함수는 `buyInvest = exec.price * exec.quantity`를 환율 없이 그대로
// invest에 넣고 있었다 — 국내종목(원=KRW)은 우연히 맞았지만, 해외종목은 invest가
// KRW가 아니라 USD 숫자로 저장되는 채였다. 지금까지 실제 Vault에 이 버그가 안 보인
// 건 현재 보유 중인 해외종목이 전부 v1 마이그레이션 값 그대로(`appliedDedupKeys: []`)
// 였기 때문 — 이 함수가 해외종목 매수에 실제로 쓰인 적이 아직 없었을 뿐, 다음
// 해외주식 신규매수/추가매수부터 바로 터질 잠복 버그였다.
// `usdKrwRate`는 exec.currency==='USD'일 때만 쓰고, 조회 실패로 null이면 잘못된 값을
// 쓰지 않고 warning으로 건너뛴다(applySell과 동일 원칙 — ADR 0003 폴백 금지).
export function applyBuy(existingHolding, exec, { usdKrwRate = null } = {}) {
  const fx = exec.currency === 'USD' ? usdKrwRate : 1;
  if (fx == null) {
    return { holding: null, warning: `USD 매수 체결인데 환율을 못 가져와 KRW 환산 불가 — ${exec.account ?? '(계좌미상)'} ${exec.stockName}` };
  }
  const buyInvest = exec.price * exec.quantity * fx; // KRW
  if (!existingHolding) {
    return {
      holding: {
        account: exec.account, assetClass: exec.assetClass ?? '', name: exec.stockName,
        ticker: exec.stockCode ?? '', market: '',
        avgPrice: exec.price, qty: exec.quantity, invest: buyInvest,
        curPrice: null, evalAmount: null, profitAmount: null, profitPct: null,
        isCashLike: false,
      },
      warning: null,
    };
  }
  const newQty = existingHolding.qty + exec.quantity;
  const newInvest = existingHolding.invest + buyInvest; // KRW + KRW
  // avgPrice는 원어(raw currency) 가중평균 — invest(KRW)/qty로 구하면 환산이 섞여
  // avgPrice의 통화 관례(raw)가 깨진다. existingHolding.avgPrice도 raw이므로 그대로
  // qty 가중평균하면 통화가 일관되게 유지된다.
  const newAvgPrice = (existingHolding.avgPrice * existingHolding.qty + exec.price * exec.quantity) / newQty;
  // ⚠️ 버그 수정(2026-08-24, 오너 신고 — evalAmount 0원으로 화면 필터 누락) — curPrice는
  // 그대로 이어받되(체결 자체가 새 시세를 알려주지 않음, 다음 update-holdings-prices.mjs
  // 실행이 갱신할 몫), evalAmount·profitAmount·profitPct는 새 qty·invest 기준으로 즉시
  // 재계산해야 한다. 예전엔 `...existingHolding`로 옛 값을 그대로 들고 가서, 매수 직후~
  // 다음 시세갱신 사이에 "매수 이전 수량 기준" 평가액이 남아있었다 — 과거 전량매도 후
  // 종목만 남겨둔 0-qty 플레이스홀더 보유(예: findExistingInstruments 후보용으로 유지되던
  // ACE 미국달러SOFR금리(합성)·TIGER 일본엔선물)에 새로 매수가 들어오면 evalAmount가
  // 0에서 다음 시세갱신 전까지 그대로 남아, 프론트엔드 필터(invest>0 && eval>0)에 걸려
  // 화면에서 통째로 사라지는 사고로 표면화됐다. consolidateLots의 재계산 방식과 동일
  // 원칙(curPrice가 없으면 추정하지 않고 null 그대로).
  const curPrice = existingHolding.curPrice ?? null;
  const evalAmount = curPrice != null ? curPrice * newQty : null;
  const profitAmount = evalAmount != null ? evalAmount - newInvest : null;
  const profitPct = profitAmount != null && newInvest > 0 ? (profitAmount / newInvest) * 100 : null;
  return {
    holding: {
      ...existingHolding,
      avgPrice: newAvgPrice,
      qty: newQty,
      invest: newInvest,
      curPrice, evalAmount, profitAmount, profitPct,
    },
    warning: null,
  };
}

// 반환: { updatedHolding, realizedProfit, closed, warning }
// - warning이 있으면 updatedHolding은 null이고 호출부는 아무것도 쓰지 않는다(데이터 불일치
//   상태에서 잘못된 값을 State에 남기지 않기 위함 — 원인 규명 전까지 이전 값 그대로 유지).
// - closed:true면 updatedHolding이 null이지만 warning은 없다 — 정상적으로 전량 매도됨,
//   호출부가 그 보유 파일을 삭제해야 한다는 신호.
// ⚠️ 버그 수정(2026-09-04, applyBuy와 동일 사고) — realizedProfit을 환율 없이
// `(exec.price - avgPrice) * quantity`로 계산했다. avgPrice·exec.price 둘 다 원어라
// 차는 원어 단위인데, 이걸 그대로 "원(KRW) 실현손익"으로 기록해 Facts/Ledger/Profits·
// 대시보드까지 달러 숫자에 원화 기호만 붙어 나갔다(2026-09-03 엔비디아 매도 24주 —
// 실제 발견된 사례). usdKrwRate는 exec.currency==='USD'일 때만 곱한다.
export function applySell(existingHolding, exec, { usdKrwRate = null } = {}) {
  if (!existingHolding) {
    return { updatedHolding: null, realizedProfit: null, closed: false, warning: `매도 체결인데 보유 기록이 없음: ${exec.account ?? '(계좌미상)'} ${exec.stockName}` };
  }
  if (exec.quantity > existingHolding.qty + EPS) {
    return {
      updatedHolding: null, realizedProfit: null, closed: false,
      warning: `매도수량(${exec.quantity})이 보유수량(${existingHolding.qty})을 초과 — ${existingHolding.account} ${existingHolding.name}, 이전 매수 체결 누락 가능성`,
    };
  }
  const fx = exec.currency === 'USD' ? usdKrwRate : 1;
  if (fx == null) {
    return {
      updatedHolding: null, realizedProfit: null, closed: false,
      warning: `USD 매도 체결인데 환율을 못 가져와 KRW 환산 불가 — ${existingHolding.account} ${existingHolding.name}`,
    };
  }
  const realizedProfit = (exec.price - existingHolding.avgPrice) * exec.quantity * fx; // KRW
  const newQty = existingHolding.qty - exec.quantity;
  if (newQty <= EPS) {
    return { updatedHolding: null, realizedProfit, closed: true, warning: null };
  }
  // applyBuy와 동일한 이유(2026-08-24) — curPrice는 이어받고 evalAmount·profitAmount·
  // profitPct는 축소된 새 qty·invest 기준으로 즉시 재계산(옛 값을 그대로 들고 가면
  // 일부 매도 직후 화면 평가액이 매도 전 수량 기준으로 부풀려진 채 남는다).
  // newInvest는 기존 KRW 원가(invest)를 수량 비율로 그대로 줄인다 — avgPrice(원어)에
  // 오늘 환율을 다시 곱해 재기준하면 매수 시점 원가가 아니라 "오늘 재평가한 원가"가
  // 되어 실제 손익과 어긋난다(recomputeFxCashValuation 주석의 같은 원칙 — 원가는
  // 매수 시점에 고정돼야 한다). 이 방식은 fx 없이도 항상 정확하다.
  const newInvest = existingHolding.qty > 0 ? (existingHolding.invest / existingHolding.qty) * newQty : 0;
  const curPrice = existingHolding.curPrice ?? null;
  const evalAmount = curPrice != null ? curPrice * newQty : null;
  const profitAmount = evalAmount != null ? evalAmount - newInvest : null;
  const profitPct = profitAmount != null && newInvest > 0 ? (profitAmount / newInvest) * 100 : null;
  return {
    updatedHolding: { ...existingHolding, qty: newQty, invest: newInvest, curPrice, evalAmount, profitAmount, profitPct },
    realizedProfit, closed: false, warning: null,
  };
}
