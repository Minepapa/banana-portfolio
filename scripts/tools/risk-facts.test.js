import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, assembleMacro, renderRiskFacts } from './risk-facts.mjs';

// risk-facts.mjs — 리스크관리실 Themis 대화형 보고용 Node 결정론 사실 조립기.
// 2026-08-20 축소 재작성 — 개별종목 논리훼손(B신호)·펀더멘털 기준선 섹션 제거
// (project-v2-gap-audit-20260820 메모리 참고: 두 트랙 다 "재량적 개별종목 매수논리"
// 전제가 없어졌고, 레거시 개별종목 7종도 오너가 시스템 감시 대상에서 뺐음).
// 남은 건 거시지표 + 감시 잡 상태뿐.

test('parseArgs — 기본은 전 섹션, --section/--json', () => {
  assert.deepEqual(parseArgs([]), { section: 'all', json: false });
  assert.deepEqual(parseArgs(['--section', 'macro']), { section: 'macro', json: false });
  assert.deepEqual(parseArgs(['--section', 'jobs', '--json']), { section: 'jobs', json: true });
});

test('parseArgs — 잘못된 section 거부', () => {
  assert.throws(() => parseArgs(['--section', 'x']), /section/i);
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
  const facts = { macro: assembleMacro(macroFixture()) };
  const human = renderRiskFacts(facts, { json: false });
  assert.match(human, /재조회|Node/);
  assert.match(human, /USDKRW/);
  const json = JSON.parse(renderRiskFacts(facts, { json: true }));
  assert.equal(json.macro, assembleMacro(macroFixture()));
});

test('renderRiskFacts — jobs 섹션은 daily-asset-allocation-check·health-watcher 라벨로 표시', () => {
  const jobs = { text: '  daily-asset-allocation-check: OK (...)', failing: [] };
  const human = renderRiskFacts({ jobs }, { json: false });
  assert.match(human, /daily-asset-allocation-check·health-watcher/);
});
