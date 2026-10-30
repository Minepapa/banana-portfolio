import { test } from 'node:test';
import assert from 'node:assert/strict';
import { llmRunFailed, markLlmRunOutcome } from './llm-run-outcome.mjs';

test('규칙: 성공 0·실패 1건 이상만 잡 실패, 부분 실패·시도 없음·한도로 멈춤(실패 0)은 OK', () => {
  assert.equal(llmRunFailed({ succeeded: 0, failed: 1 }), true);
  assert.equal(llmRunFailed({ succeeded: 0, failed: 50 }), true);
  assert.equal(llmRunFailed({ succeeded: 1, failed: 49 }), false, '부분 실패는 OK(경보 피로 방지)');
  assert.equal(llmRunFailed({ succeeded: 0, failed: 0 }), false, '시도 없음·쿨다운·한도·시간 상한으로 멈춤');
  assert.equal(llmRunFailed({ succeeded: 3, failed: 0 }), false);
  assert.equal(llmRunFailed(), false);
});

test('예외: 다시 시도할 수단이 없는 단발 잡은 한도로 멈춰도 실패, 재시도 있는 잡은 OK', () => {
  assert.equal(llmRunFailed({ succeeded: 0, failed: 0, limited: 1, retryable: false }), true, '주간 점검이 알림 없이 빠지면 안 됨');
  assert.equal(llmRunFailed({ succeeded: 0, failed: 0, limited: 1 }), false, '재시도 있는 잡(기본)은 한도면 OK');
  assert.equal(llmRunFailed({ succeeded: 1, failed: 0, limited: 1, retryable: false }), false);
  assert.equal(llmRunFailed({ succeeded: 0, failed: 0, limited: 0, retryable: false }), false, '시도 없음은 OK');
});

test('markLlmRunOutcome: 걸리면 exitCode=1과 이유 한 줄, 아니면 건드리지 않음, 기존 비정상 코드는 덮지 않음', () => {
  const logs = [];
  const proc = { exitCode: undefined };
  assert.equal(markLlmRunOutcome({ succeeded: 0, failed: 2 }, { job: 'x', log: (m) => logs.push(m), proc }), true);
  assert.equal(proc.exitCode, 1);
  assert.match(logs[0], /\[x\] claude 판단 성공 0건·실패 2건/);
  const ok = { exitCode: undefined };
  assert.equal(markLlmRunOutcome({ succeeded: 1, failed: 2 }, { job: 'x', log: () => {}, proc: ok }), false);
  assert.equal(ok.exitCode, undefined);
  const prior = { exitCode: 2 };
  markLlmRunOutcome({ succeeded: 0, failed: 1 }, { job: 'x', log: () => {}, proc: prior });
  assert.equal(prior.exitCode, 2);
});

// 구조적 가드: claude를 부르는 잡은 이 규칙을 실제로 쓴다(주석 문구가 아니라 import + 호출로 판정, 리뷰 M3).
// "claude를 부르는 잡" = claude 실행 모듈(headless-claude, 그것을 다시 내보내는 sheets-common, 관문 telegram-gate-llm)을
// 홑·겹따옴표·동적 import 어느 것으로든 가져오고, 실행 함수(runHeadlessClaude·runGateClaude)를 코드에서 쓰는 잡.
// 규칙을 따르는 방식이 다른 잡만 아래 예외 표에 사유와 함께 둔다(예외 잡이 claude를 더 안 부르면 표에서 빼라고 실패한다).
const LLM_RULE_EXEMPT = {
  'daily-note.mjs': '날짜별 요약 실패를 failed로 모아 exitCode=1(같은 규칙, 쿨다운 보류는 실패 아님)',
  'mine-athena-fields.mjs': 'failed(summary)가 같은 규칙(쓰기 관문·락 오류는 더 엄하게 실패)',
  'weekly-report.mjs': '리포트 본문 실패는 throw → exit 1, 성향 관찰은 부분 실패',
  'morning-briefing.mjs': '판단 실패는 MORNING_JUDGMENT_FAILED 운영 경고로 이미 알림(이중 경보 회피)',
  'telegram-gate.mjs': '상시 데몬 — 종료코드로 성패를 남기지 않고 메시지마다 알린다',
};
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
const CLAUDE_MODULE_RE = /(?:from\s*|import\s*\(\s*)['"]\.\.\/lib\/(?:headless-claude|sheets-common|telegram-gate-llm)\.mjs['"]/;
const CLAUDE_CALL_RE = /\b(?:runHeadlessClaude|runGateClaude)\b(?!\s*[,}]?\s*from)/;
const RULE_IMPORT_RE = /(?:from\s*|import\s*\(\s*)['"]\.\.\/lib\/llm-run-outcome\.mjs['"]/;
const RULE_CALL_RE = /\b(?:markLlmRunOutcome|llmRunFailed)\s*\(/;

export function classifyClaudeJob(source) {
  const code = stripComments(source);
  const body = code.split('\n').filter((line) => !/^\s*import\s/.test(line)).join('\n');
  const callsClaude = CLAUDE_MODULE_RE.test(code) && CLAUDE_CALL_RE.test(body);
  const usesRule = RULE_IMPORT_RE.test(code) && RULE_CALL_RE.test(body);
  return { callsClaude, usesRule };
}

test('가드 판정: 따옴표·동적 import·sheets-common 경로를 잡고, 주석만 있는 선언은 통과시키지 않는다', () => {
  const call = 'await runHeadlessClaude(p);';
  assert.equal(classifyClaudeJob(`import { runHeadlessClaude } from "../lib/headless-claude.mjs";\n${call}`).callsClaude, true);
  assert.equal(classifyClaudeJob(`const { runHeadlessClaude } = await import('../lib/headless-claude.mjs');\n${call}`).callsClaude, true);
  assert.equal(classifyClaudeJob(`import { runHeadlessClaude } from '../lib/sheets-common.mjs';\n${call}`).callsClaude, true);
  assert.equal(classifyClaudeJob(`import { resolveClaudeBin } from '../lib/headless-claude.mjs';\nresolveClaudeBin();`).callsClaude, false, '경로만 쓰면 호출 아님');
  const commentOnly = `import { runHeadlessClaude } from '../lib/headless-claude.mjs';\n// 종료코드 규칙(llm-run-outcome) markLlmRunOutcome(x)\n${call}`;
  assert.equal(classifyClaudeJob(commentOnly).usesRule, false, '주석 문구로는 통과하지 않는다');
  const real = `import { markLlmRunOutcome } from '../lib/llm-run-outcome.mjs';\n${call}\nmarkLlmRunOutcome(c, { job: 'x' });`;
  assert.equal(classifyClaudeJob(real).usesRule, true);
});

test('claude를 부르는 잡은 모두 종료코드 규칙을 실제로 쓴다(예외는 사유와 함께 표에)', async () => {
  const { readdirSync, readFileSync } = await import('node:fs');
  const dir = new URL('../jobs/', import.meta.url);
  const files = readdirSync(dir).filter((n) => n.endsWith('.mjs'));
  const claudeJobs = files.filter((n) => classifyClaudeJob(readFileSync(new URL(n, dir), 'utf8')).callsClaude);
  assert.ok(claudeJobs.length >= 15, `claude 호출 잡 판정이 깨졌을 가능성(${claudeJobs.length})`);
  const missing = claudeJobs.filter((n) => !(n in LLM_RULE_EXEMPT) && !classifyClaudeJob(readFileSync(new URL(n, dir), 'utf8')).usesRule);
  assert.deepEqual(missing, [], `종료코드 규칙을 쓰지 않는 claude 호출 잡: ${missing.join(', ')} — scripts/lib/llm-run-outcome.mjs의 markLlmRunOutcome으로 종료코드를 정할 것`);
  const stale = Object.keys(LLM_RULE_EXEMPT).filter((n) => !claudeJobs.includes(n));
  assert.deepEqual(stale, [], `claude를 더 부르지 않는 예외 항목: ${stale.join(', ')} — 표에서 뺄 것`);
});
