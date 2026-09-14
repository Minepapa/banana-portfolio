// 구조적 가드 — scripts/jobs·scripts/tools·scripts/lib의 모든 sendTelegram() 호출이
// 표준 포맷터(formatFactsMessage/formatDepartmentMessage)를 거치는지 npm test마다
// 기계적으로 검증한다(2026-09-14, 오너 지적 반영).
//
// ⚠️ 왜 필요한가 — PANTHEON.md "텔레그램 메시지 표준 구조" 절이 "새 헤드리스 잡을
// 만들 때 체크리스트"를 이미 문서화해뒀는데도(2026-08-30 신설), 그 직후에도
// annual-instrument-rescore.mjs의 "반쪽 발송" 경고가 이모지 포함 raw 문자열로
// sendTelegram()에 직접 넘어가고 있었다(2026-09-14 오너 지적으로 발견 — "운영실
// 경고 메세지가 정리 안 된 채 온다"). 프로즈 규칙만으로는 새 잡을 짤 때마다
// 매번 기억해야 하는데, 이 프로젝트에서 이미 최소 5차례(EXPECTED_INTERVALS_MS
// 누락 반복, progress: 필드 등) 증명된 실패 패턴과 같다 — 테스트로 강제한다.
//
// ⚠️ 독립 코드리뷰 지적(2026-09-14) — 최초 버전은 scripts/lib를 안 훑어서, 이번에
// 정작 고친 job-alerts.mjs(잡 15개+가 공유하는 최대 트래픽 발신처) 자신이 가드
// 사각지대에 있었다(REQUEST CHANGES). scripts/lib를 스캔 대상에 추가하되, sendTelegram
// "정의부"인 telegram.mjs는 파일명으로 제외(그 파일의 함수 시그니처
// `sendTelegram(text, chatId)` 자체가 호출처럼 매치돼 오탐이 남).
//
// ⚠️ 같은 리뷰 지적 — 콜백 주입 예외(SAFE_INDIRECT_RE)가 원래 "파일 전체"에 그
// 패턴이 있는지만 봐서, 실제로는 아무 관련 없는 곳의 raw `sendTelegram(text)`도
// 파일 안에 진짜 콜백 정의가 하나만 있으면 전부 통과시켰다(실측 재현됨). 매치
// 직전 텍스트가 실제로 그 콜백 정의 자체인지(줄 단위)로 좁혔다.
//
// 검사 방식 — 완전한 JS 파서가 아니라 이 코드베이스의 실제 관례에 맞춘 라이트
// 스캐너다: 주석을 먼저 제거한 뒤(주석 안의 "sendTelegram(...)" 언급이 오탐으로
// 잡히는 걸 방지, 이 레포는 한글 설명 주석 밀도가 높아 실제로 발생할 수 있는
// 케이스였음 — 코드리뷰 지적), `sendTelegram(` 바로 다음 토큰이
// `formatFactsMessage(`나 `formatDepartmentMessage(`로 시작하면 통과. 유일한 예외는
// `proposal-flow.mjs`가 쓰는 의존성 주입 패턴 — 호출측이
// `sendMessage: (text) => sendTelegram(text)...`(또는
// `const sendMessage = async (text) => sendTelegram(text)...`) 형태의 콜백을
// **그 자리에서 정의**하면, `proposal-flow.mjs`가 나중에 이미 `formatFactsMessage`로
// 조립한 문자열을 그 콜백에 주입해서 부른다 — ⚠️ 이 가드는 `proposal-flow.mjs` 자체가
// 실제로 그렇게 조립하는지는 검증하지 못한다(그 파일은 sendTelegram을 직접 안 불러
// 이 스캐너의 대상이 아님 — `scripts/lib/proposal-flow.mjs:156-157`을 수동으로 확인할
// 것, 2026-09-14 코드리뷰 지적으로 이 한계를 명시).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCAN_DIRS = [join(HERE, '..', 'jobs'), join(HERE, '..', 'tools'), HERE];
const EXCLUDED_FILENAMES = new Set(['telegram.mjs']); // sendTelegram "정의부" — 호출이 아님
const SAFE_WRAPPERS = ['formatFactsMessage(', 'formatDepartmentMessage('];
// 매치 직전 텍스트가 이 패턴으로 끝나야만("줄 단위" 근접 확인) 콜백 정의 자체로 인정 —
// 파일 전체 존재 여부로 판단하지 않는다(위 코드리뷰 지적).
const SAFE_INDIRECT_DEFINITION_RE = /sendMessage\s*[:=]\s*(?:async\s*)?\(?\s*text\s*\)?\s*=>\s*$/;

function stripComments(content) {
  return content
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

// 순수함수 — 파일 내용 하나를 스캔해 위반 목록 반환(테스트 가능하도록 분리).
export function findUnformattedSendTelegramCalls(rawContent) {
  const content = stripComments(rawContent);
  const violations = [];
  const callRe = /sendTelegram\(([^)]*)/g;
  let m;
  while ((m = callRe.exec(content))) {
    const arg = m[1].trim();
    if (!arg) continue; // 인자 없는 호출(즉시 터지는 명백한 버그) — 서식 위반과는 다른 범주, 이 가드 대상 아님
    if (SAFE_WRAPPERS.some((w) => arg.startsWith(w))) continue;
    if (arg === 'text') {
      const before = content.slice(Math.max(0, m.index - 80), m.index);
      if (SAFE_INDIRECT_DEFINITION_RE.test(before)) continue;
    }
    violations.push({ arg, snippet: content.slice(m.index, m.index + 120).replace(/\s+/g, ' ').trim() });
  }
  return violations;
}

function listScriptFiles() {
  const files = [];
  for (const dir of SCAN_DIRS) {
    for (const f of readdirSync(dir)) {
      if (f.endsWith('.mjs') && !f.endsWith('.test.js') && !EXCLUDED_FILENAMES.has(f)) files.push(join(dir, f));
    }
  }
  return files;
}

test('findUnformattedSendTelegramCalls: formatFactsMessage/formatDepartmentMessage로 감싼 호출은 통과', () => {
  const content = "await sendTelegram(formatFactsMessage({ departmentLabel: 'X', facts: [] }));";
  assert.equal(findUnformattedSendTelegramCalls(content).length, 0);
});

test('findUnformattedSendTelegramCalls: raw 문자열/변수를 그대로 넘기면 위반으로 잡힘', () => {
  const content = 'const alertMsg = `경고: ${x}`; await sendTelegram(alertMsg);';
  const violations = findUnformattedSendTelegramCalls(content);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].arg, 'alertMsg');
});

test('findUnformattedSendTelegramCalls: proposal-flow.mjs 콜백 주입 패턴(sendMessage: (text) => sendTelegram(text))은 예외', () => {
  const content = 'const opts = { sendMessage: (text) => sendTelegram(text).then((r) => r?.result ?? r) };';
  assert.equal(findUnformattedSendTelegramCalls(content).length, 0);
});

test('findUnformattedSendTelegramCalls: 콜백 정의와 무관한 곳의 raw sendTelegram(text)는 잡힘(2026-09-14 코드리뷰 지적 — 예전엔 파일 전체 검사라 놓쳤음)', () => {
  const content = [
    'const o = { sendMessage: (text) => sendTelegram(text).then((r) => r) };',
    'const text = `완전히 포맷 안 된 원문`;',
    'await sendTelegram(text);',
  ].join('\n');
  const violations = findUnformattedSendTelegramCalls(content);
  assert.equal(violations.length, 1, '콜백 정의부는 통과하고, 무관한 두 번째 sendTelegram(text)만 위반으로 잡혀야 함');
});

test('findUnformattedSendTelegramCalls: 주석 안의 sendTelegram(...) 언급은 전부 무시(빈 괄호든 인자 있는 언급이든)', () => {
  assert.equal(findUnformattedSendTelegramCalls('// MCP 없이 sendTelegram()으로 직접 발송').length, 0);
  assert.equal(findUnformattedSendTelegramCalls('// 예전엔 sendTelegram(alertMsg)로 직접 보냈다').length, 0);
  assert.equal(findUnformattedSendTelegramCalls('/* sendTelegram(rawText) 안티패턴 예시 */').length, 0);
});

test('scripts/jobs·scripts/tools·scripts/lib 전수 — sendTelegram() 호출은 전부 표준 포맷터를 거쳐야 함', () => {
  const offenders = [];
  for (const filePath of listScriptFiles()) {
    const content = readFileSync(filePath, 'utf8');
    for (const v of findUnformattedSendTelegramCalls(content)) {
      offenders.push(`${filePath}: ${v.snippet}`);
    }
  }
  assert.deepEqual(offenders, [], `표준 포맷터(formatFactsMessage/formatDepartmentMessage)를 안 거치는 sendTelegram() 호출 발견:\n${offenders.join('\n')}`);
});
