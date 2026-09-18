import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyPriorOrderStatus, refineWithHoldings, needsHoldingsCrossCheck, confirmPriorOrderVoided, attemptCancelPriorOrder,
} from './place-breakout-fallback-entry.mjs';

// [핵심 안전장치] 코드리뷰 CRITICAL 지적(2026-09-13) 재발방지 — "전날 장후시간외
// 미체결 주문은 세션 종료 시 자동실효된다"는 가정이 틀렸을 경우, 확인 없이 다음날
// 시가 주문을 또 내면 이중매수가 된다. 애매한 모든 경우는 voided=false(폴백 보류).
test('classifyPriorOrderStatus: 조회결과 없음(null)이면 voided=false — 추정 안 함', () => {
  const r = classifyPriorOrderStatus(null);
  assert.equal(r.voided, false);
});

test('classifyPriorOrderStatus: canceled:true면 voided=true(안전하게 폴백 진행 가능)', () => {
  const r = classifyPriorOrderStatus({ canceled: true });
  assert.equal(r.voided, true);
});

test('classifyPriorOrderStatus: fullyFilled:true면 voided=false — 이미 체결된 걸 또 사면 안 됨', () => {
  const r = classifyPriorOrderStatus({ fullyFilled: true, avgFillPrice: 71000 });
  assert.equal(r.voided, false);
  assert.match(r.note, /전량체결/);
});

test('classifyPriorOrderStatus: 부분체결(filledQty>0, fullyFilled:false)이면 voided=false', () => {
  const r = classifyPriorOrderStatus({ fullyFilled: false, filledQty: 3, canceled: false });
  assert.equal(r.voided, false);
  assert.match(r.note, /일부/);
});

test('classifyPriorOrderStatus: 미체결(filledQty=0)이지만 canceled 아니면 voided=false(자동실효 가정 검증 안 됨)', () => {
  const r = classifyPriorOrderStatus({ fullyFilled: false, filledQty: 0, canceled: false });
  assert.equal(r.voided, false);
  assert.match(r.note, /미체결 상태로 남아있는/);
});

// [교차검증 대상 범위] 2026-09-19 코드리뷰 HIGH 지적 재발방지 — unfilled는
// checkOrderFill이 이미 filledQty=0을 직접 말해준 상태라 holdings 부재가 거기
// 더할 새 정보가 없다("아직 체결 안 됨" ≠ "주문이 죽었음"). no_result만 대상.
test('needsHoldingsCrossCheck: no_result만 true, unfilled/partial/fullyFilled/canceled는 전부 false', () => {
  assert.equal(needsHoldingsCrossCheck(classifyPriorOrderStatus(null)), true);
  assert.equal(needsHoldingsCrossCheck(classifyPriorOrderStatus({ fullyFilled: false, filledQty: 0, canceled: false })), false);
  assert.equal(needsHoldingsCrossCheck(classifyPriorOrderStatus({ fullyFilled: false, filledQty: 3, canceled: false })), false);
  assert.equal(needsHoldingsCrossCheck(classifyPriorOrderStatus({ fullyFilled: true, avgFillPrice: 71000 })), false);
  assert.equal(needsHoldingsCrossCheck(classifyPriorOrderStatus({ canceled: true })), false);
});

// [교차검증] no_result(당일 주문 조회에 아예 안 잡힘) + 보유 없음 → voided=true 승격.
test('refineWithHoldings: no_result + 계좌에 해당 종목 없음 → voided=true로 자동 확정', () => {
  const classification = classifyPriorOrderStatus(null);
  const r = refineWithHoldings(classification, '055550', []);
  assert.equal(r.voided, true);
  assert.match(r.note, /보유 없음/);
});

test('refineWithHoldings: no_result + 계좌에 해당 종목 실제 보유 → voided=false 유지, 근거만 보강', () => {
  const classification = classifyPriorOrderStatus(null);
  const r = refineWithHoldings(classification, '055550', [{ code: '055550', qty: 1 }]);
  assert.equal(r.voided, false);
  assert.match(r.note, /실제 보유 확인됨/);
});

// [HIGH 재발방지] unfilled는 holdings로 승격시키지 않는다 — "아직 체결 안 됨"과
// "주문이 죽었음"은 별개 명제라, 자동실효 가정이 틀렸다면 승격이 이중매수로 이어짐.
test('refineWithHoldings: unfilled은 holdings와 무관하게 원판정 그대로 유지(승격 안 함)', () => {
  const classification = classifyPriorOrderStatus({ fullyFilled: false, filledQty: 0, canceled: false });
  assert.deepEqual(refineWithHoldings(classification, '055550', []), classification);
  assert.deepEqual(refineWithHoldings(classification, '055550', [{ code: '055550', qty: 1 }]), classification);
});

test('refineWithHoldings: fullyFilled/partial/canceled은 건드리지 않음(이미 확정적 판단)', () => {
  const fullyFilled = classifyPriorOrderStatus({ fullyFilled: true, avgFillPrice: 71000 });
  assert.deepEqual(refineWithHoldings(fullyFilled, '055550', []), fullyFilled);
  const partial = classifyPriorOrderStatus({ fullyFilled: false, filledQty: 3, canceled: false });
  assert.deepEqual(refineWithHoldings(partial, '055550', []), partial);
  const canceled = classifyPriorOrderStatus({ canceled: true });
  assert.deepEqual(refineWithHoldings(canceled, '055550', []), canceled);
});

test('refineWithHoldings: holdings 항목의 qty=0(전량매도 흔적)은 보유로 안 침', () => {
  const classification = classifyPriorOrderStatus(null);
  const r = refineWithHoldings(classification, '055550', [{ code: '055550', qty: 0 }]);
  assert.equal(r.voided, true);
});

// [HIGH 재발방지] holdings가 배열이 아니면(API 응답 파싱 실패 등) "보유 없음"의
// 증거로 쓰지 않는다 — 조회 실패를 승격 근거로 쓰면 검증 못 한 상태에서 실주문 위험.
test('refineWithHoldings: holdings가 배열이 아니면(undefined/null) 원판정 유지 — 승격 안 함', () => {
  const classification = classifyPriorOrderStatus(null);
  assert.deepEqual(refineWithHoldings(classification, '055550', undefined), classification);
  assert.deepEqual(refineWithHoldings(classification, '055550', null), classification);
});

// [LOW 재발방지] code 형 불일치(문자열 vs 숫자, 선행0 소실)로 교차검증이 조용히
// "보유 없음"으로 오판하지 않도록 6자리 0패딩 정규화 비교.
test('refineWithHoldings: code가 숫자형(선행0 소실)이어도 holdings의 문자열 code와 정확히 매칭', () => {
  const classification = classifyPriorOrderStatus(null);
  const r = refineWithHoldings(classification, 55550, [{ code: '055550', qty: 1 }]);
  assert.equal(r.voided, false);
});

// [MEDIUM 재발방지] confirmPriorOrderVoided 래퍼도 주입 가능하게 export돼 순수함수
// 합성 로직(no_result→holdings 교차검증)이 실제로 연결됐는지, holdings 조회 실패
// 시 기존 보수적 기본값(voided=false)이 보존되는지 검증.
test('confirmPriorOrderVoided: no_result(주입) + 계좌 조회에서 보유 없음 → voided=true', async () => {
  const r = await confirmPriorOrderVoided({
    token: 't', appkey: 'k', appsecret: 's', cano: 'c', acntPrdtCd: '01', code: '055550',
    afterHoursOrderNo: '0017009800', signalDate: '2026-09-15',
    checkOrderFillImpl: async () => null,
    getAccountBalanceImpl: async () => ({ holdings: [], cash: 524681 }),
  });
  assert.equal(r.voided, true);
});

test('confirmPriorOrderVoided: no_result인데 getAccountBalance 자체가 실패 → voided=false 보존(기존 보수적 기본값 유지)', async () => {
  const r = await confirmPriorOrderVoided({
    token: 't', appkey: 'k', appsecret: 's', cano: 'c', acntPrdtCd: '01', code: '055550',
    afterHoursOrderNo: '0017009800', signalDate: '2026-09-15',
    checkOrderFillImpl: async () => null,
    getAccountBalanceImpl: async () => { throw new Error('EGW00201 rate limit'); },
  });
  assert.equal(r.voided, false);
  assert.match(r.note, /교차검증 실패/);
});

test('confirmPriorOrderVoided: unfilled(주입)이면 holdings 조회까지 가지 않고 voided=false 유지', async () => {
  let balanceCalled = false;
  const r = await confirmPriorOrderVoided({
    token: 't', appkey: 'k', appsecret: 's', cano: 'c', acntPrdtCd: '01', code: '055550',
    afterHoursOrderNo: '0017009800', signalDate: '2026-09-15',
    checkOrderFillImpl: async () => ({ fullyFilled: false, filledQty: 0, canceled: false }),
    getAccountBalanceImpl: async () => { balanceCalled = true; return { holdings: [], cash: 0 }; },
  });
  assert.equal(r.voided, false);
  assert.equal(balanceCalled, false);
});

// [취소시도, 2026-09-19] unfilled(055550류)가 checkOrderFill/holdings 조합으로는
// 여전히 uncertain에 갇히던 문제 — 취소를 직접 시도해 성공하면(주문이 여전히
// 살아있었다는 확정 증거) 곧바로 voided=true로 해소한다. 2026-09-19 코드리뷰 HIGH
// 지적으로 read(checkOrderFill)를 항상 먼저 하고, 그 결과가 정확히 'unfilled'로
// 확정된 경우에만(그리고 allowCancel:true일 때만 — CRITICAL 지적) 취소를 시도한다.
// 취소요청 성공(rt_cd=0) 후에도 재조회로 실제 canceled 상태를 재확인한다(Open
// Question 대응 — rt_cd=0이 "적용완료"인지 "접수만 됨"인지 미검증이므로).
test('confirmPriorOrderVoided: allowCancel:true + unfilled 확정 → 취소시도 성공 + 재확인도 canceled → voided=true(canceledByUs)', async () => {
  let checkOrderFillCallCount = 0;
  const r = await confirmPriorOrderVoided({
    token: 't', appkey: 'k', appsecret: 's', cano: 'c', acntPrdtCd: '01', code: '055550',
    afterHoursOrderNo: '0017009800', afterHoursOrgNo: '06010', afterHoursOrderQty: 2, signalDate: '2026-09-15',
    allowCancel: true,
    checkOrderFillImpl: async () => {
      checkOrderFillCallCount += 1;
      // 1차 조회(취소 전)=unfilled, 2차 조회(취소 후 재확인)=canceled
      return checkOrderFillCallCount === 1
        ? { fullyFilled: false, filledQty: 0, canceled: false }
        : { fullyFilled: false, filledQty: 0, canceled: true };
    },
    reviseKrOrderImpl: async () => ({ orderNo: '9', orgNo: '06010' }),
  });
  assert.equal(checkOrderFillCallCount, 2);
  assert.equal(r.voided, true);
  assert.equal(r.kind, 'canceledByUs');
  assert.equal(r.cancelOrderNo, '9');
});

test('confirmPriorOrderVoided: 취소요청은 성공(rt_cd=0)했지만 재확인 조회에서 아직 canceled로 안 보임(비동기 지연 등) → 자동진행 보류', async () => {
  let checkOrderFillCallCount = 0;
  const r = await confirmPriorOrderVoided({
    token: 't', appkey: 'k', appsecret: 's', cano: 'c', acntPrdtCd: '01', code: '055550',
    afterHoursOrderNo: '0017009800', afterHoursOrgNo: '06010', afterHoursOrderQty: 2, signalDate: '2026-09-15',
    allowCancel: true,
    checkOrderFillImpl: async () => {
      checkOrderFillCallCount += 1;
      return { fullyFilled: false, filledQty: 0, canceled: false }; // 재확인 때도 여전히 unfilled로만 보임
    },
    reviseKrOrderImpl: async () => ({ orderNo: '9', orgNo: '06010' }),
  });
  assert.equal(checkOrderFillCallCount, 2);
  assert.equal(r.voided, false);
  assert.equal(r.kind, 'unfilled');
});

test('confirmPriorOrderVoided: 취소요청 성공했지만 재확인 조회에서 실제로는 그새 전량체결로 확인됨(레이스) → 이중매수 방지, voided=false', async () => {
  let checkOrderFillCallCount = 0;
  const r = await confirmPriorOrderVoided({
    token: 't', appkey: 'k', appsecret: 's', cano: 'c', acntPrdtCd: '01', code: '055550',
    afterHoursOrderNo: '0017009800', afterHoursOrgNo: '06010', afterHoursOrderQty: 2, signalDate: '2026-09-15',
    allowCancel: true,
    checkOrderFillImpl: async () => {
      checkOrderFillCallCount += 1;
      return checkOrderFillCallCount === 1
        ? { fullyFilled: false, filledQty: 0, canceled: false }
        : { fullyFilled: true, avgFillPrice: 71000 }; // 취소 시도 사이 실제로는 체결돼 있었음
    },
    reviseKrOrderImpl: async () => ({ orderNo: '9', orgNo: '06010' }),
  });
  assert.equal(r.voided, false);
  assert.equal(r.kind, 'fullyFilled');
});

test('confirmPriorOrderVoided: 취소요청 성공했지만 재확인 조회 자체가 실패 → 적용 여부 불확실, 자동진행 보류', async () => {
  const r = await confirmPriorOrderVoided({
    token: 't', appkey: 'k', appsecret: 's', cano: 'c', acntPrdtCd: '01', code: '055550',
    afterHoursOrderNo: '0017009800', afterHoursOrgNo: '06010', afterHoursOrderQty: 2, signalDate: '2026-09-15',
    allowCancel: true,
    checkOrderFillImpl: (() => {
      let n = 0;
      return async () => {
        n += 1;
        if (n === 1) return { fullyFilled: false, filledQty: 0, canceled: false };
        throw new Error('네트워크 오류');
      };
    })(),
    reviseKrOrderImpl: async () => ({ orderNo: '9', orgNo: '06010' }),
  });
  assert.equal(r.voided, false);
  assert.match(r.note, /재확인 조회 실패/);
});

// [CRITICAL 재발방지] allowCancel 기본값(미지정)은 false — 킬스위치를 먼저 확인하지
// 않은 호출부가 실수로 취소를 내보내면 안 된다. 예전엔 이 함수가 항상 취소를
// 시도했는데, main()의 킬스위치 체크가 이 함수 호출 뒤에 있어 킬스위치가 켜져
// 있어도 실제 KIS 취소주문이 나갔었다.
test('confirmPriorOrderVoided: allowCancel 생략(기본 false) → unfilled여도 취소시도 자체를 안 함', async () => {
  let reviseCalled = false;
  const r = await confirmPriorOrderVoided({
    token: 't', appkey: 'k', appsecret: 's', cano: 'c', acntPrdtCd: '01', code: '055550',
    afterHoursOrderNo: '0017009800', afterHoursOrgNo: '06010', afterHoursOrderQty: 2, signalDate: '2026-09-15',
    checkOrderFillImpl: async () => ({ fullyFilled: false, filledQty: 0, canceled: false }),
    reviseKrOrderImpl: async () => { reviseCalled = true; return { orderNo: '9' }; },
  });
  assert.equal(reviseCalled, false);
  assert.equal(r.voided, false);
});

// [HIGH 재발방지] 부분체결(partial)·전량체결(fullyFilled)·이미취소(canceled)는
// allowCancel:true여도 취소시도 자체를 안 함 — QTY_ALL_ORD_YN='Y' 취소요청이
// 부분체결 잔량까지 지워버려 "이미 체결된 수량 + 오늘 폴백 매수"의 이중매수+
// 무보호 잔량을 만들 수 있기 때문(read-then-write로 이미 확정판단이 난 kind는
// 건드리지 않는다).
test('confirmPriorOrderVoided: allowCancel:true여도 partial/fullyFilled/canceled는 취소시도 안 함', async () => {
  for (const result of [
    { fullyFilled: false, filledQty: 3, canceled: false }, // partial
    { fullyFilled: true, avgFillPrice: 71000 }, // fullyFilled
    { canceled: true }, // canceled
  ]) {
    let reviseCalled = false;
    await confirmPriorOrderVoided({
      token: 't', appkey: 'k', appsecret: 's', cano: 'c', acntPrdtCd: '01', code: '055550',
      afterHoursOrderNo: '0017009800', afterHoursOrgNo: '06010', afterHoursOrderQty: 2, signalDate: '2026-09-15',
      allowCancel: true,
      checkOrderFillImpl: async () => result,
      reviseKrOrderImpl: async () => { reviseCalled = true; return { orderNo: '9' }; },
    });
    assert.equal(reviseCalled, false, `${JSON.stringify(result)}에서 취소시도가 발생함`);
  }
});

test('confirmPriorOrderVoided: allowCancel:true + unfilled인데 취소시도 실패(이미 체결/실효 등) → 원판정 그대로, 사유에 실패이유 포함', async () => {
  const r = await confirmPriorOrderVoided({
    token: 't', appkey: 'k', appsecret: 's', cano: 'c', acntPrdtCd: '01', code: '055550',
    afterHoursOrderNo: '0017009800', afterHoursOrgNo: '06010', afterHoursOrderQty: 2, signalDate: '2026-09-15',
    allowCancel: true,
    checkOrderFillImpl: async () => ({ fullyFilled: false, filledQty: 0, canceled: false }),
    reviseKrOrderImpl: async () => { const e = new Error('이미 체결된 주문입니다.'); e.confirmedNotSent = true; throw e; },
  });
  assert.equal(r.voided, false);
  assert.equal(r.kind, 'unfilled');
  assert.match(r.note, /취소시도 실패/);
  assert.match(r.note, /이미 체결된 주문입니다/);
});

test('confirmPriorOrderVoided: allowCancel:true + no_result → 취소시도가 아니라 기존 holdings 교차검증 경로로 감(취소는 unfilled 전용)', async () => {
  let reviseCalled = false;
  const r = await confirmPriorOrderVoided({
    token: 't', appkey: 'k', appsecret: 's', cano: 'c', acntPrdtCd: '01', code: '055550',
    afterHoursOrderNo: '0017009800', afterHoursOrgNo: '06010', afterHoursOrderQty: 2, signalDate: '2026-09-15',
    allowCancel: true,
    checkOrderFillImpl: async () => null,
    reviseKrOrderImpl: async () => { reviseCalled = true; return { orderNo: '9' }; },
    getAccountBalanceImpl: async () => ({ holdings: [], cash: 0 }),
  });
  assert.equal(reviseCalled, false);
  assert.equal(r.voided, true); // no_result + holdings 없음 → 기존 경로대로 자동확정
});

test('confirmPriorOrderVoided: allowCancel:true + orgNo·quantity 없음(과거 레코드) → 취소시도 자체를 스킵, unfilled는 그대로 보류', async () => {
  let reviseCalled = false;
  const r = await confirmPriorOrderVoided({
    token: 't', appkey: 'k', appsecret: 's', cano: 'c', acntPrdtCd: '01', code: '055550',
    afterHoursOrderNo: '0017009800', signalDate: '2026-09-15', // afterHoursOrgNo/Qty 없음
    allowCancel: true,
    checkOrderFillImpl: async () => ({ fullyFilled: false, filledQty: 0, canceled: false }),
    reviseKrOrderImpl: async () => { reviseCalled = true; return { orderNo: '9' }; },
  });
  assert.equal(reviseCalled, false);
  assert.equal(r.voided, false);
});

// [MEDIUM 재발방지] attemptCancelPriorOrder 자체를 export해 guard matrix를 직접
// 테이블 테스트 — orgNo·quantity 조합별로 시도 여부가 정확한지, 그리고 reviseKrOrderImpl
// 이 정확한 인자 모양으로 호출되는지(파라미터명 오타 등은 여태 아무 테스트도 못 잡았음).
test('attemptCancelPriorOrder: orgNo·quantity guard matrix', async () => {
  const cases = [
    { orgNo: '06010', quantity: 2, shouldAttempt: true, label: '정상' },
    { orgNo: null, quantity: 2, shouldAttempt: false, label: 'orgNo 없음' },
    { orgNo: '', quantity: 2, shouldAttempt: false, label: 'orgNo 빈문자열' },
    { orgNo: '06010', quantity: null, shouldAttempt: false, label: 'quantity null(ord_qty 결측)' },
    { orgNo: '06010', quantity: '2', shouldAttempt: false, label: 'quantity 문자열(형 불일치, 실패 방향으로 닫힘)' },
    { orgNo: '06010', quantity: 0, shouldAttempt: false, label: 'quantity 0' },
  ];
  for (const c of cases) {
    let called = false;
    await attemptCancelPriorOrder({
      token: 't', appkey: 'k', appsecret: 's', cano: 'cano', acntPrdtCd: '01',
      orgNo: c.orgNo, orderNo: '0017009800', quantity: c.quantity,
      reviseKrOrderImpl: async () => { called = true; return { orderNo: '9' }; },
    });
    assert.equal(called, c.shouldAttempt, c.label);
  }
});

test('attemptCancelPriorOrder: reviseKrOrderImpl에 정확한 인자 모양으로 호출됨(파라미터명 오타 회귀 방지)', async () => {
  let captured = null;
  await attemptCancelPriorOrder({
    token: 't', appkey: 'k', appsecret: 's', cano: 'cano123', acntPrdtCd: '01',
    orgNo: '06010', orderNo: '0017009800', quantity: 2,
    reviseKrOrderImpl: async (args) => { captured = args; return { orderNo: '9' }; },
  });
  assert.equal(captured.action, '취소');
  assert.equal(captured.price, 0);
  assert.equal(captured.quantity, 2);
  assert.equal(captured.orgNo, '06010');
  assert.equal(captured.orderNo, '0017009800');
  assert.equal(captured.cano, 'cano123');
});

test('attemptCancelPriorOrder: 성공하면 취소응답의 orderNo를 cancelOrderNo로 반환(감사추적용)', async () => {
  const r = await attemptCancelPriorOrder({
    token: 't', appkey: 'k', appsecret: 's', cano: 'c', acntPrdtCd: '01',
    orgNo: '06010', orderNo: '0017009800', quantity: 2,
    reviseKrOrderImpl: async () => ({ orderNo: '9999', orgNo: '06010' }),
  });
  assert.equal(r.attempted, true);
  assert.equal(r.canceled, true);
  assert.equal(r.cancelOrderNo, '9999');
});
