import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyPriorOrderStatus, refineWithHoldings, needsHoldingsCrossCheck, confirmPriorOrderVoided, attemptCancelPriorOrder,
  buildFallbackWatchArgs, buildPlacedPendingEntryUpdate, processFallbackEntry,
} from './place-breakout-fallback-entry.mjs';
import { join } from 'node:path';
import { buildPendingEntryRecord, parsePendingEntry } from '../lib/breakout-pending-entry-vault.mjs';

// 완료된 Pending Entry는 출처 추적을 위해 제자리에 보존한다. 이 테스트가 없으면
// placed 전환 시 실제 진입일이 아닌 신호일을 링크하거나 링크 자체를 빼도 감지 못 한다.
test('buildPlacedPendingEntryUpdate: 실제 진입일 기반 체결예정 Position id를 placed 레코드에 남긴다', () => {
  const update = buildPlacedPendingEntryUpdate({
    code: '017670', entryDate: '2026-09-25', updatedAt: '2026-09-25T00:03:00.000Z',
  });

  assert.deepEqual(update, {
    status: 'placed',
    expectedPositionId: '017670-2026-09-25',
    updatedAt: '2026-09-25T00:03:00.000Z',
  });
});

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

// [실사고 재발방지] 2026-09-22 실전 첫 실행 — SK텔레콤(017670) 장후시간외 1주
// 매수가 거부/자동실효됐는데(KIS 응답: cncl_yn:""·tot_ccld_qty:"0"·rmn_qty:"0"·
// rjct_qty:"1") canceled==='Y'가 아니라서 예전 로직은 'unfilled'로 오분류 →
// 이미 죽은 주문에 취소를 또 시도 → KIS가 거부(취소가능수량 없음) → uncertain에
// 갇혀 다음날시가 폴백이 하루 지연됐다. remainingQty===0인데 filledQty도 0이면
// (체결 0·잔여도 0) 거부/실효뿐이라 voided=true여야 한다 — attemptCancelPriorOrder
// 재시도 없이 바로 폴백 진행.
test('classifyPriorOrderStatus: filledQty=0·remainingQty=0(체결도 잔여도 없음)이면 거부/자동실효로 voided=true — 2026-09-22 실사고 재현', () => {
  const r = classifyPriorOrderStatus({ fullyFilled: false, filledQty: 0, remainingQty: 0, canceled: false });
  assert.equal(r.voided, true);
  assert.equal(r.kind, 'rejectedOrExpired');
  assert.match(r.note, /거부되었거나.*자동실효/);
});

test('classifyPriorOrderStatus: filledQty=0인데 remainingQty>0(아직 살아있음)이면 여전히 voided=false — 위 분기와 안 헷갈려야 함', () => {
  const r = classifyPriorOrderStatus({ fullyFilled: false, filledQty: 0, remainingQty: 10, canceled: false });
  assert.equal(r.voided, false);
  assert.equal(r.kind, 'unfilled');
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

// [실사고 재현, 2026-09-22] rejectedOrExpired는 취소시도·holdings 조회 둘 다 없이
// 바로 voided=true — 2026-09-22 SK텔레콤 건의 실제 KIS 원본 응답값(체결 0·잔여 0·
// cncl_yn 빈값)을 그대로 넣어 confirmPriorOrderVoided 전체 경로로 검증.
test('confirmPriorOrderVoided: 거부/자동실효(체결·잔여 모두 0) → 취소시도·holdings 조회 없이 바로 voided=true', async () => {
  let reviseCalled = false, balanceCalled = false;
  const r = await confirmPriorOrderVoided({
    token: 't', appkey: 'k', appsecret: 's', cano: 'c', acntPrdtCd: '01', code: '017670',
    afterHoursOrderNo: '0018416600', afterHoursOrgNo: '91257', afterHoursOrderQty: 1, signalDate: '2026-09-21',
    allowCancel: true,
    checkOrderFillImpl: async () => ({
      orderNo: '0018416600', orderQty: 1, filledQty: 0, remainingQty: 0, avgFillPrice: 0, canceled: false, fullyFilled: false,
    }),
    reviseKrOrderImpl: async () => { reviseCalled = true; return { orderNo: '9' }; },
    getAccountBalanceImpl: async () => { balanceCalled = true; return { holdings: [], cash: 0 }; },
  });
  assert.equal(r.voided, true);
  assert.equal(r.kind, 'rejectedOrExpired');
  assert.equal(reviseCalled, false, '이미 죽은 주문에 취소요청을 또 보내면 안 됨');
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
test('confirmPriorOrderVoided: allowCancel:true여도 partial/fullyFilled/canceled/rejectedOrExpired는 취소시도 안 함', async () => {
  for (const result of [
    { fullyFilled: false, filledQty: 3, canceled: false }, // partial
    { fullyFilled: true, avgFillPrice: 71000 }, // fullyFilled
    { canceled: true }, // canceled
    { fullyFilled: false, filledQty: 0, remainingQty: 0, canceled: false }, // rejectedOrExpired(2026-09-22 실사고) — 이미 죽어있어 취소할 게 없음
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
  // note는 notify()를 거쳐 오너에게 직접 나갈 수 있어(place-breakout-fallback-entry.mjs
  // "수동확인 필요" 알림 경로) 2026-09-20부터 원본 에러 텍스트(e.message)를 담지 않는다
  // — 상세는 console.error로만 남긴다(오너 DevRequest, 공통규칙 0). 부재 확인만으론
  // note가 통째로 비어도 통과하므로(독립 코드리뷰 LOW 지적), 실제로 남아야 할 안전한
  // 문구까지 정확히 일치시켜 검증한다.
  assert.equal(r.note, '전날 주문이 아직 미체결 상태로 남아있는 것으로 확인됨(자동실효 가정이 틀렸을 가능성) — 폴백 보류 — 취소시도 실패');
  assert.doesNotMatch(r.note, /이미 체결된 주문입니다/);
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

// [CRITICAL 재발방지] 2026-09-19 코드리뷰 — 폴백 다리(watch-breakout-entry-fill.mjs
// 재스폰)에 stopLossPct가 안 실리면 장후시간외 미체결→다음날시가 폴백 경로에서
// 손절폭이 소실돼, 4%로 사이징(2배 투입)된 포지션에 8% 손절이 걸리는 사고로
// 이어진다(실제 리스크가 Max2%룰의 2배). place-breakout-entry-order.mjs의
// buildWatchArgs --org-no 가드와 정확히 같은 이유·같은 형태.
test('buildFallbackWatchArgs: stopLossPct가 --stop-loss-pct로 실림', () => {
  const args = buildFallbackWatchArgs({
    order: { orderNo: '9' }, code: '055550', name: '신한지주', entryDate: '2026-09-21', stopLossPct: 0.04,
  });
  assert.ok(args.includes('--stop-loss-pct=0.04'), args.join(' '));
  assert.ok(args.includes('--order-no=9'), args.join(' '));
});

test('buildFallbackWatchArgs: stopLossPct 없음(과거 대기항목 레코드) → STOP_LOSS_PCT(0.08)로 폴백', () => {
  const args = buildFallbackWatchArgs({
    order: { orderNo: '9' }, code: '055550', name: '신한지주', entryDate: '2026-09-21', stopLossPct: undefined,
  });
  assert.ok(args.includes('--stop-loss-pct=0.08'), args.join(' '));
});

function makeFallbackEntry(overrides = {}) {
  const signalDate = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const record = buildPendingEntryRecord({
    code: '055550', name: '신한지주', signalDate, investedWon: 25_000,
    afterHoursOrderNo: 'prior-1', afterHoursOrgNo: 'org-1', afterHoursOrderQty: 2,
    stopLossPct: 0.04,
  });
  return { ...record, ...parsePendingEntry(record.content), ...overrides };
}

function makeFallbackHarness({ state = { remainingCash: 20_000, remainingSlots: 2 }, ctx = {}, deps = {}, dir = '/not-a-real-dir' } = {}) {
  const calls = [];
  const child = {
    on: (event, listener) => { calls.push(['on', event, listener]); return child; },
    unref: () => { calls.push(['unref']); },
  };
  const defaultDeps = {
    notify: async (tag, body) => { calls.push(['notify', tag, body]); },
    writeAtomic: (path, content) => { calls.push(['write', path, parsePendingEntry(content)]); },
    getKrQuote: async (params) => { calls.push(['quote', params]); return { price: 10_000 }; },
    readKillSwitch: () => { calls.push(['kill']); return { content: null, readFailed: false }; },
    confirmPriorOrderVoided: async (params) => {
      calls.push(['confirm', params]);
      return { voided: true, kind: 'rejectedOrExpired', note: '자동실효 확인' };
    },
    placeKrOrder: async (params) => { calls.push(['place', params]); return { orderNo: 'new-1' }; },
    todayKST: () => { calls.push(['today']); return '2026-10-02'; },
    spawn: (command, args, options) => { calls.push(['spawn', command, args, options]); return child; },
  };
  return {
    calls, state, dir, ctx: { token: 'token', appkey: 'key', appsecret: 'secret', cano: 'cano', acntPrdtCd: '01', here: '/fake/jobs', ...ctx },
    deps: { ...defaultDeps, ...deps },
  };
}

async function runFallback(harness, entry = makeFallbackEntry()) {
  return processFallbackEntry({ entry, state: harness.state, dir: harness.dir, ctx: harness.ctx, deps: harness.deps });
}

function callNames(calls) {
  return calls.map(([name]) => name);
}

test('processFallbackEntry: 정상 주문은 전날 주문 확인 → placing → 매수 → placed → 감시 순서이며 state를 차감한다', async () => {
  const h = makeFallbackHarness();
  const entry = makeFallbackEntry();
  assert.equal(await runFallback(h, entry), undefined);
  assert.deepEqual(callNames(h.calls), ['quote', 'kill', 'confirm', 'write', 'place', 'today', 'write', 'spawn', 'on', 'unref']);
  assert.deepEqual(h.calls[0][1], { token: 'token', appkey: 'key', appsecret: 'secret', code: entry.code });
  assert.deepEqual(h.calls[2][1], {
    token: 'token', appkey: 'key', appsecret: 'secret', cano: 'cano', acntPrdtCd: '01',
    code: entry.code, afterHoursOrderNo: 'prior-1', afterHoursOrgNo: 'org-1', afterHoursOrderQty: 2,
    signalDate: entry.signalDate, allowCancel: true,
  });
  assert.equal(h.calls[3][1], join('/not-a-real-dir', entry.filename));
  assert.equal(h.calls[3][2].status, 'placing');
  assert.deepEqual(h.calls[4][1], {
    token: 'token', appkey: 'key', appsecret: 'secret', cano: 'cano', acntPrdtCd: '01',
    code: entry.code, side: '매수', quantity: 2, marketOrder: true,
  });
  assert.equal(h.calls[6][2].status, 'placed');
  assert.equal(h.calls[6][2].expectedPositionId, '055550-2026-10-02');
  assert.deepEqual(h.calls[7].slice(1), [
    'node',
    [join('/fake/jobs', '..', 'tools', 'watch-breakout-entry-fill.mjs'),
      ...buildFallbackWatchArgs({ order: { orderNo: 'new-1' }, code: entry.code, name: entry.name, entryDate: '2026-10-02', stopLossPct: entry.stopLossPct })],
    { detached: true, stdio: 'ignore' },
  ]);
  assert.deepEqual(h.state, { remainingCash: 0, remainingSlots: 1 });
});

test('processFallbackEntry: 전날 주문 생사 미확인은 uncertain만 기록하고 주문하지 않는다', async () => {
  const h = makeFallbackHarness();
  const { calls } = h;
  h.deps.confirmPriorOrderVoided = async (params) => {
    calls.push(['confirm', params]);
    return { voided: false, kind: 'unfilled', note: '전날 주문 상태 미확인' };
  };
  const entry = makeFallbackEntry();
  await runFallback(h, entry);
  assert.deepEqual(callNames(h.calls), ['quote', 'kill', 'confirm', 'write', 'notify']);
  assert.equal(h.calls[3][1], join('/not-a-real-dir', entry.filename));
  assert.equal(h.calls[3][2].status, 'uncertain');
  assert.equal(h.calls[3][2].reason, '전날 주문 상태 미확인');
  assert.equal(h.calls[4][1], '경고');
  assert.match(h.calls[4][2], /수동확인 필요/);
  assert.deepEqual(h.state, { remainingCash: 20_000, remainingSlots: 2 });
});

test('processFallbackEntry: 킬스위치 활성과 읽기 실패는 취소 확인 전에 멈춘다', async () => {
  for (const [killState, expectedTag] of [
    [{ content: '---\nactive: true\n---\n', readFailed: false }, '스킵'],
    [{ content: null, readFailed: true, error: new Error('접근 실패') }, '경고'],
  ]) {
    const h = makeFallbackHarness();
    const { calls } = h;
    h.deps.readKillSwitch = () => { calls.push(['kill']); return killState; };
    await runFallback(h);
    assert.deepEqual(callNames(calls), ['quote', 'kill', 'notify']);
    assert.equal(calls[2][1], expectedTag);
    assert.deepEqual(h.state, { remainingCash: 20_000, remainingSlots: 2 });
  }
});

test('processFallbackEntry: 현재가 실패·수량 0·슬롯 소진·신호일 만료는 전날 주문 확인 전에 멈춘다', async () => {
  const cases = [
    { label: '현재가 실패', harness: () => makeFallbackHarness(), quoteFailure: true, names: ['quote', 'notify'], tag: '경고', message: /현재가 조회 실패/ },
    { label: '수량 0', harness: () => makeFallbackHarness({ state: { remainingCash: 5_000, remainingSlots: 2 } }), names: ['quote', 'write', 'notify'], tag: '스킵', message: /가용 예수금/, status: 'failed' },
    { label: '슬롯 소진', harness: () => makeFallbackHarness({ state: { remainingCash: 20_000, remainingSlots: 0 } }), names: ['notify'], tag: '스킵', message: /슬롯 소진/ },
    { label: '신호일 만료', harness: () => makeFallbackHarness(), entry: () => makeFallbackEntry({ signalDate: '2000-01-01' }), names: ['write', 'notify'], tag: '경고', message: /신호일 만료/, status: 'expired' },
  ];
  for (const c of cases) {
    const h = c.harness();
    if (c.quoteFailure) {
      const { calls } = h;
      h.deps.getKrQuote = async (params) => { calls.push(['quote', params]); throw new Error(`시세 실패 ${params.code}`); };
    }
    const before = { ...h.state };
    await runFallback(h, c.entry?.() ?? makeFallbackEntry());
    assert.deepEqual(callNames(h.calls), c.names, c.label);
    const notifyCall = h.calls.find(([name]) => name === 'notify');
    assert.equal(notifyCall[1], c.tag, c.label);
    assert.match(notifyCall[2], c.message, c.label);
    if (c.status) assert.equal(h.calls.find(([name]) => name === 'write')[2].status, c.status, c.label);
    assert.deepEqual(h.state, before, c.label);
  }
});

test('processFallbackEntry: 슬롯이 소진돼도 신호일 만료를 먼저 기록한다', async () => {
  const h = makeFallbackHarness({ state: { remainingCash: 20_000, remainingSlots: 0 } });
  const entry = makeFallbackEntry({ signalDate: '2000-01-01' });
  const before = { ...h.state };
  await runFallback(h, entry);
  assert.deepEqual(callNames(h.calls), ['write', 'notify']);
  assert.equal(h.calls[0][2].status, 'expired');
  assert.equal(h.calls[1][1], '경고');
  assert.match(h.calls[1][2], /신호일 만료/);
  assert.doesNotMatch(h.calls[1][2], /슬롯 소진/);
  assert.deepEqual(h.state, before);
});

test('processFallbackEntry: 직접 취소한 전날 주문은 완료 알림 후 placing 사유에 기록하고 매수한다', async () => {
  const h = makeFallbackHarness();
  const { calls } = h;
  h.deps.confirmPriorOrderVoided = async (params) => {
    calls.push(['confirm', params]);
    return { voided: true, kind: 'canceledByUs', note: '전날 주문 직접 취소' };
  };
  await runFallback(h);
  assert.deepEqual(callNames(calls), ['quote', 'kill', 'confirm', 'notify', 'write', 'place', 'today', 'write', 'spawn', 'on', 'unref']);
  assert.equal(calls[3][1], '완료');
  assert.equal(calls[4][2].reason, '전날 주문 직접 취소');
  assert.equal(calls[7][2].reason, '전날 주문 직접 취소');
  assert.equal(calls[5][1].side, '매수');
});

test('processFallbackEntry: 주문 실패는 확실한 미접수만 failed, 응답 불명은 uncertain으로 기록한다', async () => {
  for (const [confirmedNotSent, status] of [[true, 'failed'], [false, 'uncertain']]) {
    const h = makeFallbackHarness();
    const { calls } = h;
    h.deps.placeKrOrder = async (params) => {
      calls.push(['place', params]);
      const error = new Error('주문 실패');
      if (confirmedNotSent) error.confirmedNotSent = true;
      throw error;
    };
    await runFallback(h);
    assert.deepEqual(callNames(h.calls), ['quote', 'kill', 'confirm', 'write', 'place', 'write', 'notify']);
    assert.equal(h.calls[3][2].status, 'placing');
    assert.equal(h.calls[5][2].status, status);
    assert.equal(h.calls[6][1], '경고');
    assert.deepEqual(h.state, { remainingCash: 20_000, remainingSlots: 2 });
  }
});

test('processFallbackEntry: 동일 state의 현금 차감은 다음 건의 수량 0 판정에 반영된다', async () => {
  const h = makeFallbackHarness();
  await runFallback(h);
  await runFallback(h, makeFallbackEntry({ id: 'second', filename: 'second.md' }));
  assert.deepEqual(callNames(h.calls), ['quote', 'kill', 'confirm', 'write', 'place', 'today', 'write', 'spawn', 'on', 'unref', 'quote', 'write', 'notify']);
  assert.equal(h.calls[11][2].status, 'failed');
  assert.equal(h.calls[12][1], '스킵');
  assert.deepEqual(h.state, { remainingCash: 0, remainingSlots: 1 });
});

test('processFallbackEntry: 동일 state의 슬롯 차감은 다음 건의 슬롯 게이트에 반영된다', async () => {
  const h = makeFallbackHarness({ state: { remainingCash: 20_000, remainingSlots: 1 } });
  await runFallback(h);
  await runFallback(h, makeFallbackEntry({ id: 'second', filename: 'second.md' }));
  assert.deepEqual(callNames(h.calls), ['quote', 'kill', 'confirm', 'write', 'place', 'today', 'write', 'spawn', 'on', 'unref', 'notify']);
  assert.equal(h.calls[10][1], '스킵');
  assert.deepEqual(h.state, { remainingCash: 0, remainingSlots: 0 });
});

test('processFallbackEntry: 의존성·state·ctx 배선 오류는 어떤 부작용보다 먼저 거부한다', async () => {
  for (const invalid of [
    (h) => { delete h.deps.placeKrOrder; },
    (h) => { h.state.remainingCash = NaN; },
    (h) => { h.ctx.here = 42; },
    (h) => { h.ctx.token = undefined; },
    (h) => { h.ctx.cano = ''; },
    (h) => { delete h.dir; },
  ]) {
    const h = makeFallbackHarness();
    invalid(h);
    await assert.rejects(runFallback(h), /배선 오류로 주문 전에 중단/);
    assert.deepEqual(h.calls, []);
  }
});
