#!/usr/bin/env node
/** 클리오 Inbox ingest 1단계: 원본과 Wiki를 바꾸지 않고 계획만 기록한다. */
import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VAULT_PATHS, VAULT_REL } from '../lib/vault-paths.mjs';
import { parseFrontmatter } from '../lib/vault-frontmatter.mjs';
import { checkNote, parseRegistry } from '../lib/vault-registry.mjs';
import { writeAtomic } from '../lib/state-writer.mjs';
import { cooldownActive } from '../lib/quota-cooldown.mjs';
import { loadAgent } from '../lib/agent-loader.mjs';
import { runHeadlessClaude } from '../lib/headless-claude.mjs';
import { sendAgentMessage } from '../lib/pantheon-send.mjs';
import { agentTitle } from '../lib/agent-registry.mjs';

export const MAX_ITEMS = 10;
export const MAX_INPUT_CHARS = 30_000;
export const MAX_WIKI_TITLES_PER_FOLDER = 100;
export const MAX_WIKI_INDEX_CHARS = 12_000;
export const MAX_JOB_MS = 30 * 60_000;
export const MAX_TITLE_CHARS = 60;
const WIKI_FOLDERS = [VAULT_REL.people, VAULT_REL.places, VAULT_REL.wikiObjects, VAULT_REL.knowledgeTopics];
const EXTRACTED_KEYS = ['people', 'places', 'topics', 'objects', 'dates', 'todos', 'decisions'];
const WIKI_ACTIONS = new Set(['append-source', 'candidate', 'question']);
const DATE_RE = /\d{4}-\d{2}-\d{2}/;

const readJson = (path, fallback) => existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : fallback;
const hashOf = (content) => createHash('sha256').update(content).digest('hex');
const kstDate = (now) => new Date(now.getTime() + 9 * 3_600_000).toISOString().slice(0, 10);
const plain = (value) => value && typeof value === 'object' && !Array.isArray(value);
const safeScalar = (value) => typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value === null;
const yaml = (value) => JSON.stringify(value);

function readWikiHeader(path) {
  const fd = openSync(path, 'r');
  const chunk = Buffer.alloc(1_024);
  const parts = [];
  let bytes = 0;
  try {
    while (bytes < 16_384) {
      const count = readSync(fd, chunk, 0, chunk.length, null);
      if (!count) break;
      parts.push(Buffer.from(chunk.subarray(0, count)));
      bytes += count;
      const header = Buffer.concat(parts).toString('utf8');
      const end = header.indexOf('\n---', 4);
      if (header.startsWith('---\n') && end !== -1) return header.slice(0, end + 4);
      if (!header.startsWith('---\n')) break;
    }
    return '';
  } finally {
    closeSync(fd);
  }
}

function wikiAliases(header) {
  const parsed = parseFrontmatter(header).aliases;
  if (Array.isArray(parsed)) return parsed.filter((alias) => typeof alias === 'string');
  if (parsed) return [parsed];
  const lines = header.split('\n');
  const start = lines.findIndex((line) => /^aliases:\s*$/.test(line));
  if (start === -1) return [];
  const aliases = [];
  for (const line of lines.slice(start + 1)) {
    const match = line.match(/^\s+-\s+(.+?)\s*$/);
    if (!match) break;
    aliases.push(match[1].replace(/^['"]|['"]$/g, ''));
  }
  return aliases;
}

export function readWikiIndex(root) {
  const paths = new Set();
  const lines = [];
  let chars = 0;
  for (const folder of WIKI_FOLDERS) {
    const queue = [folder];
    let count = 0;
    while (queue.length && count < MAX_WIKI_TITLES_PER_FOLDER && chars < MAX_WIKI_INDEX_CHARS) {
      const current = queue.shift();
      const absolute = join(root, current);
      if (!existsSync(absolute)) continue;
      for (const entry of readdirSync(absolute, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'ko'))) {
        const rel = `${current}/${entry.name}`;
        if (entry.isDirectory()) queue.push(rel);
        if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
        if (count >= MAX_WIKI_TITLES_PER_FOLDER) break;
        const title = entry.name.slice(0, -3);
        const header = readWikiHeader(join(root, rel));
        const names = wikiAliases(header);
        const isPerson = current === VAULT_REL.people || current.startsWith(`${VAULT_REL.people}/`);
        const personFields = isPerson ? parseFrontmatter(header) : null;
        const relation = personFields?.relation;
        const description = personFields?.description;
        const line = isPerson
          ? `${current} · ${title}${relation ? ` · 관계: ${relation}` : ''} · 별칭: ${names.join(', ') || '없음'}${description ? ` · 설명: ${description}` : ''}`
          : `${current} · ${title} · ${names.join(', ') || '없음'}`;
        if (chars + line.length + 1 > MAX_WIKI_INDEX_CHARS) break;
        lines.push(line);
        paths.add(rel.slice(0, -3));
        chars += line.length + 1;
        count += 1;
      }
    }
  }
  return { paths, prompt: lines.join('\n') };
}

export function priorityOf(content) {
  const fm = parseFrontmatter(content);
  const origin = String(fm.origin ?? '').toLowerCase();
  const sample = content.slice(0, 2_000).toLowerCase();
  if (/미네|mine|mnemosyne/.test(`${origin} ${sample}`)) return 0;
  if (/텔레그램|telegram|📜|옵시디언|obsidian|직접|owner/.test(origin) || /^\s*📜/m.test(sample)) return 1;
  if (/대화|통화|회의|conversation|chat/.test(`${origin} ${sample}`)) return 2;
  if (/사진|영상|녹음|audio|video|media/.test(`${origin} ${sample}`)) return 3;
  return 4;
}

function knownHashes(root) {
  const seen = new Map();
  const states = new Map();
  const processed = readJson(join(root, VAULT_REL.inboxIngestProcessed), {});
  for (const [path, value] of Object.entries(processed)) {
    if (typeof value === 'string') seen.set(path, value);
    else if (value?.hash) seen.set(path, value.hash);
  }
  const dir = join(root, VAULT_REL.inboxIngestPlans);
  if (existsSync(dir)) for (const name of readdirSync(dir).filter((x) => /^\d{4}-\d{2}-\d{2}\.json$/.test(x)).sort()) {
    const previous = readJson(join(dir, name), {});
    for (const entry of previous.items ?? []) {
      if (!entry.hash) continue;
      const prior = states.get(entry.hash) ?? { attempts: 0 };
      states.set(entry.hash, { status: entry.status, attempts: Math.max(prior.attempts, entry.attempts ?? 0),
        oversized: entry.status === '판단 실패' && entry.reason?.startsWith('입력 글자 수 상한(') });
      if (entry.source && entry.status === '계획함') seen.set(entry.source, entry.hash);
    }
  }
  return { seen, states };
}

function pendingPlans(root) {
  const dir = join(root, VAULT_REL.inboxIngestPlans);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => /^\d{4}-\d{2}-\d{2}\.json$/.test(name)).sort()
    .map((name) => {
      const date = name.slice(0, 10);
      const plan = readJson(join(dir, name), {});
      const reportPath = join(root, VAULT_REL.clioLog, `${date.slice(0, 7)}.md`);
      const report = existsSync(reportPath) ? readFileSync(reportPath, 'utf8') : '';
      const version = renderReport(date, plan.items ?? [], plan.remaining ?? 0).split('\n')[1];
      return { date, path: join(dir, name), plan, reportPath, needsRecovery: !report.includes(version) };
    }).filter(({ plan, needsRecovery }) => plan.pendingMessageItems?.length && needsRecovery);
}

export function collectInbox(root, { maxItems = MAX_ITEMS, maxChars = MAX_INPUT_CHARS } = {}) {
  const dir = join(root, VAULT_REL.inboxRoot);
  if (!existsSync(dir)) return { selected: [], oversized: [], exhausted: [], remaining: 0 };
  const { seen: known, states } = knownHashes(root);
  const allKnownHashes = new Set(known.values());
  const pendingHashes = new Set();
  const exhausted = [];
  const candidates = readdirSync(dir, { withFileTypes: true }).filter((x) => x.isFile() && x.name.endsWith('.md')).map((x) => {
    const source = `${VAULT_REL.inboxRoot}/${x.name}`;
    const content = readFileSync(join(dir, x.name), 'utf8');
    return { source, content, hash: hashOf(content), priority: priorityOf(content) };
  }).sort((a, b) => a.priority - b.priority || a.source.localeCompare(b.source, 'ko')).filter((x) => {
    const state = states.get(x.hash);
    if (known.get(x.source) === x.hash || allKnownHashes.has(x.hash) || pendingHashes.has(x.hash)) return false;
    pendingHashes.add(x.hash);
    if (state?.status === '분류 불가' || state?.oversized || state?.status === '계획함') return false;
    if (state?.attempts >= 3) {
      exhausted.push({ source: x.source, hash: x.hash, status: '보류(재시도 소진)', reason: '판단 시도 3회 소진', attempts: state.attempts });
      return false;
    }
    x.attempts = state?.attempts ?? 0;
    return true;
  });
  const selected = [];
  const oversized = [];
  let chars = 0;
  for (const item of candidates) {
    if (selected.length >= maxItems) break;
    if (item.content.length > maxChars) {
      oversized.push({ source: item.source, hash: item.hash, status: '판단 실패', reason: `입력 글자 수 상한(${maxChars}자) 초과`, attempts: 0 });
      continue;
    }
    if (chars + item.content.length > maxChars) continue;
    selected.push(item);
    chars += item.content.length;
  }
  return { selected, oversized, exhausted, remaining: candidates.length - selected.length - oversized.length };
}

function targetPreview(judgment, date) {
  const { target, frontmatter } = judgment;
  const fields = { type: target.type, category: frontmatter.category, description: frontmatter.description,
    sensitivity: frontmatter.sensitivity, created: frontmatter.created ?? date,
    modified: frontmatter.modified ?? date, ...frontmatter };
  const lines = Object.entries(fields).filter(([, value]) => value !== undefined).map(([key, value]) => `${key}: ${yaml(value)}`);
  return `---\n${lines.join('\n')}\n---\n\n계획 검증용 본문\n`;
}

function parseJudgment(raw) {
  const trimmed = raw.trim();
  const unfenced = trimmed.replace(/^```(?:json)?[ \t]*\r?\n/i, '').replace(/\r?\n?```$/, '').trim();
  try { return JSON.parse(unfenced); } catch (error) {
    const start = unfenced.indexOf('{');
    if (start === -1) throw error;
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (let i = start; i < unfenced.length; i += 1) {
      const char = unfenced[i];
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') quoted = false;
      } else if (char === '"') quoted = true;
      else if (char === '{') depth += 1;
      else if (char === '}' && --depth === 0) return JSON.parse(unfenced.slice(start, i + 1));
    }
    throw error;
  }
}

export function validateJudgment(raw, { rules, root, date, wikiIndex = readWikiIndex(root) }) {
  const value = typeof raw === 'string' ? parseJudgment(raw) : raw;
  if (!plain(value) || !plain(value.target) || !plain(value.frontmatter) || !plain(value.extracted)
      || !Array.isArray(value.wiki) || !(value.dailyLink === null || typeof value.dailyLink === 'string')
      || !(value.unclassifiable === null || typeof value.unclassifiable === 'string')) throw new Error('JSON 스키마 위반');
  for (const key of EXTRACTED_KEYS) {
    const entries = value.extracted[key];
    const actualType = (entry) => entry === null ? 'null' : Array.isArray(entry) ? 'array' : typeof entry;
    if (!Array.isArray(entries)) throw new Error(`추출 스키마 위반: ${key}이 배열이 아님(${actualType(entries)})`);
    const invalidIndex = entries.findIndex((entry) => typeof entry !== 'string');
    if (invalidIndex !== -1) throw new Error(`추출 스키마 위반: ${key}[${invalidIndex}]이 문자열이 아님(${actualType(entries[invalidIndex])})`);
  }
  const dailyLink = value.dailyLink?.match(DATE_RE)?.[0] ?? null;
  if (value.wiki.some((entry) => !plain(entry) || !WIKI_ACTIONS.has(entry.action)
      || typeof entry.page !== 'string' || !entry.page.trim()
      || typeof entry.reason !== 'string' || !entry.reason.trim())) throw new Error('Wiki 스키마 위반');
  if (value.unclassifiable !== null) {
    if (!value.unclassifiable.trim()) throw new Error('분류 불가 이유 누락');
    return { ...value, dailyLink, wiki: [] };
  }
  const { folder, type, title } = value.target;
  if (![folder, type, title].every((x) => typeof x === 'string' && x.trim())
      || !folder.startsWith(`${VAULT_REL.recordsRoot}/`) || folder.startsWith('/') || folder.includes('..')
      || title.includes('/') || title.includes('\\') || title.endsWith('.md')) throw new Error('대상 경로·제목 형식 위반');
  if (Array.from(title).length > MAX_TITLE_CHARS) throw new Error('대상 제목 60자 초과');
  if (Object.values(value.frontmatter).some((x) => !safeScalar(x) && !(Array.isArray(x) && x.every(safeScalar)))) throw new Error('머리말 중첩 값 금지');
  if (value.frontmatter.type && value.frontmatter.type !== type) throw new Error('대상 type과 머리말 type 불일치');
  const rel = `${folder}/${title}.md`;
  const problems = checkNote(rel, targetPreview(value, date), rules);
  if (problems.length) throw new Error(`등록부 위반: ${problems.join(' / ')}`);
  const wiki = value.wiki.map((entry) => {
    const page = entry.page.replace(/\.md$/, '');
    if (!page.startsWith(`${VAULT_REL.knowledge}/`) || page.includes('..') || page.includes('\\')) throw new Error('Wiki 경로 위반');
    return entry.action === 'append-source' && !wikiIndex.paths.has(page)
      ? { ...entry, action: 'candidate', reason: `${entry.reason} (페이지 없음 — 생성 관문 보류)` } : entry;
  });
  return { ...value, dailyLink, wiki };
}

function promptFor(item, registrySummary) {
  return `다음 Inbox 메모를 기록 대상으로 분류하라. JSON 객체만 출력하고 도구는 사용하지 마라.\n`
    + `순서: 분류→인물·장소·주제·물건·날짜·할 일·결정 추출→Wiki 기존 페이지 보강 또는 후보/질문→데일리 연결.\n`
    + `새 Wiki 페이지는 D32 생성 관문과 D79 개념 테스트를 통과할 때까지 candidate로 둔다. 분류 불가면 이유를 적는다.\n`
    + `배우자·아내·와이프·엄마·아빠 같은 관계어는 relation으로 기존 인물에 매칭하라.\n`
    + `경로 등록부 요약:\n${registrySummary}\n`
    + `정확한 JSON 스키마: {"target":{"folder":"${VAULT_REL.recordsRoot}/.../{YYYY}","type":"note|literature|conversation|media","title":"YYYY-MM-DD 제목"},"frontmatter":{},"extracted":{"people":[],"places":[],"topics":[],"objects":[],"dates":[],"todos":[],"decisions":[]},"wiki":[{"action":"append-source|candidate|question","page":"${VAULT_REL.knowledge}/...","reason":"..."}],"dailyLink":null,"unclassifiable":null}\n`
    + `extracted의 모든 값은 문자열 배열이며 객체를 넣지 마라. 인물은 Wiki 페이지 제목 그대로(예: "미네") 쓰고 관계 정보는 넣지 마라. frontmatter 값은 문자열·숫자·불리언 또는 그 배열만 허용한다.\n`
    + `제목은 날짜를 포함해 60자 이내로 작성하라.\n`
    + `원본 경로: ${item.source}\n원문:\n${item.content}`;
}

export function renderReport(date, items, remaining) {
  const version = hashOf(JSON.stringify({ items, remaining })).slice(0, 16);
  const lines = [`<!-- clio-inbox-ingest:${date}:start -->`, `<!-- clio-inbox-ingest:${date}:version:${version} -->`, `## ${date} Inbox ingest 계획`, '', '리포트만 — 실제 이동 없음', '', `계획 ${items.filter((x) => x.status === '계획함').length}건 · 판단 실패 ${items.filter((x) => x.status === '판단 실패').length}건 · 분류 불가 ${items.filter((x) => x.status === '분류 불가').length}건 · 보류(재시도 소진) ${items.filter((x) => x.status === '보류(재시도 소진)').length}건 · 남은 ${remaining}건`, ''];
  for (const item of items) {
    lines.push(`### ${item.source}`, '', `- 상태: ${item.status}`);
    if (item.status === '계획함') {
      const j = item.judgment;
      lines.push(`- 이동 계획: ${j.target.folder}/${j.target.title}.md`, `- 추출: ${EXTRACTED_KEYS.map((key) => `${key} ${j.extracted[key].join(', ') || '없음'}`).join(' · ')}`,
        `- Wiki: ${j.wiki.map((w) => `${w.action} ${w.page} (${w.reason})`).join(' · ') || '없음'}`, `- 데일리: ${j.dailyLink ?? '없음'}`);
    } else lines.push(`- 사유: ${item.reason}`);
    lines.push('');
  }
  lines.push(`<!-- clio-inbox-ingest:${date}:end -->`);
  // 판단 결과 안의 마커 문자열이 다음 실행의 절 경계를 흉내 내지 못하게 한다.
  return `${lines.map((line, index) => index <= 1 || index === lines.length - 1
    ? line : line.replaceAll('<!-- clio-inbox-ingest:', '&lt;!-- clio-inbox-ingest:')).join('\n')}\n`;
}

function ownerAdditions(actual, generated) {
  const oldLines = generated.split('\n');
  const currentLines = actual.split('\n');
  const matches = Array.from({ length: oldLines.length + 1 }, () => new Uint16Array(currentLines.length + 1));
  for (let i = oldLines.length - 1; i >= 0; i -= 1) {
    for (let j = currentLines.length - 1; j >= 0; j -= 1) {
      matches[i][j] = oldLines[i] === currentLines[j] ? matches[i + 1][j + 1] + 1
        : Math.max(matches[i + 1][j], matches[i][j + 1]);
    }
  }
  const added = [];
  let i = 0;
  let j = 0;
  while (j < currentLines.length) {
    if (i < oldLines.length && oldLines[i] === currentLines[j]) { i += 1; j += 1; }
    else if (i < oldLines.length && matches[i + 1][j] >= matches[i][j + 1]) i += 1;
    else { added.push(currentLines[j]); j += 1; }
  }
  return added.join('\n');
}

function monthlyReport(date, section, existing, previousSection = null) {
  const start = `<!-- clio-inbox-ingest:${date}:start -->`;
  const end = `<!-- clio-inbox-ingest:${date}:end -->`;
  if (existing === null) {
    return `---\ntype: "agent-log"\ndescription: "${agentTitle('clio')} 작업 기록"\ncreated: "${date}"\nmodified: "${date}"\nagent: "clio"\n---\n\n# ${date.slice(0, 7)} ${agentTitle('clio')} 기록\n\n${section}`;
  }
  const from = existing.indexOf(start);
  if (from !== -1) {
    const until = existing.lastIndexOf(`\n${end}\n`);
    if (until === -1) throw new Error(`기존 Inbox ingest 절 종료 표시 없음: ${date}`);
    if (previousSection === null) throw new Error(`기존 Inbox ingest 절 생성 기록 없음: ${date}`);
    const actual = existing.slice(from + start.length, until);
    const generated = previousSection.slice(start.length, previousSection.indexOf(`\n${end}`));
    const added = ownerAdditions(actual, generated);
    const suffix = existing.slice(until + end.length + 1);
    return `${existing.slice(0, from)}${section.trimEnd()}${added ? `\n\n### 오너 추가 기록\n${added}\n` : ''}${suffix}`;
  }
  if (existing.includes(end) || existing.includes(`## ${date} Inbox ingest 계획`)) {
    throw new Error(`기존 Inbox ingest 절 경계 불명확: ${date}`);
  }
  return `${existing}${existing.endsWith('\n') ? '\n' : '\n\n'}${section}`;
}

export function telegramMessage(items, remaining) {
  const planned = items.filter((x) => x.status === '계획함');
  if (!items.length) return null;
  const failed = items.filter((item) => item.status === '판단 실패').length;
  const unclassifiable = items.filter((item) => item.status === '분류 불가').length;
  const oneLine = (value) => String(value).replace(/\s+/g, ' ').trim();
  // 제목 상한은 Telegram에서 한 항목을 훑어보기 위한 가독성 제한이다(D96).
  const titleLine = (value) => Array.from(oneLine(value)).slice(0, MAX_TITLE_CHARS).join('');
  const body = [`계획 ${planned.length}건 · 판단 실패 ${failed}건 · 분류 불가 ${unclassifiable}건 · 남은 ${remaining}건`,
    ...items.flatMap((item) => {
      if (item.status !== '계획함') {
        const originalTitle = basename(item.source ?? '제목 없음', '.md');
        return [`■ ${titleLine(originalTitle)} (${item.status})`];
      }
      const { target, wiki, extracted } = item.judgment;
      const folder = basename(target.folder);
      const label = /^\d{4}$/.test(folder) ? basename(dirname(target.folder)) : folder;
      const actionLabel = { 'append-source': '보강', candidate: '후보', question: '질문' };
      return [
        `■ ${titleLine(target.title)}`,
        `• 폴더: ${label}`,
        ...wiki.map((entry) => `• Wiki ${actionLabel[entry.action] ?? entry.action}: ${oneLine(entry.page)}${entry.reason ? ` — ${oneLine(entry.reason)}` : ''}`),
        `• 인물: ${extracted?.people?.map(oneLine).join(', ') || '없음'}`,
        `• 장소: ${extracted?.places?.map(oneLine).join(', ') || '없음'}`,
      ];
    }), '리포트만 — 실제 이동 없음'].join('\n');
  return { agent: 'clio', kind: '정보', topic: 'Inbox 정리 계획', body };
}

async function sendWithinDeadline(message, send, clock, startedAt) {
  const timeLeft = MAX_JOB_MS - (clock() - startedAt);
  if (!message || timeLeft <= 0) return false;
  const controller = new AbortController();
  let timer;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => { controller.abort(); resolve(false); }, timeLeft);
  });
  const deliver = send ?? ((value, { signal }) => sendAgentMessage(value, undefined, {
    fetchImpl: (url, options) => fetch(url, { ...options, signal }),
  }));
  try {
    return await Promise.race([Promise.resolve().then(() => deliver(message, { signal: controller.signal })).then(() => true), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

export async function run({ root = VAULT_PATHS.root, mode = 'report', dryRun = false, noSend = false,
  now = new Date(), rules, judge, send, cooldown = cooldownActive, charter, maxItems = MAX_ITEMS,
  maxChars = MAX_INPUT_CHARS, write = writeAtomic, clock = () => Date.now() } = {}) {
  if (mode === 'apply') throw new Error('--mode=apply 미구현');
  if (mode !== 'report') throw new Error(`지원하지 않는 mode: ${mode}`);
  const date = kstDate(now);
  const activeRules = rules ?? parseRegistry(readFileSync(join(root, VAULT_REL.registryFile), 'utf8'));
  const startedAt = clock();
  const previousStates = knownHashes(root).states;
  const { selected, oversized, exhausted, remaining } = collectInbox(root, { maxItems, maxChars });
  const reportRel = `${VAULT_REL.clioLog}/${date.slice(0, 7)}.md`;
  const reportPath = join(root, reportRel);
  const existingReport = existsSync(reportPath) ? readFileSync(reportPath, 'utf8') : null;
  const planRel = `${VAULT_REL.inboxIngestPlans}/${date}.json`;
  const previousPlan = readJson(join(root, planRel), null);
  const olderPendingPlans = pendingPlans(root).filter(({ path }) => path !== join(root, planRel));
  const olderPendingItems = olderPendingPlans.flatMap(({ plan }) => plan.pendingMessageItems);
  const sectionStart = `<!-- clio-inbox-ingest:${date}:start -->`;
  const plannedSection = previousPlan ? renderReport(date, previousPlan.items ?? [], previousPlan.remaining ?? 0) : null;
  const plannedVersion = plannedSection?.split('\n')[1];
  const needsReportRecovery = previousPlan && (!existingReport?.includes(sectionStart)
    || !existingReport.includes(plannedVersion));
  const previousPending = needsReportRecovery ? previousPlan?.pendingMessageItems ?? [] : [];
  const recoverOlderReports = () => {
    for (const { date: oldDate, path, plan, reportPath: oldReportPath } of olderPendingPlans) {
      const oldReport = existsSync(oldReportPath) ? readFileSync(oldReportPath, 'utf8') : null;
      const oldSection = renderReport(oldDate, plan.items ?? [], plan.remaining ?? 0);
      const recovered = monthlyReport(oldDate, oldSection, oldReport, plan.reportBaseSection ?? oldSection);
      const problems = checkNote(`${VAULT_REL.clioLog}/${oldDate.slice(0, 7)}.md`, recovered, activeRules);
      if (problems.length) throw new Error(`이전 리포트 등록부 위반: ${problems.join(' / ')}`);
      mkdirSync(dirname(oldReportPath), { recursive: true });
      write(oldReportPath, recovered);
      write(path, `${JSON.stringify({ ...plan, pendingMessageItems: [] }, null, 2)}\n`);
    }
  };
  if (!selected.length && !oversized.length && !exhausted.length && !remaining && !needsReportRecovery && !previousPending.length) {
    const message = telegramMessage(olderPendingItems, remaining);
    if (!dryRun) recoverOlderReports();
    const sent = !dryRun && !noSend && await sendWithinDeadline(message, send, clock, startedAt);
    return { date, items: [], remaining, sent, written: !dryRun && !!olderPendingPlans.length, message };
  }
  const previousSection = needsReportRecovery && previousPlan.reportBaseSection
    ? previousPlan.reportBaseSection : plannedSection;
  const preflight = checkNote(reportRel, monthlyReport(date, renderReport(date, [], remaining), existingReport, previousSection), activeRules);
  if (preflight.length) return { date, items: [], remaining: selected.length + remaining, sent: false, written: false,
    blocked: `리포트 등록부 위반: ${preflight.join(' / ')}` };
  const registrySummary = activeRules.filter((r) => r.path.startsWith(`${VAULT_REL.recordsRoot}/`) || r.path.startsWith(`${VAULT_REL.knowledge}/`))
    .map((r) => `${r.type}: ${r.path}; 필수 ${[...r.required.bundle, ...r.required.extra].join(', ')}`).join('\n');
  const wikiIndex = selected.length ? readWikiIndex(root) : { paths: new Set(), prompt: '' };
  const agent = selected.length ? (charter ?? loadAgent('clio', { fallbackModel: 'sonnet' })) : null;
  if (agent?.warning) console.warn(agent.warning);
  const systemPrompt = `${agent?.systemPrompt ?? ''}\n\n경로 등록부 요약:\n${registrySummary}\n\n기존 Wiki 색인 (인물: 폴더 · 제목 · 관계 · 별칭 · 설명):\n${wikiIndex.prompt || '없음'}`;
  const decide = judge ?? ((prompt) => runHeadlessClaude(prompt, agent.model, '', {
    appendSystemPrompt: systemPrompt, tools: '', timeoutMs: Math.max(1, Math.min(5 * 60_000, MAX_JOB_MS - (clock() - startedAt))),
  }));
  const items = [];
  for (const item of selected) {
    if (clock() - startedAt >= MAX_JOB_MS) break;
    if (cooldown()) break;
    let failure;
    let attempts = item.attempts;
    let validationError = '';
    let rawPreview;
    for (let attempt = 0; attempt < Math.min(2, 3 - item.attempts) && clock() - startedAt < MAX_JOB_MS; attempt += 1) {
      rawPreview = undefined;
      try {
        const prompt = promptFor(item, registrySummary) + (validationError ? `\n직전 검증 오류: ${validationError}\n오류를 고쳐 JSON 객체만 다시 출력하라.` : '');
        const raw = await decide(prompt, item, systemPrompt);
        attempts += 1;
        let judgment;
        try {
          judgment = validateJudgment(raw, { rules: activeRules, root, date, wikiIndex });
        } catch (error) {
          rawPreview = (typeof raw === 'string' ? raw : JSON.stringify(raw))?.slice(0, 500);
          throw error;
        }
        items.push({ source: item.source, hash: item.hash, status: judgment.unclassifiable ? '분류 불가' : '계획함',
          attempts, ...(judgment.unclassifiable ? { reason: judgment.unclassifiable } : { judgment }) });
        failure = null;
        break;
      } catch (error) {
        if (attempts === item.attempts + attempt) attempts += 1;
        failure = error;
        validationError = String(error.message).slice(0, 200);
        if (error.isLimit || /타임아웃/.test(validationError)) break;
      }
    }
    if (failure) items.push({ source: item.source, hash: item.hash, status: '판단 실패', attempts,
      reason: failure.isLimit ? '사용량 한도' : String(failure.message).slice(0, 200),
      ...(rawPreview === undefined ? {} : { rawPreview }) });
    if (failure?.isLimit) break;
  }
  const finalRemaining = remaining + selected.length - items.length;
  items.push(...oversized, ...exhausted);
  const previousItems = previousPlan?.items ?? [];
  const newSources = new Set(items.map((item) => item.source));
  const allItems = [...previousItems.filter((item) => !newSources.has(item.source)), ...items];
  const newMessageItems = items.filter((item) => item.status !== '보류(재시도 소진)'
    && !(item.status === '판단 실패' && previousStates.get(item.hash)?.status === '판단 실패'))
    .map(({ rawPreview, ...item }) => item);
  const pendingMessageItems = [...previousPending.filter((item) => !newSources.has(item.source)), ...newMessageItems];
  const planContent = (pending) => `${JSON.stringify({ date, mode: 'report', remaining: finalRemaining, items: allItems,
    reportBaseSection: previousSection, pendingMessageItems: pending }, null, 2)}\n`;
  const report = monthlyReport(date, renderReport(date, allItems, finalRemaining), existingReport, previousSection);
  const problems = checkNote(reportRel, report, activeRules);
  if (problems.length) return { date, items, remaining: finalRemaining, sent: false, written: false,
    blocked: `리포트 등록부 위반: ${problems.join(' / ')}`, report };
  if (!dryRun) {
    // 상태 파일을 먼저 남기면 보고서 쓰기 실패 후에도 다음 실행이 절을 복구할 수 있다.
    for (const [rel, content] of [[planRel, planContent(pendingMessageItems)], [reportRel, report]]) {
      const path = join(root, rel);
      mkdirSync(dirname(path), { recursive: true });
      write(path, content);
    }
    write(join(root, planRel), planContent([]));
    recoverOlderReports();
  }
  const message = telegramMessage([...olderPendingItems, ...pendingMessageItems], finalRemaining);
  const sent = !dryRun && !noSend && await sendWithinDeadline(message, send, clock, startedAt);
  return { date, items, remaining: finalRemaining, sent,
    written: !dryRun, report, reportRel, planRel, message };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = Object.fromEntries(process.argv.slice(2).map((arg) => arg.replace(/^--/, '').split('=')).map(([key, value]) => [key, value ?? true]));
  run({ mode: args.mode ?? 'report', dryRun: args['dry-run'] === true, noSend: args['no-send'] === true })
    .then((result) => {
      if (result.blocked) { console.error(result.blocked); process.exitCode = 1; }
      else console.log(`Inbox 계획 ${result.items.length}건, 남은 ${result.remaining}건`);
    }).catch((error) => { console.error(`Inbox ingest 실패: ${error.message}`); process.exitCode = 1; });
}
