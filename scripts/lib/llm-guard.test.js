import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  coerceEnum, extractSignal, mentionedNames, unknownMentions, claimViolations,
  claimViolationsInDoc, clampLen, filterObservations, SIGNAL_EMOJI, CONFIDENCE,
  extractPercentages, collectFactPercentages, numericClaimViolations, numericClaimViolationsWithLocation,
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
  const factsText = '■ 이번 주 매수\n  - 2026-07-09 삼성전자 5주\n■ 평가 후 매수: 1건 (SK하이닉스)';
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

test('collectFactPercentages: 계좌 수익률·자산군 내 종목 점유율·직전 리포트·프로필 임계값을 수집', () => {
  const facts = {
    accounts: [{ returnPct: 16.8 }, { returnPct: null }],
    holdings: [
      { type: '채권', evalValue: 8000000 },
      { type: '현금', evalValue: 1000000 },
      { type: '미매칭', evalValue: 500000 },
    ],
    assetClasses: [
      { type: '채권', evalValue: 10000000 },
      { type: '현금', evalValue: 0 },
    ],
    prevReport: { summary: '리츠TOP10 수익률 -9.5%' },
  };

  const nums = collectFactPercentages(facts, { profileText: '손실 -10% 이상이면 점검' });
  assert.ok(nums.includes(16.8));
  assert.ok(nums.includes(80));
  assert.ok(nums.includes(-9.5));
  assert.ok(nums.includes(-10));
  assert.ok(!nums.some((n) => !Number.isFinite(n)));
});

test('collectFactPercentages: 두 번째 인자 없이 기존 4종만 반환해 하위호환', () => {
  const facts = {
    macro: { KOSDAQ: { change5d: -5.66 } },
    holdings: [{ totalReturnPct: 12.3 }],
    assetClasses: [{ weightPct: 30.5 }],
    weekTrades: [{ realizedPct: -8.2 }],
  };
  assert.deepEqual(
    collectFactPercentages(facts).sort((a, b) => a - b),
    [-8.2, -5.66, 12.3, 30.5],
  );
});

test('[DevRequest 회귀] numericClaimViolations: 정상 4종은 허용하고 무관한 퍼센트는 계속 탐지', () => {
  const facts = {
    accounts: [{ returnPct: 16.8 }],
    holdings: [{ type: '채권', evalValue: 8000000 }],
    assetClasses: [{ type: '채권', evalValue: 10000000 }],
    prevReport: { summary: '리츠TOP10 -9.5%' },
  };
  const allowed = collectFactPercentages(facts, { profileText: '손실 -10% 이상이면 점검' });
  assert.deepEqual(
    numericClaimViolations('연금저축 16.8%, 채권 80%, 리츠TOP10 -9.5%, 기준선 -10%', allowed),
    [],
  );
  assert.deepEqual(numericClaimViolations('근거 없는 +37.2%', allowed), [37.2]);
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

// ── numericClaimViolationsWithLocation(2026-09-20 오너 DevRequest — "fact 근거가
// 없는 수치가 리포트의 어디에 있는지 위치를 표기한다") ──

test('numericClaimViolationsWithLocation: 가장 가까운 앞쪽 헤딩과 줄 번호를 같이 반환', () => {
  const md = [
    '# 주간 리포트',
    '',
    '## 자산배분',
    '',
    '리츠 비중이 16%로 과다하다.',
  ].join('\n');
  const violations = numericClaimViolationsWithLocation(md, []);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].value, 16);
  assert.equal(violations[0].heading, '자산배분');
  assert.equal(violations[0].line, 5);
  assert.match(violations[0].snippet, /리츠 비중이 16%로 과다하다/);
});

test('numericClaimViolationsWithLocation: 헤딩 앞(문서 최상단)에 있으면 heading은 null', () => {
  const violations = numericClaimViolationsWithLocation('+10% 상승', []);
  assert.equal(violations[0].heading, null);
});

test('numericClaimViolationsWithLocation: numericClaimViolations와 위반 값 집합이 동일함', () => {
  const facts = { macro: { KOSDAQ: { change5d: -5.66 } } };
  const md = '## 거시\n\nKOSDAQ 5일 -7% 하락';
  const plain = numericClaimViolations(md, collectFactPercentages(facts));
  const located = numericClaimViolationsWithLocation(md, collectFactPercentages(facts));
  assert.deepEqual(located.map((v) => v.value), plain);
});

// ⚠️ 독립 코드리뷰 지적(2026-09-20, MEDIUM) 재발방지 — 첫 버전은 헤딩 줄 자체를
// return으로 건너뛰어, "## 리츠 16% 비중 점검"처럼 헤딩 안에 위반 수치가 있으면
// numericClaimViolations(잡음)와 numericClaimViolationsWithLocation(놓침)이
// 서로 다른 결과를 냈다. 위 등가성 테스트는 헤딩에 퍼센트가 없는 문서만 써서
// 이 버그를 못 잡았다(수정된 동작을 그대로 인코딩할 뿐 검증이 안 됨) — 헤딩 자체에
// 퍼센트가 있는 문서로 실제 동치성을 검증한다.
test('numericClaimViolationsWithLocation: 헤딩 줄 자체에 있는 위반 수치도 잡음(등가성 테스트가 놓쳤던 버그)', () => {
  const md = '## 리츠 16% 비중 점검\n\n본문 서술.';
  const plain = numericClaimViolations(md, []);
  const located = numericClaimViolationsWithLocation(md, []);
  assert.deepEqual(located.map((v) => v.value), plain);
  assert.equal(located.length, 1);
  assert.equal(located[0].value, 16);
  assert.equal(located[0].heading, '리츠 16% 비중 점검');
  assert.equal(located[0].line, 1);
});

test('수치검증 재설계(2026-10-10): 합산 수익률 파생값은 허용, 거시지표 이름이 붙은 불일치만 확실한 위반', async () => {
  const { collectFactPercentages, numericClaimViolationsWithLocation, classifyNumericViolations } = await import('./llm-guard.mjs');
  const facts = {
    macro: { KOSPI: { change5d: -5.66 }, VIX: { change5d: 12.3 } },
    holdings: [{ name: 'A', type: '국내주식', evalValue: 255851225, totalReturnPct: 3 }],
    assetClasses: [{ type: '국내주식', evalValue: 255851225, weightPct: 100, returnPct: 12.0 }],
    accounts: [], weekTrades: [], totalEval: 255851225,
    portfolio: { invest: 228483120, evalValue: 255851225, returnPct: 12.0 },
  };
  const allowed = collectFactPercentages(facts);
  const md = ['## 요약', '- 전체 합산 수익률 +12.0%로 견조하다.', '- 이번 주 KOSPI는 5일간 -3.0% 밀렸다.', '- 일부 테마는 +27.5% 급등했다는 보도.'].join('\n');
  const violations = numericClaimViolationsWithLocation(md, allowed);
  assert.deepEqual(violations.map((v) => v.value), [-3, 27.5], '+12.0%(합산 수익률)는 더 이상 위반이 아니다');
  const { confirmed, lowConfidence } = classifyNumericViolations(violations, facts, md);
  assert.deepEqual(confirmed.map((v) => [v.value, v.key, v.expected]), [[-3, 'KOSPI', -5.66]]);
  assert.deepEqual(lowConfidence.map((v) => v.value), [27.5], '대상이 불분명한 수치는 확신 낮음(경고 안 함)');
  const both = classifyNumericViolations([{ value: 1, line: 1, snippet: '' }], facts, 'KOSPI와 VIX가 1% 움직였다');
  assert.equal(both.confirmed.length, 0, '지표 이름이 둘 이상이면 대상이 모호해 확신 낮음');
});

test('수치검증 확실한 위반 판정은 오탐을 내지 않는다(리뷰 재현 문장 — 기대 확실 위반 0건)', async () => {
  const { classifyNumericViolations } = await import('./llm-guard.mjs');
  const facts = {
    macro: { TNX: { value: 4.25, change5d: 1.2 }, SP500: { change5d: 0.8 }, WTI: { change5d: 2 }, GOLD: { change5d: 1 },
      USDKRW: { change5d: 0.3 }, KOSPI: { change5d: -1.2 } },
    holdings: [{ name: 'TIGER 미국S&P500' }, { name: 'KODEX 코스피200' }],
  };
  const lines = [
    '- 미국 10년물 금리 4.25%로 이번 주 높은 수준을 유지했다.',
    '- TIGER 미국S&P500 이번 주 목표 대비 +3.4%p 높다.',
    '- 유가증권시장 이번 주 거래대금 +7.5% 늘었다.',
    '- 국제 금리 상승 속 이번 주 채권 -2.6%.',
    '- 이번 주 해외주식 +18.7%는 원/달러 환율 효과 포함.',
    '- 코스피는 5일간 1.2% 하락했다.',
    '- 이번 주 코스피 +1.2% 오르는 동안 보유 ETF는 +7.3%.',
  ];
  const text = lines.join('\n');
  const violations = [
    { value: 4.25, line: 1 }, { value: 3.4, line: 2 }, { value: 7.5, line: 3 }, { value: -2.6, line: 4 },
    { value: 18.7, line: 5 }, { value: 1.2, line: 6 }, { value: 7.3, line: 7 },
  ];
  const { confirmed } = classifyNumericViolations(violations, facts, text);
  assert.deepEqual(confirmed, []);
  const real = classifyNumericViolations([{ value: 9.1, line: 1 }], facts, '- 이번 주 WTI +9.1% 급등');
  assert.equal(real.confirmed.length, 1, '지표 바로 뒤 숫자 + 주간 표현 + 크기 불일치면 여전히 잡는다');
});
