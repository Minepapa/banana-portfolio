import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyNhTimeoutOrder, formatNhTimeoutBody } from './watch-nh-order-fill.mjs';

test('classifyNhTimeoutOrder: 행이 없으면 추정하지 않는다', () => {
  assert.deepEqual(classifyNhTimeoutOrder(null), { kind: 'unknown' });
});

test('classifyNhTimeoutOrder: 전체 미체결을 수량으로 판정한다', () => {
  assert.deepEqual(classifyNhTimeoutOrder({
    tot_cns_qty: '0', ny_cns_qty: '49', can_qty: '0', orr_rjt_rsn_cd_nm: '정상',
  }), {
    kind: 'unfilled', filledQty: 0, unfilledQty: 49, canceledQty: 0,
  });
});

test('classifyNhTimeoutOrder: 부분체결을 수량으로 판정한다', () => {
  assert.deepEqual(classifyNhTimeoutOrder({
    tot_cns_qty: '20', ny_cns_qty: '29', can_qty: '0', orr_rjt_rsn_cd_nm: '정상',
  }), {
    kind: 'partial', filledQty: 20, unfilledQty: 29, canceledQty: 0,
  });
});

test('classifyNhTimeoutOrder: 취소와 거부는 체결수량보다 우선한다', () => {
  assert.equal(classifyNhTimeoutOrder({
    tot_cns_qty: '20', ny_cns_qty: '0', can_qty: '29', orr_rjt_rsn_cd_nm: '정상',
  }).kind, 'canceled');
  assert.equal(classifyNhTimeoutOrder({
    tot_cns_qty: '0', ny_cns_qty: '49', can_qty: '0', orr_rjt_rsn_cd_nm: '주문거부',
  }).kind, 'rejected');
});

test('formatNhTimeoutBody: 미체결은 수량과 정정·취소 경로를 함께 알린다', () => {
  const body = formatNhTimeoutBody({
    name: 'SK텔레콤', code: '017670', orderNo: '0018416600', account: '위탁', timeoutMin: 30,
    state: { kind: 'unfilled', filledQty: 0, unfilledQty: 49, canceledQty: 0 },
  });
  assert.match(body, /■ 주문/);
  assert.match(body, /■ API 최종 조회/);
  assert.match(body, /전량미체결/);
  assert.match(body, /미체결 49주/);
  assert.match(body, /정정 또는 취소/);
});
