#!/usr/bin/env node
// 볼트 헌장을 Claude Code 에이전트 정의로 복사한다. 볼트는 읽기만 한다.
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VAULT_REL, vaultAbs } from '../lib/vault-paths.mjs';
import { applyCommonOverrides, applyLegacyOverrides, LEGACY_OVERRIDES, AGENT_SPECIFIC_OVERRIDES } from './agent-legacy-overrides.mjs';

export const AGENT_NAMES = ['zeus', 'clio', 'themis', 'hermes', 'athena', 'plutus'];
const OLD_FILES = ['kairos.md', 'apollo.md', 'PANTHEON.md'];
export { LEGACY_OVERRIDES, AGENT_SPECIFIC_OVERRIDES };
const OLD_NAMES = ['Athena', 'Kairos', 'Hermes', 'Apollo', '투자전략실', '퀀트전략실', '운영실', '비서실', '리스크관리실'];
const DEFAULT_OUT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '.claude', 'agents');

function parseVaultNote(text) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) throw new Error('볼트 헌장 머리말 없음');
  const fields = {};
  for (const line of match[1].split(/\r?\n/)) {
    const separator = line.indexOf(':');
    if (separator < 0) continue;
    const key = line.slice(0, separator);
    const raw = line.slice(separator + 1).trim();
    fields[key] = raw.startsWith('[') ? JSON.parse(raw) : raw.startsWith('"') ? JSON.parse(raw) : raw;
  }
  return { fields, body: text.slice(match[0].length).trim() };
}

function validateCharterBody(body, name) {
  const headings = [...body.matchAll(/^## ([1-9])\. ([^\n]+)$/gm)];
  const expected = ['신화적 원형', '사명', '성격', '말투', '책임', '경계', '작업 유형별 절차', '협업', '개별 금지'];
  if (headings.length !== 9 || headings.some((match, index) => Number(match[1]) !== index + 1 || match[2] !== expected[index])) {
    throw new Error(`헌장 본문 9섹션 손상: ${name}`);
  }
  if (!body.startsWith('# ') || /^## 부록/m.test(body)) throw new Error(`헌장 부록 경계 손상: ${name}`);
  const lastSection = headings.at(-1).index + headings.at(-1)[0].length;
  const history = body.indexOf('## 변경 이력', lastSection);
  if (history < 0 || !body.slice(lastSection, history).trim()) throw new Error(`헌장 부록 경계 손상: ${name}`);
}

export function renderAgent(name, { charterDir = vaultAbs(VAULT_REL.agentCharters), archiveDir = vaultAbs(VAULT_REL.archivedAgentDefs) } = {}) {
  if (!existsSync(charterDir)) throw new Error(`Agents 폴더 없음: ${charterDir}`);
  const common = parseVaultNote(readFileSync(join(charterDir, '판테온 공통 헌장.md'), 'utf8'));
  const charter = parseVaultNote(readFileSync(join(charterDir, `${name}.md`), 'utf8'));
  validateCharterBody(charter.body, name);
  const { fields } = charter;
  if (fields.name !== name || !fields.title || !fields.description || !fields.routingHint || !fields.runtimeModel || !fields.tools) {
    throw new Error(`필수 머리말 누락: ${name}`);
  }
  const appendix = (fields.legacyAppendix ?? []).map((link) => {
    const prefix = `[[${VAULT_REL.archivedAgentDefs}/`;
    const filename = link.startsWith(prefix) && link.endsWith(']]')
      ? link.slice(prefix.length, -2) : null;
    if (!filename || !/^[\w-]+$/.test(filename)) throw new Error(`잘못된 legacyAppendix 링크: ${link}`);
    let body = parseVaultNote(readFileSync(join(archiveDir, `${filename}.md`), 'utf8')).body;
    if (name === 'zeus') {
      body = body.replace(/^## 텔레그램 상시세션 프로토콜[^\n]*\n[\s\S]*?(?=^## 운영 규칙)/m,
        `텔레그램 운영 규칙은 \`${VAULT_REL.telegramChannelFile.replace(/\.md$/, '')}\`을 읽는다.\n\n`);
    }
    if (!body.startsWith('# ') || !/^## /m.test(body)) throw new Error(`보관본 부록 경계 손상: ${filename}`);
    return `### 2026-10-08 이전 구 ${filename} 지침 (현행 헌장 우선)\n\n${applyLegacyOverrides(body, name, filename)}`;
  });
  const description = `${fields.title}(${name[0].toUpperCase() + name.slice(1)}) — ${fields.description}. 이럴 때 사용: ${fields.routingHint}${name === 'zeus' ? ' 스폰하지 말 것.' : ''}`;
  const tools = name === 'zeus' ? null : `tools: ${fields.tools}\n`;
  // routingHint 안에는 콜론·따옴표가 올 수 있어 YAML 스칼라를 반드시 인용한다.
  const frontmatter = `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\nmodel: ${fields.runtimeModel}\n${tools ?? ''}---`;
  const sections = [
    `생성물 — 정본은 볼트 \`${VAULT_REL.agentCharters}/${name}\`. 손으로 고치지 말고 헌장을 고친 뒤 생성기를 다시 돌린다.`,
    applyCommonOverrides(common.body), charter.body,
    ...(appendix.length ? ['## 부록 — 구 부서 정의에서 이관한 상세 지침\n\n2026-10-08 이전 역할의 역사적 서술은 참고만 한다. 아래 역할 지시와 충돌하면 위 현행 헌장이 우선한다.', ...appendix] : []),
  ];
  return `${frontmatter}\n\n${sections.join('\n\n')}\n`;
}

export function buildAgentDefs({ check = false, outDir = DEFAULT_OUT, charterDir, archiveDir } = {}) {
  const outputs = AGENT_NAMES.map((name) => ({ name, text: renderAgent(name, { charterDir, archiveDir }) }));
  const differences = [];
  for (const { name, text } of outputs) {
    const path = join(outDir, `${name}.md`);
    if (!existsSync(path) || readFileSync(path, 'utf8') !== text) {
      differences.push(`${name}.md`);
      if (!check) writeFileSync(path, text);
    }
  }
  for (const name of OLD_FILES) {
    const path = join(outDir, name);
    if (existsSync(path)) {
      differences.push(name);
      if (!check) unlinkSync(path);
    }
  }
  const remaining = outputs.map(({ name, text }) => ({ name, matches: [...new Set(OLD_NAMES.filter((oldName) => text.includes(oldName)))], lines: text.split('\n').length - 1 }));
  return { differences, remaining };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const result = buildAgentDefs({ check: process.argv.includes('--check') });
    for (const file of result.remaining) console.log(`${file.name}.md: ${file.lines}줄, 남은 옛 이름: ${file.matches.join(', ') || '없음'}`);
    if (process.argv.includes('--check') && result.differences.length) {
      console.error(`생성 결과 불일치: ${result.differences.join(', ')}`);
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
