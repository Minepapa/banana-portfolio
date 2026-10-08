// 무세이온 색인 자동 생성(이관 3-5, 2026-10-08).
//
// 90_Delphi/index.md의 키워드 표(위키 질문 승인 흐름이 직접 쓰는 사람용 색인)는 건드리지 않고,
// 파일 끝의 자동 구역(AUTO_START~AUTO_END)만 다시 만든다. 01_Home의 분류 노트도 같은 방식으로
// 자동 구역에 그 분류의 노트 목록을 채운다(D12: 분류 노트는 색인만, 종합은 Wiki).
// 내용이 같으면 파일을 쓰지 않는다 — 야간 백업 잡이 매일 부르므로 불필요한 변경·동기화를 만들지 않기 위해서다.
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { VAULT_REL } from './vault-paths.mjs';
import { MOUSEION_TOP_FOLDERS } from './vault-layout.mjs';

export const AUTO_START = '<!-- AUTO-INDEX:START — 이 구역은 야간 잡이 다시 만든다. 손으로 고치지 않는다 -->';
export const AUTO_END = '<!-- AUTO-INDEX:END -->';

// 기계 데이터(95_)와 금고(99_)는 색인하지 않는다. 폴더 이름은 vault-layout 상수에서 번호로 찾는다(경로 리터럴 금지 규칙).
const topFolder = (prefix) => MOUSEION_TOP_FOLDERS.find((f) => f.startsWith(prefix));
const HOME_FOLDER = topFolder('01_');
const SKIP_TOP = new Set([topFolder('95_'), topFolder('99_')]);

function walkMarkdown(root) {
  const out = [];
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (dir === root && SKIP_TOP.has(entry.name)) continue;
        visit(abs);
      } else if (entry.name.endsWith('.md')) {
        out.push(relative(root, abs).split(sep).join('/'));
      }
    }
  };
  visit(root);
  return out.sort();
}

function frontmatterOf(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return {};
  const fm = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^(\w+):\s*(.*)$/);
    if (kv) fm[kv[1]] = kv[2].trim();
  }
  return fm;
}

const unquote = (v) => (v ?? '').replace(/^"(.*)"$/, '$1');
const noteName = (rel) => rel.replace(/\.md$/, '');
const wikilink = (rel, label) => `[[${noteName(rel)}${label ? `|${label}` : ''}]]`;

export function parseCategories(value) {
  if (!value) return [];
  const prefix = `[[${HOME_FOLDER}/`;
  return value.split(prefix).slice(1).map((part) => part.split(/[\]|]/)[0]);
}

export function collectNotes(root) {
  return walkMarkdown(root).map((rel) => {
    const fm = frontmatterOf(readFileSync(join(root, rel), 'utf8'));
    return {
      rel,
      type: unquote(fm.type),
      status: unquote(fm.status),
      description: unquote(fm.description),
      decisionKey: unquote(fm.decisionKey),
      objectKind: unquote(fm.objectKind),
      categories: parseCategories(fm.category),
    };
  });
}

// 자동 구역 교체. 표시선이 없으면 끝에 붙인다. 표시선이 하나만 있으면 손상으로 보고 오류.
export function replaceAutoBlock(text, block) {
  const s = text.indexOf(AUTO_START);
  const e = text.indexOf(AUTO_END);
  const wrapped = `${AUTO_START}\n${block.trim()}\n${AUTO_END}`;
  if (s < 0 && e < 0) return `${text.replace(/\s*$/, '')}\n\n${wrapped}\n`;
  if (s < 0 || e < 0 || e < s) throw new Error('자동 색인 표시선이 손상됐습니다(시작·끝 짝이 맞지 않음)');
  return `${text.slice(0, s)}${wrapped}${text.slice(e + AUTO_END.length)}`;
}

export function buildIndexBlock(notes) {
  const lines = ['## 자동 색인', '', '야간 잡이 볼트를 훑어 만든 목록이다. 키워드 표(위)는 사람이 관리하고, 이 구역은 자동이다.', ''];
  const cats = new Map();
  for (const n of notes) for (const c of n.categories) cats.set(c, (cats.get(c) ?? 0) + 1);
  lines.push('### 분류별 노트 수', '');
  for (const n of notes.filter((x) => x.type === 'category').sort((a, b) => a.rel.localeCompare(b.rel))) {
    const name = noteName(n.rel).split('/').pop();
    lines.push(`- ${wikilink(n.rel, name)} — ${cats.get(name) ?? 0}개`);
  }
  const decisions = notes.filter((n) => n.decisionKey && n.status === '결정됨').sort((a, b) => a.decisionKey.localeCompare(b.decisionKey));
  lines.push('', '### 정본 결정 (decisionKey)', '');
  for (const d of decisions) lines.push(`- \`${d.decisionKey}\` → ${wikilink(d.rel)}`);
  const features = notes.filter((n) => n.rel.startsWith(`${VAULT_REL.projectFeatures}/`));
  lines.push('', '### 기능 허브', '');
  for (const f of features) lines.push(`- ${wikilink(f.rel, noteName(f.rel).split('/').pop())}${f.description ? ` — ${f.description}` : ''}`);
  const objects = notes.filter((n) => n.rel.startsWith(`${VAULT_REL.wikiObjects}/`));
  const byKind = new Map();
  for (const o of objects) {
    const k = o.objectKind || '기타';
    if (!byKind.has(k)) byKind.set(k, []);
    byKind.get(k).push(o);
  }
  lines.push('', '### 대상(33_Objects)', '');
  for (const [k, list] of [...byKind.entries()].sort()) {
    lines.push(`- **${k}** (${list.length}): ${list.map((o) => wikilink(o.rel, noteName(o.rel).split('/').pop())).join(' · ')}`);
  }
  const tops = new Map();
  for (const n of notes) {
    const t = n.rel.split('/')[0];
    tops.set(t, (tops.get(t) ?? 0) + 1);
  }
  lines.push('', '### 폴더별 노트 수 (기계 데이터·금고 제외)', '');
  for (const [t, c] of [...tops.entries()].sort()) if (MOUSEION_TOP_FOLDERS.includes(t)) lines.push(`- \`${t}\` ${c}개`);
  return lines.join('\n');
}

export function buildCategoryBlock(categoryName, notes) {
  const members = notes.filter((n) => n.categories.includes(categoryName) && n.type !== 'category');
  const groups = new Map();
  for (const n of members) {
    const g = n.rel.split('/').slice(0, 2).join('/');
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(n);
  }
  const lines = ['## 이 분류의 노트', '', `총 ${members.length}개. 야간 잡이 머리말 \`category\`를 보고 만든다.`, ''];
  for (const [g, list] of [...groups.entries()].sort()) {
    lines.push(`### \`${g}\` (${list.length})`, '');
    for (const n of list.sort((a, b) => b.rel.localeCompare(a.rel))) {
      lines.push(`- ${wikilink(n.rel, noteName(n.rel).split('/').pop())}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

// 변경된 파일 상대경로 목록을 돌려준다. apply=false면 쓰지 않는다.
export function buildVaultIndex(root, { apply = true } = {}) {
  const notes = collectNotes(root);
  const changed = [];
  const update = (rel, block) => {
    const abs = join(root, rel);
    const before = readFileSync(abs, 'utf8');
    const after = replaceAutoBlock(before, block);
    if (after !== before) {
      changed.push(rel);
      if (apply) writeFileSync(abs, after);
    }
  };
  const indexRel = VAULT_REL.knowledgeIndexFile;
  if (!existsSync(join(root, indexRel))) throw new Error(`색인 파일이 없습니다: ${indexRel}`);
  update(indexRel, buildIndexBlock(notes));
  for (const n of notes.filter((x) => x.type === 'category')) {
    update(n.rel, buildCategoryBlock(noteName(n.rel).split('/').pop(), notes));
  }
  return changed;
}
