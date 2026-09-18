// 돌파매매 전략 리스크 관리 — R배수 손절/트레일링스톱 + Max 2%룰 사이징 (2026-09-12,
// 오너 확정: 손절 -8%, 손익비 1:3, 1R/2R/3R 도달 시 손절선 상향, 점진적 베팅).
// 순수 함수 — 실제 보유/체결 상태는 호출측(백테스트 시뮬레이터·Kairos)이 들고 있는다.

export const STOP_LOSS_PCT = 0.08; // 1R = 8%(오너 확정 — naver 블로그 "깡토" 체계 그대로). 2026-09-19부터 "넓은" 손절값으로도 겸용(아래 ATR 가변손절 참고)
export const RISK_PER_TRADE_PCT = 0.02; // Max 2% 룰(오너 확정)
// ATR 기준 가변 손절(2026-09-19, 오너 지시 — "시장 상황에 따라 손절 -4%/-8% 두
// 가지를 지표로 스스로 정할 수 있어야 함"). "시장 상황" 대신 "종목 자체 변동성"을
// 지표로 쓰기로 확정(오너, AskUserQuestion 응답 — "ATR에 따라 판단하는 로직").
// TIGHT_STOP_LOSS_PCT=4%는 이 판단이 "타이트해도 되는 종목"이라고 볼 때 쓰는 값,
// STOP_LOSS_PCT(8%, 위)는 그대로 "넓은" 손절값을 겸한다(새 상수를 따로 안 만들고
// 기존 상수를 재해석 — 2026-09-13 오너가 확정했던 원래 "손절 -8%"가 이제
// "변동성 큰 종목의 기본값"이라는 의미로 좁혀졌을 뿐, 코드 값 자체는 안 바뀜).
export const TIGHT_STOP_LOSS_PCT = 0.04;
export const ATR_LOOKBACK_DAYS = 14; // Wilder 관례값 — ATR 계산에 가장 널리 쓰이는 기간
// ATR%(=ATR÷가격×100)가 이 값 이상이면 "원래도 하루 변동폭이 큰 종목"으로 보고
// 넓은 손절(STOP_LOSS_PCT=8%)을 쓴다 — 좁은 손절(4%)로는 정상적인 일상 변동폭에도
// 자주 손절될 위험이 있기 때문. 미만이면 좁은 손절로도 충분한 여유가 있다고 보고
// TIGHT_STOP_LOSS_PCT(4%)를 쓴다. 4.0이라는 값은 "TIGHT_STOP_LOSS_PCT와 정확히
// 같은 수치"로 맞춘 초기값(좁은 손절폭 자체가 하루 평균 변동폭보다 작아지는
// 지점을 경계로 삼음) — 실측·백테스트로 조정 대상(다른 조건들과 동일 원칙).
export const ATR_STOP_THRESHOLD_PCT = 4.0;
export const PYRAMID_TRIGGER_R = 3; // 3R 도달 시 불타기(유닛 추가) — 자본 반영 미구현(별도 기록 참고)
export const PARTIAL_PROFIT_TRIGGER_R = 3; // 3R 도달 시 포지션 50% 매도(오너 확정, 2026-09-13)
export const PARTIAL_PROFIT_SELL_FRACTION = 0.5;
// 동시보유 종목수 상한 — 원래 백테스트 파라미터 기본값(runBreakoutBacktest)이었는데,
// 일별 신호스캔 잡(daily-breakout-signal-scan.mjs)이 실계좌 슬롯 배정에도 같은 값을
// 써야 해서 여기로 뽑아 단일 진실 소스화(오너가 실전에도 10 그대로 확정, 2026-09-13).
export const MAX_CONCURRENT_POSITIONS = 10;

// entryPrice 기준 rMultiple×R 가격 수준(rMultiple=1→+stopLossPct, 2→+2×stopLossPct,
// 3→+3×stopLossPct ...). stopLossPct 파라미터화(2026-09-19, ATR 가변손절 대응) —
// 기본값은 기존 STOP_LOSS_PCT(8%) 그대로라 기존 호출부는 전부 하위호환(회귀 없음).
// ⚠️ R배수는 정의상 "그 포지션의 손절폭" 기준이다 — stopLossPct가 4%인 포지션은
// 3R 부분익절 목표가 자동으로 +12%가 된다(기존 +24%가 아님). "손익비 1:3"이라는
// 오너 원칙 자체는 그대로 지켜지고, 절대 퍼센트만 손절폭에 비례해 같이 움직인다.
export function rMultiplePrice(entryPrice, rMultiple, stopLossPct = STOP_LOSS_PCT) {
  return entryPrice * (1 + rMultiple * stopLossPct);
}

// highSinceEntry: 진입 이후 지금까지의 최고가(당일 고가 포함, 종가가 아니라 고가 —
// 트레일링은 "실제로 거기까지 갔었는지"로 판정해야 실제 주문 체결과 어긋나지 않음).
// 반환: 도달한 정수 R단계(0=1R 미도달, 1=1R 이상 2R 미만, ...). 음수는 없음(손실 중이어도 0).
export function reachedRMultiple(entryPrice, highSinceEntry, stopLossPct = STOP_LOSS_PCT) {
  if (!(entryPrice > 0) || highSinceEntry == null) return 0;
  const gain = (highSinceEntry - entryPrice) / entryPrice;
  return Math.max(0, Math.floor(gain / stopLossPct));
}

// 트레일링 손절선(래칫 — 한 번 오른 손절선은 다시 안 내려간다, 호출측이 이전값과
// Math.max로 비교해 유지). 오너 확정 규칙: 1R 도달=본전(매수가), 2R 도달=1R가,
// 3R 이상 도달=직전 R가(예: 3R=2R가, 4R=3R가 ...). 0R(아직 1R 미도달)은 최초 손절
// (진입가-stopLossPct). 이 매핑은 blog 원문이 명시한 "3R→본전"을 일반화한 것(1R/2R
// 구간의 정확한 단계는 오너가 "적용"이라고만 했지 세부 숫자를 안 줘서, 매 R단계마다
// 직전 단계를 잠그는 표준적 래칫 방식을 기본값으로 채택 — 백테스트 결과 보고 조정
// 대상). stopLossPct 파라미터화(2026-09-19, ATR 가변손절 — 위 rMultiplePrice와 동일
// 이유, 기본값 유지로 하위호환).
export function computeTrailingStop(entryPrice, highSinceEntry, stopLossPct = STOP_LOSS_PCT) {
  const r = reachedRMultiple(entryPrice, highSinceEntry, stopLossPct);
  if (r <= 0) return entryPrice * (1 - stopLossPct);
  if (r === 1) return entryPrice;
  return rMultiplePrice(entryPrice, r - 1, stopLossPct);
}

// True Range(당일 변동폭의 실제 범위, ATR의 구성요소) — max(고가-저가, |고가-전일
// 종가|, |저가-전일종가|). 전일 갭(전일종가 대비 오늘 시가가 크게 뛰거나 떨어진
// 경우)까지 반영한다는 게 단순 고가-저가와의 차이 — 위아래 갭 둘 다 고려.
// index 0은 전일종가가 없어 null.
export function computeTrueRange(highs, lows, closes) {
  const out = [null];
  for (let i = 1; i < highs.length; i++) {
    if (highs[i] == null || lows[i] == null || closes[i - 1] == null) { out.push(null); continue; }
    out.push(Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1]),
    ));
  }
  return out;
}

// ATR(Average True Range) — endIndex 포함 최근 period(기본 ATR_LOOKBACK_DAYS)개
// True Range의 단순평균(Wilder 지수이동평균 대신 단순이동평균으로 근사 — 이
// 프로젝트의 다른 롤링 지표(rollingVolatility 등)와 동일하게 단순 MA 관례를 따름,
// 실무상 차이는 미미). 창 부족·창 안에 null이 하나라도 있으면 null(추정 안 함,
// 이 파일의 다른 함수들과 동일 원칙).
export function computeATR(highs, lows, closes, endIndex, period = ATR_LOOKBACK_DAYS) {
  const tr = computeTrueRange(highs, lows, closes);
  const startIndex = endIndex - period + 1;
  if (startIndex < 0) return null;
  const window = tr.slice(startIndex, endIndex + 1);
  if (window.length < period || window.some((v) => v == null)) return null;
  return window.reduce((a, b) => a + b, 0) / period;
}

// ATR 기준 가변 손절폭 선택 — atr(computeATR 결과)와 price(보통 진입가)로 ATR%
// (=atr÷price×100)를 구해 임계값(ATR_STOP_THRESHOLD_PCT)과 비교, 넓은/좁은 손절
// 중 하나를 고른다(위 상수 설명 참고). 데이터 부족(atr=null)이거나 price가 유효하지
// 않으면 null — "판단 불가"를 조용히 어느 한쪽으로 떨구지 않는다(추정 안 함 원칙,
// 호출측이 null을 어떻게 처리할지 — 예: 기존 고정값 STOP_LOSS_PCT로 안전하게 폴백
// — 명시적으로 결정하게 한다).
export function selectAdaptiveStopLossPct(atr, price, {
  thresholdPct = ATR_STOP_THRESHOLD_PCT, tightPct = TIGHT_STOP_LOSS_PCT, widePct = STOP_LOSS_PCT,
} = {}) {
  if (atr == null || !(price > 0)) return null;
  const atrPct = (atr / price) * 100;
  return atrPct >= thresholdPct ? widePct : tightPct;
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
// stopLossPct 파라미터화(2026-09-19, ATR 가변손절 — 위 rMultiplePrice 등과 동일 이유).
export function shouldPyramid(entryPrice, highSinceEntry, unitsHeld, stopLossPct = STOP_LOSS_PCT) {
  return reachedRMultiple(entryPrice, highSinceEntry, stopLossPct) >= PYRAMID_TRIGGER_R && unitsHeld < 2;
}

// 3R 도달 시 포지션 50% 매도(부분 익절) 트리거 — 이미 실행했으면(alreadyTaken) 다시
// 안 함(1회성). "익절 신호 없이 있다가 고점 대비 되돌림에만 걸려 수익이 2R~3R 부근에
// 갇히는" 문제(오너 지적)에 대한 대응 — 절반은 3R에서 확정 실현, 나머지 절반만
// 트레일링을 계속 태워 더 크게 갈 여지를 남긴다.
export function shouldTakePartialProfit(entryPrice, highSinceEntry, alreadyTaken, stopLossPct = STOP_LOSS_PCT) {
  return !alreadyTaken && reachedRMultiple(entryPrice, highSinceEntry, stopLossPct) >= PARTIAL_PROFIT_TRIGGER_R;
}
