import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENT_IDS, agentWorkTypes } from './agent-registry.mjs';

const DEFAULT_TOOLS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'tools');
const FACTS_FILE = /^[a-z0-9][a-z0-9-]*-facts\.mjs$/;

export function readFactsMeta(path) {
  // 몇몇 CLI는 import 시 loadEnv()를 호출한다. 한 줄 JSON 리터럴만 읽어 실행 부작용을 피한다.
  const source = readFileSync(path, 'utf8');
  const literal = source.match(/^export const FACTS_META = (\{[^\r\n]+\});$/m)?.[1];
  if (!literal) throw new Error(`FACTS_META 누락 또는 JSON 한 줄 형식 오류: ${path}`);
  return JSON.parse(literal);
}

export function factsCatalog({ toolsDir = DEFAULT_TOOLS_DIR, agentIds = AGENT_IDS, workTypesFor = agentWorkTypes } = {}) {
  return readdirSync(toolsDir).filter((name) => FACTS_FILE.test(name) && name !== 'department-call-facts.mjs')
    .sort().map((filename) => {
      const meta = readFactsMeta(join(toolsDir, filename));
      if (!Array.isArray(meta.serves) || (!meta.deprecated && meta.serves.length === 0)) throw new Error(`serves 누락: ${filename}`);
      if (meta.attach !== 'always' && meta.attach !== 'on-request') throw new Error(`attach 오류: ${filename}`);
      if (!Array.isArray(meta.args) || meta.args.some((arg) => !/^--[a-z-]+$/.test(arg))) throw new Error(`args 오류: ${filename}`);
      if (typeof meta.summary !== 'string' || !meta.summary.trim()) throw new Error(`summary 누락: ${filename}`);
      if (meta.deprecated !== undefined && (typeof meta.deprecated !== 'string' || !meta.deprecated.trim())) throw new Error(`deprecated 이유 누락: ${filename}`);
      // input: 실행에 오너 질문에서 나온 값(종목명 등)이 필요한 도구. 자동·일괄 실행 대상이 아니다.
      if (meta.input !== undefined && (typeof meta.input !== 'string' || !meta.input.trim() || meta.attach === 'always')) throw new Error(`input 오류(always 도구는 입력을 받을 수 없음): ${filename}`);
      if (filename === 'macro-overlay-facts.mjs' && !meta.args.includes('--dry-run')) throw new Error('macro-overlay-facts.mjs는 --dry-run 필수');
      for (const { agent, workType } of meta.serves) {
        if (!agentIds.includes(agent) || !workTypesFor(agent).includes(workType)) throw new Error(`미등록 담당·작업 유형: ${filename}: ${agent}/${workType}`);
      }
      return { filename, ...meta, command: [filename, ...meta.args].join(' ') };
    });
}

export function factsFor(agent, options = {}) {
  if (!options.agentIds && !AGENT_IDS.includes(agent)) throw new Error(`미등록 담당: ${agent}`);
  const entries = factsCatalog(options).filter((entry) => !entry.deprecated && entry.serves.some((service) => service.agent === agent));
  return {
    always: entries.filter((entry) => entry.attach === 'always'),
    onRequest: entries.filter((entry) => entry.attach === 'on-request'),
  };
}
