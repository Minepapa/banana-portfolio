// 데일리 노트(D85, 5-1) — 그날 볼트에 들어온 기록을 날짜로 엮는 허브. 순수함수만 둔다(파일·LLM·발송은 잡이 한다).
//
// 오너 글 보존 원칙(D19, 리뷰 HIGH 1~3 반영):
// - 노트를 `## ` 섹션 단위로 나눈다(코드 블록 안의 `## `는 경계가 아니다). AI는 AI_SECTIONS 다섯 칸만 다시 쓴다.
// - 그 밖의 모든 것(맨 위 영역, 오늘 한 줄·오너 메모, 오너가 추가한 칸, 머리말의 모르는 키)은 원문 그대로 둔다.
// - AI 칸 내용의 지문(aiHash)을 머리말에 남긴다. 다음 실행 때 지문이 다르면 오너가 AI 칸을 고친 것이므로 쓰지 않는다.
//   aiHash가 없는 파일(오너가 템플릿으로 먼저 만든 파일 등)도 덮어쓰지 않는다.
import { createHash } from 'node:crypto';
import { buildFrontmatter, parseFrontmatter } from './vault-frontmatter.mjs';
import { VAULT_REL } from './vault-paths.mjs';
import { escapeHtml } from './telegram.mjs';
import { formatEventLine } from './google-calendar.mjs';

export const OWNER_SECTIONS = ['오늘 한 줄', '오너 메모'];
export const AI_SECTIONS = ['일정', '동선', '오늘 들어온 기록', '오늘 생긴 할 일', 'AI 하루 요약'];
const SECTION_ORDER = ['오늘 한 줄', ...AI_SECTIONS, '오너 메모'];
const MANAGED_KEYS = new Set(['type', 'category', 'description', 'sensitivity', 'created', 'modified', 'dailyStatus', 'model',
  'recordCount', 'recordHash', 'aiHash', 'summaryStatus', 'telegramSentAt']);
const OWNER_HINT = '<!-- 오너가 쓰는 칸. AI는 이 칸을 고치지 않는다. -->';
export const PROMPT_VERSION = 'v1';

// 기록 수집에서 빼는 최상위 폴더: 데일리 자신·보관본·기계 데이터·금고·규칙(델포이)·홈(분류 노트)
export const DAILY_SKIP_TOP = new Set([
  VAULT_REL.periodicRoot, VAULT_REL.archiveRoot, VAULT_REL.etnaRoot, VAULT_REL.adytonRoot, VAULT_REL.knowledgeMeta, VAULT_REL.homeDir,
]);

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const CATEGORY_RE = new RegExp(`\\[\\[${escapeRe(VAULT_REL.homeDir)}\\/([^\\]|]+)(?:\\|[^\\]]*)?\\]\\]`);
const sha = (text) => createHash('sha256').update(text).digest('hex').slice(0, 16);
const lf = (text) => String(text ?? '').replace(/^﻿/, '').replace(/\r\n/g, '\n');

// 노트를 머리말 원문·본문으로 나눈다.
export function splitNote(content) {
  const text = lf(content);
  const m = text.match(/^---\n([\s\S]*?)\n---\n?/);
  return m ? { fmRaw: m[1], body: text.slice(m[0].length) } : { fmRaw: null, body: text };
}

// 머리말 원문에서 키별 원문 블록(키 줄 + 들여쓴 다음 줄들)을 꺼낸다 — 여러 줄 목록도 원문 그대로 보존하기 위함.
export function frontmatterBlocks(fmRaw) {
  const blocks = [];
  if (fmRaw == null) return blocks;
  for (const line of String(fmRaw).split('\n')) {
    if (line === '' && !blocks.length) continue; // 첫 키 앞의 빈 줄은 보존할 내용이 아니다
    const indented = /^\s/.test(line) || line === '';
    const key = !indented ? line.match(/^("[^"]+"|'[^']+'|[^\s#:'"-][^:]*):(?:\s|$)/)?.[1] : null;
    if (key) blocks.push({ key: key.replace(/^["']|["']$/g, ''), lines: [line] });
    else if ((indented || /^- /.test(line)) && blocks.length) blocks.at(-1).lines.push(line); // 들여쓰지 않은 목록(`- x`)도 앞 키에 붙인다
    else blocks.push({ key: null, lines: [line] }); // 키가 아닌 줄(주석·첫 키 앞 줄)도 원문 그대로 보존(리뷰 HIGH)
  }
  return blocks;
}

// 본문을 섹션으로 나눈다. 코드 블록(``` 또는 ~~~) 안의 `## `는 경계로 보지 않는다. 제목은 끝 공백을 무시한다.
export function parseSections(body) {
  const lines = lf(body).split('\n');
  const preamble = [];
  const sections = [];
  let fence = null;
  for (const line of lines) {
    const f = line.match(/^\s*(```|~~~)/)?.[1];
    if (f) fence = fence === f ? null : (fence ?? f);
    const h = !fence && !f ? line.match(/^## (.+?)\s*$/) : null;
    if (h) sections.push({ title: h[1], lines: [] });
    else if (sections.length) sections.at(-1).lines.push(line);
    else preamble.push(line);
  }
  return { preamble: preamble.join('\n'), sections: sections.map((s) => ({ title: s.title, content: s.lines.join('\n').replace(/\s+$/, '') })) };
}

const aiHashOf = (sections) => sha(AI_SECTIONS.map((t) => `${t}\n${(sections.find((s) => s.title === t)?.content ?? '').replace(/\s+$/, '')}`).join('\n\n'));
export const hasNormalSchedule = (prev) => /^- (?:종일|\d{2}:\d{2})/m.test(prev?.sections.find((s) => s.title === '일정')?.content ?? '');

// 기존 파일을 다시 써도 되는지 판정한다(오너 글 보존 관문). 쓸 수 없으면 reason과 함께 ok:false.
export function inspectExisting(existing) {
  if (existing == null) return { ok: true, prev: null };
  const { fmRaw, body } = splitNote(existing);
  const fields = fmRaw != null ? parseFrontmatter(`---\n${fmRaw}\n---\n`) ?? {} : {};
  const parsed = parseSections(body);
  if (fields.type !== 'daily' || !fields.aiHash) {
    return { ok: false, reason: '데일리 잡이 만든 형식이 아닌 파일이 이미 있음(오너가 먼저 만든 노트일 수 있어 덮어쓰지 않음)' };
  }
  const dupAi = AI_SECTIONS.find((t) => parsed.sections.filter((s) => s.title === t).length > 1);
  if (dupAi && aiHashOf(parsed.sections) !== fields.aiHash) {
    return { ok: false, reason: `AI 칸 "${dupAi}"과 같은 이름의 칸이 그보다 앞에 있음(오너 칸 이름을 바꾸면 다시 갱신됨)` };
  }
  if (aiHashOf(parsed.sections) !== fields.aiHash) {
    return { ok: false, reason: 'AI 칸(일정·동선·기록·할 일·요약)이 마지막 생성 뒤 바뀌었음(오너 수정으로 보고 덮어쓰지 않음)' };
  }
  return { ok: true, prev: { fields, fmRaw, preamble: parsed.preamble, sections: parsed.sections } };
}

// 머리말의 category를 한 줄 배열·여러 줄 목록 둘 다에서 읽는다(파서는 여러 줄 목록을 빈 값으로 돌려준다).
export function readCategories(content) {
  const block = splitNote(content).fmRaw ?? '';
  const lines = block.split('\n');
  const i = lines.findIndex((l) => l.startsWith('category:'));
  if (i < 0) return [];
  const parts = [lines[i].slice('category:'.length)];
  for (let k = i + 1; k < lines.length && /^\s+-/.test(lines[k]); k += 1) parts.push(lines[k]);
  return [...parts.join('\n').matchAll(new RegExp(CATEGORY_RE, 'g'))].map((m) => m[1].trim());
}

// 노트 하나가 그날 "들어온 기록"인지와 표시 정보. created(YYYY-MM-DD…)가 그날이면 포함한다.
// 머리말이 없는 노트는 fallbackDate(호출측이 00_Inbox에만 파일 생성일을 준다)로 판정한다.
export function toDayRecord(relPath, content, date, { fallbackDate = null } = {}) {
  const text = lf(content);
  const fm = parseFrontmatter(text) ?? {};
  const created = String(fm.created ?? '').slice(0, 10) || fallbackDate;
  if (created !== date) return null;
  return {
    link: relPath.replace(/\.md$/, ''),
    title: relPath.split('/').pop().replace(/\.md$/, ''),
    type: fm.type ?? null,
    description: typeof fm.description === 'string' ? fm.description.replace(/\s*\n\s*/g, ' ') : '',
    sensitivity: fm.sensitivity === '개인' ? '개인' : '일반',
    categories: readCategories(text),
  };
}

export const recordHashOf = (records) => sha([PROMPT_VERSION, ...records.map((r) => [r.link, r.title, r.description, r.sensitivity, r.categories.join(',')].join('|'))].join('\n'));

function categoryOrder(name) {
  const n = Number(String(name).match(/^\d+/)?.[0]);
  return Number.isFinite(n) ? n : 9999;
}

export function groupByCategory(records) {
  const groups = new Map();
  for (const r of records) {
    const key = r.categories[0] ?? '분류 없음';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  return [...groups].sort((a, b) => categoryOrder(a[0]) - categoryOrder(b[0]) || a[0].localeCompare(b[0]));
}

function aiSectionContents(records, summary, events, eventGroups) {
  const recordLines = records.length
    ? groupByCategory(records).flatMap(([cat, items]) => [`### ${cat}`, ...items.map((r) => `- [[${r.link}|${r.title}]]${r.description ? ` — ${r.description}` : ''}`), ''])
    : ['(오늘 들어온 기록 없음)'];
  return {
    일정: events === null ? '(캘린더 미연결 — google-oauth-setup 필요)'
      : events === 'failed' ? '(캘린더 조회 실패 — 다음 실행에서 다시 시도)'
        : events.length ? (eventGroups
          ? eventGroups.map(({ owner, events: ownerEvents }) => [
            `**${owner}**`, ...ownerEvents.map((event) => formatEventLine(event, { owner, showCalendar: owner === '기타' })),
          ].join('\n')).join('\n')
          : events.map(formatEventLine).join('\n')) : '(일정 없음)',
    동선: '(위치 연동 전 — 5단계 3번에서 채운다)',
    '오늘 들어온 기록': recordLines.join('\n').replace(/\s+$/, ''),
    '오늘 생긴 할 일': '(캘린더·Tasks 연동 전 — 5단계 2번에서 채운다)',
    'AI 하루 요약': summary && summary.trim() ? summary.trim() : '(요약 없음)',
  };
}

// 데일리 노트를 만든다. prev(inspectExisting 결과)가 있으면 AI 칸만 바꾸고 나머지는 원문 그대로 둔다.
export function renderDailyNote({ date, records, summary, status, model, summaryStatus, recordHash, today, telegramSentAt = null, prev = null, events = null, eventGroups = null }) {
  const ai = aiSectionContents(records, summary, events, eventGroups);
  const prevSections = prev?.sections ?? [];
  const keep = (title) => prevSections.find((s) => s.title === title)?.content;
  // 조회 실패·미연결 시 이전에 확인한 일정은 보존한다. 빈 일정이나 오류 문구는 정상 일정이 아니다.
  if ((events === null || events === 'failed') && hasNormalSchedule(prev)) ai.일정 = keep('일정');
  const known = new Set(SECTION_ORDER);
  // 정해진 칸 이름은 처음 나온 칸만 그 칸으로 쓰고, 같은 이름이 또 나오면 오너가 추가한 칸으로 보존한다(리뷰 HIGH).
  const extras = prevSections.filter((s, i) => !known.has(s.title) || prevSections.findIndex((x) => x.title === s.title) !== i);
  const ordered = [
    ...SECTION_ORDER.map((title) => ({ title, content: AI_SECTIONS.includes(title) ? ai[title] : (keep(title) ?? OWNER_HINT) })),
    ...extras, // 오너가 추가한 칸은 원래 순서대로 끝에 그대로
  ];
  const categories = [...new Set(records.flatMap((r) => r.categories))].sort((a, b) => categoryOrder(a) - categoryOrder(b));
  const managed = {
    type: 'daily',
    category: categories.map((c) => `[[${VAULT_REL.homeDir}/${c}]]`),
    description: `${date} 데일리 — 들어온 기록 ${records.length}개`,
    sensitivity: records.some((r) => r.sensitivity === '개인') || /^- (?:종일|\d{2}:\d{2})/m.test(ai.일정) ? '개인' : '일반',
    created: prev?.fields?.created ?? date,
    modified: today,
    dailyStatus: status,
    model: model ?? '없음',
    summaryStatus,
    recordCount: records.length,
    recordHash,
    aiHash: aiHashOf(ordered),
    ...(telegramSentAt ? { telegramSentAt } : {}),
  };
  const ownerKeys = frontmatterBlocks(prev?.fmRaw).filter((b) => !MANAGED_KEYS.has(b.key)).flatMap((b) => b.lines);
  const core = buildFrontmatter(managed).replace(/\s*---\s*$/, ''); // 닫는 --- 와 앞뒤 빈 줄 제거 후 다시 닫는다
  const fmText = `${core}${ownerKeys.length ? `\n${ownerKeys.join('\n')}` : ''}\n---\n`;
  const preamble = prev ? prev.preamble.replace(/^\s*\n/, '').replace(/\s+$/, '') : `# ${date}`; // 앞뒤 빈 줄 정리(실행마다 늘지 않게)
  const body = [preamble, '', ...ordered.flatMap((s) => [`## ${s.title}`, s.content, ''])].join('\n');
  return `${fmText}\n${body}`;
}

// 내용 비교용 — modified 줄만 다른 경우는 같은 노트로 본다(불필요한 쓰기·LiveSync 충돌 줄이기).
export const sameIgnoringModified = (a, b) => lf(a).replace(/^modified: .*$/m, '') === lf(b).replace(/^modified: .*$/m, '');

// AI 하루 요약 프롬프트 — 숫자·사실을 지어내지 않게 목록만 준다. 개인 등급은 제목·설명 없이 카테고리별 개수만 준다(D84, 리뷰 M-3).
export function buildSummaryPrompt(date, records) {
  const general = records.filter((r) => r.sensitivity !== '개인');
  const personal = groupByCategory(records.filter((r) => r.sensitivity === '개인'));
  const list = [
    ...general.map((r) => `- [${r.categories[0] ?? '분류 없음'}] ${r.title}${r.description ? `: ${r.description}` : ''}`),
    ...personal.map(([cat, items]) => `- [${cat}] 개인 기록 ${items.length}건(내용 비공개)`),
  ].join('\n');
  return [
    `${date} 하루 동안 오너(Frank)의 볼트에 들어온 기록 목록이다. 이 목록만 근거로 오늘 하루를 한국어 3~5줄로 요약하라.`,
    '- 줄마다 한 가지만. 목록에 없는 사실·숫자는 만들지 마라. 개인 기록은 "가족 기록 2건"처럼 개수로만 언급하라.',
    '- 머리말·제목 없이 요약 줄만 출력하라. 각 줄은 "- "로 시작한다.',
    '',
    list || '(기록 없음)',
  ].join('\n');
}

// LLM 출력에서 "- " 줄만 받는다(제목·머리말·`## ` 줄이 노트 구조를 바꾸지 못하게, 리뷰 M-5).
export function sanitizeSummary(text) {
  return lf(text).split('\n').map((l) => l.trim()).filter((l) => /^- \S/.test(l) && !/^- #/.test(l)).slice(0, 7).join('\n');
}

// 클리오 텔레그램 본문(정보성: 헤더 + 항목형). 기록은 카테고리별 개수만, 요약은 HTML 이스케이프.
export function buildDailyTelegramBody(date, records, summary, status = '초안') {
  const counts = groupByCategory(records).map(([cat, items]) => `- ${escapeHtml(cat)}: ${items.length}개`);
  const confirm = status === '초안'
    ? `- 볼트 ${VAULT_REL.dailyNotes}에서 "오늘 한 줄"을 채워 주세요. 다음날 05:00에 확정합니다.`
    : `- 볼트 ${VAULT_REL.dailyNotes}에서 확인할 수 있습니다.`;
  return [`<b>${date} 데일리 ${status}</b> — 들어온 기록 ${records.length}개`, '', '■ 기록', ...(counts.length ? counts : ['- 없음']),
    '', '■ 하루 요약', summary && summary.trim() ? escapeHtml(summary.trim()) : '- (요약 없음)', '', '■ 확인', confirm].join('\n');
}

export { parseFrontmatter };
