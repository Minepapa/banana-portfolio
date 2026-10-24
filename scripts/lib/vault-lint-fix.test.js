import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseFrontmatter } from './vault-frontmatter.mjs';
import { parseRegistry } from './vault-registry.mjs';
import {
  autoFixVault, lintVaultWithSuggestions, recordFixesInClioLog, safeFixWorkDoc, splitWaitingOn, suggestFixes,
  WAITING_ON_PROBLEM,
} from './vault-lint-fix.mjs';

const REGISTRY = `## 2. 등록표

| type | 경로 | 제목 | 필수 | 쓰는 주체 |
|---|---|---|---|---|
| \`dev-request\` | \`40_Projects/{프로젝트}/Requests/\` | \`YYYY-MM-DD 내용\` | C + \`status\` · \`requestedVia\` | 개발 세션 |
| \`note\` | \`20_Records/21_Notes/{YYYY}/\` | \`YYYY-MM-DD 내용\` | C | 클리오 |
| \`agent-log\` | \`60_Logs/{에이전트}/\` | 자유 | S | 각 에이전트 |
${Array.from({ length: 20 }, (_, i) => `| \`t${i}\` | \`x${i}/\` | 자유 | S |`).join('\n')}

## 3. 검사 규칙
`;
const REL = '40_Projects/p/Requests/2026-10-23 요청.md';
const doc = (waitingOn, extra = '') => `---\ntype: "dev-request"\ncategory: ["[[01_Home/500 기술]]"]\ndescription: "d"\nsensitivity: "일반"\ncreated: "2026-10-23"\nmodified: "2026-10-23"\nstatus: "보류"\nwaitingOn: ${JSON.stringify(waitingOn)}\nnextCheck: "2026-10-29"\n${extra}requestedVia: "개발 세션"\n---\n# 본문\n`;

function makeVault() {
  const root = mkdtempSync(join(tmpdir(), 'lintfix-'));
  mkdirSync(join(root, '90_Delphi/Schema'), { recursive: true });
  writeFileSync(join(root, '90_Delphi/Schema/경로 등록부.md'), REGISTRY);
  mkdirSync(join(root, '40_Projects/p/Requests'), { recursive: true });
  return root;
}
const old = (path) => utimesSync(path, new Date(Date.now() - 3600_000), new Date(Date.now() - 3600_000));

test('splitWaitingOn: 허용값으로 시작할 때만 값과 나머지 설명을 나눈다', () => {
  assert.deepEqual(splitWaitingOn('데이터 축적(병행 비교 10-24 시작)'), { value: '데이터 축적', rest: '병행 비교 10-24 시작' });
  assert.deepEqual(splitWaitingOn('오너 판단 — 10-29 점검'), { value: '오너 판단', rest: '10-29 점검' });
  assert.deepEqual(splitWaitingOn('외부'), { value: '외부', rest: '' });
  assert.equal(splitWaitingOn('외부인 답변'), null, '낱말이 이어지면 허용값이 아니다');
  assert.equal(splitWaitingOn('오너 확인 3건 뒤 착수'), null, '해석이 필요한 자유서술은 자동 수정 대상 아님');
  assert.equal(splitWaitingOn(undefined), null);
});

test('safeFixWorkDoc: 설명을 statusDetail로 옮기고 원래 글자를 보존한다', () => {
  const fix = safeFixWorkDoc(REL, doc('데이터 축적 — 병행 비교'), { today: '2026-10-25' });
  const f = parseFrontmatter(fix.content);
  assert.equal(f.waitingOn, '데이터 축적');
  assert.equal(f.statusDetail, '병행 비교');
  assert.equal(f.modified, '2026-10-25');
  assert.match(fix.content, /# 본문\n$/);
  const merged = parseFrontmatter(safeFixWorkDoc(REL, doc('외부: 업체 회신', 'statusDetail: "1단계 끝"\n')).content);
  assert.equal(merged.statusDetail, '업체 회신. 1단계 끝');
});

test('safeFixWorkDoc: 고칠 수 없거나 고칠 것 없으면 null', () => {
  assert.equal(safeFixWorkDoc(REL, doc('오너 판단')), null, '이미 허용값');
  assert.equal(safeFixWorkDoc(REL, doc('오너 확인 3건 + 착수')), null, '해석 필요');
  assert.equal(safeFixWorkDoc('20_Records/21_Notes/2026/2026-10-23 a.md', doc('외부 — x')), null, '작업 문서 아님');
  assert.equal(safeFixWorkDoc(REL, doc('외부 — x').replace('"보류"', '"완료"')), null, '닫힌 문서는 대상 아님');
  assert.equal(safeFixWorkDoc(REL, doc('외부 — x', 'statusDetail: |\n  여러 줄\n')), null, '여러 줄 statusDetail은 손대지 않음');
});

test('suggestFixes: waitingOn·nextCheck·type·제목 추천, 확신 없으면 일반 안내', () => {
  const rules = parseRegistry(REGISTRY);
  const s = (rel, content, problems) => suggestFixes(rel, content, problems, rules, { today: '2026-10-24' });
  assert.deepEqual(s(REL, doc('오너 확인 3건(10-29) + 기준 동결 뒤 착수'), [WAITING_ON_PROBLEM]), ['waitingOn "오너 판단", 원래 설명은 statusDetail로']);
  assert.deepEqual(s(REL, doc('병행 수집·비교(2026-10-24 시작)'), [WAITING_ON_PROBLEM]), ['waitingOn "데이터 축적", 원래 설명은 statusDetail로']);
  assert.match(s(REL, doc('???'), [WAITING_ON_PROBLEM])[0], /중 하나로/);
  assert.deepEqual(s(REL, doc('외부'), ['작업 문서 nextCheck 없음 또는 유효한 날짜 아님']), ['nextCheck "2026-10-31"(일주일 뒤)']);
  assert.deepEqual(s('40_Projects/p/Requests/2026-10-23 x.md', '본문', ['type 없음']), ['type "dev-request"']);
  assert.deepEqual(s('태블릿 동기화 시험.md', '테스트', ['type 없음']), ['볼트 맨 위 노트 — 00_Inbox로 옮기거나 삭제 판단']);
  assert.deepEqual(s('40_Projects/p/Requests/요청.md', doc('외부'), ['제목 형식 위반(dev-request)']), ['제목 "2026-10-23 요청"']);
});

test('autoFixVault: 오래된 안전 대상만 고치고, 최근 파일·해석 필요 파일은 그대로', () => {
  const root = makeVault();
  try {
    const a = join(root, REL);
    const b = join(root, '40_Projects/p/Requests/2026-10-23 최근.md');
    const c = join(root, '40_Projects/p/Requests/2026-10-23 해석.md');
    writeFileSync(a, doc('데이터 축적 — 병행 비교')); old(a);
    writeFileSync(b, doc('데이터 축적 — 방금 씀'));
    writeFileSync(c, doc('오너 확인 3건 + 착수')); old(c);
    const dry = autoFixVault(root, { dryRun: true });
    assert.equal(dry.length, 1);
    assert.equal(parseFrontmatter(readFileSync(a, 'utf8')).waitingOn, '데이터 축적 — 병행 비교', 'dryRun은 쓰지 않는다');
    const fixed = autoFixVault(root);
    assert.deepEqual(fixed.map((f) => f.rel), [REL]);
    assert.equal(parseFrontmatter(readFileSync(a, 'utf8')).statusDetail, '병행 비교');
    assert.equal(parseFrontmatter(readFileSync(b, 'utf8')).waitingOn, '데이터 축적 — 방금 씀');
    const { results } = lintVaultWithSuggestions(root);
    assert.deepEqual(results.map((r) => r.rel).filter((r) => r.startsWith('40_')).sort(), ['40_Projects/p/Requests/2026-10-23 최근.md', '40_Projects/p/Requests/2026-10-23 해석.md']);
    assert.ok(results.every((r) => r.suggestions.length));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('recordFixesInClioLog: 월간 기록에 그날 구역을 새로 쓰고 다시 쓰면 바꿔 끼운다', () => {
  const root = makeVault();
  try {
    const now = Date.parse('2026-10-24T15:00:00Z'); // KST 10-25 00:00
    const rel = recordFixesInClioLog(root, [{ rel: REL, changes: ['a'] }], { now });
    assert.equal(rel, '60_Logs/Clio/2026-10.md');
    recordFixesInClioLog(root, [{ rel: REL, changes: ['b'] }], { now });
    const text = readFileSync(join(root, rel), 'utf8');
    assert.equal(text.match(/vault-autofix:2026-10-25:start/g).length, 1);
    assert.match(text, /b\n<!-- vault-autofix:2026-10-25:end -->/);
    assert.equal(parseFrontmatter(text).type, 'agent-log');
    assert.equal(recordFixesInClioLog(root, [], { now }), null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('리뷰 회귀(2026-10-24): 해석이 갈리거나 머리말이 깨질 수 있는 경우는 자동 수정하지 않는다', () => {
  assert.equal(splitWaitingOn('오너 판단 불필요, 외부 업체 답변'), null, '공백만 있는 구분자');
  assert.equal(splitWaitingOn('착수 대기 중'), null);
  assert.equal(splitWaitingOn('오너 판단 — 불필요'), null, '부정어');
  assert.equal(splitWaitingOn('외부\t업체'), null, '제어문자');
  assert.deepEqual(splitWaitingOn('외부 (업체 A) 그리고 (업체 B)'), { value: '외부', rest: '(업체 A) 그리고 (업체 B)' }, '괄호 짝 보존');
  const continued = doc('외부 — 업체').replace('nextCheck:', '  답변 대기\nnextCheck:');
  assert.equal(safeFixWorkDoc(REL, continued), null, '들여쓴 이어지는 줄');
  const joined = parseFrontmatter(safeFixWorkDoc(REL, doc('외부 — 회신 옴.', 'statusDetail: "기존"\n')).content);
  assert.equal(joined.statusDetail, '회신 옴. 기존', '문장부호 겹치지 않음');
});

test('리뷰 회귀: 추천안은 자동 수정과 같은 값을 먼저 낸다', () => {
  const rules = parseRegistry(REGISTRY);
  assert.deepEqual(suggestFixes(REL, doc('외부 — 업체 확인 대기'), [WAITING_ON_PROBLEM], rules), ['waitingOn "외부", 원래 설명은 statusDetail로']);
});

test('리뷰 회귀: 파일 하나가 실패해도 나머지는 고치고 실패는 skipped로', () => {
  const root = makeVault();
  try {
    const a = join(root, REL);
    const b = join(root, '40_Projects/p/Requests/2026-10-23 둘.md');
    writeFileSync(a, doc('외부 — 하나')); old(a);
    writeFileSync(b, doc('외부 — 둘')); old(b);
    let calls = 0;
    const fixed = autoFixVault(root, { write: (path, text) => { calls += 1; if (calls === 1) throw new Error('디스크'); writeFileSync(path, text); } });
    assert.equal(fixed.length, 1);
    assert.equal(fixed.skipped.length, 1);
    assert.match(fixed.skipped[0].error, /디스크/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('리뷰 회귀: 같은 날 두 번 기록하면 앞 항목을 지우지 않고 덧붙인다', () => {
  const root = makeVault();
  try {
    const now = Date.parse('2026-10-24T03:00:00Z');
    recordFixesInClioLog(root, [{ rel: REL, changes: ['a'] }], { now });
    recordFixesInClioLog(root, [{ rel: REL, changes: ['b'] }, { rel: REL, changes: ['a'] }], { now });
    const text = readFileSync(join(root, '60_Logs/Clio/2026-10.md'), 'utf8');
    assert.equal(text.match(/^- \[\[/gm).length, 2);
    assert.match(text, /: a\n- \[\[.*: b\n<!-- vault-autofix/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
