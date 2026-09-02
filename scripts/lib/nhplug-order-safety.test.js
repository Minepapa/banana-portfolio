import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateOrderInputs, validateIdentity, validateOrgOrderRef, validatePartialQty, rethrowOrderError,
  validateSbyDitCd, validateFixedOption, extractOrderNo,
} from './nhplug-order-safety.mjs';

// 2026-09-01 신설 — krstock에서 검증됐던 로직을 krgold와 공유하도록 뽑은 모듈이라
// 여기 직접 테스트도 둔다(간접적으로는 nhplug-krstock.test.js가 이미 촘촘히
// 검증하지만, 이 모듈 자체가 나중에 세 번째 자산군에서도 쓰일 걸 감안하면 소비자
// 테스트에만 의존하지 않는 게 안전).

test('validateOrderInputs: 수량 0 이하·소수면 throw + confirmedNotSent=true', () => {
  for (const bad of [0, -1, 1.5]) {
    try {
      validateOrderInputs({ quantity: bad, price: 100 });
      assert.fail(`throw 됐어야 함(quantity=${bad})`);
    } catch (e) {
      assert.equal(e.confirmedNotSent, true);
    }
  }
});

test('validateOrderInputs: price가 null/undefined면 검증 생략(시장가 등 가격 없는 주문)', () => {
  assert.doesNotThrow(() => validateOrderInputs({ quantity: 10, price: null }));
  assert.doesNotThrow(() => validateOrderInputs({ quantity: 10, price: undefined }));
});

test('validateOrderInputs: price가 0 이하면 throw + confirmedNotSent=true', () => {
  try {
    validateOrderInputs({ quantity: 10, price: -1 });
    assert.fail('throw 됐어야 함');
  } catch (e) {
    assert.equal(e.confirmedNotSent, true);
  }
});

test('validateIdentity: actNo·iemCd 둘 다 있으면 통과', () => {
  assert.doesNotThrow(() => validateIdentity({ actNo: '1', iemCd: 'M04020000' }));
});

test('[막아야 함] validateIdentity: actNo·iemCd 각각 없거나 공백뿐이면 throw + confirmedNotSent=true', () => {
  for (const actNo of [undefined, null, '', '  ']) {
    try { validateIdentity({ actNo, iemCd: '005930' }); assert.fail(`throw 됐어야 함(actNo=${JSON.stringify(actNo)})`); }
    catch (e) { assert.equal(e.confirmedNotSent, true); }
  }
  for (const iemCd of [undefined, null, '', '  ']) {
    try { validateIdentity({ actNo: '1', iemCd }); assert.fail(`throw 됐어야 함(iemCd=${JSON.stringify(iemCd)})`); }
    catch (e) { assert.equal(e.confirmedNotSent, true); }
  }
});

test('validateOrgOrderRef: 양의 정수면 통과, 그 외(undefined·0·음수·문자열)는 throw + confirmedNotSent=true', () => {
  assert.doesNotThrow(() => validateOrgOrderRef({ orgMktOrrNo: 123 }));
  for (const bad of [undefined, 0, -1, '123']) {
    try { validateOrgOrderRef({ orgMktOrrNo: bad }); assert.fail(`throw 됐어야 함(${bad})`); }
    catch (e) { assert.equal(e.confirmedNotSent, true); }
  }
});

test('validateOrgOrderRef: label을 주면 에러 메시지가 실제 파라미터명을 가리킴(기본값은 하위호환용 orgMktOrrNo)', () => {
  try {
    validateOrgOrderRef({ orgMktOrrNo: undefined, label: '예약주문번호(bkgOrrNo)' });
    assert.fail('throw 됐어야 함');
  } catch (e) {
    assert.match(e.message, /예약주문번호\(bkgOrrNo\)/);
    assert.doesNotMatch(e.message, /orgMktOrrNo/);
  }
  try {
    validateOrgOrderRef({ orgMktOrrNo: undefined });
    assert.fail('throw 됐어야 함');
  } catch (e) {
    assert.match(e.message, /orgMktOrrNo/);
  }
});

test('validateSbyDitCd: "1"·"2"는 통과, 그 외는 throw + confirmedNotSent=true', () => {
  assert.doesNotThrow(() => validateSbyDitCd('1'));
  assert.doesNotThrow(() => validateSbyDitCd('2'));
  for (const bad of [undefined, null, '0', '3', 1, 2]) {
    try { validateSbyDitCd(bad); assert.fail(`throw 됐어야 함(${bad})`); }
    catch (e) { assert.equal(e.confirmedNotSent, true); }
  }
});

test('validateFixedOption: 지정값과 같으면 통과, 다르면 throw + confirmedNotSent=true', () => {
  assert.doesNotThrow(() => validateFixedOption('KRX', 'KRX', '요청시장코드'));
  try {
    validateFixedOption('NXT', 'KRX', '요청시장코드');
    assert.fail('throw 됐어야 함');
  } catch (e) {
    assert.equal(e.confirmedNotSent, true);
    assert.match(e.message, /요청시장코드/);
  }
});

test('extractOrderNo: 필드가 있으면 문자열로 반환(숫자·문자열 둘 다), 없으면 throw(confirmedNotSent 안 붙음 — 불명 상태 유지가 호출부 책임)', () => {
  assert.equal(extractOrderNo({ Output_0: { mkt_orr_no: 113 } }, 'mkt_orr_no', '주문'), '113');
  assert.equal(extractOrderNo({ Output_0: { bkg_orr_no: '555' } }, 'bkg_orr_no', '예약주문'), '555');
  try {
    extractOrderNo({ Output_0: {} }, 'mkt_orr_no', '주문');
    assert.fail('throw 됐어야 함');
  } catch (e) {
    assert.equal(e.confirmedNotSent, undefined);
    assert.match(e.message, /mkt_orr_no/);
  }
});

test('validatePartialQty: allPatDitCd 기본(전체)이고 corQty 없으면 통과', () => {
  assert.doesNotThrow(() => validatePartialQty({ allPatDitCd: '1', corQty: undefined }));
});

test('[막아야 함] validatePartialQty: corQty를 줬는데 allPatDitCd가 "2"가 아니면 throw(조용히 전체로 처리될 뻔한 걸 방지)', () => {
  try {
    validatePartialQty({ allPatDitCd: '1', corQty: 5 });
    assert.fail('throw 됐어야 함');
  } catch (e) {
    assert.equal(e.confirmedNotSent, true);
    assert.match(e.message, /allPatDitCd/);
  }
});

test('[막아야 함] validatePartialQty: allPatDitCd="2"인데 corQty가 없거나 유효하지 않으면 throw', () => {
  for (const bad of [undefined, 0, -1]) {
    try { validatePartialQty({ allPatDitCd: '2', corQty: bad }); assert.fail(`throw 됐어야 함(${bad})`); }
    catch (e) { assert.equal(e.confirmedNotSent, true); }
  }
});

test('validatePartialQty: allPatDitCd="2"이고 corQty가 양의 정수면 통과', () => {
  assert.doesNotThrow(() => validatePartialQty({ allPatDitCd: '2', corQty: 5 }));
});

test('rethrowOrderError: businessRejection이면 confirmedNotSent=true로 승격 후 던짐', () => {
  const e = new Error('업무거부'); e.businessRejection = true;
  try { rethrowOrderError(e); assert.fail('throw 됐어야 함'); }
  catch (caught) { assert.equal(caught.confirmedNotSent, true); }
});

test('[막아야 함] rethrowOrderError: businessRejection 없으면(429·네트워크예외 등) confirmedNotSent 승격 안 함', () => {
  const e = new Error('유량초과'); e.code = 'RATE_LIMIT';
  try { rethrowOrderError(e); assert.fail('throw 됐어야 함'); }
  catch (caught) { assert.equal(caught.confirmedNotSent, undefined); }
});
