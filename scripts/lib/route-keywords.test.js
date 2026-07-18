import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyRequest } from './route-keywords.mjs';

// classifyRequest(prompt) → { delegate, dept, matched }
// 목적: UserPromptSubmit 훅이 "이 요청은 부서 위임 대상인가"를 결정론으로 판정.
// 완벽한 부서 선택이 아니라 "위임 여부 + 1차 추정 부서"만 책임진다(최종 라우팅은 Zeus).

test('투자전략실 키워드 — 평가/매수/매도/리밸런싱/큐/주문', () => {
  for (const p of ['엔비디아 평가해줘', '삼성전자 매수 어때', '지금 매도할까', '리밸런싱안 줘', '큐 비워줘', '주문서 짜줘']) {
    const r = classifyRequest(p);
    assert.equal(r.delegate, true, `"${p}" 는 위임 대상`);
    assert.equal(r.dept, 'athena', `"${p}" → athena`);
    assert.ok(r.matched.length > 0);
  }
});

test('리스크관리실 키워드 — 위험/리스크/검증/환율/금리/VIX', () => {
  for (const p of ['지금 위험한 거 없나', '이 논리 아직 유효해?', '이 제안 검증해줘', '환율 괜찮아?', 'VIX 지금 어때']) {
    const r = classifyRequest(p);
    assert.equal(r.delegate, true, `"${p}" 위임`);
    assert.equal(r.dept, 'themis', `"${p}" → themis`);
  }
});

test('운영실 키워드 — 예수금/체결/시트 정합/배당/잡 상태', () => {
  for (const p of ['예수금 확인해줘', '체결 기록됐어?', '시트 정합 확인', '배당 얼마 들어왔어', '잡 상태 어때']) {
    const r = classifyRequest(p);
    assert.equal(r.delegate, true, `"${p}" 위임`);
    assert.equal(r.dept, 'hermes', `"${p}" → hermes`);
  }
});

test('비서실 키워드 — 리포트/KPI/성향/이번 주', () => {
  for (const p of ['이번 주 어때', '주간 리포트 보여줘', 'KPI 어떻게 됐어', '내 성향 어때']) {
    const r = classifyRequest(p);
    assert.equal(r.delegate, true, `"${p}" 위임`);
    assert.equal(r.dept, 'apollo', `"${p}" → apollo`);
  }
});

test('비투자 요청 — 위임 안 함', () => {
  // '큐' 단일문자 오발 회귀 방지(리뷰 지적): 바베큐·큐레이션은 투자 아님
  for (const p of ['오늘 날씨 어때', '이 함수 리팩터해줘', '깃 상태 보여줘', '안녕', '', '바베큐 맛집 추천', '큐레이션 기능 구현']) {
    const r = classifyRequest(p);
    assert.equal(r.delegate, false, `"${p}" 는 위임 대상 아님`);
    assert.equal(r.dept, null);
    assert.deepEqual(r.matched, []);
  }
});

test('이미 슬래시로 위임 중 — 훅 발화 안 함(중복 방지)', () => {
  for (const p of ['/athena 엔비디아 평가', '/themis 위험 점검', '/hermes 예수금']) {
    const r = classifyRequest(p);
    assert.equal(r.delegate, false, `"${p}" 는 이미 위임 경로 — 중복 리마인드 금지`);
  }
});

test('복수 부서 매칭 — argmax, 동수 시 우선순위(athena>themis>hermes>apollo)', () => {
  // 매수(athena) + 리스크(themis) 동시 — athena 2? 여기선 각 1개씩 동수 → 우선순위 athena
  const r = classifyRequest('이 종목 매수하면서 리스크도 봐줘');
  assert.equal(r.delegate, true);
  assert.equal(r.dept, 'athena');
  // 평가 2회 언급 → athena 확정
  const r2 = classifyRequest('리스크 있어도 평가하고 매수 판단해줘');
  assert.equal(r2.dept, 'athena');
});

test('입력 방어 — null/비문자열도 안전', () => {
  for (const bad of [null, undefined, 123, {}, []]) {
    const r = classifyRequest(bad);
    assert.equal(r.delegate, false);
    assert.equal(r.dept, null);
  }
});
