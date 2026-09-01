import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  getKrBalance, getKrCurrentPrice, getKrBuyableQuantity, getKrSellableQuantity,
  placeKrCashBuyOrder, placeKrCashSellOrder, modifyKrOrder, cancelKrOrder,
} from './nhplug-krstock.mjs';
import { setNhRateLimitForTests } from './nhplug.mjs';

// nhplug.mjs의 속도제한(초당 4회 슬라이딩 윈도우)을 끈다 — 이 파일이 callNh를
// 여러 번 부르는 함수를 계속 테스트해서 안 끄면 최대 1초씩 실제로 기다린다.
setNhRateLimitForTests(Infinity);

// fetch 모킹 헬퍼 — kis.test.js·nhplug.test.js와 동일 패턴. 요청 body도 캡처해서
// 실제로 openapi.json 스펙대로 필드가 실렸는지 검증한다(2026-09-01, openapi.json
// 실측 필드명으로 작성 — 필드명 오타는 실계좌에서만 드러나는 사고라 여기서 최대한 막음).
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

test('getKrBalance: 계좌번호와 기본 조회조건이 Input_0에 정확히 실림(openapi.json 필드명)', async () => {
  const fetchImpl = mockFetch([{ body: { Output_0: { tot_eal_amt: '100' }, Output_1: [] } }]);
  await getKrBalance({ token: 't', actNo: '20501596019', fetchImpl });
  assert.match(fetchImpl.calls[0].url, /\/krstock\/inquiry\/v1\/balance$/);
  assert.deepEqual(fetchImpl.calls[0].body.Input_0, {
    act_no: '20501596019', bnc_bse_cd: '5', ltg_aot_dit_cd: '1', aet_bse: '1', qut_dit_cd: 'UNT',
  });
});

test('getKrCurrentPrice: market_cd 기본값 KRX, iem_cd 그대로 전달', async () => {
  const fetchImpl = mockFetch([{ body: { Output_0: { stck_prpr: '75000' } } }]);
  const r = await getKrCurrentPrice({ token: 't', iemCd: '005930', fetchImpl });
  assert.deepEqual(fetchImpl.calls[0].body.Input_0, { market_cd: 'KRX', iem_cd: '005930' });
  assert.equal(r.Output_0.stck_prpr, '75000');
});

test('getKrBuyableQuantity: price 있으면 지정가(01)+orr_pr, 없으면 시장가(05)', async () => {
  const fetchImpl = mockFetch([{ body: { Output_0: {} } }]);
  await getKrBuyableQuantity({ token: 't', actNo: '1', iemCd: '005930', price: 70000, fetchImpl });
  assert.equal(fetchImpl.calls[0].body.Input_0.nmn_pr_tp_cd, '01');
  assert.equal(fetchImpl.calls[0].body.Input_0.orr_pr, 70000);
  assert.equal(fetchImpl.calls[0].body.Input_0.ost_dit_cd, '1');

  const fetchImpl2 = mockFetch([{ body: { Output_0: {} } }]);
  await getKrBuyableQuantity({ token: 't', actNo: '1', iemCd: '005930', fetchImpl: fetchImpl2 });
  assert.equal(fetchImpl2.calls[0].body.Input_0.nmn_pr_tp_cd, '05');
  assert.equal('orr_pr' in fetchImpl2.calls[0].body.Input_0, false);
});

test('getKrSellableQuantity: cfd_lon_cd 기본값 00(일반거래, 신용 아님)', async () => {
  const fetchImpl = mockFetch([{ body: { Output_0: {} } }]);
  await getKrSellableQuantity({ token: 't', actNo: '1', iemCd: '005930', fetchImpl });
  assert.equal(fetchImpl.calls[0].body.Input_0.cfd_lon_cd, '00');
});

test('placeKrCashBuyOrder: 정상 응답이면 mkt_orr_no 반환', async () => {
  const fetchImpl = mockFetch([{ body: { Output_0: { mkt_orr_no: '123456' } } }]);
  const r = await placeKrCashBuyOrder({ token: 't', actNo: '1', iemCd: '005930', quantity: 10, price: 70000, fetchImpl });
  assert.equal(r.orderNo, '123456');
  const input0 = fetchImpl.calls[0].body.Input_0;
  assert.equal(input0.nmn_pr_tp_cd, '01');
  assert.equal(input0.orr_qty, 10);
  assert.equal(input0.orr_pr, 70000);
  assert.equal(input0.rmt_mkt_cd, 'KRX');
});

test('placeKrCashBuyOrder: price 생략하면 시장가(05), orr_pr 필드 자체가 없음', async () => {
  const fetchImpl = mockFetch([{ body: { Output_0: { mkt_orr_no: '1' } } }]);
  await placeKrCashBuyOrder({ token: 't', actNo: '1', iemCd: '005930', quantity: 10, fetchImpl });
  assert.equal(fetchImpl.calls[0].body.Input_0.nmn_pr_tp_cd, '05');
  assert.equal('orr_pr' in fetchImpl.calls[0].body.Input_0, false);
});

// ⚠️ 안전장치 테스트(kis.test.js의 placeKrOrder 안전장치 테스트와 동일 철학) —
// 이 프로젝트 전역 원칙: "확실히 안 나감"과 "불명"을 confirmedNotSent로 구분한다.

test('[핵심 안전장치] placeKrCashBuyOrder: 수량 0 이하·소수는 네트워크 호출 전 즉시 throw + confirmedNotSent=true', async () => {
  const fetchImpl = mockFetch([{ body: { Output_0: { mkt_orr_no: '1' } } }]);
  for (const bad of [0, -1, 1.5]) {
    try {
      await placeKrCashBuyOrder({ token: 't', actNo: '1', iemCd: '005930', quantity: bad, price: 70000, fetchImpl });
      assert.fail('throw 됐어야 함');
    } catch (e) {
      assert.equal(e.confirmedNotSent, true);
    }
  }
  assert.equal(fetchImpl.calls.length, 0, '네트워크 호출 자체가 없어야 함');
});

test('[핵심 안전장치] placeKrCashBuyOrder: 가격 0 이하는 즉시 throw(네트워크 호출 안 함) + confirmedNotSent=true', async () => {
  const fetchImpl = mockFetch([{ body: { Output_0: { mkt_orr_no: '1' } } }]);
  try {
    await placeKrCashBuyOrder({ token: 't', actNo: '1', iemCd: '005930', quantity: 10, price: -1, fetchImpl });
    assert.fail('throw 됐어야 함');
  } catch (e) {
    assert.equal(e.confirmedNotSent, true);
  }
  assert.equal(fetchImpl.calls.length, 0);
});

test('[핵심 안전장치] placeKrCashBuyOrder: NH 업무거부(rsp_cd)면 confirmedNotSent=true(명시적 거부 확인됨)', async () => {
  const fetchImpl = mockFetch([{ body: { rsp_cd: '10006', rsp_msg: '주문가능금액이 부족합니다.' } }]);
  try {
    await placeKrCashBuyOrder({ token: 't', actNo: '1', iemCd: '005930', quantity: 10, price: 70000, fetchImpl });
    assert.fail('throw 됐어야 함');
  } catch (e) {
    assert.equal(e.confirmedNotSent, true);
    assert.equal(e.code, '10006');
  }
});

// 2026-09-01 코드리뷰 HIGH 지적 대응 — actNo·iemCd가 비어도 quantity/price만 맞으면
// 그대로 네트워크에 나갔었다(JSON.stringify가 undefined 필드를 조용히 생략). 이제
// 네트워크 호출 전에 막힌다.
test('[핵심 안전장치] placeKrCashBuyOrder: actNo 없으면 네트워크 호출 전 즉시 throw + confirmedNotSent=true', async () => {
  const fetchImpl = mockFetch([{ body: { Output_0: { mkt_orr_no: '1' } } }]);
  try {
    await placeKrCashBuyOrder({ token: 't', iemCd: '005930', quantity: 10, price: 70000, fetchImpl });
    assert.fail('throw 됐어야 함');
  } catch (e) {
    assert.equal(e.confirmedNotSent, true);
    assert.match(e.message, /계좌번호/);
  }
  assert.equal(fetchImpl.calls.length, 0);
});

test('[핵심 안전장치] placeKrCashBuyOrder: iemCd 없으면 네트워크 호출 전 즉시 throw + confirmedNotSent=true', async () => {
  const fetchImpl = mockFetch([{ body: { Output_0: { mkt_orr_no: '1' } } }]);
  try {
    await placeKrCashBuyOrder({ token: 't', actNo: '1', quantity: 10, price: 70000, fetchImpl });
    assert.fail('throw 됐어야 함');
  } catch (e) {
    assert.equal(e.confirmedNotSent, true);
    assert.match(e.message, /종목코드/);
  }
  assert.equal(fetchImpl.calls.length, 0);
});

// 2026-09-01 코드리뷰 지적 — "가장 중요한데 테스트가 하나도 없었던" 케이스. 네트워크
// 자체가 예외를 던지면(타임아웃·DNS 실패 등) 주문이 브로커까지 도달했는지 이 프로세스는
// 알 방법이 없다 — confirmedNotSent가 안 붙어야 호출측이 함부로 재시도/롤백 안 함.
test('[핵심 안전장치] placeKrCashBuyOrder: 네트워크 자체가 예외를 던지면(fetch 실패) confirmedNotSent 안 붙음(불명 — 이 프로젝트에서 가장 중요한 케이스)', async () => {
  const fetchImpl = async () => { throw new Error('fetch failed: ETIMEDOUT'); };
  try {
    await placeKrCashBuyOrder({ token: 't', actNo: '1', iemCd: '005930', quantity: 10, price: 70000, fetchImpl });
    assert.fail('throw 됐어야 함');
  } catch (e) {
    assert.equal(e.confirmedNotSent, undefined);
  }
});

test('[핵심 안전장치] placeKrCashBuyOrder: 429(유량초과)로 실패해도 confirmedNotSent 안 붙음(게이트웨이 단 거절이라 브로커 도달 여부 불명 — 코드리뷰 HIGH 실측 재현)', async () => {
  const fetchImpl = mockFetch([{ status: 429, body: { rsp_msg: '초당 호출한도 초과' } }]);
  try {
    await placeKrCashBuyOrder({ token: 't', actNo: '1', iemCd: '005930', quantity: 10, price: 70000, fetchImpl });
    assert.fail('throw 됐어야 함');
  } catch (e) {
    assert.equal(e.confirmedNotSent, undefined);
    assert.equal(e.code, 'RATE_LIMIT');
  }
});

// 2026-09-02 코드리뷰 LOW 지적 — krgold 리뷰 때 이 케이스(429 아닌 HTTP 4xx/5xx)
// 테스트가 krgold에만 있고 krstock엔 없다는 게 드러남(둘 다 동일한 callNh를 쓰므로
// 원래 있었어야 함).
test('[핵심 안전장치] placeKrCashBuyOrder: HTTP 4xx(비-429)여도 confirmedNotSent 안 붙음(불명 — 전송계층 실패)', async () => {
  const fetchImpl = async () => ({ ok: false, status: 500, text: async () => JSON.stringify({ error: 'internal' }) });
  try {
    await placeKrCashBuyOrder({ token: 't', actNo: '1', iemCd: '005930', quantity: 10, price: 70000, fetchImpl });
    assert.fail('throw 됐어야 함');
  } catch (e) {
    assert.equal(e.confirmedNotSent, undefined);
  }
});

test('[핵심 안전장치] placeKrCashBuyOrder: rsp_cd는 성공인데 mkt_orr_no가 없으면 throw하되 confirmedNotSent는 안 붙음(불명 — 롤백 금지)', async () => {
  const fetchImpl = mockFetch([{ body: { Output_0: {} } }]);
  try {
    await placeKrCashBuyOrder({ token: 't', actNo: '1', iemCd: '005930', quantity: 10, price: 70000, fetchImpl });
    assert.fail('throw 됐어야 함');
  } catch (e) {
    assert.equal(e.confirmedNotSent, undefined);
    assert.match(e.message, /mkt_orr_no/);
  }
});

test('[핵심 안전장치] placeKrCashSellOrder: 매도도 동일 안전장치(수량 검증)', async () => {
  const fetchImpl = mockFetch([{ body: { Output_0: { mkt_orr_no: '1' } } }]);
  try {
    await placeKrCashSellOrder({ token: 't', actNo: '1', iemCd: '005930', quantity: -5, fetchImpl });
    assert.fail('throw 됐어야 함');
  } catch (e) {
    assert.equal(e.confirmedNotSent, true);
  }
});

test('[핵심 안전장치] placeKrCashSellOrder: 네트워크 예외면 confirmedNotSent 안 붙음(불명, place 계열 4개 함수 전부 이 케이스를 갖도록 보강 — 2026-09-01 코드리뷰 지적)', async () => {
  const fetchImpl = async () => { throw new Error('fetch failed'); };
  try {
    await placeKrCashSellOrder({ token: 't', actNo: '1', iemCd: '005930', quantity: 10, price: 70000, fetchImpl });
    assert.fail('throw 됐어야 함');
  } catch (e) {
    assert.equal(e.confirmedNotSent, undefined);
  }
});

test('modifyKrOrder: 전체정정(allPatDitCd 기본값 1)이면 cor_qty 필드 자체가 없음', async () => {
  const fetchImpl = mockFetch([{ body: { Output_0: { mkt_orr_no: '999' } } }]);
  const r = await modifyKrOrder({ token: 't', actNo: '1', orgMktOrrNo: 123, iemCd: '005930', corPr: 71000, fetchImpl });
  assert.equal(r.orderNo, '999');
  const input0 = fetchImpl.calls[0].body.Input_0;
  assert.equal(input0.all_pat_dit_cd, '1');
  assert.equal('cor_qty' in input0, false);
  assert.equal(input0.cor_pr, 71000);
});

test('modifyKrOrder: 일부정정(allPatDitCd=2)이면 cor_qty 포함', async () => {
  const fetchImpl = mockFetch([{ body: { Output_0: { mkt_orr_no: '999' } } }]);
  await modifyKrOrder({ token: 't', actNo: '1', orgMktOrrNo: 123, iemCd: '005930', corPr: 71000, corQty: 5, allPatDitCd: '2', fetchImpl });
  assert.equal(fetchImpl.calls[0].body.Input_0.cor_qty, 5);
});

test('[핵심 안전장치] modifyKrOrder: 정정가격 0 이하는 즉시 throw + confirmedNotSent=true', async () => {
  const fetchImpl = mockFetch([{ body: { Output_0: { mkt_orr_no: '1' } } }]);
  try {
    await modifyKrOrder({ token: 't', actNo: '1', orgMktOrrNo: 123, iemCd: '005930', corPr: 0, fetchImpl });
    assert.fail('throw 됐어야 함');
  } catch (e) {
    assert.equal(e.confirmedNotSent, true);
  }
  assert.equal(fetchImpl.calls.length, 0);
});

test('[핵심 안전장치] modifyKrOrder: actNo·iemCd 없으면 네트워크 호출 전 즉시 throw + confirmedNotSent=true', async () => {
  const fetchImpl = mockFetch([{ body: { Output_0: { mkt_orr_no: '1' } } }]);
  await assert.rejects(() => modifyKrOrder({ token: 't', orgMktOrrNo: 123, iemCd: '005930', corPr: 71000, fetchImpl }));
  await assert.rejects(() => modifyKrOrder({ token: 't', actNo: '1', orgMktOrrNo: 123, corPr: 71000, fetchImpl }));
  assert.equal(fetchImpl.calls.length, 0);
});

test('[핵심 안전장치] modifyKrOrder: orgMktOrrNo 없거나 정수가 아니면 즉시 throw + confirmedNotSent=true', async () => {
  const fetchImpl = mockFetch([{ body: { Output_0: { mkt_orr_no: '1' } } }]);
  for (const bad of [undefined, 0, -1, '123']) {
    try {
      await modifyKrOrder({ token: 't', actNo: '1', orgMktOrrNo: bad, iemCd: '005930', corPr: 71000, fetchImpl });
      assert.fail(`throw 됐어야 함(orgMktOrrNo=${bad})`);
    } catch (e) {
      assert.equal(e.confirmedNotSent, true);
    }
  }
  assert.equal(fetchImpl.calls.length, 0);
});

// 2026-09-01 코드리뷰 HIGH 지적 — corQty를 줬는데 allPatDitCd를 '2'로 안 바꾸면
// corQty가 조용히 무시되고 전체(1)로 처리되던 문제(부분정정 의도가 전체정정으로
// 실행됨). 반대(allPatDitCd='2'인데 corQty 누락)도 같이 막는다.
test('[핵심 안전장치] modifyKrOrder: corQty를 줬는데 allPatDitCd가 "2"가 아니면 즉시 throw(전체로 조용히 처리될 뻔한 걸 방지) + confirmedNotSent=true', async () => {
  const fetchImpl = mockFetch([{ body: { Output_0: { mkt_orr_no: '1' } } }]);
  try {
    await modifyKrOrder({ token: 't', actNo: '1', orgMktOrrNo: 123, iemCd: '005930', corPr: 71000, corQty: 5, fetchImpl });
    assert.fail('throw 됐어야 함');
  } catch (e) {
    assert.equal(e.confirmedNotSent, true);
    assert.match(e.message, /allPatDitCd/);
  }
  assert.equal(fetchImpl.calls.length, 0);
});

test('[핵심 안전장치] modifyKrOrder: allPatDitCd="2"인데 corQty가 없거나 유효하지 않으면 즉시 throw + confirmedNotSent=true', async () => {
  const fetchImpl = mockFetch([{ body: { Output_0: { mkt_orr_no: '1' } } }]);
  for (const bad of [undefined, 0, -1]) {
    try {
      await modifyKrOrder({ token: 't', actNo: '1', orgMktOrrNo: 123, iemCd: '005930', corPr: 71000, corQty: bad, allPatDitCd: '2', fetchImpl });
      assert.fail(`throw 됐어야 함(corQty=${bad})`);
    } catch (e) {
      assert.equal(e.confirmedNotSent, true);
    }
  }
  assert.equal(fetchImpl.calls.length, 0);
});

test('[핵심 안전장치] modifyKrOrder: NH 업무거부면 confirmedNotSent=true(place와 동일 계약, 이전엔 modify에 이 테스트가 없었음)', async () => {
  const fetchImpl = mockFetch([{ body: { rsp_cd: '10006', rsp_msg: '주문번호가 존재하지 않습니다.' } }]);
  try {
    await modifyKrOrder({ token: 't', actNo: '1', orgMktOrrNo: 123, iemCd: '005930', corPr: 71000, fetchImpl });
    assert.fail('throw 됐어야 함');
  } catch (e) {
    assert.equal(e.confirmedNotSent, true);
  }
});

test('[핵심 안전장치] modifyKrOrder: 네트워크 예외면 confirmedNotSent 안 붙음(불명)', async () => {
  const fetchImpl = async () => { throw new Error('fetch failed'); };
  try {
    await modifyKrOrder({ token: 't', actNo: '1', orgMktOrrNo: 123, iemCd: '005930', corPr: 71000, fetchImpl });
    assert.fail('throw 됐어야 함');
  } catch (e) {
    assert.equal(e.confirmedNotSent, undefined);
  }
});

test('cancelKrOrder: 전체취소가 기본값, org_mkt_orr_no·iem_cd 그대로 전달', async () => {
  const fetchImpl = mockFetch([{ body: { Output_0: { mkt_orr_no: '888' } } }]);
  const r = await cancelKrOrder({ token: 't', actNo: '1', orgMktOrrNo: 123, iemCd: '005930', fetchImpl });
  assert.equal(r.orderNo, '888');
  assert.equal(fetchImpl.calls[0].body.Input_0.org_mkt_orr_no, 123);
  assert.equal(fetchImpl.calls[0].body.Input_0.all_pat_dit_cd, '1');
});

test('[핵심 안전장치] cancelKrOrder: 응답 성공인데 mkt_orr_no 없으면 confirmedNotSent 안 붙음(불명)', async () => {
  const fetchImpl = mockFetch([{ body: { Output_0: {} } }]);
  try {
    await cancelKrOrder({ token: 't', actNo: '1', orgMktOrrNo: 123, iemCd: '005930', fetchImpl });
    assert.fail('throw 됐어야 함');
  } catch (e) {
    assert.equal(e.confirmedNotSent, undefined);
  }
});

test('[핵심 안전장치] cancelKrOrder: actNo·iemCd 없으면 네트워크 호출 전 즉시 throw + confirmedNotSent=true', async () => {
  const fetchImpl = mockFetch([{ body: { Output_0: { mkt_orr_no: '1' } } }]);
  await assert.rejects(() => cancelKrOrder({ token: 't', orgMktOrrNo: 123, iemCd: '005930', fetchImpl }));
  await assert.rejects(() => cancelKrOrder({ token: 't', actNo: '1', orgMktOrrNo: 123, fetchImpl }));
  assert.equal(fetchImpl.calls.length, 0);
});

test('[핵심 안전장치] cancelKrOrder: orgMktOrrNo 없거나 정수가 아니면 즉시 throw + confirmedNotSent=true', async () => {
  const fetchImpl = mockFetch([{ body: { Output_0: { mkt_orr_no: '1' } } }]);
  for (const bad of [undefined, 0, -1, '123']) {
    try {
      await cancelKrOrder({ token: 't', actNo: '1', orgMktOrrNo: bad, iemCd: '005930', fetchImpl });
      assert.fail(`throw 됐어야 함(orgMktOrrNo=${bad})`);
    } catch (e) {
      assert.equal(e.confirmedNotSent, true);
    }
  }
  assert.equal(fetchImpl.calls.length, 0);
});

test('[핵심 안전장치] cancelKrOrder: corQty를 줬는데 allPatDitCd가 "2"가 아니면 즉시 throw(전체취소로 조용히 처리될 뻔한 걸 방지) + confirmedNotSent=true', async () => {
  const fetchImpl = mockFetch([{ body: { Output_0: { mkt_orr_no: '1' } } }]);
  try {
    await cancelKrOrder({ token: 't', actNo: '1', orgMktOrrNo: 123, iemCd: '005930', corQty: 5, fetchImpl });
    assert.fail('throw 됐어야 함');
  } catch (e) {
    assert.equal(e.confirmedNotSent, true);
    assert.match(e.message, /allPatDitCd/);
  }
  assert.equal(fetchImpl.calls.length, 0);
});

test('[핵심 안전장치] cancelKrOrder: allPatDitCd="2"인데 corQty가 없거나 유효하지 않으면 즉시 throw + confirmedNotSent=true', async () => {
  const fetchImpl = mockFetch([{ body: { Output_0: { mkt_orr_no: '1' } } }]);
  for (const bad of [undefined, 0, -1]) {
    try {
      await cancelKrOrder({ token: 't', actNo: '1', orgMktOrrNo: 123, iemCd: '005930', corQty: bad, allPatDitCd: '2', fetchImpl });
      assert.fail(`throw 됐어야 함(corQty=${bad})`);
    } catch (e) {
      assert.equal(e.confirmedNotSent, true);
    }
  }
  assert.equal(fetchImpl.calls.length, 0);
});

test('[핵심 안전장치] cancelKrOrder: NH 업무거부면 confirmedNotSent=true(이전엔 cancel에 이 테스트가 없었음)', async () => {
  const fetchImpl = mockFetch([{ body: { rsp_cd: '10006', rsp_msg: '이미 체결된 주문입니다.' } }]);
  try {
    await cancelKrOrder({ token: 't', actNo: '1', orgMktOrrNo: 123, iemCd: '005930', fetchImpl });
    assert.fail('throw 됐어야 함');
  } catch (e) {
    assert.equal(e.confirmedNotSent, true);
  }
});

test('[핵심 안전장치] cancelKrOrder: 429여도 confirmedNotSent 안 붙음(불명)', async () => {
  const fetchImpl = mockFetch([{ status: 429, body: { rsp_msg: '초당 호출한도 초과' } }]);
  try {
    await cancelKrOrder({ token: 't', actNo: '1', orgMktOrrNo: 123, iemCd: '005930', fetchImpl });
    assert.fail('throw 됐어야 함');
  } catch (e) {
    assert.equal(e.confirmedNotSent, undefined);
  }
});

test('[핵심 안전장치] cancelKrOrder: 네트워크 예외면 confirmedNotSent 안 붙음(불명)', async () => {
  const fetchImpl = async () => { throw new Error('fetch failed'); };
  try {
    await cancelKrOrder({ token: 't', actNo: '1', orgMktOrrNo: 123, iemCd: '005930', fetchImpl });
    assert.fail('throw 됐어야 함');
  } catch (e) {
    assert.equal(e.confirmedNotSent, undefined);
  }
});
