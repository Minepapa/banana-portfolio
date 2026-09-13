// 돌파매매 전략 리스크 관리 — R배수 손절/트레일링스톱 + Max 2%룰 사이징 (2026-09-12,
// 오너 확정: 손절 -8%, 손익비 1:3, 1R/2R/3R 도달 시 손절선 상향, 점진적 베팅).
// 순수 함수 — 실제 보유/체결 상태는 호출측(백테스트 시뮬레이터·Kairos)이 들고 있는다.

export const STOP_LOSS_PCT = 0.08; // 1R = 8%(오너 확정 — naver 블로그 "깡토" 체계 그대로)
export const RISK_PER_TRADE_PCT = 0.02; // Max 2% 룰(오너 확정)
export const PYRAMID_TRIGGER_R = 3; // 3R 도달 시 불타기(유닛 추가) — 자본 반영 미구현(별도 기록 참고)
export const PARTIAL_PROFIT_TRIGGER_R = 3; // 3R 도달 시 포지션 50% 매도(오너 확정, 2026-09-13)
export const PARTIAL_PROFIT_SELL_FRACTION = 0.5;
// 동시보유 종목수 상한 — 원래 백테스트 파라미터 기본값(runBreakoutBacktest)이었는데,
// 일별 신호스캔 잡(daily-breakout-signal-scan.mjs)이 실계좌 슬롯 배정에도 같은 값을
// 써야 해서 여기로 뽑아 단일 진실 소스화(오너가 실전에도 10 그대로 확정, 2026-09-13).
export const MAX_CONCURRENT_POSITIONS = 10;

// entryPrice 기준 rMultiple×R 가격 수준(rMultiple=1→+8%, 2→+16%, 3→+24% ...).
export function rMultiplePrice(entryPrice, rMultiple) {
  return entryPrice * (1 + rMultiple * STOP_LOSS_PCT);
}

// highSinceEntry: 진입 이후 지금까지의 최고가(당일 고가 포함, 종가가 아니라 고가 —
// 트레일링은 "실제로 거기까지 갔었는지"로 판정해야 실제 주문 체결과 어긋나지 않음).
// 반환: 도달한 정수 R단계(0=1R 미도달, 1=1R 이상 2R 미만, ...). 음수는 없음(손실 중이어도 0).
export function reachedRMultiple(entryPrice, highSinceEntry) {
  if (!(entryPrice > 0) || highSinceEntry == null) return 0;
  const gain = (highSinceEntry - entryPrice) / entryPrice;
  return Math.max(0, Math.floor(gain / STOP_LOSS_PCT));
}

// 트레일링 손절선(래칫 — 한 번 오른 손절선은 다시 안 내려간다, 호출측이 이전값과
// Math.max로 비교해 유지). 오너 확정 규칙: 1R 도달=본전(매수가), 2R 도달=1R가,
// 3R 이상 도달=직전 R가(예: 3R=2R가, 4R=3R가 ...). 0R(아직 1R 미도달)은 최초 손절
// (진입가-8%). 이 매핑은 blog 원문이 명시한 "3R→본전"을 일반화한 것(1R/2R 구간의
// 정확한 단계는 오너가 "적용"이라고만 했지 세부 숫자를 안 줘서, 매 R단계마다 직전
// 단계를 잠그는 표준적 래칫 방식을 기본값으로 채택 — 백테스트 결과 보고 조정 대상).
export function computeTrailingStop(entryPrice, highSinceEntry) {
  const r = reachedRMultiple(entryPrice, highSinceEntry);
  if (r <= 0) return entryPrice * (1 - STOP_LOSS_PCT);
  if (r === 1) return entryPrice;
  return rMultiplePrice(entryPrice, r - 1);
}

// Max 2%룰 포지션 사이징 — 최대손실허용액(자본금×riskPct) ÷ 손절률 = 최대투입금액.
// 동일가중이 아니라 손절폭(변동성)에 반비례하는 사이징(OCF/P의 "동일가중±50%"와는
// 다른 방식 — 전략마다 독립적인 사이징 규칙을 쓴다는 오너의 "여러 전략을 각자 운영"
// 설계와 일치).
export function computePositionSize(capitalWon, { riskPct = RISK_PER_TRADE_PCT, stopLossPct = STOP_LOSS_PCT } = {}) {
  if (!(capitalWon > 0) || !(stopLossPct > 0)) return 0;
  const maxLossWon = capitalWon * riskPct;
  return maxLossWon / stopLossPct;
}

// 3R 도달 시 불타기(유닛 추가) 여부 — highSinceEntry 기준. 실제 추가매수 금액·유닛수는
// 호출측(포지션 상태를 아는 시뮬레이터/Kairos)이 결정, 이 함수는 트리거 판정만.
export function shouldPyramid(entryPrice, highSinceEntry, unitsHeld) {
  return reachedRMultiple(entryPrice, highSinceEntry) >= PYRAMID_TRIGGER_R && unitsHeld < 2;
}

// 3R 도달 시 포지션 50% 매도(부분 익절) 트리거 — 이미 실행했으면(alreadyTaken) 다시
// 안 함(1회성). "익절 신호 없이 있다가 고점 대비 되돌림에만 걸려 수익이 2R~3R 부근에
// 갇히는" 문제(오너 지적)에 대한 대응 — 절반은 3R에서 확정 실현, 나머지 절반만
// 트레일링을 계속 태워 더 크게 갈 여지를 남긴다.
export function shouldTakePartialProfit(entryPrice, highSinceEntry, alreadyTaken) {
  return !alreadyTaken && reachedRMultiple(entryPrice, highSinceEntry) >= PARTIAL_PROFIT_TRIGGER_R;
}
