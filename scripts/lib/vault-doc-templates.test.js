import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  checkDevRequestBody, checkLogEntry, docTemplateWarning, renderDevRequest, renderLogEntry,
} from './vault-doc-templates.mjs';
import { lintVault } from './vault-registry.mjs';
import { decideWrite } from '../hooks/vault-write-gate.mjs';

const REL = '40_Projects/p/Requests/2026-11-07 시험 요청.md';
const make = () => renderDevRequest({
  title: '시험 요청', category: '[[01_Home/500 기술]]', date: '2026-11-07', description: '시험', requestedVia: '제우스 세션',
  what: '무언가를 한다', why: '이유', done: ['테스트 통과', '문서 갱신'], ownerGod: 'zeus',
});

test('renderDevRequest: 양식을 충족하고 머리말이 갖춰진다', () => {
  const doc = make();
  assert.deepEqual(checkDevRequestBody(doc), []);
  assert.match(doc, /^---\ntype: "dev-request"\n/);
  assert.match(doc, /nextCheck: "2026-11-14"/);
  assert.match(doc, /## 완료 기준\n- 테스트 통과\n- 문서 갱신\n/);
});

test('checkDevRequestBody: 빠진 절을 알려주고 옛 제목(별칭·괄호)은 인정한다', () => {
  assert.deepEqual(checkDevRequestBody('# 제목\n## 무엇을\nx'), ['왜', '완료 기준']);
  assert.deepEqual(checkDevRequestBody('## 오너 요청 (2026-11-06)\n## 배경\n## 완료 조건\n'), []);
  assert.deepEqual(checkDevRequestBody('## 왜(오너 원문)\n## 무엇이 필요한가\n## 완료\n'), []);
  assert.deepEqual(checkDevRequestBody('## 완료 처리\n').includes('완료 기준'), true, '완료 처리는 완료 기준이 아니다');
});

test('renderLogEntry: 항목 양식을 충족, checkLogEntry는 빠진 불릿을 짚는다', () => {
  const entry = renderLogEntry({ time: '14:05', topic: '양식 정리', did: '양식을 정했다', evidence: ['abc1234 커밋'], remaining: '없음' });
  assert.match(entry, /^### 14:05 양식 정리\n- 한 일: 양식을 정했다\n- 근거·커밋:\n {2}- abc1234 커밋\n- 남은 것: 없음\n$/);
  assert.deepEqual(checkLogEntry(entry), []);
  assert.deepEqual(checkLogEntry(`${entry}\n### 15:00 둘째\n- 한 일: x\n`), ['"15:00 둘째" 항목에 빠진 불릿: 근거·커밋, 남은 것']);
  assert.match(checkLogEntry('- 그냥 목록\n')[0], /항목 제목 없음/);
});

test('docTemplateWarning: 요청 기록·로그만 대상, 충족이면 null', () => {
  assert.equal(docTemplateWarning(REL, make()), null);
  assert.match(docTemplateWarning(REL, make().replace('## 왜\n이유\n\n', '')), /## 왜 절 없음[\s\S]*문서 본문 양식/);
  assert.equal(docTemplateWarning('20_Records/21_Notes/2026/2026-11-07 메모.md', '---\ntype: "note"\n---\n본문'), null);
  assert.match(docTemplateWarning('60_Logs/Zeus/2026/2026-11-07 주제.md', '---\ntype: "session-log"\n---\n- 목록'), /항목 제목 없음/);
});

const REGISTRY = `## 2. 등록표

| type | 경로 | 제목 | 필수 | 쓰는 주체 |
|---|---|---|---|---|
| \`dev-request\` | \`40_Projects/{프로젝트}/Requests/\` | \`YYYY-MM-DD 내용\` | C + \`status\` · \`requestedVia\` | 개발 세션 |
${Array.from({ length: 20 }, (_, i) => `| \`t${i}\` | \`x${i}/\` | 자유 | S |`).join('\n')}

## 3. 검사 규칙
`;

test('decideWrite: 새 요청 기록의 양식 누락은 막지 않고 warning만, 기존 파일 수정이면 경고 없음', () => {
  const bare = make().replace(/## 왜[\s\S]*?(?=## 완료)/, '');
  const fresh = decideWrite({ relPath: REL, content: bare, registryText: REGISTRY, isNew: true });
  assert.equal(fresh.block, false);
  assert.match(fresh.warning, /## 왜 절 없음/);
  assert.deepEqual(decideWrite({ relPath: REL, content: bare, registryText: REGISTRY, isNew: false }), { block: false });
  assert.deepEqual(decideWrite({ relPath: REL, content: make(), registryText: REGISTRY, isNew: true }), { block: false });
});

test('훅 실행: 임시 볼트에서 새 요청 기록의 양식 누락은 종료 0 + additionalContext 경고', () => {
  const vault = mkdtempSync(join(tmpdir(), 'tpl-vault-'));
  try {
    mkdirSync(join(vault, '90_Delphi/Schema'), { recursive: true });
    writeFileSync(join(vault, '90_Delphi/Schema/경로 등록부.md'), REGISTRY);
    const hook = new URL('../hooks/vault-write-gate.mjs', import.meta.url).pathname;
    const file = join(vault, REL);
    const r = spawnSync('node', [hook], {
      input: JSON.stringify({ tool_name: 'Write', tool_input: { file_path: file, content: make().replace(/## 완료 기준[\s\S]*$/, '') } }),
      encoding: 'utf8', env: { ...process.env, VAULT_PATH: vault },
    });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');
    assert.match(out.hookSpecificOutput.additionalContext, /## 완료 기준 절 없음/);
  } finally { rmSync(vault, { recursive: true, force: true }); }
});

test('lintVault: 시행일 이후 요청 기록만 양식 경고(위반 results에는 넣지 않음)', () => {
  const vault = mkdtempSync(join(tmpdir(), 'tpl-lint-'));
  try {
    mkdirSync(join(vault, '90_Delphi/Schema'), { recursive: true });
    writeFileSync(join(vault, '90_Delphi/Schema/경로 등록부.md'), REGISTRY);
    mkdirSync(join(vault, '40_Projects/p/Requests'), { recursive: true });
    const bare = (d) => make().replace('2026-11-07', d).split('# 시험 요청')[0] + '# 시험 요청\n본문\n';
    writeFileSync(join(vault, '40_Projects/p/Requests/2026-11-07 새 요청.md'), bare('2026-11-07'));
    writeFileSync(join(vault, '40_Projects/p/Requests/2026-11-06 옛 요청.md'), bare('2026-11-06'));
    const { warnings } = lintVault(vault);
    assert.deepEqual(warnings.map((w) => w.rel), ['40_Projects/p/Requests/2026-11-07 새 요청.md']);
    assert.match(warnings[0].warning, /## 무엇을 절 없음/);
  } finally { rmSync(vault, { recursive: true, force: true }); }
});
