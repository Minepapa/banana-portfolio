import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, assembleSignals, assembleBaseline, assembleMacro, renderRiskFacts } from './risk-facts.mjs';

// risk-facts.mjs — 리스크관리실 Themis 대화형 보고용 Node 결정론 사실 조립기.
// Themis는 이미 read-only(과거 disallowedTools: Write,Edit)였으나 숫자 fetch(Bash·MCP)는
// 안 막혀 있었다 — 이 파일 + frontmatter tools 제한으로 숫자 무결성 하드 보장을 완성한다.

test('parseArgs — 기본은 전 섹션, --section/--target/--json', () => {
  assert.deepEqual(parseArgs([]), { section: 'all', target: null, json: false });
  assert.deepEqual(parseArgs(['--section', 'signals', '--target', '마이크로소프트']),
    { section: 'signals', target: '마이크로소프트', json: false });
});

test('parseArgs — 잘못된 section 거부', () => {
  assert.throws(() => parseArgs(['--section', 'x']), /section/i);
});

// 리스크모니터!A2:H(RISK_COL): 날짜0 유형1 대상2 신호3 요약4 상세5 근거데이터6 기준선참조7
const signalsFixture = () => [
  ['2026-07-13', 'B', '마이크로소프트', '🔴', '논리 훼손', '영업이익률 기준선 대비 -8%p', '{}', '2026-06-13'],
  ['2026-07-17', 'D', '거시', '🟡', 'VIX 급등', 'VIX 5일 +19.8%', '{}', ''],
  ['2026-07-01', 'B', '삼성전자', '🟢', '정상', '기준선 내', '{}', '2026-06-01'],
];

test('assembleSignals — DETAIL clamp은 risk-monitor.mjs 쓰기 계약(400자)과 정합 — 짧게 자르면 Themis의 원문 인용이 훼손됨', () => {
  // risk-monitor.mjs가 clampLen(detail, 400)으로 저장하므로, 보고용 clamp이 그보다 짧으면
  // 실제 저장된 트리거 근거가 잘려 "원문 그대로 인용" 원칙이 깨진다(리뷰 지적).
  const longDetail = 'X'.repeat(350) + ' 결정적 근거';
  const { text } = assembleSignals([['2026-07-17', 'B', '테스트종목', '🔴', '요약', longDetail, '{}', '']], {});
  assert.match(text, /결정적 근거/);
});

test('assembleSignals — target 선행단어 매칭 + 날짜 내림차순(시트 순서 아님)', () => {
  const { rows, text } = assembleSignals(signalsFixture(), {});
  assert.equal(rows.length, 3);
  assert.equal(rows[0][0], '2026-07-17'); // 가장 최근이 먼저
  assert.match(text, /VIX/);
});

test('assembleSignals — target 필터(정확일치)', () => {
  const { rows } = assembleSignals(signalsFixture(), { target: '마이크로소프트' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0][2], '마이크로소프트');
});

test('assembleSignals — 매칭 없음/빈 응답 정직하게 명시', () => {
  assert.match(assembleSignals([], {}).text, /데이터 부족/);
  assert.match(assembleSignals(signalsFixture(), { target: '테슬라' }).text, /없음/);
});

// 리스크기준선!A2:K(BASELINE_COL): 종목0 티커1 시장2 기준일3 매출총이익률4 영업이익률5 ROE6 부채비율7 EPS8 PBR9 비고10
const baselineFixture = () => [
  ['마이크로소프트', 'MSFT', 'US', '2026-06-13', '68.9%', '46.3%', '34%', '30.3%', '11.8', '12.1', ''],
  ['알파벳 Class A', 'GOOGL', 'US', '2026-06-13', '58.2%', '36.1%', '38.9%', '20%', '13.09', '9.1', ''],
];

test('assembleBaseline — 선행단어 매칭("알파벳"→"알파벳 Class A")', () => {
  const { rows, text } = assembleBaseline(baselineFixture(), { target: '알파벳' });
  assert.equal(rows.length, 1);
  assert.match(text, /GOOGL/);
  assert.match(text, /ROE 38\.9%/);
});

test('assembleBaseline — target 없으면 전체, 매칭 없으면 정직 명시', () => {
  assert.equal(assembleBaseline(baselineFixture(), {}).rows.length, 2);
  assert.match(assembleBaseline(baselineFixture(), { target: '테슬라' }).text, /없음/);
});

// fetchMacroIndicators() 반환 형태(주입 — 이 함수 자체는 IO 없음, 테스트는 순수)
const macroFixture = () => ({
  USDKRW: { value: 1350.5, change5d: 1.2, source: 'yfinance(FX,~10h지연)' },
  VIX: { value: 22.3, change5d: 19.8, source: 'yfinance' },
  TNX: { value: 4.569, change5d: 0.3, source: 'yfinance' },
});

test('assembleMacro — 값·변동률·출처를 서술, 값 없으면 데이터없음 명시', () => {
  const text = assembleMacro(macroFixture());
  assert.match(text, /USDKRW/);
  assert.match(text, /1350\.5/);
  assert.match(text, /VIX/);
  assert.match(text, /19\.8/);
});

test('assembleMacro — §4 가드레일이 실제로 발동 기준으로 쓰는 지표(저점대비 상승·고점대비 낙폭)도 있으면 노출', () => {
  // 리뷰 지적: checkGuardrails는 endpoint change5d가 아니라 drawdown5d/rally5d로 D신호를 발동한다.
  // 종점 변동만 보이면 실제 트리거 근거와 어긋난 인상을 줄 수 있어, 있으면 반드시 포함한다.
  const text = assembleMacro({
    KOSPI: { value: 6820.6, change5d: -6.46, drawdown5d: -8.77, source: '네이버(비지연)' },
    USDKRW: { value: 1487.46, change5d: -1.23, rally5d: 3.1, source: 'yfinance(FX,~10h지연)' },
  });
  assert.match(text, /고점대비.*-8\.77%|저점대비.*3\.1%/s);
});

test('assembleMacro — yfinance 원본 부동소수점 정밀도를 가독성 있게 반올림(실증: 1487.4599609375 같은 값)', () => {
  const text = assembleMacro({ USDKRW: { value: 1487.4599609375, change5d: -1.234567, source: 'yfinance' } });
  assert.match(text, /1487\.46\b/);      // 소수 2자리로 반올림, 원본 긴 소수 아님
  assert.doesNotMatch(text, /1487\.4599609375/);
  assert.match(text, /-1\.23%/);
});

test('assembleMacro — null 지표는 데이터없음으로 정직하게', () => {
  const text = assembleMacro({ VIX: { value: null, change5d: null, source: '데이터없음' } });
  assert.match(text, /데이터없음|데이터 없음/);
});

test('renderRiskFacts — 재조회 금지 가드 포함, --json 구조 보존', () => {
  const facts = {
    signals: assembleSignals(signalsFixture(), {}),
    baseline: assembleBaseline(baselineFixture(), {}),
    macro: assembleMacro(macroFixture()),
  };
  const human = renderRiskFacts(facts, { json: false });
  assert.match(human, /재조회|Node/);
  const json = JSON.parse(renderRiskFacts(facts, { json: true }));
  assert.ok(json.signals && json.baseline);
});
