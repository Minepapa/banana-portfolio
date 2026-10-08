import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyRequest } from './route-keywords.mjs';

test('투자·장부·거시·리포트는 플루토스', () => {
  for (const prompt of ['엔비디아 평가해줘', '삼성전자 매수 어때', '지금 매도할까', '리밸런싱안 줘', '큐 비워줘', '주문서 짜줘', '예수금 확인해줘', '체결 기록됐어?', '배당 얼마 들어왔어', '환율 괜찮아?', 'VIX 지금 어때', '주간 리포트 보여줘', 'KPI 어떻게 됐어', '돌파매매 신호', '퀀트 포지션']) {
    const result = classifyRequest(prompt);
    assert.equal(result.delegate, true, prompt);
    assert.equal(result.dept, 'plutus', prompt);
  }
});

test('제안 검증은 테미스', () => {
  for (const prompt of ['이 제안 검증해줘', '논리 아직 유효해?', '차단해제 검증']) {
    assert.equal(classifyRequest(prompt).dept, 'themis', prompt);
  }
});

test('미네는 아테나, 투자 질문은 아테나로 가지 않는다', () => {
  assert.equal(classifyRequest('미네 사진 기록해줘').dept, 'athena');
  assert.equal(classifyRequest('딸 미네 일정 확인').dept, 'athena');
  assert.equal(classifyRequest('투자 리밸런싱').dept, 'plutus');
  assert.equal(classifyRequest('미네 교육비 투자 어떻게 할까').dept, 'plutus');
  assert.equal(classifyRequest('딸 미네 교육비 투자 어떻게 할까').dept, 'plutus');
  assert.equal(classifyRequest('딸 계좌 리밸런싱안 줘').dept, 'plutus');
});

test('일정·할 일·리마인더는 헤르메스, 기록·볼트·성향은 클리오', () => {
  for (const prompt of ['일정 확인해줘', '할 일 알려줘', '리마인더 설정']) assert.equal(classifyRequest(prompt).dept, 'hermes', prompt);
  for (const prompt of ['볼트 정합 확인', '내 성향 어때', '지난 기록 찾아줘']) assert.equal(classifyRequest(prompt).dept, 'clio', prompt);
});

test('비업무와 이미 위임 중인 요청은 훅이 통과시킨다', () => {
  for (const prompt of ['오늘 날씨 어때', '이 함수 리팩터해줘', '깃 상태 보여줘', '안녕', '', '바베큐 맛집 추천', '/plutus 리밸런싱']) {
    assert.equal(classifyRequest(prompt).delegate, false, prompt);
  }
  for (const bad of [null, undefined, 123, {}, []]) assert.equal(classifyRequest(bad).delegate, false);
});
