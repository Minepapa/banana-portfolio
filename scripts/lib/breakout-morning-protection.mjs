// 아침 보호주문 조정의 부작용 없는 판정 계층. 미체결 매도주문이 같은 종목에
// 보유수량/API 응답이 불일치하거나 미확인 매도주문이 있으면 중복 방지를 위해 발주하지 않는다.
import { PARTIAL_PROFIT_SELL_FRACTION } from './breakout-risk.mjs';

export function decideMorningProtection({ position, holding, sellOrders, currentPrice, stopPrice, profitPrice }) {
  if (!position || position.status !== '보유') return { action: 'skip', reason: '보유 포지션 아님' };
  if (!holding || !Number.isInteger(holding.qty) || holding.qty <= 0) {
    return { action: 'review', reason: 'KIS 잔고에서 보유수량을 확정하지 못함' };
  }
  if (holding.qty !== Number(position.quantity)) {
    return { action: 'review', reason: `보유수량 불일치(기록 ${position.quantity}, KIS ${holding.qty})` };
  }
  if (!Number.isFinite(Number(position.stopPrice)) || Number(position.stopPrice) !== stopPrice) {
    return { action: 'review', reason: `기록 손절가와 진입값 기반 계산 손절가 불일치(기록 ${position.stopPrice ?? '없음'}, 계산 ${stopPrice})` };
  }
  if (!(currentPrice > 0) || !(stopPrice > 0) || (profitPrice != null && !(profitPrice > 0))) {
    return { action: 'review', reason: '현재가 또는 보호가격 확인 불가' };
  }
  if (currentPrice <= stopPrice || (profitPrice != null && currentPrice >= profitPrice)) {
    return { action: 'review', reason: '현재가가 손절/3R 조건선을 이미 통과' };
  }
  const orders = (sellOrders || []).filter((o) => o.code === position.code && o.side === '매도' && (o.cancelableQty ?? 0) > 0);
  const stopQty = Number(position.quantity);
  const profitQty = Math.floor(stopQty * PARTIAL_PROFIT_SELL_FRACTION);
  const isExactProtectionLeg = (order, quantity, price) => quantity > 0
    && order.orderTypeCode === '22'
    && order.quantity === quantity
    && order.filledQty === 0
    && order.cancelableQty === quantity
    && order.conditionPrice === price
    && order.orderPrice === price;
  const stopMatches = orders.filter((o) => isExactProtectionLeg(o, stopQty, stopPrice));
  const profitMatches = profitQty > 0 && profitPrice != null
    ? orders.filter((o) => isExactProtectionLeg(o, profitQty, profitPrice)) : [];
  const identified = new Set([...stopMatches, ...profitMatches]);
  const unexpected = orders.filter((o) => !identified.has(o));
  if (stopMatches.length > 1 || profitMatches.length > 1 || unexpected.length) {
    return {
      action: 'review',
      reason: `같은 종목 미체결 매도주문을 보호주문과 유일하게 대조할 수 없음(확인대상 ${orders.length}건)`,
      orders,
    };
  }
  return {
    action: 'place',
    reason: '잔고·가격 조건 일치, 보호주문 다리별 대조 완료',
    existingStop: stopMatches[0] ?? null,
    existingProfit: profitMatches[0] ?? null,
  };
}

// API에서 확인한 기존 보호 다리를 실행기 입력으로 이어준다. ensurePositionProtected가
// 이 번호들을 받은 다리는 건너뛰고 실제 누락 다리만 접수하므로 부분 성공을 안전히 재개한다.
export function carryForwardProtectionOrders(position, decision) {
  return {
    ...position,
    stopOrderNo: decision.existingStop?.orderNo ?? null,
    stopOrderOrgNo: decision.existingStop?.branchNo ?? null,
    profitOrderNo: decision.existingProfit?.orderNo ?? null,
    profitOrderOrgNo: decision.existingProfit?.branchNo ?? null,
  };
}
