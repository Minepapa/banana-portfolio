import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  coerceEnum, extractSignal, mentionedNames, unknownMentions, claimViolations,
  claimViolationsInDoc, clampLen, filterObservations, SIGNAL_EMOJI, CONFIDENCE,
  extractPercentages, collectFactPercentages, numericClaimViolations,
} from './llm-guard.mjs';

test('coerceEnum: 정확값 통과·변형 흡수·목록밖은 fallback+coerced', () => {
  const a = coerceEnum('높음', CONFIDENCE, '보통');
  assert.deepEqual(a, { value: '높음', coerced: false });
  const b = coerceEnum('신뢰도 높음이라고 봄', CONFIDENCE, '보통');
  assert.equal(b.value, '높음'); assert.equal(b.coerced, true);
  const c = coerceEnum('완전확신', CONFIDENCE, '보통');
  assert.deepEqual(c, { value: '보통', coerced: true });
});

test('extractSignal: 이모지 추출·변형 흡수·불명은 null', () => {
  assert.equal(extractSignal('🟡'), '🟡');
  assert.equal(extractSignal('🟡 주의'), '🟡');
  assert.equal(extractSignal('주의'), null);
  assert.equal(extractSignal(''), null);
  assert.equal(extractSignal(null), null);
  for (const e of SIGNAL_EMOJI) assert.equal(extractSignal(e), e);
});

test('mentionedNames: 부분문자열 충돌 방지(삼성전자우 vs 삼성전자)', () => {
  const universe = ['삼성전자', '삼성전자우'];
  assert.deepEqual(mentionedNames('삼성전자우 매수', universe), ['삼성전자우']);
  assert.deepEqual(mentionedNames('삼성전자 매수', universe).sort(), ['삼성전자']);
  const both = mentionedNames('삼성전자와 삼성전자우 둘 다', universe).sort();
  assert.deepEqual(both, ['삼성전자', '삼성전자우']);
});

test('unknownMentions: 사실 텍스트에 없는 종목 인용 탐지', () => {
  const universe = ['SK하이닉스', '현대차'];
  assert.deepEqual(unknownMentions('SK하이닉스 매수', universe, ['SK하이닉스']), []);
  assert.deepEqual(unknownMentions('현대차 매수', universe, ['SK하이닉스']), ['현대차']);
});

test('claimViolations: 사고 회귀 — "논리훼손(B) 종목(SK하이닉스)" + B🔴 목록에 없음 → 위반', () => {
  const universe = ['SK하이닉스', '현대차'];
  const claimRe = /논리\s*훼손|B\s*신호/;
  const text = '🔴 논리훼손(B) 종목(SK하이닉스)에 대규모 매수 후 미매도 지속';
  assert.deepEqual(claimViolations(text, claimRe, universe, []), ['SK하이닉스']);
  // 실제 B🔴 종목이면 위반 아님
  assert.deepEqual(claimViolations(text, claimRe, universe, ['SK하이닉스']), []);
  // 주장 자체가 없으면(claimRe 미매치) 검사 안 함
  assert.deepEqual(claimViolations('SK하이닉스 급락 매수', claimRe, universe, []), []);
});

test('claimViolationsInDoc: 사고 회귀 — "논리 훼손 없음"(부정문)은 문서 전체를 오염시키지 않음', () => {
  // 2026-07-26 실사고 재현: claimViolations(문서 전체)를 그대로 쓰면 이 한 줄 때문에
  // 무관한 다른 줄의 종목명(테슬라 등)까지 전부 위반으로 잡혔다.
  const universe = ['SK하이닉스', '삼성전자', '테슬라'];
  const doc = [
    '## 국내주식',
    '삼성전자·SK하이닉스 논리 훼손 없음 — 저비중 구간',
    '## 해외주식',
    '테슬라 급락 매수 창구 열림, 논리(B) 🟢 유지',
  ].join('\n');
  assert.deepEqual(claimViolationsInDoc(doc, /논리\s*훼손/, universe, []), []);
});

test('claimViolationsInDoc: 실제 위반(부정문 아님)은 여전히 잡힘, 같은 줄 종목만', () => {
  const universe = ['SK하이닉스', '삼성전자', '테슬라'];
  const doc = [
    '삼성전자는 정상.',
    '🔴 논리훼손(B) 종목(SK하이닉스)에 대규모 매수 후 미매도 지속',
    '테슬라는 급락매수 트리거 발동',
  ].join('\n');
  // SK하이닉스가 실제 B🔴 목록에 없으면 위반, 다른 줄의 삼성전자·테슬라는 안 섞임
  assert.deepEqual(claimViolationsInDoc(doc, /논리\s*훼손/, universe, []), ['SK하이닉스']);
  assert.deepEqual(claimViolationsInDoc(doc, /논리\s*훼손/, universe, ['SK하이닉스']), []);
});

test('claimViolationsInDoc: "~이 아니다" 부정형도 제외', () => {
  const universe = ['현대차'];
  const doc = '하락의 주범은 국내주식이며 이는 시장 리스크지 현대차 개별 논리 훼손이 아니다.';
  assert.deepEqual(claimViolationsInDoc(doc, /논리\s*훼손/, universe, []), []);
});

test('claimViolationsInDoc: claimRe 매치 없으면 빈 배열', () => {
  assert.deepEqual(claimViolationsInDoc('SK하이닉스 급락 매수', /논리\s*훼손/, ['SK하이닉스'], []), []);
});

test('claimViolationsInDoc: 한 줄에 부정+긍정 섞이면 진짜 주장(SK하이닉스)을 놓치지 않음(코드리뷰 지적 회귀) — 같은 줄의 부정 대상(삼성전자)까지 함께 잡히는 건 과잉 경보 쪽으로 허용된 트레이드오프', () => {
  const universe = ['삼성전자', 'SK하이닉스'];
  const doc = '삼성전자 논리 훼손 없음, 그리고 SK하이닉스 논리 훼손 발생';
  const result = claimViolationsInDoc(doc, /논리\s*훼손/, universe, []);
  // 핵심 회귀 대상: 뒤쪽 진짜 주장(SK하이닉스)을 절대 놓치면 안 됨(줄 단위 첫 매치만 보던
  // 이전 버전은 이걸 놓쳤다 — false negative, 안전망 무력화).
  assert.ok(result.includes('SK하이닉스'));
});

test('claimViolationsInDoc: "없으며"·"없었다"·"없고"·"없는" 등 부정 활용형도 제외(코드리뷰 지적 회귀)', () => {
  const universe = ['삼성전자'];
  for (const suffix of ['없으며', '없었다', '없고', '없는 상태']) {
    const doc = `삼성전자 논리 훼손 ${suffix}`;
    assert.deepEqual(claimViolationsInDoc(doc, /논리\s*훼손/, universe, []), [], `실패: ${suffix}`);
  }
});

test('claimViolationsInDoc: claimRe에 g 플래그가 있어도 안전(lastIndex 공유 버그 방지)', () => {
  const universe = ['SK하이닉스'];
  const globalRe = /논리\s*훼손/g;
  const doc = '🔴 논리훼손(B) 종목(SK하이닉스)에 대규모 매수 후 미매도 지속';
  // 같은 g 정규식으로 두 번 호출해도 결과가 매번 동일해야 함(lastIndex가 안 남아야 함)
  assert.deepEqual(claimViolationsInDoc(doc, globalRe, universe, []), ['SK하이닉스']);
  assert.deepEqual(claimViolationsInDoc(doc, globalRe, universe, []), ['SK하이닉스']);
});

test('clampLen: 길이 제한 + 말줄임', () => {
  assert.equal(clampLen('짧은글', 10), '짧은글');
  assert.equal(clampLen('12345678901234567890', 10), '123456789…');
});

test('filterObservations: enum 보정·엔티티 DROP·주장 DROP·중복 DROP·최대건수', () => {
  const universe = ['SK하이닉스', '현대차', '삼성전자'];
  const factsText = '■ 이번 주 매수\n  - 2026-07-09 삼성전자 5주\n■ 1회 500만 원칙: 위반 1건 (SK하이닉스)';
  const claimAllowed = []; // 이번 주 B🔴 종목 없음(사고 재현)

  const observations = [
    // ① 사고 재현 — SK하이닉스에 대한 논리훼손 주장, B🔴 아님 → DROP
    { type: '매수 규율', observation: '🔴 논리훼손(B) 종목(SK하이닉스)에 대규모 매수 후 미매도',
      evidence: 'SK하이닉스 500만 위반', confidence: '높음', vsProfile: '상충' },
    // ② 정상 — factsText에 실존하는 삼성전자만 언급, 훼손 주장 없음 → kept
    { type: '매수 타이밍', observation: '삼성전자 정기 매수 지속', evidence: '2026-07-09 삼성전자 5주',
      confidence: '신뢰도 높음', vsProfile: '일치' },
    // ③ 사실 텍스트에 없는 종목(현대차) 언급 → DROP
    { type: '매도 타이밍', observation: '현대차 매도 회피', evidence: '현대차 미매도',
      confidence: '보통', vsProfile: '신규' },
  ];

  const { kept, dropped } = filterObservations(observations, {
    universe, factsText, claimAllowed, priorTexts: [], maxRows: 3,
  });

  assert.equal(kept.length, 1);
  assert.equal(kept[0].observation, '삼성전자 정기 매수 지속');
  assert.equal(kept[0].confidence, '높음');   // 변형 흡수 확인
  assert.equal(kept[0].vsProfile, '일치(보강)');

  assert.equal(dropped.length, 2);
  assert.match(dropped[0].reason, /논리훼손 주장 불일치/);
  assert.match(dropped[1].reason, /사실 텍스트에 없는 종목/);
});

test('filterObservations: 기존 관찰과 중복이면 DROP', () => {
  const universe = ['삼성전자'];
  const factsText = '삼성전자 5주 매수';
  const observations = [
    { observation: '삼성전자 정기 매수 지속', evidence: '', confidence: '보통', vsProfile: '신규' },
  ];
  const { kept, dropped } = filterObservations(observations, {
    universe, factsText, priorTexts: ['삼성전자 정기 매수 지속'],
  });
  assert.equal(kept.length, 0);
  assert.equal(dropped.length, 1);
  assert.match(dropped[0].reason, /중복/);
});

test('filterObservations: 최대 건수 초과분은 DROP', () => {
  const universe = ['삼성전자'];
  const factsText = '삼성전자 매수';
  const observations = Array.from({ length: 5 }, (_, i) => ({
    observation: `관찰 ${i}`, evidence: '삼성전자', confidence: '보통', vsProfile: '신규',
  }));
  const { kept, dropped } = filterObservations(observations, { universe, factsText, maxRows: 3 });
  assert.equal(kept.length, 3);
  assert.equal(dropped.length, 2);
});

// ── 수치 주장 검증(2026-09-06 신설) — weekly-report "가장 큰 변화" facts 불일치
// 사고(Log/DevRequests/2026-09-06-weekly-report-facts-불일치-버그.md) 회귀 방지 ──

test('extractPercentages: 부호·소수 보존, 여러 개 추출', () => {
  assert.deepEqual(extractPercentages('WTI +9.7% 급등, KOSDAQ -3.0% 하락'), [9.7, -3.0]);
});

test('extractPercentages: 퍼센트 없으면 빈 배열', () => {
  assert.deepEqual(extractPercentages('이번 주 특이사항 없음'), []);
});

test('collectFactPercentages: macro·holdings·assetClasses·weekTrades 전부 수집', () => {
  const facts = {
    macro: { KOSDAQ: { change5d: -5.66 }, WTI: { change5d: 2.1 }, VIX: { change5d: null } },
    holdings: [{ totalReturnPct: 12.3 }, { totalReturnPct: null }],
    assetClasses: [{ weightPct: 30.5 }],
    weekTrades: [{ realizedPct: -8.2 }, { realizedPct: null }],
  };
  const nums = collectFactPercentages(facts);
  assert.deepEqual(nums.sort((a, b) => a - b), [-8.2, -5.66, 2.1, 12.3, 30.5]);
});

test('[실사고 재현] numericClaimViolations: Themis 실측(KOSDAQ -5.66%)과 다른 weekly-report 서술(-3.0%, WTI +9.7%)을 위반으로 잡음', () => {
  const facts = { macro: { KOSDAQ: { change5d: -5.66 }, NASDAQ: { change5d: 0.4 } } };
  const bullet = '**가장 큰 변화**: WTI +9.7% 급등 — 에너지 인플레이션 재점화 경계, KOSPI -1.5%·KOSDAQ -3.0%로 국내 시장 추가 약세';
  const violations = numericClaimViolations(bullet, collectFactPercentages(facts));
  // KOSDAQ -3.0%는 실제(-5.66%)와 tolerance(0.5) 밖 → 위반. WTI 9.7%·KOSPI -1.5%는
  // facts에 그 항목 자체가 없어(위 macro엔 KOSDAQ·NASDAQ만 있음) 역시 위반.
  assert.ok(violations.includes(9.7));
  assert.ok(violations.includes(-1.5));
  assert.ok(violations.includes(-3.0));
});

test('numericClaimViolations: facts와 정확히 일치하는 퍼센트는 위반 아님', () => {
  const facts = { macro: { KOSDAQ: { change5d: -5.66 } } };
  const bullet = '**가장 큰 변화**: KOSDAQ 5일 -5.66% 하락';
  assert.deepEqual(numericClaimViolations(bullet, collectFactPercentages(facts)), []);
});

test('numericClaimViolations: tolerance 이내 반올림 표기는 위반 아님', () => {
  const facts = { macro: { KOSDAQ: { change5d: -5.66 } } };
  const bullet = 'KOSDAQ 5일 -5.7% 하락(반올림 표기)';
  assert.deepEqual(numericClaimViolations(bullet, collectFactPercentages(facts)), []);
});

test('numericClaimViolations: tolerance 밖으로 벗어난 값은 위반', () => {
  const facts = { macro: { KOSDAQ: { change5d: -5.66 } } };
  const bullet = 'KOSDAQ 5일 -7% 하락'; // 실제(-5.66)와 1.34%p 차이 — tolerance(0.5) 밖
  assert.deepEqual(numericClaimViolations(bullet, collectFactPercentages(facts)), [-7]);
});

test('numericClaimViolations: 허용 퍼센트가 비어있으면 언급된 모든 퍼센트가 위반', () => {
  assert.deepEqual(numericClaimViolations('알 수 없는 근거로 +10% 상승', []), [10]);
});
