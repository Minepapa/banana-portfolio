import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  getGoldBalance, getGoldCurrentPrice, getGoldOrderableQuantity,
  placeGoldBuyOrder, placeGoldSellOrder, modifyGoldOrder, cancelGoldOrder,
} from './nhplug-krgold.mjs';
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

test('getGoldBalance: act_no만 Input_0에 실림', async () => {
  const fetchImpl = mockFetch([{ body: { Output_0: {}, Output_1: [] } }]);
  await getGoldBalance({ token: 't', actNo: '20902920556', fetchImpl });
  assert.match(fetchImpl.calls[0].url, /\/krgold\/inquiry\/v1\/goldDepositAndBalance$/);
  assert.deepEqual(fetchImpl.calls[0].body.Input_0, { act_no: '20902920556' });
});

test('getGoldCurrentPrice: iem_cd 그대로 전달', async () => {
  const fetchImpl = mockFetch([{ body: { Output_0: { stck_sdpr: '212000' } } }]);
  const r = await getGoldCurrentPrice({ token: 't', iemCd: 'M04020000', fetchImpl });
  assert.deepEqual(fetchImpl.calls[0].body.Input_0, { iem_cd: 'M04020000' });
  assert.equal(r.Output_0.stck_sdpr, '212000');
});

test('getGoldOrderableQuantity: sbyDitCd 1(매도)·2(매수) 그대로 실림, price 있으면 orr_pr 포함', async () => {
  const fetchImpl = mockFetch([{ body: { Output_0: {} } }]);
  await getGoldOrderableQuantity({ token: 't', actNo: '1', iemCd: 'M04020000', sbyDitCd: '2', price: 212000, fetchImpl });
  assert.equal(fetchImpl.calls[0].body.Input_0.sby_dit_cd, '2');
  assert.equal(fetchImpl.calls[0].body.Input_0.orr_pr, 212000);
});

test('[막아야 함] getGoldOrderableQuantity: sbyDitCd가 1·2 외의 값이면 throw(추정 안 함)', async () => {
  const fetchImpl = mockFetch([{ body: { Output_0: {} } }]);
  await assert.rejects(() => getGoldOrderableQuantity({ token: 't', actNo: '1', iemCd: 'M04020000', sbyDitCd: '3', fetchImpl }));
  assert.equal(fetchImpl.calls.length, 0);
});

test('placeGoldBuyOrder: 정상 응답이면 mkt_orr_no 반환, ivsUagYn 기본값 2(투자용)', async () => {
  const fetchImpl = mockFetch([{ body: { Output_0: { mkt_orr_no: '113' } } }]);
  const r = await placeGoldBuyOrder({ token: 't', actNo: '20902920556', iemCd: 'M04020000', quantity: 10, price: 212090, fetchImpl });
  assert.equal(r.orderNo, '113');
  const input0 = fetchImpl.calls[0].body.Input_0;
  assert.equal(input0.orr_qty, 10);
  assert.equal(input0.orr_pr, 212090);
  assert.equal(input0.ivs_uag_yn, '2');
  assert.equal(input0.orr_cnd_dit_cd, '00');
});

test('placeGoldBuyOrder: ivsUagYn을 명시하면 그 값 사용(산업용 1 등)', async () => {
  const fetchImpl = mockFetch([{ body: { Output_0: { mkt_orr_no: '1' } } }]);
  await placeGoldBuyOrder({ token: 't', actNo: '1', iemCd: 'M04020000', quantity: 10, price: 212090, ivsUagYn: '1', fetchImpl });
  assert.equal(fetchImpl.calls[0].body.Input_0.ivs_uag_yn, '1');
});

// ⚠️ 안전장치 테스트 — nhplug-krstock.test.js와 동일 철학(공유 모듈이라 로직은
// nhplug-order-safety.test.js에서 이미 직접 검증됨, 여기선 krgold 함수들이 그
// 검증을 실제로 호출하는지 + 금현물 전용 규칙(price 필수·ivsUagYn 검증)을 확인).

test('[핵심 안전장치] placeGoldBuyOrder: price 없으면 즉시 throw(금현물은 시장가 없음) + confirmedNotSent=true', async () => {
  const fetchImpl = mockFetch([{ body: { Output_0: { mkt_orr_no: '1' } } }]);
  try {
    await placeGoldBuyOrder({ token: 't', actNo: '1', iemCd: 'M04020000', quantity: 10, fetchImpl });
    assert.fail('throw 됐어야 함');
  } catch (e) {
    assert.equal(e.confirmedNotSent, true);
    assert.match(e.message, /시장가/);
  }
  assert.equal(fetchImpl.calls.length, 0);
});

test('[핵심 안전장치] placeGoldBuyOrder: 수량 0 이하면 즉시 throw + confirmedNotSent=true(공유 검증기 호출 확인)', async () => {
  const fetchImpl = mockFetch([{ body: { Output_0: { mkt_orr_no: '1' } } }]);
  try {
    await placeGoldBuyOrder({ token: 't', actNo: '1', iemCd: 'M04020000', quantity: 0, price: 212090, fetchImpl });
    assert.fail('throw 됐어야 함');
  } catch (e) {
    assert.equal(e.confirmedNotSent, true);
  }
  assert.equal(fetchImpl.calls.length, 0);
});

test('[핵심 안전장치] placeGoldBuyOrder: actNo·iemCd 없으면 즉시 throw + confirmedNotSent=true(공유 검증기 호출 확인)', async () => {
  const fetchImpl = mockFetch([{ body: { Output_0: { mkt_orr_no: '1' } } }]);
  try {
    await placeGoldBuyOrder({ token: 't', iemCd: 'M04020000', quantity: 10, price: 212090, fetchImpl });
    assert.fail('throw 됐어야 함');
  } catch (e) {
    assert.equal(e.confirmedNotSent, true);
  }
  assert.equal(fetchImpl.calls.length, 0);
});

test('[핵심 안전장치] placeGoldBuyOrder: ivsUagYn이 1·2가 아니면 즉시 throw + confirmedNotSent=true', async () => {
  const fetchImpl = mockFetch([{ body: { Output_0: { mkt_orr_no: '1' } } }]);
  try {
    await placeGoldBuyOrder({ token: 't', actNo: '1', iemCd: 'M04020000', quantity: 10, price: 212090, ivsUagYn: '3', fetchImpl });
    assert.fail('throw 됐어야 함');
  } catch (e) {
    assert.equal(e.confirmedNotSent, true);
  }
  assert.equal(fetchImpl.calls.length, 0);
});

test('[핵심 안전장치] placeGoldBuyOrder: NH 업무거부면 confirmedNotSent=true', async () => {
  const fetchImpl = mockFetch([{ body: { rsp_cd: '10006', rsp_msg: '주문가능금액이 부족합니다.' } }]);
  try {
    await placeGoldBuyOrder({ token: 't', actNo: '1', iemCd: 'M04020000', quantity: 10, price: 212090, fetchImpl });
    assert.fail('throw 됐어야 함');
  } catch (e) {
    assert.equal(e.confirmedNotSent, true);
  }
});

test('[핵심 안전장치] placeGoldBuyOrder: 응답 성공인데 mkt_orr_no 없으면 confirmedNotSent 안 붙음(불명)', async () => {
  const fetchImpl = mockFetch([{ body: { Output_0: {} } }]);
  try {
    await placeGoldBuyOrder({ token: 't', actNo: '1', iemCd: 'M04020000', quantity: 10, price: 212090, fetchImpl });
    assert.fail('throw 됐어야 함');
  } catch (e) {
    assert.equal(e.confirmedNotSent, undefined);
  }
});

test('[핵심 안전장치] placeGoldBuyOrder: 네트워크 예외면 confirmedNotSent 안 붙음(불명)', async () => {
  const fetchImpl = async () => { throw new Error('fetch failed'); };
  try {
    await placeGoldBuyOrder({ token: 't', actNo: '1', iemCd: 'M04020000', quantity: 10, price: 212090, fetchImpl });
    assert.fail('throw 됐어야 함');
  } catch (e) {
    assert.equal(e.confirmedNotSent, undefined);
  }
});

test('[핵심 안전장치] placeGoldBuyOrder: 429여도 confirmedNotSent 안 붙음(불명)', async () => {
  const fetchImpl = mockFetch([{ status: 429, body: { rsp_msg: '초당 호출한도 초과' } }]);
  try {
    await placeGoldBuyOrder({ token: 't', actNo: '1', iemCd: 'M04020000', quantity: 10, price: 212090, fetchImpl });
    assert.fail('throw 됐어야 함');
  } catch (e) {
    assert.equal(e.confirmedNotSent, undefined);
  }
});

test('[핵심 안전장치] placeGoldSellOrder: 매도도 동일 안전장치(price 필수)', async () => {
  const fetchImpl = mockFetch([{ body: { Output_0: { mkt_orr_no: '1' } } }]);
  try {
    await placeGoldSellOrder({ token: 't', actNo: '1', iemCd: 'M04020000', quantity: 10, fetchImpl });
    assert.fail('throw 됐어야 함');
  } catch (e) {
    assert.equal(e.confirmedNotSent, true);
  }
});

// 2026-09-02 코드리뷰 MEDIUM 지적 — place 계열(4개 함수) 전부 갖춰야 하는 네트워크
// 예외 케이스가 매도에는 없었음(krstock 코드리뷰에서 이미 한 번 지적됐던 것과
// 같은 클래스 — 매도는 실제 보유 포지션을 청산하는 경로라 오판 방향의 비용이 큼).
test('[핵심 안전장치] placeGoldSellOrder: 네트워크 예외면 confirmedNotSent 안 붙음(불명)', async () => {
  const fetchImpl = async () => { throw new Error('fetch failed'); };
  try {
    await placeGoldSellOrder({ token: 't', actNo: '1', iemCd: 'M04020000', quantity: 10, price: 212090, fetchImpl });
    assert.fail('throw 됐어야 함');
  } catch (e) {
    assert.equal(e.confirmedNotSent, undefined);
  }
});

// 2026-09-02 코드리뷰 MEDIUM 지적 — 금현물은 종목코드가 정확히 두 개뿐이라
// 화이트리스트 검증이 가능한데(krstock은 종목이 수천 개라 불가능) 처음엔 안
// 걸려 있었다. 두 코드를 헷갈리면(미니금 100g인데 금 1kg 코드로 주문 등) NH가
// 그냥 받아버릴 수 있어 네트워크 호출 전에 막는다.
test('[핵심 안전장치] placeGoldBuyOrder: iemCd가 금현물 종목코드(M04020000·M04020100)가 아니면 즉시 throw + confirmedNotSent=true', async () => {
  const fetchImpl = mockFetch([{ body: { Output_0: { mkt_orr_no: '1' } } }]);
  try {
    await placeGoldBuyOrder({ token: 't', actNo: '1', iemCd: '005930', quantity: 10, price: 212090, fetchImpl });
    assert.fail('throw 됐어야 함');
  } catch (e) {
    assert.equal(e.confirmedNotSent, true);
  }
  assert.equal(fetchImpl.calls.length, 0);
});

test('placeGoldBuyOrder: 미니금 100g(M04020100) 코드도 정상 통과', async () => {
  const fetchImpl = mockFetch([{ body: { Output_0: { mkt_orr_no: '1' } } }]);
  await placeGoldBuyOrder({ token: 't', actNo: '1', iemCd: 'M04020100', quantity: 10, price: 21000, fetchImpl });
  assert.equal(fetchImpl.calls[0].body.Input_0.iem_cd, 'M04020100');
});

test('[핵심 안전장치] placeGoldBuyOrder: HTTP 4xx(비-429)여도 confirmedNotSent 안 붙음(불명 — 전송계층 실패)', async () => {
  const fetchImpl = async () => ({ ok: false, status: 500, text: async () => JSON.stringify({ error: 'internal' }) });
  try {
    await placeGoldBuyOrder({ token: 't', actNo: '1', iemCd: 'M04020000', quantity: 10, price: 212090, fetchImpl });
    assert.fail('throw 됐어야 함');
  } catch (e) {
    assert.equal(e.confirmedNotSent, undefined);
  }
});

test('modifyGoldOrder: 전체정정(allPatDitCd 기본값 1)이면 cor_qty 필드 자체가 없고, sop_cnd_pr 필드도 없음(주식과 다름)', async () => {
  const fetchImpl = mockFetch([{ body: { Output_0: { mkt_orr_no: '999' } } }]);
  const r = await modifyGoldOrder({ token: 't', actNo: '1', orgMktOrrNo: 123, iemCd: 'M04020000', corPr: 213000, fetchImpl });
  assert.equal(r.orderNo, '999');
  const input0 = fetchImpl.calls[0].body.Input_0;
  assert.equal(input0.all_pat_dit_cd, '1');
  assert.equal('cor_qty' in input0, false);
  assert.equal('sop_cnd_pr' in input0, false);
  assert.equal(input0.cor_pr, 213000);
});

test('modifyGoldOrder: 일부정정(allPatDitCd=2)이면 cor_qty 포함', async () => {
  const fetchImpl = mockFetch([{ body: { Output_0: { mkt_orr_no: '999' } } }]);
  await modifyGoldOrder({ token: 't', actNo: '1', orgMktOrrNo: 123, iemCd: 'M04020000', corPr: 213000, corQty: 5, allPatDitCd: '2', fetchImpl });
  assert.equal(fetchImpl.calls[0].body.Input_0.cor_qty, 5);
});

test('[핵심 안전장치] modifyGoldOrder: 정정가격 0 이하는 즉시 throw + confirmedNotSent=true', async () => {
  const fetchImpl = mockFetch([{ body: { Output_0: { mkt_orr_no: '1' } } }]);
  try {
    await modifyGoldOrder({ token: 't', actNo: '1', orgMktOrrNo: 123, iemCd: 'M04020000', corPr: 0, fetchImpl });
    assert.fail('throw 됐어야 함');
  } catch (e) {
    assert.equal(e.confirmedNotSent, true);
  }
  assert.equal(fetchImpl.calls.length, 0);
});

test('[핵심 안전장치] modifyGoldOrder: orgMktOrrNo 없으면 즉시 throw + confirmedNotSent=true(공유 검증기 호출 확인)', async () => {
  const fetchImpl = mockFetch([{ body: { Output_0: { mkt_orr_no: '1' } } }]);
  try {
    await modifyGoldOrder({ token: 't', actNo: '1', iemCd: 'M04020000', corPr: 213000, fetchImpl });
    assert.fail('throw 됐어야 함');
  } catch (e) {
    assert.equal(e.confirmedNotSent, true);
  }
  assert.equal(fetchImpl.calls.length, 0);
});

test('[핵심 안전장치] modifyGoldOrder: corQty를 줬는데 allPatDitCd가 "2"가 아니면 즉시 throw(공유 검증기 호출 확인)', async () => {
  const fetchImpl = mockFetch([{ body: { Output_0: { mkt_orr_no: '1' } } }]);
  try {
    await modifyGoldOrder({ token: 't', actNo: '1', orgMktOrrNo: 123, iemCd: 'M04020000', corPr: 213000, corQty: 5, fetchImpl });
    assert.fail('throw 됐어야 함');
  } catch (e) {
    assert.equal(e.confirmedNotSent, true);
  }
  assert.equal(fetchImpl.calls.length, 0);
});

// 2026-09-02 코드리뷰 MEDIUM 지적 — krstock 코드리뷰에서 "이전엔 modify에 이
// 테스트가 없었음"이라고 명시적으로 지적됐던 바로 그 케이스가 krgold에도 똑같이
// 빠져 있었다(안전장치를 공유 모듈로 뽑았다고 각 소비자가 그걸 실제로 올바르게
// 쓰는지까지 저절로 검증되는 건 아님 — 소비자마다 배선 테스트가 따로 필요).
test('[핵심 안전장치] modifyGoldOrder: NH 업무거부면 confirmedNotSent=true', async () => {
  const fetchImpl = mockFetch([{ body: { rsp_cd: '10006', rsp_msg: '주문번호가 존재하지 않습니다.' } }]);
  try {
    await modifyGoldOrder({ token: 't', actNo: '1', orgMktOrrNo: 123, iemCd: 'M04020000', corPr: 213000, fetchImpl });
    assert.fail('throw 됐어야 함');
  } catch (e) {
    assert.equal(e.confirmedNotSent, true);
  }
});

test('[핵심 안전장치] modifyGoldOrder: 네트워크 예외면 confirmedNotSent 안 붙음(불명)', async () => {
  const fetchImpl = async () => { throw new Error('fetch failed'); };
  try {
    await modifyGoldOrder({ token: 't', actNo: '1', orgMktOrrNo: 123, iemCd: 'M04020000', corPr: 213000, fetchImpl });
    assert.fail('throw 됐어야 함');
  } catch (e) {
    assert.equal(e.confirmedNotSent, undefined);
  }
});

test('cancelGoldOrder: 전체취소가 기본값, org_mkt_orr_no·iem_cd 그대로 전달', async () => {
  const fetchImpl = mockFetch([{ body: { Output_0: { mkt_orr_no: '888' } } }]);
  const r = await cancelGoldOrder({ token: 't', actNo: '1', orgMktOrrNo: 123, iemCd: 'M04020000', fetchImpl });
  assert.equal(r.orderNo, '888');
  assert.equal(fetchImpl.calls[0].body.Input_0.org_mkt_orr_no, 123);
  assert.equal(fetchImpl.calls[0].body.Input_0.all_pat_dit_cd, '1');
});

// 2026-09-02 코드리뷰 MEDIUM 지적 — cancelGoldOrder는 공유 검증기(validateIdentity·
// validateOrgOrderRef·validatePartialQty) 세 개를 모두 호출하는데도 그걸 실제로
// 배선했는지 확인하는 테스트가 하나도 없었다(modifyGoldOrder·placeGoldBuyOrder는
// 이미 있음 — krstock.test.js:314,321,334,346의 취소 배선 테스트를 포팅).
test('[핵심 안전장치] cancelGoldOrder: actNo·iemCd 없으면 즉시 throw + confirmedNotSent=true(공유 검증기 호출 확인)', async () => {
  const fetchImpl = mockFetch([{ body: { Output_0: { mkt_orr_no: '1' } } }]);
  try {
    await cancelGoldOrder({ token: 't', orgMktOrrNo: 123, iemCd: 'M04020000', fetchImpl });
    assert.fail('throw 됐어야 함');
  } catch (e) {
    assert.equal(e.confirmedNotSent, true);
  }
  assert.equal(fetchImpl.calls.length, 0);
});

test('[핵심 안전장치] cancelGoldOrder: orgMktOrrNo 없으면 즉시 throw + confirmedNotSent=true(공유 검증기 호출 확인)', async () => {
  const fetchImpl = mockFetch([{ body: { Output_0: { mkt_orr_no: '1' } } }]);
  try {
    await cancelGoldOrder({ token: 't', actNo: '1', iemCd: 'M04020000', fetchImpl });
    assert.fail('throw 됐어야 함');
  } catch (e) {
    assert.equal(e.confirmedNotSent, true);
  }
  assert.equal(fetchImpl.calls.length, 0);
});

test('[핵심 안전장치] cancelGoldOrder: corQty를 줬는데 allPatDitCd가 "2"가 아니면 즉시 throw(공유 검증기 호출 확인)', async () => {
  const fetchImpl = mockFetch([{ body: { Output_0: { mkt_orr_no: '1' } } }]);
  try {
    await cancelGoldOrder({ token: 't', actNo: '1', orgMktOrrNo: 123, iemCd: 'M04020000', corQty: 5, fetchImpl });
    assert.fail('throw 됐어야 함');
  } catch (e) {
    assert.equal(e.confirmedNotSent, true);
  }
  assert.equal(fetchImpl.calls.length, 0);
});

test('[핵심 안전장치] cancelGoldOrder: 응답 성공인데 mkt_orr_no 없으면 confirmedNotSent 안 붙음(불명)', async () => {
  const fetchImpl = mockFetch([{ body: { Output_0: {} } }]);
  try {
    await cancelGoldOrder({ token: 't', actNo: '1', orgMktOrrNo: 123, iemCd: 'M04020000', fetchImpl });
    assert.fail('throw 됐어야 함');
  } catch (e) {
    assert.equal(e.confirmedNotSent, undefined);
  }
});

test('[핵심 안전장치] cancelGoldOrder: NH 업무거부면 confirmedNotSent=true', async () => {
  const fetchImpl = mockFetch([{ body: { rsp_cd: '10006', rsp_msg: '이미 체결된 주문입니다.' } }]);
  try {
    await cancelGoldOrder({ token: 't', actNo: '1', orgMktOrrNo: 123, iemCd: 'M04020000', fetchImpl });
    assert.fail('throw 됐어야 함');
  } catch (e) {
    assert.equal(e.confirmedNotSent, true);
  }
});

test('[핵심 안전장치] cancelGoldOrder: 네트워크 예외면 confirmedNotSent 안 붙음(불명)', async () => {
  const fetchImpl = async () => { throw new Error('fetch failed'); };
  try {
    await cancelGoldOrder({ token: 't', actNo: '1', orgMktOrrNo: 123, iemCd: 'M04020000', fetchImpl });
    assert.fail('throw 됐어야 함');
  } catch (e) {
    assert.equal(e.confirmedNotSent, undefined);
  }
});
