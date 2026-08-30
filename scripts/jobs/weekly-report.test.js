import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractSummary, extractSummaryBullets, safeTrim, markdownBoldToHtml } from './weekly-report.mjs';
import { buildFrontmatter, parseFrontmatter } from '../lib/vault-frontmatter.mjs';

// 2026-08-30 오너 신고 — 텔레그램 주간 리포트 요약이 숫자 한가운데서("-2,504,0") 잘려
// 발송됐다. 원인: 옛 extractSummary가 "> 요약:" 리터럴 라인을 정규식으로 찾다 실패하면
// 본문 전체를 공백으로 이어붙여 .slice(0, 200)로 하드컷했는데, 이 컷이 불릿 구조도
// 문장 경계도 무시했다. 아래 테스트는 그 정확한 실패 시나리오를 재현한 리포트로 회귀를
// 막는다.

const REAL_REPORT_BODY = `# 주간 자산 종합 점검 — 2026-08-30

> 글로벌 위험선호 회복(VIX -9.4%)에도 KOSPI -1.79% 역행, 지난 주 디커플링이 방향을 바꿨다.

## [한눈에] 이번 주 요약
- **가장 큰 변화**: 글로벌 주식(NASDAQ +1.82%) 반등 주에 KOSPI -1.79% 역행 — 지난 주와 반대 방향 디커플링
- **잘 가고 있는 것**: 위탁 +16.3%, 연금저축 +17.6% 누적 수익 견고; 삼성전자·PLUS 고배당주 등 핵심 포지션 건재
- **주의·행동 필요**: SK하이닉스 -14.3%(손실 약 **-2,504,000원**) 지속, TIGER 리츠 -8.6% 여전히 손실 구간

---

## [자산현황]

### 계좌별 손익

| 계좌 | 원금 | 평가액 |
|------|-----:|-------:|
| 위탁 | 103,771,880원 | 120,701,650원 |
`;

// ── extractSummaryBullets — 텔레그램용(개행 유지, 여러 줄 배열) ──────────────────

test('extractSummaryBullets: "## [한눈에] 이번 주 요약" 3개 불릿을 온전히(중간에 안 잘리고) 배열로 추출', () => {
  const bullets = extractSummaryBullets(REAL_REPORT_BODY);
  assert.equal(bullets.length, 3);
  // 회귀 확인 — 옛 버그는 정확히 이 지점("-2,504,0")에서 잘렸다.
  assert.match(bullets[2], /-2,504,000원/);
  assert.match(bullets[2], /TIGER 리츠 -8.6% 여전히 손실 구간$/);
});

test('extractSummaryBullets: 헤더 뒤 공백이 있어도 매칭(코드리뷰 지적 — 예전엔 정확히 "## [한눈에] 이번 주 요약\\n"만 매칭)', () => {
  const md = REAL_REPORT_BODY.replace('## [한눈에] 이번 주 요약\n', '## [한눈에] 이번 주 요약   \n');
  const bullets = extractSummaryBullets(md);
  assert.equal(bullets.length, 3);
});

test('extractSummaryBullets: * 불릿도 인식(코드리뷰 지적 — 예전엔 "-"로 시작하는 줄만 인정)', () => {
  const md = `# 제목\n\n## [한눈에] 이번 주 요약\n* 첫 줄\n* 둘째 줄\n\n---\n`;
  const bullets = extractSummaryBullets(md);
  assert.deepEqual(bullets, ['* 첫 줄', '* 둘째 줄']);
});

test('extractSummaryBullets: 불릿 사이 빈 줄이 있어도 뒤 불릿을 안 놓침(코드리뷰 지적 — 예전 정규식은 첫 빈 줄에서 멈춤)', () => {
  const md = `# 제목\n\n## [한눈에] 이번 주 요약\n- 첫 줄\n\n- 둘째 줄\n\n---\n`;
  const bullets = extractSummaryBullets(md);
  assert.equal(bullets.length, 2);
  assert.equal(bullets[1], '- 둘째 줄');
});

test('extractSummaryBullets: 섹션 헤더 자체가 없으면(포맷 이탈) 폴백으로 넘어가되 단어 중간을 안 자름', () => {
  const longLine = '반복적으로 문구를 덧붙인다 '.repeat(20); // 확실히 200자 초과
  const noSectionMd = `# 제목\n\n${longLine}\n`;
  const bullets = extractSummaryBullets(noSectionMd);
  assert.equal(bullets.length, 1);
  assert.ok(bullets[0].length <= 201); // 200 + "…"
  assert.ok(bullets[0].endsWith('…')); // 원문이 200자를 넘으므로 반드시 안전하게 잘렸다는 표시가 남아야 함
});

// ── extractSummary — frontmatter·직전주 컨텍스트용(반드시 한 줄) ──────────────────

test('extractSummary: 개행 없는 단일 줄(코드리뷰 HIGH 지적 — 여러 줄을 frontmatter에 그대로 넣으면 YAML이 깨져 2번째 줄부터 소실됨)', () => {
  const summary = extractSummary(REAL_REPORT_BODY);
  assert.ok(!summary.includes('\n'));
  assert.match(summary, /-2,504,000원/); // 압축해도 내용은 보존
});

test('extractSummary: frontmatter round-trip에서 불릿 전부 보존(실제 buildFrontmatter/parseFrontmatter로 왕복 검증)', () => {
  const summary = extractSummary(REAL_REPORT_BODY);
  const content = buildFrontmatter({ type: 'weekly-report', date: '2026-08-30', summary });
  const parsed = parseFrontmatter(content);
  assert.equal(parsed.summary, summary);
  assert.match(parsed.summary, /가장 큰 변화/);
  assert.match(parsed.summary, /주의·행동 필요/);
  assert.match(parsed.summary, /-2,504,000원/); // 3번째 불릿까지 전부 살아있어야 함
});

// ── safeTrim ─────────────────────────────────────────────────────────────────

test('safeTrim: 길이 이내면 그대로', () => {
  assert.equal(safeTrim('짧은 문장', 200), '짧은 문장');
});

test('safeTrim: 넘치면 마지막 공백에서 자르고 … 표시(단어 중간 절단 금지)', () => {
  const text = 'abc def ghijklmnop';
  const result = safeTrim(text, 10); // 'abc def gh' 위치에서 컷 시도 → 마지막 공백은 'abc def' 뒤
  assert.ok(!result.includes('ghijkl')); // 단어 중간이 그대로 안 남아있어야 함
  assert.ok(result.endsWith('…'));
});

// ── markdownBoldToHtml ───────────────────────────────────────────────────────

test('markdownBoldToHtml: **text** → <b>text</b>(텔레그램 parse_mode:HTML용, 2026-08-30 오너 신고 — 별표가 그대로 노출되던 문제)', () => {
  assert.equal(markdownBoldToHtml('- **가장 큰 변화**: 내용'), '- <b>가장 큰 변화</b>: 내용');
});

test('markdownBoldToHtml: 여러 개 굵게 표시가 전부 변환됨', () => {
  const input = '**A**와 **B** 둘 다';
  assert.equal(markdownBoldToHtml(input), '<b>A</b>와 <b>B</b> 둘 다');
});

test('markdownBoldToHtml: 굵게 표시 없으면 그대로', () => {
  assert.equal(markdownBoldToHtml('평범한 문장'), '평범한 문장');
});

test('markdownBoldToHtml: <·>·& 이스케이프(코드리뷰 지적 — 안 하면 텔레그램이 "can\'t parse entities"로 발송 자체를 거부)', () => {
  assert.equal(markdownBoldToHtml('PER < 10 & 저평가'), 'PER &lt; 10 &amp; 저평가');
});

test('markdownBoldToHtml: 이스케이프와 굵게 변환이 함께 있어도 <b> 태그 자체는 안 망가짐', () => {
  const result = markdownBoldToHtml('PER < 10 & **저평가** 구간');
  assert.equal(result, 'PER &lt; 10 &amp; <b>저평가</b> 구간');
});
