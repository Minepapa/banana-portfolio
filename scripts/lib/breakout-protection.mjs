// 돌파매매 전략 — 매수 체결 후 보호주문(손절 전량+3R 부분익절 절반) 동시 발주
// (2026-09-13). 순수 계산(computeProtectionOrders)과 실제 발주(placeProtectionOrders,
// 부작용 있음 — placeOrder를 주입받아 테스트 가능)를 분리한다.
import {
  STOP_LOSS_PCT, rMultiplePrice, PARTIAL_PROFIT_TRIGGER_R, PARTIAL_PROFIT_SELL_FRACTION,
} from './breakout-risk.mjs';
import { PROTECTION_STATUS } from './breakout-position-vault.mjs';
import { roundToKrxTick } from './krx-tick.mjs';

// entryPrice/quantity: 실제 매수 체결 결과(체결가·체결수량 — 예약 시점의 예상치가
// 아니라 실제 값이어야 함, 시가 갭으로 예상과 다를 수 있어서). 반환: 두 스톱지정가
// 주문에 쓸 파라미터.
//
// ⚠️ 부분익절 수량은 Math.floor(내림)만 쓴다 — 절대 올림 금지(매도가능수량 초과 방지,
// 추정 금지 원칙과 동일 정신: 애매하면 보수적 쪽으로).
//
// ⚠️ 미검증 가정(2026-09-13, 실거래 전 확인 필요) — 손절주문(전량)과 부분익절주문
// (절반)을 "동시에" 걸어두는 게 실제 KIS 계좌에서 허용되는지(둘 다 조건부 미체결
// 상태라 매도가능수량을 겹쳐서 예약해도 되는지, 아니면 한쪽이 다른 쪽의 가용수량을
// 막는지)는 코드로 확인 못 했다 — `inquire_psbl_sell`(주식매도가능수량조회)로 실제
// 계좌에서 사전 확인 필요. 만약 겹치는 예약이 거부되면, 부분익절 수량만큼을 손절
// 주문에서 미리 빼는 방식(손절 전량 대신 "손절 수량 = 전체-부분익절수량"으로 걸고,
// 부분익절 체결 시 나머지에 대해 새 손절을 거는 방식)으로 재설계해야 할 수 있다.
// stopLossPct 파라미터화(2026-09-19, ATR 가변손절 실전배선) — 기본값은 기존
// STOP_LOSS_PCT(8%) 그대로라 안 넘기는 호출부는 하위호환(회귀 없음). 3R
// 부분익절 목표가 stopLossPct에 비례하는 건 breakout-risk.mjs rMultiplePrice의
// 기존 설계 그대로(손절폭 4%인 포지션은 3R 목표가 +12%가 됨, +24%가 아님).
// ⚠️ 호가단위 보정(2026-09-22, 실전 첫 손절주문 시도가 KIS "주식주문호가단위
// 오류입니다"로 거부되며 발견 — SK텔레콤 87,400원×0.92=80,408원은 이 가격대
// (50,000~200,000원) 호가단위 100원의 배수가 아니었다). entryPrice*(1±비율)
// 퍼센트 계산은 호가단위를 모르므로, 실제 주문 가격으로 쓰기 직전에 여기서만
// roundToKrxTick으로 보정한다 — breakout-risk.mjs의 rMultiplePrice·
// computeTrailingStop 자체는 안 건드림(백테스트 시뮬레이터(breakout-simulator.mjs)
// 도 같은 함수를 쓰는데, 거기 반올림을 넣으면 과거 검증된 백테스트 성과 수치가
// 미세하게 달라진다 — 실주문 경계에서만 보정하는 게 맞다).
export function computeProtectionOrders(entryPrice, quantity, stopLossPct = STOP_LOSS_PCT) {
  const stopPrice = roundToKrxTick(entryPrice * (1 - stopLossPct));
  const partialQty = Math.floor(quantity * PARTIAL_PROFIT_SELL_FRACTION);
  const profitPrice = roundToKrxTick(rMultiplePrice(entryPrice, PARTIAL_PROFIT_TRIGGER_R, stopLossPct));
  return {
    stopOrder: { quantity, conditionPrice: stopPrice, price: stopPrice },
    profitOrder: partialQty > 0 ? { quantity: partialQty, conditionPrice: profitPrice, price: profitPrice } : null,
  };
}

async function tryPlace(placeOrder, params) {
  try {
    const order = await placeOrder(params);
    return { ok: true, orderNo: order.orderNo, orgNo: order.orgNo };
  } catch (e) {
    return { ok: false, error: e.message, confirmedNotSent: e.confirmedNotSent === true };
  }
}

// 손절+부분익절 두 주문을 각각 독립 시도 — 하나가 실패해도 나머지는 시도한다(부분
// 성공을 정직하게 반영, 호출측이 stopResult/profitResult 각각의 ok로 무엇이 됐는지
// 판단해 재시도 대상을 좁힐 수 있게). placeOrder: (params)=>Promise<{orderNo,orgNo}>
// — kis.mjs placeKrOrder를 code/side 고정해 부분적용한 함수를 호출측이 주입(테스트
// 시엔 스텁 주입). 반환: { stopOrder: {...계산값, ...tryPlace결과}, profitOrder,
// fullyProtected }.
export async function placeProtectionOrders({ entryPrice, quantity, placeOrder, stopLossPct = STOP_LOSS_PCT }) {
  const { stopOrder, profitOrder } = computeProtectionOrders(entryPrice, quantity, stopLossPct);

  const stopResult = { ...stopOrder, ...await tryPlace(placeOrder, { side: '매도', quantity: stopOrder.quantity, price: stopOrder.price, conditionPrice: stopOrder.conditionPrice }) };
  const profitResult = profitOrder
    ? { ...profitOrder, ...await tryPlace(placeOrder, { side: '매도', quantity: profitOrder.quantity, price: profitOrder.price, conditionPrice: profitOrder.conditionPrice }) }
    : { ok: true, skipped: true };

  return { stopOrder: stopResult, profitOrder: profitResult, fullyProtected: stopResult.ok && profitResult.ok };
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 포지션 레코드(breakout-position-vault.mjs 파싱 결과) 기준으로 "아직 안 걸린
// 보호주문만" 재시도 — 이미 걸린 다리(stopOrderNo/profitOrderNo가 non-null)는
// 절대 다시 발주하지 않는다(재시도가 중복주문이 되면 안 됨, 이 프로젝트 전체의
// idempotency 원칙과 동일). profitOrderApplicable=false인 포지션은 부분익절
// 자체를 처음부터 필요없다고 보고 재시도 대상에서 제외.
//
// maxAttempts 회까지 시도, 매 시도 사이 delayMs 대기(sleep 주입 — 테스트에서
// 실제로 안 기다리게). 반환: { stopOrderNo, stopOrderOrgNo, profitOrderNo,
// profitOrderOrgNo, protectionStatus, attempts } — 호출측이 이 값을
// updateBreakoutPositionRecord에 그대로 병합하면 됨.
export async function ensurePositionProtected(position, {
  placeOrder, maxAttempts = 3, delayMs = 5000, sleep = defaultSleep,
}) {
  const needsStop = !position.stopOrderNo;
  const needsProfit = position.profitOrderApplicable && !position.profitOrderNo;

  const out = {
    stopOrderNo: position.stopOrderNo ?? null,
    stopOrderOrgNo: position.stopOrderOrgNo ?? null,
    profitOrderNo: position.profitOrderNo ?? null,
    profitOrderOrgNo: position.profitOrderOrgNo ?? null,
  };
  if (!needsStop && !needsProfit) {
    return { ...out, protectionStatus: PROTECTION_STATUS.PROTECTED, attempts: 0 };
  }

  // position.stopLossPct 사용(2026-09-19, ATR 가변손절) — 없으면(과거 레코드,
  // ATR 계산 불가로 폴백됐던 포지션 등) 기존 고정값. 3R 부분익절 재시도 가격이
  // 이 값에 비례하므로, 원래 진입 시 확정됐던 손절폭과 반드시 같아야 한다(재시도
  // 때 다른 값을 쓰면 원래 포지션의 3R 목표가와 어긋난 가격으로 주문이 나간다).
  const { stopOrder, profitOrder } = computeProtectionOrders(position.entryPrice, position.quantity, position.stopLossPct ?? STOP_LOSS_PCT);
  let attempts = 0;
  let stopDone = !needsStop;
  let profitDone = !needsProfit;
  // ⚠️ 코드리뷰 HIGH 지적(2026-09-13) — confirmedNotSent가 아닌 실패(네트워크 예외·
  // 응답파싱 실패 등, "실제로 접수됐을 수 있음")를 무조건 재시도하면 이미 접수된
  // 주문 위에 또 하나를 얹어 이중 주문이 될 수 있다(kis.mjs placeKrOrder 상단
  // confirmedNotSent 계약과 동일 원칙). 애매한 실패는 그 다리만 즉시 재시도 중단.
  let stopAmbiguous = false;
  let profitAmbiguous = false;

  while (attempts < maxAttempts && (!stopDone || !profitDone)) {
    attempts += 1;
    if (!stopDone) {
      const r = await tryPlace(placeOrder, { side: '매도', quantity: stopOrder.quantity, price: position.stopPrice, conditionPrice: position.stopPrice });
      if (r.ok) { out.stopOrderNo = r.orderNo; out.stopOrderOrgNo = r.orgNo; stopDone = true; }
      else if (!r.confirmedNotSent) { stopDone = true; stopAmbiguous = true; }
    }
    if (!profitDone && profitOrder) {
      const r = await tryPlace(placeOrder, { side: '매도', quantity: profitOrder.quantity, price: profitOrder.price, conditionPrice: profitOrder.conditionPrice });
      if (r.ok) { out.profitOrderNo = r.orderNo; out.profitOrderOrgNo = r.orgNo; profitDone = true; }
      else if (!r.confirmedNotSent) { profitDone = true; profitAmbiguous = true; }
    }
    if ((!stopDone || !profitDone) && attempts < maxAttempts) await sleep(delayMs);
  }

  const protectionStatus = (stopDone && profitDone && !stopAmbiguous && !profitAmbiguous)
    ? PROTECTION_STATUS.PROTECTED : PROTECTION_STATUS.FAILED;
  return { ...out, protectionStatus, attempts, stopAmbiguous, profitAmbiguous };
}
