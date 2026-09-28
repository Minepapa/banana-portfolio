import { STOP_LOSS_PCT } from './breakout-risk.mjs';
import { PROTECTION_STATUS } from './breakout-position-vault.mjs';
import { roundToKrxTick } from './krx-tick.mjs';

export function computeInitialStopOrder(entryPrice, quantity, stopLossPct = STOP_LOSS_PCT) {
  const price = roundToKrxTick(entryPrice * (1 - stopLossPct));
  return { quantity, price, conditionPrice: price };
}

async function attempt(placeOrder, params) {
  try {
    const order = await placeOrder(params);
    if (!order?.orderNo) return { ok: false, confirmedNotSent: false, error: 'KIS 주문 응답에 주문번호 없음' };
    return { ok: true, orderNo: order.orderNo, orgNo: order.orgNo };
  } catch (error) {
    return { ok: false, confirmedNotSent: error.confirmedNotSent === true, error: error.message };
  }
}

export async function ensureStopOrder(position, {
  placeOrder, beforePlaceOrder = async () => true, maxAttempts = 3, delayMs = 5000,
  sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms)),
} = {}) {
  if (position.stopOrderNo) return { stopOrderNo: position.stopOrderNo, stopOrderOrgNo: position.stopOrderOrgNo ?? null, protectionStatus: PROTECTION_STATUS.PROTECTED, attempts: 0, stopAmbiguous: false };
  let attempts = 0;
  const stop = computeInitialStopOrder(position.entryPrice, position.quantity, position.stopLossPct ?? STOP_LOSS_PCT);
  while (attempts < maxAttempts) {
    if (!await beforePlaceOrder({ leg: 'stop', attempt: attempts + 1 })) return { stopOrderNo: null, stopOrderOrgNo: null, protectionStatus: PROTECTION_STATUS.FAILED, attempts, gateBlocked: true, stopAmbiguous: false };
    attempts += 1;
    const result = await attempt(placeOrder, { side: '매도', quantity: stop.quantity, price: position.stopPrice ?? stop.price, conditionPrice: position.stopPrice ?? stop.conditionPrice });
    if (result.ok) return { stopOrderNo: result.orderNo, stopOrderOrgNo: result.orgNo ?? null, protectionStatus: PROTECTION_STATUS.PROTECTED, attempts, stopAmbiguous: false };
    if (!result.confirmedNotSent) return { stopOrderNo: null, stopOrderOrgNo: null, protectionStatus: PROTECTION_STATUS.FAILED, attempts, stopAmbiguous: true, error: result.error };
    if (attempts < maxAttempts) await sleep(delayMs);
  }
  return { stopOrderNo: null, stopOrderOrgNo: null, protectionStatus: PROTECTION_STATUS.FAILED, attempts, stopAmbiguous: false };
}
