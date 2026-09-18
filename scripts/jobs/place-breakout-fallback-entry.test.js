import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyPriorOrderStatus, refineWithHoldings, needsHoldingsCrossCheck, confirmPriorOrderVoided } from './place-breakout-fallback-entry.mjs';

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
