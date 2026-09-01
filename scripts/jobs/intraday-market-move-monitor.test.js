import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyTier, buildMoveFacts, buildThemisPrompt, splitOffConsultation,
  parseConsultationRequest, buildConsultationPrompt, buildFinalSynthesisPrompt, shouldAlert,
  todayForSignal,
} from './intraday-market-move-monitor.mjs';
import { parseDepartmentResponse } from '../lib/telegram-messages.mjs';

// 2026-09-01 신설 — 텔레그램 메시지 2단계(장중 시장 급변 감시). 순수함수만 테스트
// (KIS 조회·yfinance 서브프로세스·헤드리스 LLM 호출은 main() 내부 IO — 라이브 검증은
// --dry-run + 오너 확인으로 수행).

test('classifyTier: 3단계(t1<t2<t3) 임계값을 정확히 판정', () => {
  const tiers = { t1: 3, t2: 5, t3: 8 };
  assert.equal(classifyTier(2.9, tiers), null);
  assert.equal(classifyTier(3, tiers), '관심');
  assert.equal(classifyTier(4.9, tiers), '관심');
  assert.equal(classifyTier(5, tiers), '경계');
  assert.equal(classifyTier(7.9, tiers), '경계');
  assert.equal(classifyTier(8, tiers), '심각');
  assert.equal(classifyTier(10, tiers), '심각');
});

test('classifyTier: t3 없는 신호(DXY·10Y)는 t2에서 멈춤(정책, 버그 아님)', () => {
  const tiers = { t1: 1, t2: 2 };
  assert.equal(classifyTier(1.5, tiers), '관심');
  assert.equal(classifyTier(2, tiers), '경계');
  assert.equal(classifyTier(100, tiers), '경계');
});

test('classifyTier: 숫자가 아니면(NaN·undefined) null', () => {
  assert.equal(classifyTier(NaN, { t1: 1, t2: 2 }), null);
  assert.equal(classifyTier(undefined, { t1: 1, t2: 2 }), null);
});

test('buildMoveFacts: breach 배열을 "라벨 상세(단계)" 불릿 문자열로', () => {
  const facts = buildMoveFacts([
    { label: '코스피', detailText: '-5.20%(현재 2450.10)', tier: '경계' },
    { label: 'VIX', detailText: '32.5', tier: '관심' },
  ]);
  assert.deepEqual(facts, ['코스피 -5.20%(현재 2450.10)(경계)', 'VIX 32.5(관심)']);
});

test('buildMoveFacts: 빈 배열이면 빈 배열(null/undefined도 안전)', () => {
  assert.deepEqual(buildMoveFacts([]), []);
  assert.deepEqual(buildMoveFacts(undefined), []);
});

test('buildThemisPrompt: 사실 불릿 포함 + 4마커([결론]·[맥락]·[의사결정]·[자문요청]) 지시', () => {
  const prompt = buildThemisPrompt([{ label: '코스피', detailText: '-5.20%', tier: '경계' }]);
  assert.match(prompt, /코스피 -5\.20%\(경계\)/);
  assert.match(prompt, /\[결론\]/);
  assert.match(prompt, /\[맥락\]/);
  assert.match(prompt, /\[의사결정\]/);
  assert.match(prompt, /\[자문요청\]/);
  assert.match(prompt, /아테나.*카이로스.*헤르메스.*아폴로/);
});

test('splitOffConsultation: [자문요청] 마커 이후를 별도 섹션으로 분리하고 본문은 그 앞까지만', () => {
  const text = '[결론]\n지켜볼 단계.\n\n[맥락]\n근거.\n\n[의사결정]\n\n[자문요청]\n아테나\n이유: 리밸런싱 영향';
  const { mainText, consultationText } = splitOffConsultation(text);
  assert.doesNotMatch(mainText, /자문요청/);
  assert.match(mainText, /\[의사결정\]/);
  assert.equal(consultationText, '아테나\n이유: 리밸런싱 영향');
});

test('splitOffConsultation: 마커가 프리앰블 문장 중에만 언급되면(줄 맨 앞 아님) 오인하지 않음', () => {
  const text = '[결론]\n결론입니다.\n\n[맥락]\n요청하신 [자문요청] 여부는 판단했음, 결과는 아래.\n\n[의사결정]\n- 항목1';
  const { mainText, consultationText } = splitOffConsultation(text);
  assert.equal(consultationText, '');
  assert.match(mainText, /요청하신 \[자문요청\] 여부는 판단했음/);
});

test('splitOffConsultation: 마커 자체가 없으면 mainText=원문 그대로, consultationText는 빈 문자열', () => {
  const text = '[결론]\n결론.\n\n[맥락]\n근거.\n\n[의사결정]\n';
  const { mainText, consultationText } = splitOffConsultation(text);
  assert.equal(mainText, text.trim());
  assert.equal(consultationText, '');
});

test('parseConsultationRequest: 정확일치 부서명이면 agentKey·department·reason 추출', () => {
  const r = parseConsultationRequest('아테나\n이유: 리밸런싱 판단에 영향');
  assert.equal(r.department, '아테나');
  assert.equal(r.agentKey, 'athena');
  assert.equal(r.reason, '이유: 리밸런싱 판단에 영향');
});

test('parseConsultationRequest: "없음"이면 자문 없음(agentKey null)', () => {
  const r = parseConsultationRequest('없음');
  assert.equal(r.agentKey, null);
  assert.equal(r.department, null);
});

test('parseConsultationRequest: 오타·모호한 표현은 안전하게 자문 없음으로 폴백', () => {
  assert.equal(parseConsultationRequest('아테나일 수도').agentKey, null);
  assert.equal(parseConsultationRequest('Athena').agentKey, null);
  assert.equal(parseConsultationRequest('').agentKey, null);
  assert.equal(parseConsultationRequest(undefined).agentKey, null);
});

// 2026-09-01 코드리뷰 지적 — 흔한 LLM 장식(불릿·마크다운 볼드·끝맺음 문장부호·괄호
// 설명)만 붙어도 전부 자문 누락으로 떨어지던 걸 실측 재현했다. normalizeDeptToken이
// 이 장식들을 벗겨내되, 진짜 오타·모호한 표현(위 테스트)은 여전히 안 걸러야 한다.
test('parseConsultationRequest: 흔한 LLM 장식(불릿·볼드·마침표·콜론·괄호설명)은 정규화 후 매칭', () => {
  assert.equal(parseConsultationRequest('아테나.').agentKey, 'athena');
  assert.equal(parseConsultationRequest('**아테나**').agentKey, 'athena');
  assert.equal(parseConsultationRequest('아테나 (리밸런싱 영향)').agentKey, 'athena');
  assert.equal(parseConsultationRequest('아테나:').agentKey, 'athena');
  assert.equal(parseConsultationRequest('- 아테나').agentKey, 'athena');
  assert.equal(parseConsultationRequest(' 아테나 ').agentKey, 'athena');
});

test('parseConsultationRequest: rawFirst는 매칭 성공/실패 무관하게 원본 첫 줄을 그대로 반환(관찰가능성)', () => {
  assert.equal(parseConsultationRequest('아테나').rawFirst, '아테나');
  assert.equal(parseConsultationRequest('없음').rawFirst, '없음');
  assert.equal(parseConsultationRequest('아테나일 수도').rawFirst, '아테나일 수도');
  assert.equal(parseConsultationRequest('').rawFirst, null);
});

test('parseConsultationRequest: 4개 부서명 전부 매핑 확인(카이로스·헤르메스·아폴로)', () => {
  assert.equal(parseConsultationRequest('카이로스').agentKey, 'kairos');
  assert.equal(parseConsultationRequest('헤르메스').agentKey, 'hermes');
  assert.equal(parseConsultationRequest('아폴로').agentKey, 'apollo');
});

test('buildConsultationPrompt: 사실·자문 사유를 포함하고 마커 형식 강제하지 않음(자유 서술)', () => {
  const prompt = buildConsultationPrompt([{ label: '코스피', detailText: '-5.20%', tier: '경계' }], '리밸런싱 영향 확인 필요');
  assert.match(prompt, /코스피 -5\.20%\(경계\)/);
  assert.match(prompt, /리밸런싱 영향 확인 필요/);
  assert.doesNotMatch(prompt, /\[결론\]/);
});

test('buildConsultationPrompt: 사유 없으면(reason null) 안내 문구로 대체', () => {
  const prompt = buildConsultationPrompt([{ label: 'VIX', detailText: '32.5', tier: '관심' }], null);
  assert.match(prompt, /사유 미기재/);
});

test('buildFinalSynthesisPrompt: 부서 답변·사실을 포함하고 3마커([결론]·[맥락]·[의사결정]) 지시', () => {
  const prompt = buildFinalSynthesisPrompt(
    [{ label: '코스피', detailText: '-5.20%', tier: '경계' }], '아테나', '리밸런싱 앞당길 필요는 없어 보임',
  );
  assert.match(prompt, /코스피 -5\.20%\(경계\)/);
  assert.match(prompt, /아테나의 답변/);
  assert.match(prompt, /리밸런싱 앞당길 필요는 없어 보임/);
  assert.match(prompt, /\[결론\]/);
  assert.match(prompt, /\[맥락\]/);
  assert.match(prompt, /\[의사결정\]/);
});

test('shouldAlert: tier가 null이면 항상 false(임계 미돌파)', () => {
  assert.equal(shouldAlert({ today: '2026-09-01', tier: null, storedDate: null, storedTier: null }), false);
});

test('shouldAlert: 저장된 기록이 없으면(storedDate null) 발송', () => {
  assert.equal(shouldAlert({ today: '2026-09-01', tier: '관심', storedDate: null, storedTier: null }), true);
});

test('shouldAlert: 날짜가 바뀌면(당일 첫 감지) 같은 단계라도 재발송', () => {
  assert.equal(shouldAlert({ today: '2026-09-02', tier: '관심', storedDate: '2026-09-01', storedTier: '관심' }), true);
});

test('shouldAlert: 같은 날 같은 단계면 재발송 안 함', () => {
  assert.equal(shouldAlert({ today: '2026-09-01', tier: '관심', storedDate: '2026-09-01', storedTier: '관심' }), false);
});

test('shouldAlert: 같은 날 더 낮은 단계로 완화되면 재발송 안 함(악화만 재발송)', () => {
  assert.equal(shouldAlert({ today: '2026-09-01', tier: '관심', storedDate: '2026-09-01', storedTier: '경계' }), false);
});

test('shouldAlert: 같은 날 더 높은 단계로 악화되면 재발송', () => {
  assert.equal(shouldAlert({ today: '2026-09-01', tier: '심각', storedDate: '2026-09-01', storedTier: '경계' }), true);
});

// 2026-09-01 코드리뷰 지적 — yf-macro.py 일봉은 미국장 기준으로 움직이는데 KST
// 날짜로만 dedup하면 KST 자정 전후로 같은 미국 세션을 중복 알림하거나(자정 넘어
// storedDate!==today) 반대로 KR장중에 저장된 어제 미국 종가 때문에 그날 저녁 진짜
// 새 미국 세션 급락이 조용히 억제될 수 있었다(라이브로 재현 확인).
test('todayForSignal: 코스피는 KST, 나머지 5종(yfinance 일봉)은 America/New_York 날짜', () => {
  assert.equal(todayForSignal('KOSPI'), new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date()));
  for (const key of ['SP500', 'VIX', 'DXY', 'USDKRW', 'TNX']) {
    assert.equal(todayForSignal(key), new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date()));
  }
});

// 2026-09-01 코드리뷰 HIGH 지적, 실측 재현 — Call C(재종합) 프롬프트가 [자문요청]
// 재사용을 금지하지 않아 Themis가 다시 그 마커를 붙이는 경우가 실제로 재현됐다.
// splitOffConsultation을 안 거치면 parseDepartmentResponse가 이 마커를 몰라
// [의사결정] 끝까지 그대로 삼켜 "· 리밸런싱 앞당기지 않음 [자문요청] 없음"처럼
// 오염된다(리뷰어가 실제 파서로 재현한 시나리오) — main()이 실제로 하는 두 단계
// (split 후 parse)를 그대로 재현해 오염이 안 남는지 확인한다.
test('[막아야 함] Call C 응답에 [자문요청]이 재등장해도 splitOffConsultation을 먼저 거치면 [의사결정]이 오염되지 않음', () => {
  const synthRaw = '[결론]\n리밸런싱 앞당기지 않음.\n\n[맥락]\n근거.\n\n[의사결정]\n- 리밸런싱 앞당기지 않음\n\n[자문요청]\n없음';
  const { mainText } = splitOffConsultation(synthRaw);
  const { decisions } = parseDepartmentResponse(mainText);
  assert.deepEqual(decisions, ['리밸런싱 앞당기지 않음']);
  assert.ok(!decisions.some((d) => d.includes('자문요청')));
});
