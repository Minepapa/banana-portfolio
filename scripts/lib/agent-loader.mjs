// 에이전트 정의 로더 — .claude/agents/{name}.md 가 모델·도메인 시스템프롬프트의 단일 진실 소스.
// 대화형(Claude Code 네이티브 Agent tool)과 헤드리스(claude -p --append-system-prompt) 양쪽이
// 같은 파일을 소비한다(CLAUDE.md §조직 프로토콜). 파싱은 flat key: value frontmatter만 지원 —
// YAML 의존성 없이 정규식으로 충분하고, 형식이 어긋나면 손상으로 취급해 폴백한다.

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const DEFAULT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '.claude', 'agents');

// frontmatter + 본문 파싱 — 순수함수(테스트: agent-loader.test.js).
// flat "key: value" 스칼라만 허용 — 중첩 YAML(리스트·블록)은 손상으로 간주해 throw 한다.
// 실패는 조용히 넘기지 않고 throw — 폴백·경고 정책은 loadAgent 소관(순수/IO 분리).
export function parseAgentMd(text) {
  const m = String(text ?? '').match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) throw new Error('frontmatter 없음');
  const fields = {};
  for (const line of m[1].split(/\r?\n/)) {
    if (!line.trim()) continue;
    const idx = line.indexOf(':');
    if (idx < 0) throw new Error(`frontmatter 형식 오류: "${line.slice(0, 40)}"`);
    const key = line.slice(0, idx).trim();
    fields[key] = line.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
  }
  if (!fields.model) throw new Error('model 필드 없음');
  const systemPrompt = String(text).slice(m[0].length).trim();
  if (!systemPrompt) throw new Error('본문(시스템 프롬프트) 비어있음');
  return { ...fields, systemPrompt };
}

// 절대 throw 하지 않는다 — 무인 잡이 에이전트 파일 손상으로 죽으면 안 되고, 조용히 잘못돼도
// 안 된다. 손상/누락 시 현행 하드코딩 기본값(fallbackModel)으로 기존 동작을 보존하고 warning
// 을 반환한다 — 호출부가 collectWarning(job-alerts) 또는 로그로 표면화할 책임.
export function loadAgent(agentName, { fallbackModel, dir = DEFAULT_DIR } = {}) {
  try {
    const parsed = parseAgentMd(readFileSync(join(dir, `${agentName}.md`), 'utf8'));
    return { model: parsed.model, systemPrompt: parsed.systemPrompt, warning: null };
  } catch (e) {
    return {
      model: fallbackModel,
      systemPrompt: '',
      warning: `에이전트 정의 손상/누락: ${agentName} (${e.message}) — 기본값(${fallbackModel})으로 대체`,
    };
  }
}
