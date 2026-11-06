// 요청 기록(dev-request)·활동 로그(session-log·agent-log)의 본문 양식 — 정의·렌더·검사를 한 곳에 둔다(2026-11-06 오너).
// 머리말은 경로 등록부가 강제하지만 본문은 자유라 담당마다 달랐다. 정본 설명: 볼트 `90_Delphi/Schema/문서 본문 양식`.
// 표본(2026-11-06, Requests 113개): `왜` 46 · `무엇을` 42 · 완료 계열 37이 가장 흔해 그 구조를 표준으로 삼았다.
// 검사는 경고용이다(막지 않음) — 옛 문서를 소급해 막지 않도록 쓰기 관문은 새 파일, 야간 lint는 시행일 이후 문서만 본다.
// 순수 모듈 — 볼트 경로를 읽지 않는다.

export const DOC_TEMPLATE_FROM = '2026-11-07';
export const DOC_TEMPLATE_REF = '볼트 Schema 폴더의 `문서 본문 양식`';

// 필수 절. 표본에서 같은 뜻으로 쓰인 옛 제목(aliases)도 인정한다. 제목 끝 괄호 `(…)`는 무시한다.
export const DEV_REQUEST_SECTIONS = [
  { name: '무엇을', aliases: ['무엇을', '무엇이 필요한가', '요청', '오너 요청', '한 줄 요약', '할 일'] },
  { name: '왜', aliases: ['왜', '배경', '출처'] },
  { name: '완료 기준', aliases: ['완료 기준', '완료 조건', '완료'] },
];

// 로그 한 항목의 필수 불릿 라벨. 같은 뜻의 옛 라벨(aliases)도 인정한다.
export const LOG_ENTRY_BULLETS = [
  { name: '한 일', aliases: ['한 일'] },
  { name: '근거·커밋', aliases: ['근거·커밋', '근거', '커밋', '검증'] },
  { name: '남은 것', aliases: ['남은 것', '다음'] },
];

const LOG_PATH = /^60_Logs\/(Zeus\/\d{4}\/[^/]+|[^/]+\/\d{4}-\d{2})\.md$/;
const REQUEST_PATH = /^40_Projects\/[^/]+\/Requests\/[^/]+\.md$/;

function split(text) {
  const m = String(text).replace(/^﻿/, '').match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  return m ? { front: m[1], body: m[2] } : { front: '', body: String(text) };
}

export function isDevRequestDoc(relPath, text) {
  return REQUEST_PATH.test(relPath) && /^type:\s*"?dev-request"?\s*$/m.test(split(text).front);
}

export function isLogDoc(relPath) { return LOG_PATH.test(relPath); }

const headingKey = (title) => title.replace(/\s*[(（].*$/, '').trim();

// 빠진 필수 절 이름 목록(빈 배열이면 양식 충족). text는 머리말 포함 전체 노트도, 본문만도 된다.
export function checkDevRequestBody(text) {
  const { body } = split(text);
  const found = new Set([...body.matchAll(/^##\s+(.+?)\s*$/gm)].map((m) => headingKey(m[1])));
  return DEV_REQUEST_SECTIONS.filter((s) => !s.aliases.some((a) => found.has(a))).map((s) => s.name);
}

// 로그 본문의 항목(`### HH:MM 주제`)마다 필수 불릿을 검사해 문제 문장 목록을 돌려준다.
// 항목이 하나도 없으면 양식 자체가 없는 것으로 본다.
export function checkLogEntry(text) {
  const { body } = split(text);
  const parts = body.split(/^(?=###\s)/m).filter((p) => /^###\s+\d{1,2}:\d{2}\s+\S/.test(p));
  if (!parts.length) return ['항목 제목 없음: `### HH:MM 주제` 형식의 항목이 필요'];
  const problems = [];
  for (const part of parts) {
    const title = part.split('\n', 1)[0].replace(/^###\s+/, '').trim();
    const labels = new Set([...part.matchAll(/^\s*[-*]\s+\**([^:：\n*]+?)\**\s*[:：]/gm)].map((m) => m[1].trim()));
    const missing = LOG_ENTRY_BULLETS.filter((b) => !b.aliases.some((a) => labels.has(a))).map((b) => b.name);
    if (missing.length) problems.push(`"${title}" 항목에 빠진 불릿: ${missing.join(', ')}`);
  }
  return problems;
}

const q = (v) => `"${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
const addDays = (date, n) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const bullets = (v) => (Array.isArray(v) ? v : [v]).map((x) => `- ${x}`).join('\n');

// 새 요청 기록 전문(머리말 포함). category는 홈 링크 문자열(예: 500 기술 홈 링크). done은 문자열 또는 배열. 진행·결정은 나중에 날짜 절로 덧붙인다
// (`## 진행 (YYYY-MM-DD)` · `## 오너 결정 (YYYY-MM-DD)`).
export function renderDevRequest({
  title, date, description, requestedVia, what, why, done,
  category, sensitivity = '일반', status = '예정',
  waitingOn = '착수 대기', nextCheck = addDays(date, 7), ownerGod = null,
}) {
  const front = [
    '---', 'type: "dev-request"', `category: [${q(category)}]`, `description: ${q(description)}`,
    `sensitivity: ${q(sensitivity)}`, `created: ${q(date)}`, `modified: ${q(date)}`,
    `status: ${q(status)}`, `waitingOn: ${q(waitingOn)}`, `nextCheck: ${q(nextCheck)}`,
    `requestedVia: ${q(requestedVia)}`, ...(ownerGod ? [`ownerGod: ${q(ownerGod)}`] : []), '---',
  ].join('\n');
  return `${front}\n# ${title}\n\n## 무엇을\n${what}\n\n## 왜\n${why}\n\n## 완료 기준\n${bullets(done)}\n`;
}

// 로그 한 항목. did·evidence·remaining은 문자열 또는 배열(배열이면 줄마다 하위 불릿).
export function renderLogEntry({ time, topic, did, evidence, remaining }) {
  const line = (label, v) => (Array.isArray(v)
    ? `- ${label}:\n${v.map((x) => `  - ${x}`).join('\n')}`
    : `- ${label}: ${v}`);
  return `### ${time} ${topic}\n${line('한 일', did)}\n${line('근거·커밋', evidence)}\n${line('남은 것', remaining)}\n`;
}

// 경고 문구(쓰기 관문·lint 공용). 빈 배열이면 null.
export function docTemplateWarning(relPath, text) {
  let missing = [];
  if (isDevRequestDoc(relPath, text)) missing = checkDevRequestBody(text).map((n) => `## ${n} 절 없음`);
  else if (isLogDoc(relPath)) missing = checkLogEntry(text);
  if (!missing.length) return null;
  return `문서 본문 양식 경고(막지 않음): ${relPath}\n${missing.map((m) => `- ${m}`).join('\n')}\n양식: ${DOC_TEMPLATE_REF} (scripts/lib/vault-doc-templates.mjs의 renderDevRequest·renderLogEntry로 만들 수 있음)`;
}
