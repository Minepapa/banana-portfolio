import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  getGbBalance, getGbBuyableAmount, getGbDailyTransaction, getGbMargin,
  getGbPeriodPnl, getGbPeriodPnlDetail, getGbReservedOrders, getGbUnexecuted,
  getGbCurrentPrice, getGbExecutionTrend, getGbPeriodPrice, getGbSymbolIndexFxPeriod,
  placeGbBuyOrder, placeGbSellOrder, modifyGbOrder, cancelGbOrder,
  placeGbReservedOrder, cancelGbReservedOrder,
} from './nhplug-gbstock.mjs';
import { setNhRateLimitForTests } from './nhplug.mjs';

setNhRateLimitForTests(Infinity);

// fetch 모킹 헬퍼 — nhplug-krstock.test.js와 동일 패턴.
const mockFetch = (responses) => {
  let i = 0;
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, body: init?.body ? JSON.parse(init.body) : null });
    const r = responses[Math.min(i++, responses.length - 1)];
    return { ok: r.ok !== false, status: r.status ?? 200, text: async () => JSON.stringify(r.body) };
  };
  fn.calls = calls;
  return fn;
};

// ============================================================================
// 조회(inquiry) 8종 — 읽기 전용, 필드 배선만 확인.

test('getGbBalance: 기본값(qutIqrDitCd=1·fcSecTrdNatCd=200·curCd=KRW) 배선', async () => {
  const fetchImpl = mockFetch([{ body: { Output_0: {}, Output_1: [] } }]);
  await getGbBalance({ token: 't', actNo: '1', fetchImpl });
  assert.deepEqual(fetchImpl.calls[0].body.Input_0, {
    act_no: '1', qut_iqr_dit_cd: '1', fc_sec_trd_nat_cd: '200', cur_cd: 'KRW',
  });
});

test('getGbBuyableAmount: 기본값(pcsDit=2·ahiNmnPrTpCd=00 등) 배선, price 주면 fc_orr_uit_pr 포함', async () => {
  const fetchImpl = mockFetch([{ body: { Output_0: {} } }]);
  await getGbBuyableAmount({ token: 't', actNo: '1', iemCd: 'AAPL', price: 230.5, fetchImpl });
  const input0 = fetchImpl.calls[0].body.Input_0;
  assert.equal(input0.pcs_dit, '2');
  assert.equal(input0.ahi_nmn_pr_tp_cd, '00');
  assert.equal(input0.wtm_cur_knd_cd, '1');
  assert.equal(input0.fc_orr_uit_pr, 230.5);
});

test('getGbDailyTransaction: 기본값(actTrdCfcCd=00·iemMlfCd=00001) 배선', async () => {
  const fetchImpl = mockFetch([{ body: { Output_0: [] } }]);
  await getGbDailyTransaction({ token: 't', actNo: '1', iqrStaDt: '20260801', iqrEndDt: '20260902', fetchImpl });
  const input0 = fetchImpl.calls[0].body.Input_0;
  assert.equal(input0.act_trd_cfc_cd, '00');
  assert.equal(input0.iem_mlf_cd, '00001');
});

test('getGbMargin: act_no만 배선', async () => {
  const fetchImpl = mockFetch([{ body: { Output_0: {} } }]);
  await getGbMargin({ token: 't', actNo: '1', fetchImpl });
  assert.deepEqual(fetchImpl.calls[0].body.Input_0, { act_no: '1' });
});

test('getGbPeriodPnl: staOrrDt·endOrrDt 필수값 그대로 배선', async () => {
  const fetchImpl = mockFetch([{ body: { Output_0: [] } }]);
  await getGbPeriodPnl({ token: 't', actNo: '1', staOrrDt: '20260801', endOrrDt: '20260902', fetchImpl });
  const input0 = fetchImpl.calls[0].body.Input_0;
  assert.equal(input0.sta_orr_dt, '20260801');
  assert.equal(input0.end_orr_dt, '20260902');
  assert.equal(input0.iqr_dit, '1');
});

test('getGbPeriodPnlDetail: orrDt 필수값 배선', async () => {
  const fetchImpl = mockFetch([{ body: { Output_0: [] } }]);
  await getGbPeriodPnlDetail({ token: 't', actNo: '1', orrDt: '20260902', fetchImpl });
  assert.equal(fetchImpl.calls[0].body.Input_0.orr_dt, '20260902');
});

test('getGbReservedOrders: 전체 기본값 배선', async () => {
  const fetchImpl = mockFetch([{ body: { Output_0: [] } }]);
  await getGbReservedOrders({ token: 't', actNo: '1', bkgOrrDt: '20260902', fetchImpl });
  const input0 = fetchImpl.calls[0].body.Input_0;
  assert.equal(input0.fc_mkt_dit_cd, '000');
  assert.equal(input0.sby_dit_cd, '0');
});

test('getGbUnexecuted: 기본값(ostCnsDit=0 전체) 배선', async () => {
  const fetchImpl = mockFetch([{ body: { Output_0: [] } }]);
  await getGbUnexecuted({ token: 't', actNo: '1', orrDt: '20260902', fetchImpl });
  assert.equal(fetchImpl.calls[0].body.Input_0.ost_cns_dit, '0');
});

// ============================================================================
// 시세(quote) 4종

test('getGbCurrentPrice: iem_cd만 배선', async () => {
  const fetchImpl = mockFetch([{ body: { Output_0: { iem_cd: 'USAAPL' } } }]);
  await getGbCurrentPrice({ token: 't', iemCd: 'AAPL', fetchImpl });
  assert.deepEqual(fetchImpl.calls[0].body.Input_0, { iem_cd: 'AAPL' });
});

test('getGbExecutionTrend: 기본값(periodType=1·reqCnt=30) 배선', async () => {
  const fetchImpl = mockFetch([{ body: { Output_0: [] } }]);
  await getGbExecutionTrend({ token: 't', iemCd: 'AAPL', fetchImpl });
  assert.deepEqual(fetchImpl.calls[0].body.Input_0, { period_type: '1', req_cnt: 30, iem_cd: 'AAPL' });
});

test('getGbPeriodPrice: 기본값(gubun=3 일) 배선, endDt 필수', async () => {
  const fetchImpl = mockFetch([{ body: { Output_0: [] } }]);
  await getGbPeriodPrice({ token: 't', iemCd: 'AAPL', endDt: '20260902', fetchImpl });
  const input0 = fetchImpl.calls[0].body.Input_0;
  assert.equal(input0.end_dt, '20260902');
  assert.equal(input0.gubun, '3');
});

test('getGbSymbolIndexFxPeriod: 기본값(gubun=1 일) 배선, 선택 필드는 준 경우만 포함', async () => {
  const fetchImpl = mockFetch([{ body: { Output_0: [] } }]);
  await getGbSymbolIndexFxPeriod({ token: 't', iemCd: 'USDKRW', endDt: '20260902', fetchImpl });
  const input0 = fetchImpl.calls[0].body.Input_0;
  assert.equal(input0.gubun, '1');
  assert.equal('xtick' in input0, false);
});

// ============================================================================
// 주문(order) 6종 — 안전장치 배선 확인(공유 검증기 재사용이므로 상세 로직은
// nhplug-order-safety.test.js가 이미 검증, 여기선 gbstock 함수가 그걸 실제로
// 호출하는지 + gbstock 전용 규칙만 확인).

test('placeGbBuyOrder: 정상 응답이면 orr_no 반환, price 있으면 지정가(00)', async () => {
  const fetchImpl = mockFetch([{ body: { Output_0: { orr_no: 113 } } }]);
  const r = await placeGbBuyOrder({ token: 't', actNo: '1', iemCd: 'AAPL', quantity: 10, price: 230.5, fetchImpl });
  assert.equal(r.orderNo, '113');
  assert.match(fetchImpl.calls[0].url, /\/gbstock\/order\/v1\/buy$/);
  const input0 = fetchImpl.calls[0].body.Input_0;
  assert.equal(input0.ahi_nmn_pr_tp_cd, '00');
  assert.equal(input0.fc_orr_uit_pr, 230.5);
  assert.equal(input0.fc_sec_trd_nat_cd, '200');
});

test('placeGbSellOrder: 정상 응답이면 orr_no 반환(2026-09-02 코드리뷰 지적 — 매도 happy path 누락돼 있었음, buy/sell URL 스왑을 못 잡을 뻔함)', async () => {
  const fetchImpl = mockFetch([{ body: { Output_0: { orr_no: 114 } } }]);
  const r = await placeGbSellOrder({ token: 't', actNo: '1', iemCd: 'AAPL', quantity: 10, price: 230.5, fetchImpl });
  assert.equal(r.orderNo, '114');
  assert.match(fetchImpl.calls[0].url, /\/gbstock\/order\/v1\/sell$/);
});

test('[핵심 안전장치] placeGbBuyOrder: 가격이 소수점 2자리를 초과하면 즉시 throw + confirmedNotSent=true(2026-09-02 코드리뷰 지적)', async () => {
  const fetchImpl = mockFetch([{ body: { Output_0: { orr_no: 1 } } }]);
  try {
    await placeGbBuyOrder({ token: 't', actNo: '1', iemCd: 'AAPL', quantity: 10, price: 230.567, fetchImpl });
    assert.fail('throw 됐어야 함');
  } catch (e) {
    assert.equal(e.confirmedNotSent, true);
  }
  assert.equal(fetchImpl.calls.length, 0);
});

test('placeGbBuyOrder: price 생략하면 시장가(03), fc_orr_uit_pr 필드 자체가 없음', async () => {
  const fetchImpl = mockFetch([{ body: { Output_0: { orr_no: 1 } } }]);
  await placeGbBuyOrder({ token: 't', actNo: '1', iemCd: 'AAPL', quantity: 10, fetchImpl });
  const input0 = fetchImpl.calls[0].body.Input_0;
  assert.equal(input0.ahi_nmn_pr_tp_cd, '03');
  assert.equal('fc_orr_uit_pr' in input0, false);
});

test('[핵심 안전장치] placeGbBuyOrder: actNo·iemCd 없으면 즉시 throw + confirmedNotSent=true(공유 검증기 호출 확인)', async () => {
  const fetchImpl = mockFetch([{ body: { Output_0: { orr_no: 1 } } }]);
  try {
    await placeGbBuyOrder({ token: 't', iemCd: 'AAPL', quantity: 10, price: 230.5, fetchImpl });
    assert.fail('throw 됐어야 함');
  } catch (e) {
    assert.equal(e.confirmedNotSent, true);
  }
  assert.equal(fetchImpl.calls.length, 0);
});

test('[핵심 안전장치] placeGbBuyOrder: 수량 0 이하면 즉시 throw + confirmedNotSent=true', async () => {
  const fetchImpl = mockFetch([{ body: { Output_0: { orr_no: 1 } } }]);
  try {
    await placeGbBuyOrder({ token: 't', actNo: '1', iemCd: 'AAPL', quantity: 0, price: 230.5, fetchImpl });
    assert.fail('throw 됐어야 함');
  } catch (e) {
    assert.equal(e.confirmedNotSent, true);
  }
  assert.equal(fetchImpl.calls.length, 0);
});

test('[핵심 안전장치] placeGbBuyOrder: NH 업무거부면 confirmedNotSent=true', async () => {
  const fetchImpl = mockFetch([{ body: { rsp_cd: '10006', rsp_msg: '주문가능금액이 부족합니다.' } }]);
  try {
    await placeGbBuyOrder({ token: 't', actNo: '1', iemCd: 'AAPL', quantity: 10, price: 230.5, fetchImpl });
    assert.fail('throw 됐어야 함');
  } catch (e) {
    assert.equal(e.confirmedNotSent, true);
  }
});

test('[핵심 안전장치] placeGbBuyOrder: 응답 성공인데 orr_no 없으면 confirmedNotSent 안 붙음(불명)', async () => {
  const fetchImpl = mockFetch([{ body: { Output_0: {} } }]);
  try {
    await placeGbBuyOrder({ token: 't', actNo: '1', iemCd: 'AAPL', quantity: 10, price: 230.5, fetchImpl });
    assert.fail('throw 됐어야 함');
  } catch (e) {
    assert.equal(e.confirmedNotSent, undefined);
  }
});

test('[핵심 안전장치] placeGbBuyOrder: 네트워크 예외면 confirmedNotSent 안 붙음(불명)', async () => {
  const fetchImpl = async () => { throw new Error('fetch failed'); };
  try {
    await placeGbBuyOrder({ token: 't', actNo: '1', iemCd: 'AAPL', quantity: 10, price: 230.5, fetchImpl });
    assert.fail('throw 됐어야 함');
  } catch (e) {
    assert.equal(e.confirmedNotSent, undefined);
  }
});

test('[핵심 안전장치] placeGbBuyOrder: 429여도 confirmedNotSent 안 붙음(불명)', async () => {
  const fetchImpl = mockFetch([{ status: 429, body: { rsp_msg: '초당 호출한도 초과' } }]);
  try {
    await placeGbBuyOrder({ token: 't', actNo: '1', iemCd: 'AAPL', quantity: 10, price: 230.5, fetchImpl });
    assert.fail('throw 됐어야 함');
  } catch (e) {
    assert.equal(e.confirmedNotSent, undefined);
  }
});

test('[핵심 안전장치] placeGbBuyOrder: HTTP 4xx(비-429)여도 confirmedNotSent 안 붙음(불명)', async () => {
  const fetchImpl = async () => ({ ok: false, status: 500, text: async () => JSON.stringify({ error: 'internal' }) });
  try {
    await placeGbBuyOrder({ token: 't', actNo: '1', iemCd: 'AAPL', quantity: 10, price: 230.5, fetchImpl });
    assert.fail('throw 됐어야 함');
  } catch (e) {
    assert.equal(e.confirmedNotSent, undefined);
  }
});

test('[핵심 안전장치] placeGbSellOrder: 매도도 동일 안전장치 + 네트워크 예외 케이스', async () => {
  const fetchImpl = async () => { throw new Error('fetch failed'); };
  try {
    await placeGbSellOrder({ token: 't', actNo: '1', iemCd: 'AAPL', quantity: 10, price: 230.5, fetchImpl });
    assert.fail('throw 됐어야 함');
  } catch (e) {
    assert.equal(e.confirmedNotSent, undefined);
  }
});

test('modifyGbOrder: 정상 응답이면 orr_no 반환', async () => {
  const fetchImpl = mockFetch([{ body: { Output_0: { orr_no: 999 } } }]);
  const r = await modifyGbOrder({ token: 't', actNo: '1', orgOrrNo: 123, iemCd: 'AAPL', corPr: 231.0, fetchImpl });
  assert.equal(r.orderNo, '999');
  assert.match(fetchImpl.calls[0].url, /\/gbstock\/order\/v1\/modify$/);
  assert.equal(fetchImpl.calls[0].body.Input_0.fc_orr_uit_pr, 231.0);
});

test('[핵심 안전장치] modifyGbOrder: 정정가격이 소수점 2자리를 초과하면 즉시 throw + confirmedNotSent=true', async () => {
  const fetchImpl = mockFetch([{ body: { Output_0: { orr_no: 1 } } }]);
  try {
    await modifyGbOrder({ token: 't', actNo: '1', orgOrrNo: 123, iemCd: 'AAPL', corPr: 231.567, fetchImpl });
    assert.fail('throw 됐어야 함');
  } catch (e) {
    assert.equal(e.confirmedNotSent, true);
  }
  assert.equal(fetchImpl.calls.length, 0);
});

test('[핵심 안전장치] modifyGbOrder: 정정가격 0 이하면 즉시 throw + confirmedNotSent=true', async () => {
  const fetchImpl = mockFetch([{ body: { Output_0: { orr_no: 1 } } }]);
  try {
    await modifyGbOrder({ token: 't', actNo: '1', orgOrrNo: 123, iemCd: 'AAPL', corPr: 0, fetchImpl });
    assert.fail('throw 됐어야 함');
  } catch (e) {
    assert.equal(e.confirmedNotSent, true);
  }
  assert.equal(fetchImpl.calls.length, 0);
});

test('[핵심 안전장치] modifyGbOrder: orgOrrNo 없으면 즉시 throw + confirmedNotSent=true(공유 검증기, label 확인)', async () => {
  const fetchImpl = mockFetch([{ body: { Output_0: { orr_no: 1 } } }]);
  try {
    await modifyGbOrder({ token: 't', actNo: '1', iemCd: 'AAPL', corPr: 231.0, fetchImpl });
    assert.fail('throw 됐어야 함');
  } catch (e) {
    assert.equal(e.confirmedNotSent, true);
    assert.match(e.message, /orgOrrNo/);
  }
  assert.equal(fetchImpl.calls.length, 0);
});

test('[핵심 안전장치] modifyGbOrder: NH 업무거부면 confirmedNotSent=true', async () => {
  const fetchImpl = mockFetch([{ body: { rsp_cd: '10006', rsp_msg: '주문번호가 존재하지 않습니다.' } }]);
  try {
    await modifyGbOrder({ token: 't', actNo: '1', orgOrrNo: 123, iemCd: 'AAPL', corPr: 231.0, fetchImpl });
    assert.fail('throw 됐어야 함');
  } catch (e) {
    assert.equal(e.confirmedNotSent, true);
  }
});

test('[핵심 안전장치] modifyGbOrder: 네트워크 예외면 confirmedNotSent 안 붙음(불명)', async () => {
  const fetchImpl = async () => { throw new Error('fetch failed'); };
  try {
    await modifyGbOrder({ token: 't', actNo: '1', orgOrrNo: 123, iemCd: 'AAPL', corPr: 231.0, fetchImpl });
    assert.fail('throw 됐어야 함');
  } catch (e) {
    assert.equal(e.confirmedNotSent, undefined);
  }
});

test('cancelGbOrder: 전체취소가 기본값, can_qty 필드 자체가 없음', async () => {
  const fetchImpl = mockFetch([{ body: { Output_0: { orr_no: 888 } } }]);
  const r = await cancelGbOrder({ token: 't', actNo: '1', orgOrrNo: 123, iemCd: 'AAPL', fetchImpl });
  assert.equal(r.orderNo, '888');
  assert.match(fetchImpl.calls[0].url, /\/gbstock\/order\/v1\/cancel$/);
  const input0 = fetchImpl.calls[0].body.Input_0;
  assert.equal(input0.all_pat_dit_cd, '1');
  assert.equal('can_qty' in input0, false);
});

test('cancelGbOrder: 일부취소(allPatDitCd=2)면 can_qty 포함', async () => {
  const fetchImpl = mockFetch([{ body: { Output_0: { orr_no: 888 } } }]);
  await cancelGbOrder({ token: 't', actNo: '1', orgOrrNo: 123, iemCd: 'AAPL', canQty: 5, allPatDitCd: '2', fetchImpl });
  assert.equal(fetchImpl.calls[0].body.Input_0.can_qty, 5);
});

test('[핵심 안전장치] cancelGbOrder: canQty를 줬는데 allPatDitCd가 "2"가 아니면 즉시 throw(공유 검증기 호출 확인)', async () => {
  const fetchImpl = mockFetch([{ body: { Output_0: { orr_no: 1 } } }]);
  try {
    await cancelGbOrder({ token: 't', actNo: '1', orgOrrNo: 123, iemCd: 'AAPL', canQty: 5, fetchImpl });
    assert.fail('throw 됐어야 함');
  } catch (e) {
    assert.equal(e.confirmedNotSent, true);
  }
  assert.equal(fetchImpl.calls.length, 0);
});

test('[핵심 안전장치] cancelGbOrder: actNo·iemCd 없으면 즉시 throw + confirmedNotSent=true', async () => {
  const fetchImpl = mockFetch([{ body: { Output_0: { orr_no: 1 } } }]);
  try {
    await cancelGbOrder({ token: 't', orgOrrNo: 123, fetchImpl });
    assert.fail('throw 됐어야 함');
  } catch (e) {
    assert.equal(e.confirmedNotSent, true);
  }
  assert.equal(fetchImpl.calls.length, 0);
});

test('[핵심 안전장치] cancelGbOrder: NH 업무거부면 confirmedNotSent=true', async () => {
  const fetchImpl = mockFetch([{ body: { rsp_cd: '10006', rsp_msg: '이미 체결된 주문입니다.' } }]);
  try {
    await cancelGbOrder({ token: 't', actNo: '1', orgOrrNo: 123, iemCd: 'AAPL', fetchImpl });
    assert.fail('throw 됐어야 함');
  } catch (e) {
    assert.equal(e.confirmedNotSent, true);
  }
});

test('[핵심 안전장치] cancelGbOrder: 네트워크 예외면 confirmedNotSent 안 붙음(불명)', async () => {
  const fetchImpl = async () => { throw new Error('fetch failed'); };
  try {
    await cancelGbOrder({ token: 't', actNo: '1', orgOrrNo: 123, iemCd: 'AAPL', fetchImpl });
    assert.fail('throw 됐어야 함');
  } catch (e) {
    assert.equal(e.confirmedNotSent, undefined);
  }
});

// ── 예약주문(placeGbReservedOrder·cancelGbReservedOrder) ──

test('placeGbReservedOrder: 정상 응답이면 bkg_rtn_orr_no를 orderNo로 반환, 고정값(bkg_orr_tp_cd=1·cfd_lon_cd=00·nmn_pr_tp_cd=00·oss_orr_knd_cd=1) 배선', async () => {
  const fetchImpl = mockFetch([{ body: { Output_0: { bkg_rtn_orr_no: 555 } } }]);
  const r = await placeGbReservedOrder({
    token: 't', actNo: '1', iemCd: 'AAPL', sbyDitCd: '2', quantity: 10, price: 230.5, fetchImpl,
  });
  assert.equal(r.orderNo, '555');
  assert.match(fetchImpl.calls[0].url, /\/gbstock\/order\/v1\/reservedSubmit$/);
  const input0 = fetchImpl.calls[0].body.Input_0;
  assert.equal(input0.oss_sby_dit_cd, '2');
  assert.equal(input0.bkg_orr_tp_cd, '1');
  assert.equal(input0.cfd_lon_cd, '00');
  assert.equal(input0.nmn_pr_tp_cd, '00');
  assert.equal(input0.oss_orr_knd_cd, '1');
});

// 2026-09-02 코드리뷰 HIGH 지적 — 예전엔 nmnPrTpCd가 파라미터로 노출돼 있어서
// '15'(STOP) 같은 값을 주면 fc_stop_orr_bse_pr 없이 그대로 나갈 수 있었다(krstock
// 예약주문에서 이미 한 번 지적됐던 것과 같은 클래스). 파라미터 자체를 없앴으므로
// 호출측이 그 이름으로 뭘 주든 무시되고 고정값('00')만 나간다는 걸 고정.
test('[핵심 안전장치] placeGbReservedOrder: nmnPrTpCd를 줘도 무시되고 지정가(00)로 고정(STOP 등 조건부 필수 필드 필요한 값 원천 차단)', async () => {
  const fetchImpl = mockFetch([{ body: { Output_0: { bkg_rtn_orr_no: 1 } } }]);
  await placeGbReservedOrder({
    token: 't', actNo: '1', iemCd: 'AAPL', sbyDitCd: '2', quantity: 10, price: 230.5, nmnPrTpCd: '15', fetchImpl,
  });
  assert.equal(fetchImpl.calls[0].body.Input_0.nmn_pr_tp_cd, '00');
});

test('[핵심 안전장치] placeGbReservedOrder: 가격이 소수점 2자리를 초과하면 즉시 throw + confirmedNotSent=true', async () => {
  const fetchImpl = mockFetch([{ body: { Output_0: { bkg_rtn_orr_no: 1 } } }]);
  try {
    await placeGbReservedOrder({ token: 't', actNo: '1', iemCd: 'AAPL', sbyDitCd: '2', quantity: 10, price: 230.567, fetchImpl });
    assert.fail('throw 됐어야 함');
  } catch (e) {
    assert.equal(e.confirmedNotSent, true);
  }
  assert.equal(fetchImpl.calls.length, 0);
});

test('[핵심 안전장치] placeGbReservedOrder: price 없으면 즉시 throw(예약주문도 시장가 없음) + confirmedNotSent=true', async () => {
  const fetchImpl = mockFetch([{ body: { Output_0: { bkg_rtn_orr_no: 1 } } }]);
  try {
    await placeGbReservedOrder({ token: 't', actNo: '1', iemCd: 'AAPL', sbyDitCd: '2', quantity: 10, fetchImpl });
    assert.fail('throw 됐어야 함');
  } catch (e) {
    assert.equal(e.confirmedNotSent, true);
  }
  assert.equal(fetchImpl.calls.length, 0);
});

test('[핵심 안전장치] placeGbReservedOrder: sbyDitCd가 1·2 외의 값이면 즉시 throw + confirmedNotSent=true(공유 검증기)', async () => {
  const fetchImpl = mockFetch([{ body: { Output_0: { bkg_rtn_orr_no: 1 } } }]);
  try {
    await placeGbReservedOrder({ token: 't', actNo: '1', iemCd: 'AAPL', sbyDitCd: '9', quantity: 10, price: 230.5, fetchImpl });
    assert.fail('throw 됐어야 함');
  } catch (e) {
    assert.equal(e.confirmedNotSent, true);
  }
  assert.equal(fetchImpl.calls.length, 0);
});

test('[핵심 안전장치] placeGbReservedOrder: NH 업무거부면 confirmedNotSent=true', async () => {
  const fetchImpl = mockFetch([{ body: { rsp_cd: '10006', rsp_msg: '주문가능금액이 부족합니다.' } }]);
  try {
    await placeGbReservedOrder({ token: 't', actNo: '1', iemCd: 'AAPL', sbyDitCd: '2', quantity: 10, price: 230.5, fetchImpl });
    assert.fail('throw 됐어야 함');
  } catch (e) {
    assert.equal(e.confirmedNotSent, true);
  }
});

test('[핵심 안전장치] placeGbReservedOrder: 네트워크 예외면 confirmedNotSent 안 붙음(불명)', async () => {
  const fetchImpl = async () => { throw new Error('fetch failed'); };
  try {
    await placeGbReservedOrder({ token: 't', actNo: '1', iemCd: 'AAPL', sbyDitCd: '2', quantity: 10, price: 230.5, fetchImpl });
    assert.fail('throw 됐어야 함');
  } catch (e) {
    assert.equal(e.confirmedNotSent, undefined);
  }
});

test('cancelGbReservedOrder: 필드 정상 배선(응답에 주문식별번호가 없어 wrkRltCd·raw만 반환)', async () => {
  const fetchImpl = mockFetch([{ body: { Output_0: { wrk_rlt_cd: '00000' }, rsp_cd: '00000' } }]);
  const r = await cancelGbReservedOrder({
    token: 't', actNo: '1', iemCd: 'AAPL', bkgOrrDt: '20260902', bkgRtnOrrNo: 555, fetchImpl,
  });
  assert.match(fetchImpl.calls[0].url, /\/gbstock\/order\/v1\/reservedCancel$/);
  assert.equal(fetchImpl.calls[0].body.Input_0.bkg_rtn_orr_no, 555);
  assert.equal(r.wrkRltCd, '00000');
  assert.equal(r.raw.Output_0.wrk_rlt_cd, '00000');
});

test('[핵심 안전장치] cancelGbReservedOrder: bkgOrrDt 없거나 형식이 틀리면 즉시 throw + confirmedNotSent=true(2026-09-02 코드리뷰 MEDIUM 지적 — 필수필드 검증 누락이었음)', async () => {
  const fetchImpl = mockFetch([{ body: { Output_0: { wrk_rlt_cd: '00000' } } }]);
  for (const bad of [undefined, '', '2026-09-02', '202609']) {
    try {
      await cancelGbReservedOrder({ token: 't', actNo: '1', iemCd: 'AAPL', bkgOrrDt: bad, bkgRtnOrrNo: 555, fetchImpl });
      assert.fail(`throw 됐어야 함(bkgOrrDt=${JSON.stringify(bad)})`);
    } catch (e) {
      assert.equal(e.confirmedNotSent, true);
    }
  }
  assert.equal(fetchImpl.calls.length, 0);
});

test('[핵심 안전장치] cancelGbReservedOrder: bkgRtnOrrNo 없으면 즉시 throw + confirmedNotSent=true(공유 검증기, label 확인)', async () => {
  const fetchImpl = mockFetch([{ body: { Output_0: {} } }]);
  try {
    await cancelGbReservedOrder({ token: 't', actNo: '1', iemCd: 'AAPL', bkgOrrDt: '20260902', fetchImpl });
    assert.fail('throw 됐어야 함');
  } catch (e) {
    assert.equal(e.confirmedNotSent, true);
    assert.match(e.message, /bkgRtnOrrNo/);
  }
  assert.equal(fetchImpl.calls.length, 0);
});

test('[핵심 안전장치] cancelGbReservedOrder: NH 업무거부면 confirmedNotSent=true', async () => {
  const fetchImpl = mockFetch([{ body: { rsp_cd: '10006', rsp_msg: '예약주문이 존재하지 않습니다.' } }]);
  try {
    await cancelGbReservedOrder({ token: 't', actNo: '1', iemCd: 'AAPL', bkgOrrDt: '20260902', bkgRtnOrrNo: 555, fetchImpl });
    assert.fail('throw 됐어야 함');
  } catch (e) {
    assert.equal(e.confirmedNotSent, true);
  }
});

test('[핵심 안전장치] cancelGbReservedOrder: 네트워크 예외면 confirmedNotSent 안 붙음(불명)', async () => {
  const fetchImpl = async () => { throw new Error('fetch failed'); };
  try {
    await cancelGbReservedOrder({ token: 't', actNo: '1', iemCd: 'AAPL', bkgOrrDt: '20260902', bkgRtnOrrNo: 555, fetchImpl });
    assert.fail('throw 됐어야 함');
  } catch (e) {
    assert.equal(e.confirmedNotSent, undefined);
  }
});
