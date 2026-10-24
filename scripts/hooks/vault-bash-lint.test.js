import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildBashLintMessage, changedVaultNotes, lintChanged, parseStatusZ } from './vault-bash-lint.mjs';

const REGISTRY = `## 2. 등록표

| type | 경로 | 제목 | 필수 | 쓰는 주체 |
|---|---|---|---|---|
| \`dev-request\` | \`40_Projects/{프로젝트}/Requests/\` | \`YYYY-MM-DD 내용\` | C + \`status\` · \`requestedVia\` | 개발 세션 |
${Array.from({ length: 20 }, (_, i) => `| \`t${i}\` | \`x${i}/\` | 자유 | S |`).join('\n')}

## 3. 검사 규칙
`;

test('parseStatusZ: 변경·새 파일·이름 바꾼 새 경로만, 지운 파일 제외', () => {
  const out = [' M a.md', '?? 새 폴더/b.md', 'R  c.md', 'old-c.md', ' D gone.md', 'A  d.md', ''].join('\0');
  assert.deepEqual(parseStatusZ(out), ['a.md', '새 폴더/b.md', 'c.md', 'd.md']);
});

test('changedVaultNotes: 표식 뒤에 고친 검사 대상 노트만', () => {
  const root = mkdtempSync(join(tmpdir(), 'bashlint-'));
  try {
    for (const p of ['40_Projects/p/Requests', '99_Adyton', '80_Archive']) mkdirSync(join(root, p), { recursive: true });
    const fresh = '40_Projects/p/Requests/2026-10-24 새.md';
    const stale = '40_Projects/p/Requests/2026-10-01 옛.md';
    for (const p of [fresh, stale, '99_Adyton/x.md', '80_Archive/y.md', 'z.json']) writeFileSync(join(root, p), 'x');
    utimesSync(join(root, stale), new Date(0), new Date(0));
    const status = [fresh, stale, '99_Adyton/x.md', '80_Archive/y.md', 'z.json', 'missing.md'].map((p) => `?? ${p}`).join('\0');
    assert.deepEqual(changedVaultNotes(root, Date.now() - 60_000, status), [fresh]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('lintChanged + buildBashLintMessage: 위반만 추천안과 함께 알린다', () => {
  const root = mkdtempSync(join(tmpdir(), 'bashlint-'));
  try {
    mkdirSync(join(root, '40_Projects/p/Requests'), { recursive: true });
    const bad = '40_Projects/p/Requests/2026-10-24 나쁨.md';
    writeFileSync(join(root, bad), '---\ntype: "dev-request"\ncategory: ["[[01_Home/500 기술]]"]\ndescription: "d"\nsensitivity: "일반"\ncreated: "2026-10-24"\nmodified: "2026-10-24"\nstatus: "진행중"\nwaitingOn: "병행 비교"\nnextCheck: "2026-11-01"\nrequestedVia: "개발 세션"\n---\n');
    const findings = lintChanged(root, [bad], REGISTRY, '2026-10-24');
    assert.equal(findings.length, 1);
    const msg = buildBashLintMessage(findings);
    assert.match(msg, /waitingOn 없음 또는 허용값 아님/);
    assert.match(msg, /→ 추천: waitingOn "데이터 축적"/);
    assert.equal(buildBashLintMessage([]), null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
