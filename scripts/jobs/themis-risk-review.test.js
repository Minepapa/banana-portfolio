import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRecentProposalsSummary, buildThemisPrompt, buildThemisFacts, buildMacroTable } from './themis-risk-review.mjs';

test('buildRecentProposalsSummary: 7일 이내 생성분만 포함, 오래된 건 제외', () => {
  const now = new Date('2026-08-23T00:00:00.000Z');
  const proposals = [
    { track: '퀀트', side: '매수', assetKey: '005930', quantity: 10, status: '승인', reason: '팩터 1위', createdAt: '2026-08-20T00:00:00.000Z' },
    { track: '자산분배', side: '매수', assetKey: 'QQQ', quantity: 2, status: '대기', reason: '', createdAt: '2026-08-01T00:00:00.000Z' },
  ];
  const text = buildRecentProposalsSummary(proposals, now);
  assert.match(text, /005930/);
  assert.doesNotMatch(text, /QQQ/);
});

test('buildRecentProposalsSummary: 최근 7일 생성분이 없으면 명시적으로 없음 표시', () => {
  const now = new Date('2026-08-23T00:00:00.000Z');
  const text = buildRecentProposalsSummary([], now);
  assert.equal(text, '(최근 7일 생성된 제안 없음)');
});

test('buildRecentProposalsSummary: 생성일 오름차순 정렬', () => {
  const now = new Date('2026-08-23T00:00:00.000Z');
  const proposals = [
    { track: '퀀트', side: '매수', assetKey: 'B', quantity: 1, status: '대기', createdAt: '2026-08-22T00:00:00.000Z' },
    { track: '퀀트', side: '매수', assetKey: 'A', quantity: 1, status: '대기', createdAt: '2026-08-21T00:00:00.000Z' },
  ];
  const text = buildRecentProposalsSummary(proposals, now);
  assert.ok(text.indexOf(' A ') < text.indexOf(' B '));
});

test('buildThemisPrompt: 주입된 사실 3종을 모두 포함하고 재조회 금지 문구가 있다', () => {
  const prompt = buildThemisPrompt({ macro: '  VIX: 15.13', jobsText: '  daily-asset-allocation-check: OK', recentProposalsText: '(없음)' });
  assert.match(prompt, /VIX: 15\.13/);
  assert.match(prompt, /daily-asset-allocation-check: OK/);
  assert.match(prompt, /재조회·추정 금지/);
  assert.match(prompt, /테미스/);
});

// ── buildThemisFacts(2026-08-30 신설) — 오너 지적: Themis 메시지만 다른 부서와 달리
// 불릿 없이 숫자·판정이 한 문단에 뭉쳐 나가고 있었다. Node가 계산한 사실을 개조식
// 불릿으로 먼저 뽑아 formatFactsMessage(텔레그램 표준 구조)에 넘기기 위한 순수함수.
// 2026-09-20 오너 DevRequest — 거시지표는 개별 불릿 대신 buildMacroTable이 만든 표
// 하나로 합쳐 첫 불릿에 들어간다(아래 buildMacroTable 테스트 참고).

test('buildThemisFacts: macroTable이 있으면 첫 불릿으로 들어감', () => {
  const facts = buildThemisFacts({ macroTable: '<pre>표내용</pre>', jobsText: '', recentProposalsCount: 0 });
  assert.equal(facts[0], '<pre>표내용</pre>');
});

test('buildThemisFacts: macroTable이 null이면(조회 실패) 불릿 생략', () => {
  const facts = buildThemisFacts({ macroTable: null, jobsText: '  health-watcher: OK', recentProposalsCount: 0 });
  assert.ok(!facts.some((f) => f.includes('<pre>')));
});

test('buildThemisFacts: 잡상태 라인도 불릿에 포함', () => {
  const facts = buildThemisFacts({ macroTable: null, jobsText: '  health-watcher: OK (연속실패 0회)', recentProposalsCount: 3 });
  assert.ok(facts.some((f) => f.includes('health-watcher')));
});

test('buildThemisFacts: 최근 제안 건수가 마지막 불릿으로 포함', () => {
  const facts = buildThemisFacts({ macroTable: null, jobsText: '', recentProposalsCount: 5 });
  assert.equal(facts.at(-1), '최근 7일 생성된 제안: 5건');
});

test('buildThemisFacts: jobsText 빈 줄은 걸러짐', () => {
  const facts = buildThemisFacts({ macroTable: null, jobsText: '  health-watcher: OK\n\n  daily-asset-allocation-check: OK', recentProposalsCount: 0 });
  assert.ok(!facts.includes(''));
});

// ── buildMacroTable(2026-09-20 신설, 오너 DevRequest) — 지표·값·5일변동·출처처럼
// 형식이 같은 항목을 <pre> 고정폭 표로 정리해 본문에 삽입.

test('buildMacroTable: 지표·값·5일변동·출처가 한 표에 정렬됨', () => {
  const table = buildMacroTable({
    VIX: { value: 14.512, change5d: -9.37, source: 'yfinance' },
    USDKRW: { value: 1371.5, change5d: -0.97, source: 'yfinance' },
  });
  assert.match(table, /^<pre>/);
  assert.match(table, /<\/pre>$/);
  assert.match(table, /VIX/);
  assert.match(table, /14\.51/);
  assert.match(table, /-9\.37%/);
  assert.match(table, /yfinance/);
});

test('buildMacroTable: drawdown5d·rally5d가 있으면 비고 칸에 표기(§4 D신호 근거)', () => {
  const table = buildMacroTable({ KOSPI: { value: 2500, change5d: -4.5, drawdown5d: -6.2, source: 'KRX' } });
  assert.match(table, /고점대비 -6\.2%/);
});

test('buildMacroTable: rally5d 양수는 "+"가 붙음', () => {
  const table = buildMacroTable({ KOSPI: { value: 2500, rally5d: 3.1, source: 'KRX' } });
  assert.match(table, /저점대비 \+3\.1%/);
});

test('buildMacroTable: rally5d가 음수여도(상류 계산 방어) 부호가 겹쳐 보이지 않음(LOW 지적 재발방지)', () => {
  const table = buildMacroTable({ KOSPI: { value: 2500, rally5d: -1.2, source: 'KRX' } });
  assert.doesNotMatch(table, /\+-/);
  assert.match(table, /저점대비 -1\.2%/);
});

test('buildMacroTable: value가 없으면(조회 실패) 데이터없음으로 표기, throw 안 함', () => {
  const table = buildMacroTable({ TNX: { value: null, source: 'yfinance' } });
  assert.match(table, /데이터없음/);
});

test('buildMacroTable: 빈 macroData면 null(호출부가 facts에서 생략)', () => {
  assert.equal(buildMacroTable({}), null);
  assert.equal(buildMacroTable(null), null);
});

// ── 독립 코드리뷰 지적(2026-09-20, HIGH/CRITICAL) 재발방지 회귀 테스트 ──

test('buildMacroTable: HTML 특수문자가 든 지표명(예: S&P500)이 있어도 다른 행의 패딩이 과도하게 밀리지 않음(escapeHtml을 패딩 전에 적용해야 함)', () => {
  const withAmp = buildMacroTable({ 'S&P500': { value: 100, source: 'A' }, VIX: { value: 1, source: 'B' } });
  const withoutAmp = buildMacroTable({ SXP500: { value: 100, source: 'A' }, VIX: { value: 1, source: 'B' } });
  assert.match(withAmp, /S&amp;P500/); // 이스케이프 자체는 여전히 됨
  const vixLineWithAmp = withAmp.split('\n').find((l) => l.startsWith('VIX'));
  const vixLineWithoutAmp = withoutAmp.split('\n').find((l) => l.startsWith('VIX'));
  // 'S&P500'과 'SXP500'은 표시폭이 둘 다 6이므로(escapeHtml 후 소스 길이만 다름,
  // 10 vs 6) 두 표에서 VIX 행의 패딩이 동일해야 한다 — 패딩 전에 escapeHtml을
  // 적용하는 버그가 있었다면 'S&amp;P500'(10자)이 폭 계산에 쓰여 VIX 행이 4칸 더
  // 밀렸을 것이다.
  assert.equal(vixLineWithAmp, vixLineWithoutAmp);
});

test('buildMacroTable: 헤더(한글)와 데이터(라틴)가 섞여도 표시폭 기준으로 정렬됨(padEnd의 UTF-16 length 기준 계산은 한글 표시폭을 실제보다 좁게 쳐서 어긋남, HIGH 지적 재발방지)', () => {
  const table = buildMacroTable({ VIX: { value: 14.51, change5d: -9.37, source: 'yfinance' } });
  const [header, dataRow] = table.replace(/^<pre>|<\/pre>$/g, '').split('\n');
  // 첫 컬럼(지표) 폭은 "지표"(표시폭4, 문자열길이2)와 "VIX"(표시폭3, 문자열길이3) 중
  // 큰 쪽인 4다. "지표"는 이미 표시폭 4라 패딩 0칸, "VIX"는 1칸 부족해 패딩 1칸이
  // 붙어야 한다 — 그래야 두 번째 컬럼("값"/"14.51")이 두 줄에서 같은 표시폭
  // 위치에서 시작한다. UTF-16 length 기준(옛 버그)이면 "지표"를 문자열길이 2로
  // 오인해 열 폭을 3(=VIX 길이)으로 계산, "값"이 인덱스 5에서 시작해 어긋난다.
  assert.equal(header.indexOf('값'), 4);
  assert.equal(dataRow.indexOf('14.51'), 6);
});
