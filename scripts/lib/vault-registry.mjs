// 경로 등록부(볼트 `90_Delphi/Schema/경로 등록부`)를 코드로 읽어 노트 한 개가 규칙에 맞는지 검사한다(D48 쓰기 관문).
// 등록부의 마크다운 표가 정본이다 — 규칙을 여기 하드코딩하지 않고 표에서 읽는다. 표 형식이 깨지면 throw한다.
// 쓰기 관문 훅·lint가 같은 checkNote를 쓴다. 순수함수(파일 읽기는 호출측).
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parseFlatFrontmatter } from './vault-integrity-audit.mjs';
import { VAULT_REL } from './vault-paths.mjs';

const BUNDLES = {
  C: ['type', 'category', 'description', 'sensitivity', 'created', 'modified'],
  S: ['type', 'description', 'created', 'modified'],
};

// 필수 칸이 묶음·필드 목록이 아닌 특수 type — 이 검사기는 위치만 본다.
const LOCATION_ONLY = new Set(['agent', 'index', 'secret']);

const TITLE_PATTERNS = [
  [/^`YYYY-MM-DD`$/, /^\d{4}-\d{2}-\d{2}$/],
  [/^`YYYY-Www`$/, /^\d{4}-W\d{2}$/],
  [/^`YYYY-MM`$/, /^\d{4}-\d{2}$/],
  [/^`YYYY`$/, /^\d{4}$/],
  [/^`YYYY-MM-DD [^`]+`/, /^\d{4}-\d{2}-\d{2} \S/],
];

function cells(line) {
  return line.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
}

function backticked(text) {
  return [...text.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
}

// 괄호 안 설명((`place`는 …), (최소 묶음…))은 필수 필드가 아니다.
function stripParens(text) {
  let prev;
  let out = text;
  do { prev = out; out = out.replace(/\([^()]*\)/g, ''); } while (out !== prev);
  return out;
}

function pathToRegex(pathCell) {
  const raw = backticked(pathCell)[0];
  if (!raw) return null;
  const isFile = raw.endsWith('.md');
  const body = raw.replace(/\/$/, '').split(/(\{[^}]+\})/).map((part) => {
    if (part === '{YYYY}') return '\\d{4}';
    const alt = part.match(/^\{([^}]+,[^}]+)\}$/);
    if (alt) return `(?:${alt[1].split(',').map((s) => s.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`;
    if (/^\{[^}]+\}$/.test(part)) return '[^/]+';
    return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }).join('');
  return { raw, regex: new RegExp(isFile ? `^${body}$` : `^${body}/[^/]+\\.md$`) };
}

function titleRule(titleCell) {
  for (const [cellPattern, nameRegex] of TITLE_PATTERNS) if (cellPattern.test(titleCell)) return nameRegex;
  return null; // 자유·이름·명사구 등은 형식 검사 없음
}

// 바로 뒤 괄호가 조건을 말하는 필드(`parent`(하위 분류), `repo`(코드면), `supersedes`(…, 있으면))는 필수가 아니다.
const CONDITIONAL = /^\((?:하위|[^)]*(?:있으면|코드면|선택|있을 때만))/;
function conditionalFields(requiredCell) {
  return [...requiredCell.matchAll(/`([^`]+)`\s*(\([^)]*\))?/g)]
    .filter((m) => m[2] && !m[2].includes('`') && CONDITIONAL.test(m[2])).map((m) => m[1]);
}

// 묶음(C·S) 필드와 type별 추가 필드를 나눠 돌려준다. 추가 필드는 시행일 이후 노트에만 적용한다(등록부 1절, 오너 승인).
function requiredFields(requiredCell) {
  const optional = new Set(conditionalFields(requiredCell));
  const text = stripParens(requiredCell);
  const bundle = text.match(/^\s*([CS])\b/)?.[1];
  const bundleFields = bundle ? BUNDLES[bundle] : [];
  const extra = backticked(text).filter((f) => !bundleFields.includes(f) && !optional.has(f));
  return { bundle: bundleFields, extra: [...new Set(extra)] };
}

export const EXTRA_FIELDS_FROM = '2026-10-08';

export function parseRegistry(markdown) {
  const section = markdown.split(/^## 3\. /m)[0];
  const rules = [];
  const lines = section.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const header = lines[i].trim();
    if (!header.startsWith('| type |')) continue;
    const cols = cells(header);
    const idx = (name) => cols.indexOf(name);
    if (idx('type') < 0 || idx('경로') < 0 || idx('제목') < 0 || idx('필수') < 0) throw new Error(`경로 등록부 표 머리 형식 이상: ${header}`);
    for (let j = i + 2; j < lines.length && lines[j].trim().startsWith('|'); j += 1) {
      const row = cells(lines[j]);
      // 필수 네 칸(type·경로·제목·필수)이 모자란 행은 건너뛴다(한 행 오류로 전체 쓰기가 막히지 않게)
      if (row.length <= Math.max(idx('type'), idx('경로'), idx('제목'), idx('필수'))) continue;
      const types = backticked(row[idx('type')]);
      const path = pathToRegex(row[idx('경로')]);
      if (!types.length || !path) continue; // (보관)·(데이터셋별) 행은 type이 없거나 원래 type을 유지
      for (const type of types) {
        rules.push({
          type,
          path: path.raw,
          pathRegex: path.regex,
          titleRegex: titleRule(row[idx('제목')]),
          required: LOCATION_ONLY.has(type) ? { bundle: [], extra: [] } : requiredFields(row[idx('필수')]),
          writer: idx('쓰는 주체') >= 0 ? (row[idx('쓰는 주체')] ?? '') : '',
        });
      }
    }
  }
  if (rules.length < 20) throw new Error(`경로 등록부에서 읽은 type이 너무 적음(${rules.length}) — 표 형식 확인 필요`);
  return rules;
}

// 값이 있는 필드인지 — 한 줄 값이나 다음 줄 목록(`  - 값`)을 인정한다. 빈 배열 `[]`은 "해당 없음"을 명시한 값으로
// 인정한다(예: 관련 결정이 없는 기능의 decisionKeys). 빈 문자열·null은 값이 없는 것으로 본다.
function hasField(content, field) {
  const block = content.replace(/^\uFEFF/, '').match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1];
  if (!block) return false;
  const lines = block.split(/\r?\n/);
  const i = lines.findIndex((l) => l.startsWith(`${field}:`));
  if (i < 0) return false;
  const value = lines[i].slice(field.length + 1).trim();
  if (value && !['""', "''", 'null', '~'].includes(value)) return true;
  return /^\s+-\s*\S/.test(lines[i + 1] ?? '');
}

// relPath: 볼트 루트 기준 경로(예: '50_Outputs/Decisions/2026-10-08 x.md').
// 반환: 위반 목록(빈 배열이면 통과). 검사 범위는 등록부 3절의 1~4번 중 구조 항목(type·경로·제목·필수 필드 존재).
// 허용값 검사는 기존 vault-integrity-audit(상태표준)가 맡는다.
export function checkNote(relPath, content, rules) {
  if (relPath.startsWith(`${VAULT_REL.inboxRoot}/`)) return []; // 사람(폰·옵시디언) 입력 — 클리오 ingest가 머리말을 채운다(등록부 3절)
  const fm = parseFlatFrontmatter(content.replace(/^\uFEFF/, '')) ?? {};
  const name = relPath.split('/').pop().replace(/\.md$/, '');
  const type = fm.type;
  if (!type) return ['type 없음'];
  const candidates = rules.filter((r) => r.type === type);
  if (!candidates.length) return [`등록되지 않은 type "${type}"`];
  const rule = candidates.find((r) => r.pathRegex.test(relPath));
  if (!rule) return [`type "${type}"의 경로가 아님(허용: ${candidates.map((r) => r.path).join(', ')})`];
  const problems = [];
  if (rule.titleRegex && !rule.titleRegex.test(name)) problems.push(`제목 형식 위반(${type})`);
  const created = String(fm.created ?? '').slice(0, 10);
  const applyExtra = !rule.required.bundle.length || !created || created >= EXTRA_FIELDS_FROM;
  const fields = [...rule.required.bundle, ...(applyExtra ? rule.required.extra : [])];
  const missing = fields.filter((f) => !hasField(content, f));
  if (missing.length) problems.push(`필수 필드 없음: ${missing.join(', ')}`);
  return problems;
}

// 볼트 전수 검사(D48 ③ 매일 lint) — lint CLI와 야간 backup-vault 잡이 같이 쓴다.
// 80_Archive는 원래 type을 유지한 보관본이라 등록부 검사 대상이 아니다. 볼트 루트의 CLAUDE.md·AGENTS.md는 헌법(규칙 파일).
const SKIP_TOP = new Set([VAULT_REL.archiveRoot, VAULT_REL.etnaRoot, VAULT_REL.adytonRoot]);
const ROOT_RULE_FILES = new Set(['CLAUDE.md', 'AGENTS.md']);

function walk(dir, root, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    const rel = relative(root, full);
    if (entry.isDirectory()) {
      if (!SKIP_TOP.has(rel)) walk(full, root, out);
    } else if (entry.name.endsWith('.md') && !ROOT_RULE_FILES.has(rel)) out.push(rel);
  }
  return out;
}

export function lintVault(root) {
  const rules = parseRegistry(readFileSync(join(root, VAULT_REL.registryFile), 'utf8'));
  const results = [];
  const files = walk(root, root);
  for (const rel of files) {
    const problems = checkNote(rel, readFileSync(join(root, rel), 'utf8'), rules);
    if (problems.length) results.push({ rel, problems });
  }
  return { checked: files.length, results };
}

