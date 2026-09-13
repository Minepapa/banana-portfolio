import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyPriorOrderStatus } from './place-breakout-fallback-entry.mjs';

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
