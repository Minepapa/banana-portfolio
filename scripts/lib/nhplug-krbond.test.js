import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  getBondBalance, getBondCurrentPrice,
  placeBondBuyOrder, placeBondSellOrder, modifyBondOrder, cancelBondOrder,
} from './nhplug-krbond.mjs';
import { setNhRateLimitForTests } from './nhplug.mjs';

setNhRateLimitForTests(Infinity);

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

test('getBondBalance: 기본값(iqrDit=1 종목별) 배선', async () => {
  const fetchImpl = mockFetch([{ body: { Output_0: [] } }]);
  await getBondBalance({ token: 't', actNo: '1', iqrDt: '20260902', fetchImpl });
  assert.deepEqual(fetchImpl.calls[0].body.Input_0, { act_no: '1', iqr_dt: '20260902', iqr_dit: '1' });
});

test('getBondCurrentPrice: 기본값(market=0 일반채권) 배선', async () => {
  const fetchImpl = mockFetch([{ body: { Output_0: {} } }]);
  await getBondCurrentPrice({ token: 't', iemCd: 'B150351F4', fetchImpl });
  assert.deepEqual(fetchImpl.calls[0].body.Input_0, { iem_cd: 'B150351F4', market: '0' });
});

test('placeBondBuyOrder: 정상 응답이면 mkt_orr_no 반환', async () => {
  const fetchImpl = mockFetch([{ body: { Output_0: { mkt_orr_no: 113 } } }]);
  const r = await placeBondBuyOrder({ token: 't', actNo: '1', iemCd: 'B150351F4', quantity: 3000, price: 10100, fetchImpl });
  assert.equal(r.orderNo, '113');
  assert.match(fetchImpl.calls[0].url, /\/krbond\/order\/v1\/bondBuy$/);
  assert.equal(fetchImpl.calls[0].body.Input_0.orr_pr, 10100);
});

test('[핵심 안전장치] placeBondBuyOrder: price 없으면 즉시 throw(채권도 시장가 없음) + confirmedNotSent=true', async () => {
  const fetchImpl = mockFetch([{ body: { Output_0: { mkt_orr_no: 1 } } }]);
  try {
    await placeBondBuyOrder({ token: 't', actNo: '1', iemCd: 'B150351F4', quantity: 3000, fetchImpl });
    assert.fail('throw 됐어야 함');
  } catch (e) {
    assert.equal(e.confirmedNotSent, true);
  }
  assert.equal(fetchImpl.calls.length, 0);
});

test('[핵심 안전장치] placeBondBuyOrder: actNo·iemCd 없으면 즉시 throw + confirmedNotSent=true', async () => {
  const fetchImpl = mockFetch([{ body: { Output_0: { mkt_orr_no: 1 } } }]);
  try {
    await placeBondBuyOrder({ token: 't', quantity: 3000, price: 10100, fetchImpl });
    assert.fail('throw 됐어야 함');
  } catch (e) {
    assert.equal(e.confirmedNotSent, true);
  }
  assert.equal(fetchImpl.calls.length, 0);
});

test('[핵심 안전장치] placeBondBuyOrder: NH 업무거부면 confirmedNotSent=true', async () => {
  const fetchImpl = mockFetch([{ body: { rsp_cd: '10006', rsp_msg: '주문가능금액이 부족합니다.' } }]);
  try {
    await placeBondBuyOrder({ token: 't', actNo: '1', iemCd: 'B150351F4', quantity: 3000, price: 10100, fetchImpl });
    assert.fail('throw 됐어야 함');
  } catch (e) {
    assert.equal(e.confirmedNotSent, true);
  }
});

test('[핵심 안전장치] placeBondBuyOrder: 응답 성공인데 mkt_orr_no 없으면 confirmedNotSent 안 붙음(불명)', async () => {
  const fetchImpl = mockFetch([{ body: { Output_0: {} } }]);
  try {
    await placeBondBuyOrder({ token: 't', actNo: '1', iemCd: 'B150351F4', quantity: 3000, price: 10100, fetchImpl });
    assert.fail('throw 됐어야 함');
  } catch (e) {
    assert.equal(e.confirmedNotSent, undefined);
  }
});

test('[핵심 안전장치] placeBondBuyOrder: 네트워크 예외면 confirmedNotSent 안 붙음(불명)', async () => {
  const fetchImpl = async () => { throw new Error('fetch failed'); };
  try {
    await placeBondBuyOrder({ token: 't', actNo: '1', iemCd: 'B150351F4', quantity: 3000, price: 10100, fetchImpl });
    assert.fail('throw 됐어야 함');
  } catch (e) {
    assert.equal(e.confirmedNotSent, undefined);
  }
});

test('[핵심 안전장치] placeBondBuyOrder: 429여도 confirmedNotSent 안 붙음(불명)', async () => {
  const fetchImpl = mockFetch([{ status: 429, body: { rsp_msg: '초당 호출한도 초과' } }]);
  try {
    await placeBondBuyOrder({ token: 't', actNo: '1', iemCd: 'B150351F4', quantity: 3000, price: 10100, fetchImpl });
    assert.fail('throw 됐어야 함');
  } catch (e) {
    assert.equal(e.confirmedNotSent, undefined);
  }
});

test('[핵심 안전장치] placeBondBuyOrder: HTTP 4xx(비-429)여도 confirmedNotSent 안 붙음(불명)', async () => {
  const fetchImpl = async () => ({ ok: false, status: 500, text: async () => JSON.stringify({ error: 'internal' }) });
  try {
    await placeBondBuyOrder({ token: 't', actNo: '1', iemCd: 'B150351F4', quantity: 3000, price: 10100, fetchImpl });
    assert.fail('throw 됐어야 함');
  } catch (e) {
    assert.equal(e.confirmedNotSent, undefined);
  }
});

test('placeBondSellOrder: 정상 응답이면 mkt_orr_no 반환, bynDt·synTtnDitCd 배선', async () => {
  const fetchImpl = mockFetch([{ body: { Output_0: { mkt_orr_no: 999 } } }]);
  const r = await placeBondSellOrder({
    token: 't', actNo: '1', iemCd: 'B150351F4', quantity: 1000, price: 10150,
    bynDt: '20260813', synTtnDitCd: '2', fetchImpl,
  });
  assert.equal(r.orderNo, '999');
  assert.match(fetchImpl.calls[0].url, /\/krbond\/order\/v1\/bondSell$/);
  const input0 = fetchImpl.calls[0].body.Input_0;
  assert.equal(input0.byn_dt, '20260813');
  assert.equal(input0.syn_ttn_dit_cd, '2');
});

// 2026-09-02 코드리뷰 MEDIUM 지적 — placeBondSellOrder는 세금(byn_dt·
// syn_ttn_dit_cd) 관련 로직이 가장 많은 함수인데도 정작 placeBondBuyOrder가
// 가진 테스트(업무거부·identity 누락·가격 누락·성공인데 주문번호 없음)와 짝이
// 안 맞았다 — 아래 4건으로 buy와 커버리지 동수 맞춤.
test('[핵심 안전장치] placeBondSellOrder: actNo·iemCd 없으면 즉시 throw + confirmedNotSent=true', async () => {
  const fetchImpl = mockFetch([{ body: { Output_0: { mkt_orr_no: 1 } } }]);
  try {
    await placeBondSellOrder({ token: 't', quantity: 1000, price: 10150, bynDt: '20260813', synTtnDitCd: '2', fetchImpl });
    assert.fail('throw 됐어야 함');
  } catch (e) {
    assert.equal(e.confirmedNotSent, true);
  }
  assert.equal(fetchImpl.calls.length, 0);
});

test('[핵심 안전장치] placeBondSellOrder: price 없으면 즉시 throw(채권도 시장가 없음) + confirmedNotSent=true', async () => {
  const fetchImpl = mockFetch([{ body: { Output_0: { mkt_orr_no: 1 } } }]);
  try {
    await placeBondSellOrder({ token: 't', actNo: '1', iemCd: 'B150351F4', quantity: 1000, bynDt: '20260813', synTtnDitCd: '2', fetchImpl });
    assert.fail('throw 됐어야 함');
  } catch (e) {
    assert.equal(e.confirmedNotSent, true);
  }
  assert.equal(fetchImpl.calls.length, 0);
});

test('[핵심 안전장치] placeBondSellOrder: NH 업무거부면 confirmedNotSent=true', async () => {
  const fetchImpl = mockFetch([{ body: { rsp_cd: '10006', rsp_msg: '보유수량이 부족합니다.' } }]);
  try {
    await placeBondSellOrder({
      token: 't', actNo: '1', iemCd: 'B150351F4', quantity: 1000, price: 10150, bynDt: '20260813', synTtnDitCd: '2', fetchImpl,
    });
    assert.fail('throw 됐어야 함');
  } catch (e) {
    assert.equal(e.confirmedNotSent, true);
  }
});

test('[핵심 안전장치] placeBondSellOrder: 응답 성공인데 mkt_orr_no 없으면 confirmedNotSent 안 붙음(불명)', async () => {
  const fetchImpl = mockFetch([{ body: { Output_0: {} } }]);
  try {
    await placeBondSellOrder({
      token: 't', actNo: '1', iemCd: 'B150351F4', quantity: 1000, price: 10150, bynDt: '20260813', synTtnDitCd: '2', fetchImpl,
    });
    assert.fail('throw 됐어야 함');
  } catch (e) {
    assert.equal(e.confirmedNotSent, undefined);
  }
});

test('[핵심 안전장치] placeBondSellOrder: bynDt 없으면 즉시 throw + confirmedNotSent=true(세금계산 필수값)', async () => {
  const fetchImpl = mockFetch([{ body: { Output_0: { mkt_orr_no: 1 } } }]);
  try {
    await placeBondSellOrder({ token: 't', actNo: '1', iemCd: 'B150351F4', quantity: 1000, price: 10150, synTtnDitCd: '2', fetchImpl });
    assert.fail('throw 됐어야 함');
  } catch (e) {
    assert.equal(e.confirmedNotSent, true);
  }
  assert.equal(fetchImpl.calls.length, 0);
});

test('[핵심 안전장치] placeBondSellOrder: synTtnDitCd가 1·2 외의 값이면 즉시 throw + confirmedNotSent=true', async () => {
  const fetchImpl = mockFetch([{ body: { Output_0: { mkt_orr_no: 1 } } }]);
  try {
    await placeBondSellOrder({
      token: 't', actNo: '1', iemCd: 'B150351F4', quantity: 1000, price: 10150, bynDt: '20260813', synTtnDitCd: '9', fetchImpl,
    });
    assert.fail('throw 됐어야 함');
  } catch (e) {
    assert.equal(e.confirmedNotSent, true);
  }
  assert.equal(fetchImpl.calls.length, 0);
});

test('[핵심 안전장치] placeBondSellOrder: 네트워크 예외면 confirmedNotSent 안 붙음(불명)', async () => {
  const fetchImpl = async () => { throw new Error('fetch failed'); };
  try {
    await placeBondSellOrder({
      token: 't', actNo: '1', iemCd: 'B150351F4', quantity: 1000, price: 10150, bynDt: '20260813', synTtnDitCd: '2', fetchImpl,
    });
    assert.fail('throw 됐어야 함');
  } catch (e) {
    assert.equal(e.confirmedNotSent, undefined);
  }
});

test('modifyBondOrder: 전체정정(allPatDitCd 기본값 1)이면 cor_qty 필드 자체가 없음', async () => {
  const fetchImpl = mockFetch([{ body: { Output_0: { mkt_orr_no: 888 } } }]);
  const r = await modifyBondOrder({ token: 't', actNo: '1', orgMktOrrNo: 123, iemCd: 'B150351F4', corPr: 10120, fetchImpl });
  assert.equal(r.orderNo, '888');
  assert.match(fetchImpl.calls[0].url, /\/krbond\/order\/v1\/bondModify$/);
  assert.equal('cor_qty' in fetchImpl.calls[0].body.Input_0, false);
});

test('modifyBondOrder: 일부정정(allPatDitCd=2)이면 cor_qty 포함', async () => {
  const fetchImpl = mockFetch([{ body: { Output_0: { mkt_orr_no: 888 } } }]);
  await modifyBondOrder({ token: 't', actNo: '1', orgMktOrrNo: 123, iemCd: 'B150351F4', corPr: 10120, corQty: 500, allPatDitCd: '2', fetchImpl });
  assert.equal(fetchImpl.calls[0].body.Input_0.cor_qty, 500);
});

test('[핵심 안전장치] modifyBondOrder: 정정가격 0 이하면 즉시 throw + confirmedNotSent=true', async () => {
  const fetchImpl = mockFetch([{ body: { Output_0: { mkt_orr_no: 1 } } }]);
  try {
    await modifyBondOrder({ token: 't', actNo: '1', orgMktOrrNo: 123, iemCd: 'B150351F4', corPr: 0, fetchImpl });
    assert.fail('throw 됐어야 함');
  } catch (e) {
    assert.equal(e.confirmedNotSent, true);
  }
  assert.equal(fetchImpl.calls.length, 0);
});

test('[핵심 안전장치] modifyBondOrder: corQty를 줬는데 allPatDitCd가 "2"가 아니면 즉시 throw(공유 검증기 호출 확인)', async () => {
  const fetchImpl = mockFetch([{ body: { Output_0: { mkt_orr_no: 1 } } }]);
  try {
    await modifyBondOrder({ token: 't', actNo: '1', orgMktOrrNo: 123, iemCd: 'B150351F4', corPr: 10120, corQty: 500, fetchImpl });
    assert.fail('throw 됐어야 함');
  } catch (e) {
    assert.equal(e.confirmedNotSent, true);
  }
  assert.equal(fetchImpl.calls.length, 0);
});

test('[핵심 안전장치] modifyBondOrder: NH 업무거부면 confirmedNotSent=true', async () => {
  const fetchImpl = mockFetch([{ body: { rsp_cd: '10006', rsp_msg: '주문번호가 존재하지 않습니다.' } }]);
  try {
    await modifyBondOrder({ token: 't', actNo: '1', orgMktOrrNo: 123, iemCd: 'B150351F4', corPr: 10120, fetchImpl });
    assert.fail('throw 됐어야 함');
  } catch (e) {
    assert.equal(e.confirmedNotSent, true);
  }
});

test('[핵심 안전장치] modifyBondOrder: 네트워크 예외면 confirmedNotSent 안 붙음(불명)', async () => {
  const fetchImpl = async () => { throw new Error('fetch failed'); };
  try {
    await modifyBondOrder({ token: 't', actNo: '1', orgMktOrrNo: 123, iemCd: 'B150351F4', corPr: 10120, fetchImpl });
    assert.fail('throw 됐어야 함');
  } catch (e) {
    assert.equal(e.confirmedNotSent, undefined);
  }
});

test('cancelBondOrder: 전체취소가 기본값, org_mkt_orr_no·iem_cd 그대로 전달', async () => {
  const fetchImpl = mockFetch([{ body: { Output_0: { mkt_orr_no: 777 } } }]);
  const r = await cancelBondOrder({ token: 't', actNo: '1', orgMktOrrNo: 123, iemCd: 'B150351F4', fetchImpl });
  assert.equal(r.orderNo, '777');
  assert.match(fetchImpl.calls[0].url, /\/krbond\/order\/v1\/bondCancel$/);
  assert.equal(fetchImpl.calls[0].body.Input_0.all_pat_dit_cd, '1');
});

// 2026-09-02 코드리뷰 MEDIUM 지적 — modifyBondOrder는 전체/일부 두 경로 모두
// 테스트가 있는데 cancelBondOrder는 일부취소(allPatDitCd=2) 경로가 한 번도
// 실행된 적이 없었다(라인 커버리지는 100%였지만 분기 커버리지는 아니었음 —
// `if (allPatDitCd === '2') input0.cor_qty = ...`가 if문과 한 줄이라 라인만 봐선
// 안 드러남). 돈이 움직이는 분기라 비대칭을 없앰.
test('cancelBondOrder: 일부취소(allPatDitCd=2)면 cor_qty 포함', async () => {
  const fetchImpl = mockFetch([{ body: { Output_0: { mkt_orr_no: 777 } } }]);
  await cancelBondOrder({ token: 't', actNo: '1', orgMktOrrNo: 123, iemCd: 'B150351F4', corQty: 500, allPatDitCd: '2', fetchImpl });
  assert.equal(fetchImpl.calls[0].body.Input_0.cor_qty, 500);
});

test('[핵심 안전장치] cancelBondOrder: actNo·iemCd 없으면 즉시 throw + confirmedNotSent=true', async () => {
  const fetchImpl = mockFetch([{ body: { Output_0: { mkt_orr_no: 1 } } }]);
  try {
    await cancelBondOrder({ token: 't', orgMktOrrNo: 123, fetchImpl });
    assert.fail('throw 됐어야 함');
  } catch (e) {
    assert.equal(e.confirmedNotSent, true);
  }
  assert.equal(fetchImpl.calls.length, 0);
});

test('[핵심 안전장치] cancelBondOrder: orgMktOrrNo 없으면 즉시 throw + confirmedNotSent=true', async () => {
  const fetchImpl = mockFetch([{ body: { Output_0: { mkt_orr_no: 1 } } }]);
  try {
    await cancelBondOrder({ token: 't', actNo: '1', iemCd: 'B150351F4', fetchImpl });
    assert.fail('throw 됐어야 함');
  } catch (e) {
    assert.equal(e.confirmedNotSent, true);
  }
  assert.equal(fetchImpl.calls.length, 0);
});

test('[핵심 안전장치] cancelBondOrder: NH 업무거부면 confirmedNotSent=true', async () => {
  const fetchImpl = mockFetch([{ body: { rsp_cd: '10006', rsp_msg: '이미 체결된 주문입니다.' } }]);
  try {
    await cancelBondOrder({ token: 't', actNo: '1', orgMktOrrNo: 123, iemCd: 'B150351F4', fetchImpl });
    assert.fail('throw 됐어야 함');
  } catch (e) {
    assert.equal(e.confirmedNotSent, true);
  }
});

test('[핵심 안전장치] cancelBondOrder: 네트워크 예외면 confirmedNotSent 안 붙음(불명)', async () => {
  const fetchImpl = async () => { throw new Error('fetch failed'); };
  try {
    await cancelBondOrder({ token: 't', actNo: '1', orgMktOrrNo: 123, iemCd: 'B150351F4', fetchImpl });
    assert.fail('throw 됐어야 함');
  } catch (e) {
    assert.equal(e.confirmedNotSent, undefined);
  }
});
