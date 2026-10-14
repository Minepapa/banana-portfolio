import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractStringLiterals } from './string-literals.mjs';
import { AGENT_IDS, agentLabel, agentTitle, ownerOf } from './agent-registry.mjs';

// 옛 담당 이름 잔존 사고(2026-10-14): 담당 이름을 코드 문자열에 박으면 개편 때마다 사람이 grep으로 고쳐야 한다.
// 담당 이름은 헌장에서 생성한 레지스트리(agent-registry.mjs)로만 부르고, 이름이 필요 없는 곳은 지운다.
const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const CURRENT = AGENT_IDS.flatMap((id) => [agentTitle(id), id[0].toUpperCase() + id.slice(1)]);
const LEGACY = ['Kairos', 'Apollo', '카이로스', '아폴로', '투자전략실', '퀀트전략실', '운영실', '비서실', '리스크관리실'];
const NAME_RE = new RegExp([...CURRENT, ...LEGACY].join('|'));

// 정당한 예외: 생성기(헌장 → 생성물)·레지스트리·옛 지침 치환표·생성 파일.
const EXEMPT_FILES = [
  'scripts/tools/build-agent-defs.mjs',
  'scripts/lib/agent-registry.mjs',
  'scripts/lib/string-literals.mjs',
];
const EXEMPT_FILE_RE = /agent-legacy-|\.generated\./;
// 볼트 폴더 이름(60_Logs/Zeus 등)은 담당 이름이 아니라 경로다. 볼트 폴더(NN_)로 시작하고 공백 없는 문자열만 경로로 본다.
const isPath = (text) => !/\s/.test(text) && /^\d{2}_[^/]*\//.test(text);
// 경로를 조각으로 join하는 곳(vault-paths의 '60_Logs', 'Zeus', 'Telegram').
const EXEMPT_LITERALS = [{ file: 'scripts/lib/vault-paths.mjs', text: 'Zeus' }];

function sourceFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    if (name === 'node_modules' || name.startsWith('.')) return [];
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(mjs|js|jsx)$/.test(name) && !/\.test\./.test(name) ? [path] : [];
  });
}

export function findNameLiterals(root = ROOT) {
  const hits = [];
  for (const path of [...sourceFiles(join(root, 'scripts')), ...sourceFiles(join(root, 'src'))]) {
    const rel = relative(root, path);
    if (EXEMPT_FILES.includes(rel) || EXEMPT_FILE_RE.test(rel)) continue;
    for (const literal of extractStringLiterals(readFileSync(path, 'utf8'))) {
      if (!NAME_RE.test(literal.text) || isPath(literal.text)) continue;
      if (EXEMPT_LITERALS.some((item) => item.file === rel && item.text === literal.text)) continue;
      hits.push(`${rel}:${literal.line}: ${literal.text.replace(/\s+/g, ' ').slice(0, 80)}`);
    }
  }
  return hits;
}

test('scripts·src 문자열에 담당 이름(현행·옛)을 박지 않는다 — 레지스트리로 부르거나 지운다', () => {
  assert.deepEqual(findNameLiterals(), []);
});

test('리터럴 추출: 주석·정규식은 건너뛰고 따옴표·템플릿 문자열만 뽑는다', () => {
  const source = [
    "// '주석 안 문자열'",
    "/* `블록 주석` */",
    "const a = '작은따옴표'; const b = \"큰따옴표\";",
    "const re = /it's a regex/; const c = x / y / z;",
    "const d = 'a' / 2; const e = '뒤';",
    "const t = `앞 ${f('안쪽')} 뒤`;",
  ].join('\n');
  assert.deepEqual(extractStringLiterals(source).map((item) => item.text), ['작은따옴표', '큰따옴표', 'a', '뒤', '앞 ', '안쪽', ' 뒤']);
  assert.deepEqual(extractStringLiterals("x = 1;\ny = 'two';").map((item) => item.line), [2]);
});

test('레지스트리: 담당 6인 라벨과 업무 → 담당 표', () => {
  assert.deepEqual(AGENT_IDS, ['zeus', 'clio', 'themis', 'hermes', 'athena', 'plutus']);
  for (const id of AGENT_IDS) assert.equal(agentLabel(id), `${agentTitle(id)} ${id[0].toUpperCase()}${id.slice(1)}`);
  assert.ok(AGENT_IDS.includes(ownerOf('거시 위험 트리거')));
  assert.throws(() => ownerOf('없는 업무'), /담당 없는 업무/);
  assert.throws(() => agentTitle('kairos'), /미등록 담당/);
});
