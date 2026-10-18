#!/usr/bin/env node
/** 클리오 Inbox ingest: 계획을 검증한 뒤 기록을 한 건씩 적용한다. Wiki는 보류한다. */
import { createHash } from 'node:crypto';
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, unlinkSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { VAULT_PATHS, VAULT_REL } from '../lib/vault-paths.mjs';
import { parseFrontmatter, yamlValue } from '../lib/vault-frontmatter.mjs';
import { checkNote, parseRegistry } from '../lib/vault-registry.mjs';
import { withLock, writeAtomic } from '../lib/state-writer.mjs';
import { cooldownActive } from '../lib/quota-cooldown.mjs';
import { loadAgent } from '../lib/agent-loader.mjs';
import { runHeadlessClaude, headlessResult } from '../lib/headless-claude.mjs';
import { sendAgentMessage } from '../lib/pantheon-send.mjs';
import { agentTitle } from '../lib/agent-registry.mjs';
import { buildWikiCandidates, sourceMeta } from '../lib/wiki-candidates.mjs';
import { aiHashOf, inspectExisting, parseSections, splitNote } from '../lib/daily-note.mjs';

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
const CONVERSATION_KINDS = new Set(['통화', '대면', '회의', '녹음']);
const MAX_EXECUTION_FAILURES = 7;
const EXECUTION_FAILURE_RE = /claude 종료코드|unknown option|Not logged in|claude 빈 출력|claude JSON 출력 오류|타임아웃|사용량 한도|isLimit|spawn|ENOENT|EACCES|EAGAIN|ECONNRESET|EPIPE/i;
const isExecutionFailure = (item) => item.status === '판단 보류(실행 장애)'
  || (item.status === '판단 실패' && !item.attemptedAt && EXECUTION_FAILURE_RE.test(item.reason ?? ''));

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

function readWikiCatalog(root) {
  const catalog = [];
  for (const folder of WIKI_FOLDERS) {
    const queue = [folder];
    while (queue.length) {
      const current = queue.shift();
      if (!existsSync(join(root, current))) continue;
      for (const entry of readdirSync(join(root, current), { withFileTypes: true })) {
        const rel = `${current}/${entry.name}`;
        if (entry.isDirectory()) queue.push(rel);
        else if (entry.isFile() && entry.name.endsWith('.md')) {
          catalog.push({ path: rel.slice(0, -3), aliases: wikiAliases(readWikiHeader(join(root, rel))) });
        }
      }
    }
  }
  return catalog;
}

function refreshWikiCandidates(root, write) {
  const dir = join(root, VAULT_REL.inboxIngestPlans);
  const plans = existsSync(dir) ? readdirSync(dir).filter((name) => /^\d{4}-\d{2}-\d{2}\.json$/.test(name))
    .sort().map((name) => readJson(join(dir, name), {})) : [];
  const content = `${JSON.stringify(buildWikiCandidates(plans, readWikiCatalog(root)), null, 2)}\n`;
  const path = join(root, VAULT_REL.inboxIngestWikiCandidates);
  if (!existsSync(path) && !plans.some((plan) => plan.items?.some((item) => item.status === '계획함'
    && item.judgment?.wiki?.some((wiki) => wiki.action === 'candidate')))) return;
  if (existsSync(path) && readFileSync(path, 'utf8') === content) return;
  mkdirSync(dirname(path), { recursive: true });
  write(path, content);
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
      const retry = processed[entry.source];
      const retryDate = retry?.retryResetAt ? kstDate(new Date(retry.retryResetAt)) : null;
      const beforeRetry = retry?.retryHash === entry.hash && retryDate
        && (entry.attemptedAt ? entry.attemptedAt <= retry.retryResetAt : name.slice(0, 10) <= retryDate);
      if (beforeRetry) continue;
      const prior = states.get(entry.hash) ?? { attempts: 0, rawAttempts: 0, ignoredAttempts: 0,
        executionFailures: 0 };
      const rawAttempts = entry.attempts ?? 0;
      const reset = rawAttempts < prior.rawAttempts;
      const ignoredAttempts = (reset ? 0 : prior.ignoredAttempts) + (isExecutionFailure(entry)
        ? Math.max(0, rawAttempts - (reset ? 0 : prior.rawAttempts)) : 0);
      states.set(entry.hash, { status: entry.status,
        attempts: reset ? rawAttempts - ignoredAttempts : Math.max(prior.attempts, rawAttempts - ignoredAttempts),
        rawAttempts, ignoredAttempts,
        executionFailures: entry.executionFailures ?? (isExecutionFailure(entry)
          ? prior.executionFailures + 1 : prior.executionFailures),
        oversized: entry.status === '판단 실패' && entry.reason?.startsWith('입력 글자 수 상한(') });
      // 지금 기준으로 검사에 걸리는 옛 계획은 '계획함'으로 보지 않고 다시 판단한다(계획 파일은 소급 수정하지 않음).
      if (entry.status === '계획함' && planShapeProblems(entry.judgment).length) {
        states.set(entry.hash, { status: '재판단 필요', attempts: 0, rawAttempts: 0, ignoredAttempts: 0, oversized: false });
        continue;
      }
      if (entry.source && entry.status === '계획함') seen.set(entry.source, entry.hash);
    }
  }
  return { seen, states };
}

export function retryMemo({ root = VAULT_PATHS.root, source, dryRun = false,
  now = new Date(), write = writeAtomic } = {}) {
  if (typeof source !== 'string' || !source.startsWith(`${VAULT_REL.inboxRoot}/`)
      || source.split('/').some((segment) => !segment || segment === '.' || segment === '..')
      || source.includes('\\') || source.slice(VAULT_REL.inboxRoot.length + 1).includes('/')
      || !source.endsWith('.md')) throw new Error(`Inbox 메모 경로가 아님: ${source}`);
  const inbox = join(root, VAULT_REL.inboxRoot);
  const path = join(root, source);
  if (!existsSync(inbox) || !lstatSync(inbox).isDirectory()
      || !existsSync(path) || !lstatSync(path).isFile()) throw new Error(`Inbox 메모 파일이 아님: ${source}`);
  const hash = hashOf(readFileSync(path, 'utf8'));
  const processedPath = join(root, VAULT_REL.inboxIngestProcessed);
  const processed = readJson(processedPath, {});
  const previous = processed[source];
  if ((typeof previous === 'string' ? previous : previous?.hash) === hash)
    throw new Error(`이미 처리 중이거나 적용된 Inbox 메모는 재시도할 수 없음: ${source}`);
  if (!dryRun) {
    processed[source] = { ...(typeof previous === 'string' ? { hash: previous } : previous),
      retryResetAt: now.toISOString(), retryHash: hash };
    mkdirSync(dirname(processedPath), { recursive: true });
    write(processedPath, `${JSON.stringify(processed, null, 2)}\n`);
  }
  return { source, hash, written: !dryRun };
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
      const version = renderReport(date, plan.items ?? [], plan.remaining ?? 0,
        { mode: plan.mode ?? 'report', applyResults: plan.applyResults ?? [], applyRemaining: plan.applyRemaining ?? 0 }).split('\n')[1];
      return { date, path: join(dir, name), plan, reportPath, needsRecovery: !report.includes(version) };
    }).filter(({ plan }) => plan.pendingMessageItems?.length || plan.notificationPending);
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
    if (state?.status === '분류 불가' || state?.oversized || state?.status === '계획함'
        || state?.status === '보류(실행 장애 반복)') return false;
    if (state?.executionFailures >= MAX_EXECUTION_FAILURES) return false;
    if (state?.attempts >= 3) {
      exhausted.push({ source: x.source, hash: x.hash, status: '보류(재시도 소진)', reason: '판단 시도 3회 소진', attempts: state.attempts });
      return false;
    }
    x.attempts = state?.attempts ?? 0;
    x.executionFailures = state?.executionFailures ?? 0;
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

// checkNote가 잡지 않는 등록부 값 규칙(허용값·링크 형식·조건부 필드). 계획 단계와 적용 단계가 같은 검사를 쓴다.
// 계획 단계에서 걸리면 판단을 다시 시키고(직전 검증 오류로 재시도), 이미 저장된 계획이 걸리면 다시 판단 대상으로 돌린다.
export function planShapeProblems(judgment) {
  const problems = [];
  const target = judgment?.target ?? {};
  const frontmatter = judgment?.frontmatter ?? {};
  if (target.type === 'conversation' && !CONVERSATION_KINDS.has(frontmatter.convKind))
    problems.push(`conversation convKind 등록부 허용값 위반: ${frontmatter.convKind} (허용: ${[...CONVERSATION_KINDS].join('·')})`);
  for (const [key, value] of Object.entries(frontmatter)) {
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(key)) problems.push(`머리말 키 형식 위반: ${key}`);
    if ([value].flat().some((part) => typeof part === 'string' && /[\r\n]/.test(part))) problems.push(`머리말 값에 줄바꿈 금지: ${key}`);
  }
  const categories = Array.isArray(frontmatter.category) ? frontmatter.category : null;
  const categoryLink = new RegExp(`^\\[\\[${VAULT_REL.homeDir}/[^\\]]+\\]\\]$`);
  if (!categories || !categories.length || !categories.every((value) => categoryLink.test(value)))
    problems.push(`category는 ${VAULT_REL.homeDir} 링크 배열이어야 함(예: ["[[${VAULT_REL.homeDir}/201 미네]]"])`);
  if (target.type === 'conversation' && categories?.some((value) => value.includes('201 미네'))
      && ['emotions', 'primaryEmotion', 'importance', 'mineAge'].some((key) => frontmatter[key] == null))
    problems.push('201 미네 conversation은 emotions·primaryEmotion·importance·mineAge가 필요함 — 대화가 아닌 글 메모는 21_Notes 노트로');
  return problems;
}

function targetPreview(judgment, date) {
  const { target, frontmatter } = judgment;
  const fields = { type: target.type, category: frontmatter.category, description: frontmatter.description,
    sensitivity: frontmatter.sensitivity, created: frontmatter.created ?? date,
    modified: frontmatter.modified ?? date, ...frontmatter };
  const lines = Object.entries(fields).filter(([, value]) => value !== undefined).map(([key, value]) => `${key}: ${yaml(value)}`);
  return `---\n${lines.join('\n')}\n---\n\n계획 검증용 본문\n`;
}

// 원본 인박스 머리말에서 출처·작성 시각을 보존한다(판단 머리말보다 원본이 정본인 값).
function sourceFields(sourceContent) {
  const match = sourceContent.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  const fields = match ? parseFrontmatter(`---\n${match[1]}\n---\n`) ?? {} : {};
  const body = match ? sourceContent.slice(match[0].length) : sourceContent;
  return { fields, body };
}

function sourceDailyDate(sourceContent) {
  const { fields } = sourceFields(sourceContent);
  for (const value of [fields.occurred, fields.created]) {
    const date = typeof value === 'string' ? value.match(/^\d{4}-\d{2}-\d{2}/)?.[0] : null;
    if (!date || Number.isNaN(Date.parse(`${date}T00:00:00Z`))
        || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) continue;
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) {
      const instant = new Date(value);
      if (!Number.isNaN(instant.getTime())) {
        return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul',
          year: 'numeric', month: '2-digit', day: '2-digit' }).format(instant);
      }
      continue;
    }
    return date;
  }
  return null;
}

function movedContent(item, sourceContent, { planDate, applyDate }) {
  const { fields: original, body } = sourceFields(sourceContent);
  const created = original.created ?? item.judgment.frontmatter.created ?? planDate;
  const judged = item.judgment.frontmatter;
  const fields = { ...original, ...judged, type: item.judgment.target.type,
    sensitivity: original.sensitivity ?? judged.sensitivity,
    ...Object.fromEntries(['attachment', 'capturedAt', 'occurred', 'origin', 'created']
      .filter((key) => Object.hasOwn(original, key)).map((key) => [key, original[key]])),
    created, modified: applyDate,
    movedFrom: [item.source.replace(/\.md$/, '')] };
  return `---\n${Object.entries(fields).map(([key, value]) => `${key}: ${yamlValue(value)}`).join('\n')}\n---\n${body}`;
}

// 데일리 기계 구역(오늘 들어온 기록)에 링크 한 줄. 데일리 잡의 무결성 지문(aiHash)을 같은 쓰기에서 다시 계산한다
// (안 하면 데일리 잡이 오너 수정으로 보고 그날 노트 갱신을 영구히 거부함 — 리뷰 HIGH). 이미 오너가 AI 칸을 고친 노트면 손대지 않는다.
function dailyChange(content, source, target, applyDate) {
  if (!inspectExisting(content).ok) return { pending: '데일리 AI 칸이 오너 수정 상태라 손대지 않음' };
  const start = content.search(/^## 오늘 들어온 기록\s*$/m);
  if (start < 0) return { pending: '데일리 기계 구역(오늘 들어온 기록) 없음' };
  const next = content.slice(start + 1).search(/^## /m);
  const end = next < 0 ? content.length : start + 1 + next;
  const section = content.slice(start, end);
  const oldLink = `[[${source.replace(/\.md$/, '')}|`;
  const newLink = `[[${target.replace(/\.md$/, '')}|`;
  if (section.includes(newLink)) return { content, line: section.split('\n').find((line) => line.includes(newLink)) };
  const oldLine = section.split('\n').find((line) => line.includes(oldLink));
  const title = target.split('/').at(-1).replace(/\.md$/, '');
  const suffix = oldLine?.match(/^.*?\]\](.*)$/)?.[1] ?? '';
  const line = `- [[${target.replace(/\.md$/, '')}|${title}]]${suffix}`;
  const changed = oldLine ? section.replace(oldLine, () => line) : `${section.replace(/\s*$/, '')}\n${line}\n\n`;
  const body = content.slice(0, start) + changed + content.slice(end);
  const sections = parseSections(splitNote(body).body).sections;
  const fmEnd = body.indexOf('\n---', 4);
  const head = body.slice(0, fmEnd).replace(/^aiHash: .*$/m, `aiHash: "${aiHashOf(sections)}"`)
    .replace(/^modified: .*$/m, `modified: "${applyDate}"`);
  return { content: head + body.slice(fmEnd), line };
}

function applyOne(root, item, planDate, rules, { dryRun, noWiki, write, applyDate }) {
  if (item.status !== '계획함' || !item.judgment || !item.hash) throw new Error('적용 가능한 계획 항목이 아님');
  if (!item.source.startsWith(`${VAULT_REL.inboxRoot}/`) || item.source.includes('..') || item.source.includes('\\')) throw new Error('원본 경로 위반');
  const { target, dailyLink, wiki } = item.judgment;
  const rel = `${target.folder}/${target.title}.md`;
  if (!target.folder.startsWith(`${VAULT_REL.recordsRoot}/`) || target.folder.includes('..')
      || target.title.includes('/') || target.title.includes('\\')) throw new Error('대상 경로 위반');
  if (dailyLink != null && !/^\d{4}-\d{2}-\d{2}$/.test(String(dailyLink))) throw new Error('dailyLink 형식 위반');
  if (wiki?.length && !noWiki) throw new Error('Wiki 반영은 아직 지원하지 않음: --no-wiki로 보류 필요');
  const shape = planShapeProblems(item.judgment);
  if (shape.length) throw new Error(shape.join(' / '));
  const statePath = join(root, VAULT_REL.inboxIngestProcessed);
  const state = readJson(statePath, {});
  const resuming = state[item.source]?.status === 'applying' && state[item.source]?.hash === item.hash;
  const sourcePath = join(root, item.source);
  const targetPath = join(root, rel);
  const sourceExists = existsSync(sourcePath);
  if (!sourceExists && !resuming) throw new Error(`원본 없음: ${item.source}`);
  const sourceContent = sourceExists ? readFileSync(sourcePath, 'utf8') : null;
  if (sourceContent != null && hashOf(sourceContent) !== item.hash) throw new Error(`원본 해시 변경: ${item.source}`);
  let content = null;
  if (existsSync(targetPath)) {
    // 중간에 멈춘 적용의 재개: 대상이 이미 이 원본에서 옮겨진 노트면 남은 단계만 한다.
    const existing = readFileSync(targetPath, 'utf8');
    if (!resuming || !existing.includes(`"${item.source.replace(/\.md$/, '')}"`)) throw new Error(`대상 이미 있음: ${rel}`);
  } else {
    if (!sourceContent) throw new Error(`원본 없음: ${item.source}`);
    content = movedContent(item, sourceContent, { planDate, applyDate });
    const problems = checkNote(rel, content, rules);
    if (problems.length) throw new Error(`등록부 위반: ${problems.join(' / ')}`);
  }
  const dailyRel = dailyLink ? `${VAULT_REL.dailyNotes}/${dailyLink.slice(0, 4)}/${dailyLink}.md` : null;
  const dailyPath = dailyRel ? join(root, dailyRel) : null;
  const dailyBefore = dailyPath && existsSync(dailyPath) ? readFileSync(dailyPath, 'utf8') : null;
  const daily = dailyBefore != null ? dailyChange(dailyBefore, item.source, rel, applyDate) : null;
  if (daily?.content) {
    const dailyProblems = checkNote(dailyRel, daily.content, rules);
    if (dailyProblems.length) throw new Error(`데일리 등록부 위반: ${dailyProblems.join(' / ')}`);
  }
  const logRel = `${VAULT_REL.clioLog}/${applyDate.slice(0, 7)}.md`;
  const logPath = join(root, logRel);
  const oldLog = existsSync(logPath) ? readFileSync(logPath, 'utf8') : null;
  const logLine = `- ${applyDate} Inbox apply: [[${rel.replace(/\.md$/, '')}]] ← ${item.source} (Wiki ${noWiki ? '보류' : '없음'}; 데일리 ${daily?.content ? '연결' : '보류'})`;
  // 재개를 다른 날 해도 같은 원본의 적용 줄이 두 번 붙지 않게 원본 경로 기준으로 비교한다.
  const log = oldLog?.includes(`Inbox apply: [[${rel.replace(/\.md$/, '')}]] ← ${item.source} `) ? oldLog : oldLog ? `${oldLog.replace(/\s*$/, '')}\n${logLine}\n`
    : `---\ntype: "agent-log"\ndescription: "${agentTitle('clio')} 작업 기록"\ncreated: "${applyDate}"\nmodified: "${applyDate}"\nagent: "clio"\n---\n\n# ${applyDate.slice(0, 7)}\n\n${logLine}\n`;
  const logProblems = checkNote(logRel, log, rules);
  if (logProblems.length) throw new Error(`로그 등록부 위반: ${logProblems.join(' / ')}`);
  const result = { source: item.source, target: rel, daily: daily?.line ?? null,
    dailyPending: dailyRel && !daily?.content ? (daily?.pending ? `${dailyRel} (${daily.pending})` : dailyRel) : null,
    wikiPending: noWiki ? wiki ?? [] : [], written: !dryRun, resumed: resuming };
  if (dryRun) return result;
  const saveState = (value) => {
    mkdirSync(dirname(statePath), { recursive: true });
    write(statePath, `${JSON.stringify({ ...readJson(statePath, {}), [item.source]: value }, null, 2)}\n`);
  };
  // 쓰기 순서: 진행 표시 → 노트 → 데일리 → 로그 → 원본 비움 → 완료. 중간에 멈추면 다음 실행이 'applying'을 보고 남은 단계만 한다.
  saveState({ hash: item.hash, target: rel, status: 'applying', startedAt: applyDate });
  if (content != null) {
    mkdirSync(dirname(targetPath), { recursive: true });
    write(targetPath, content); // 클리오 절차 §5: LiveSync 손상 방지를 위해 노트 한 번 쓰기.
  }
  if (daily?.content && daily.content !== dailyBefore) write(dailyPath, daily.content);
  if (log !== oldLog) { mkdirSync(dirname(logPath), { recursive: true }); write(logPath, log); }
  // D30·D95: Inbox 원본은 새 기록으로 옮긴 뒤 비운다. 옛 경로는 movedFrom에 남기며 재사용하지 않는다.
  if (existsSync(sourcePath)) unlinkSync(sourcePath);
  saveState({ hash: item.hash, target: rel, appliedAt: applyDate });
  return result;
}

// 같은 원본이 여러 날짜 계획에 있으면(재판단 등) 지금 기준을 통과하는 '계획함' 중 가장 최신 날짜 1건만 쓴다.
export function findPlan(root, id) {
  const dir = join(root, VAULT_REL.inboxIngestPlans);
  if (!existsSync(dir)) return [];
  const byKey = new Map();
  for (const name of readdirSync(dir).filter((x) => /^\d{4}-\d{2}-\d{2}\.json$/.test(x)).sort()) {
    for (const item of readJson(join(dir, name), {}).items ?? []) {
      if ((item.source !== id && item.hash !== id) || item.status !== '계획함' || planShapeProblems(item.judgment).length) continue;
      byKey.set(item.source, { item, date: name.slice(0, 10) });
    }
  }
  return [...byKey.values()];
}

export function applicablePlans(root) {
  const dir = join(root, VAULT_REL.inboxIngestPlans);
  if (!existsSync(dir)) return [];
  const latest = new Map();
  for (const name of readdirSync(dir).filter((x) => /^\d{4}-\d{2}-\d{2}\.json$/.test(x)).sort()) {
    const date = name.slice(0, 10);
    for (const item of readJson(join(dir, name), {}).items ?? []) {
      if (item.status !== '계획함' || !item.hash || !item.source || planShapeProblems(item.judgment).length) continue;
      latest.set(item.source, { item, date });
    }
  }
  const processed = readJson(join(root, VAULT_REL.inboxIngestProcessed), {});
  const memoDate = ({ item, date }) => item.sourceMeta?.occurredAt
    ?? basename(item.source).match(/^\d{4}-\d{2}-\d{2}/)?.[0]
    ?? item.judgment?.dailyLink ?? date;
  return [...latest.values()].filter(({ item }) => !(processed[item.source]?.hash === item.hash
    && (processed[item.source]?.appliedAt || ['source-gone', 'target-exists'].includes(processed[item.source]?.status))))
    .sort((a, b) => memoDate(a).localeCompare(memoDate(b))
      || a.item.source.localeCompare(b.item.source, 'ko'));
}

function applyPendingPlans(root, rules, { dryRun, write, now, clock, startedAt, jobBudgetMs, onResult }) {
  const results = [];
  const pending = applicablePlans(root);
  for (const { item } of pending) {
    if (clock() - startedAt >= jobBudgetMs) break;
    let result;
    try {
      result = applyPlans({ root, ids: item.source, dryRun, noWiki: true, rules, write, now }).items[0];
    } catch (error) {
      const failed = String(error.message).slice(0, 200);
      const status = failed.startsWith('원본 없음:') ? 'source-gone'
        : failed.startsWith('대상 이미 있음:') ? 'target-exists' : null;
      if (status && !dryRun) {
        const statePath = join(root, VAULT_REL.inboxIngestProcessed);
        const state = readJson(statePath, {});
        const prior = state[item.source];
        state[item.source] = { hash: item.hash, status, failures: (prior?.failures ?? 0) + 1,
          failedAt: now.toISOString() };
        mkdirSync(dirname(statePath), { recursive: true });
        write(statePath, `${JSON.stringify(state, null, 2)}\n`);
      }
      result = { source: item.source, failed };
    }
    results.push(result);
    onResult?.(result, pending.length - results.length);
  }
  return { results, remaining: pending.length - results.length };
}

export function applyPlans({ root = VAULT_PATHS.root, ids, dryRun = false, noWiki = false,
  rules, write = writeAtomic, now = new Date() } = {}) {
  // 점진 가동: 한 번에 1건만. 인박스 파일 이름에 쉼표가 들어갈 수 있어 문자열은 나누지 않고 통째로 하나로 본다.
  const selected = typeof ids === 'string' ? [ids.trim()].filter(Boolean) : ids;
  if (!Array.isArray(selected) || selected.length !== 1) throw new Error('--apply는 --ids로 계획 항목 1건을 명시해야 함');
  const activeRules = rules ?? parseRegistry(readFileSync(join(root, VAULT_REL.registryFile), 'utf8'));
  const matches = findPlan(root, selected[0]);
  if (matches.length !== 1) throw new Error(`적용 가능한 계획 항목 ${matches.length}건 일치: ${selected[0]}`);
  const { item, date } = matches[0];
  const state = readJson(join(root, VAULT_REL.inboxIngestProcessed), {});
  if (state[item.source]?.hash === item.hash
      && ['source-gone', 'target-exists'].includes(state[item.source]?.status))
    throw new Error(`적용 실패 확정: ${state[item.source].status}: ${item.source}`);
  if (state[item.source]?.hash === item.hash && state[item.source]?.appliedAt)
    return { items: [{ source: item.source, target: state[item.source].target, alreadyApplied: true, written: false }], written: false };
  return { items: [applyOne(root, item, date, activeRules, { dryRun, noWiki, write, applyDate: kstDate(now) })], written: !dryRun };
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

export function validateJudgment(raw, { rules, root, date, sourceContent, wikiIndex = readWikiIndex(root) }) {
  const value = typeof raw === 'string' ? parseJudgment(raw) : raw;
  if (!plain(value) || !plain(value.target) || !plain(value.frontmatter) || !plain(value.extracted)
      || !Array.isArray(value.wiki) || !(value.dailyLink == null || typeof value.dailyLink === 'string')
      || !(value.unclassifiable === null || typeof value.unclassifiable === 'string')) throw new Error('JSON 스키마 위반');
  for (const key of EXTRACTED_KEYS) {
    const entries = value.extracted[key];
    const actualType = (entry) => entry === null ? 'null' : Array.isArray(entry) ? 'array' : typeof entry;
    if (!Array.isArray(entries)) throw new Error(`추출 스키마 위반: ${key}이 배열이 아님(${actualType(entries)})`);
    const invalidIndex = entries.findIndex((entry) => typeof entry !== 'string');
    if (invalidIndex !== -1) throw new Error(`추출 스키마 위반: ${key}[${invalidIndex}]이 문자열이 아님(${actualType(entries[invalidIndex])})`);
  }
  // 데일리 연결은 판단 누락으로 잃지 않게 원본 머리말의 사건일·작성일을 우선 근거로 보정한다.
  const dailyLink = value.dailyLink?.match(DATE_RE)?.[0]
    ?? (sourceContent ? sourceDailyDate(sourceContent) : null);
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
  const problems = [...checkNote(rel, targetPreview(value, date), rules), ...planShapeProblems(value)];
  if (problems.length) throw new Error(`등록부 위반: ${problems.join(' / ')}`);
  const wiki = value.wiki.map((entry) => {
    const page = entry.page.replace(/\.md$/, '');
    if (!page.startsWith(`${VAULT_REL.knowledge}/`) || page.includes('..') || page.includes('\\')) throw new Error('Wiki 경로 위반');
    return entry.action === 'append-source' && !wikiIndex.paths.has(page)
      ? { ...entry, action: 'candidate', reason: `${entry.reason} (페이지 없음 — 생성 관문 보류)` } : entry;
  });
  return { ...value, dailyLink, wiki };
}

function homeCategories(root) {
  const dir = join(root, VAULT_REL.homeDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^\d{3} .+\.md$/.test(entry.name))
    .map((entry) => `[[${VAULT_REL.homeDir}/${entry.name.slice(0, -3)}]]`)
    .sort((a, b) => a.localeCompare(b, 'ko'));
}

function promptFor(item, registrySummary, requiredRules, categories, conversationKinds) {
  const categoryExample = categories[0] ?? `[[${VAULT_REL.homeDir}/카테고리 노트]]`;
  const requiredSummary = requiredRules.map((rule) => `${rule.type} (${rule.path}): ${[...rule.required.bundle, ...rule.required.extra].join(', ')}`).join('; ');
  const exampleRule = requiredRules.find((rule) => rule.type === 'note') ?? requiredRules[0];
  const exampleFields = [...new Set([...exampleRule.required.bundle, ...exampleRule.required.extra])];
  const exampleFrontmatter = Object.fromEntries(exampleFields.map((field) => [field,
    field === 'type' ? exampleRule.type : field === 'category' ? [categoryExample] : '(필수 값)']));
  return `다음 Inbox 메모를 기록 대상으로 분류하라. JSON 객체만 출력하고 도구는 사용하지 마라.\n`
    + `순서: 분류→인물·장소·주제·물건·날짜·할 일·결정 추출→Wiki 기존 페이지 보강 또는 후보/질문→데일리 연결.\n`
    + `새 Wiki 페이지는 D32 생성 관문과 D79 개념 테스트를 통과할 때까지 candidate로 둔다. 분류 불가면 이유를 적는다.\n`
    + `배우자·아내·와이프·엄마·아빠 같은 관계어는 relation으로 기존 인물에 매칭하라.\n`
    + `텔레그램·옵시디언 글 메모는 note(${VAULT_REL.recordsRoot}/21_Notes)다. 미네가 직접 쓴 글도 note다. conversation은 실제 통화·대면·회의·녹음 기록에만 사용하라.\n`
    + `category는 다음 실제 카테고리 노트 링크 중에서 골라 배열로 넣어라: ${categories.join(', ') || '목록 없음'}\n`
    + `conversation의 convKind 허용값: ${conversationKinds.join(', ') || '등록부에 없음'}\n`
    + `경로 등록부 요약:\n${registrySummary}\n`
    + `frontmatter에는 고른 type의 필수 필드를 빠짐없이 모두 넣어라: ${requiredSummary}. type은 target.type과 같아야 한다.\n`
    + `정확한 JSON 스키마: {"target":{"folder":"${VAULT_REL.recordsRoot}/.../{YYYY}","type":"note|literature|conversation|media","title":"YYYY-MM-DD 제목"},"frontmatter":${JSON.stringify(exampleFrontmatter)},"extracted":{"people":[],"places":[],"topics":[],"objects":[],"dates":[],"todos":[],"decisions":[]},"wiki":[{"action":"append-source|candidate|question","page":"${VAULT_REL.knowledge}/...","reason":"..."}],"dailyLink":"YYYY-MM-DD","unclassifiable":null}\n`
    + `원본 머리말에 occurred 또는 created 날짜가 있으면 dailyLink에 그 날짜(YYYY-MM-DD)를 반드시 넣어라. 둘 다 있으면 occurred를 우선한다.\n`
    + `extracted의 모든 값은 문자열 배열이며 객체를 넣지 마라. 인물은 Wiki 페이지 제목 그대로(예: "미네") 쓰고 관계 정보는 넣지 마라. frontmatter 값은 문자열·숫자·불리언 또는 그 배열만 허용한다.\n`
    + `제목은 날짜를 포함해 60자 이내로 작성하라.\n`
    + `원본 경로: ${item.source}\n원문:\n${item.content}`;
}

export function renderReport(date, items, remaining, { mode = 'report', applyResults = [], applyRemaining = 0 } = {}) {
  const version = hashOf(JSON.stringify({ items, remaining, mode, applyResults, applyRemaining })).slice(0, 16);
  const applied = applyResults.filter((item) => item.written);
  const wikiPending = applied.reduce((count, item) => count + (item.wikiPending?.length ?? 0), 0);
  const lines = [`<!-- clio-inbox-ingest:${date}:start -->`, `<!-- clio-inbox-ingest:${date}:version:${version} -->`,
    `## ${date} Inbox ingest ${mode === 'auto' ? '적용 결과' : '계획'}`, '',
    mode === 'auto' ? `적용 ${applied.length}건 · 적용 실패 ${applyResults.filter((item) => item.failed).length}건 · Wiki 보류 ${wikiPending}건 · 적용 대기 ${applyRemaining}건`
      : '리포트만 — 실제 이동 없음', '',
    `계획 ${items.filter((x) => x.status === '계획함').length}건 · 판단 실패 ${items.filter((x) => x.status === '판단 실패' && !isExecutionFailure(x)).length}건 · 실행 장애 ${items.filter(isExecutionFailure).length}건 · 분류 불가 ${items.filter((x) => x.status === '분류 불가').length}건 · 보류(재시도 소진) ${items.filter((x) => x.status === '보류(재시도 소진)').length}건 · 남은 ${remaining}건`, ''];
  for (const result of applyResults) {
    lines.push(`### 적용: ${result.source}`, result.failed ? `- 실패: ${result.failed}`
      : `- 이동: ${result.source} → ${result.target}`, ...(result.failed ? [] : [
        `- 데일리: ${result.daily ? '연결' : result.dailyPending ? `보류 (${result.dailyPending})` : '없음'}`,
        `- Wiki 보류: ${result.wikiPending?.length ?? 0}건`]), '');
  }
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
  if (existing.includes(end) || existing.includes(`## ${date} Inbox ingest 계획`) || existing.includes(`## ${date} Inbox ingest 적용 결과`)) {
    throw new Error(`기존 Inbox ingest 절 경계 불명확: ${date}`);
  }
  return `${existing}${existing.endsWith('\n') ? '\n' : '\n\n'}${section}`;
}

export function telegramMessage(items, remaining, { mode = 'report', applyResults = [], applyRemaining = 0 } = {}) {
  const planned = items.filter((x) => x.status === '계획함');
  if (!items.length && !applyResults.length) return null;
  const failed = items.filter((item) => item.status === '판단 실패' && !isExecutionFailure(item)).length;
  const unclassifiable = items.filter((item) => item.status === '분류 불가').length;
  const oneLine = (value) => String(value).replace(/\s+/g, ' ').trim();
  // 제목 상한은 Telegram에서 한 항목을 훑어보기 위한 가독성 제한이다(D96).
  const titleLine = (value) => Array.from(oneLine(value)).slice(0, MAX_TITLE_CHARS).join('');
  const applied = applyResults.filter((item) => item.written);
  const wikiPending = applied.reduce((count, item) => count + (item.wikiPending?.length ?? 0), 0);
  const body = [mode === 'auto' ? `적용 결과: 이동 ${applied.length}건 · 실패 ${applyResults.filter((item) => item.failed).length}건 · Wiki 보류 ${wikiPending}건 · 적용 대기 ${applyRemaining}건`
    : '리포트만 — 실제 이동 없음',
    `계획 ${planned.length}건 · 판단 실패 ${failed}건 · 실행 장애 ${items.filter(isExecutionFailure).length}건 · 분류 불가 ${unclassifiable}건 · 남은 ${remaining}건`,
    ...applyResults.flatMap((item) => item.failed ? [`■ 적용 실패: ${oneLine(item.source)} — ${oneLine(item.failed)}`]
      : [`■ 이동: ${oneLine(item.source)} → ${oneLine(item.target)}`, `• 데일리: ${item.daily ? '연결' : item.dailyPending ? `보류 (${oneLine(item.dailyPending)})` : '없음'}`]),
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
    })].join('\n');
  return { agent: 'clio', kind: '정보', topic: mode === 'auto' ? 'Inbox 적용 결과' : 'Inbox 정리 계획', body };
}

async function sendWithinDeadline(message, send, clock, startedAt, jobBudgetMs = MAX_JOB_MS) {
  const timeLeft = jobBudgetMs - (clock() - startedAt);
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
  } catch (error) {
    console.error(`Inbox 알림 발송 실패: ${error.message}`);
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export async function run({ root = VAULT_PATHS.root, mode = 'report', dryRun = false, preview = false, noSend = false,
  now = new Date(), rules, judge, send, cooldown = cooldownActive, charter, maxItems = MAX_ITEMS,
  maxChars = MAX_INPUT_CHARS, write = writeAtomic, clock = () => Date.now() } = {}) {
  if (!['report', 'auto'].includes(mode)) throw new Error(`지원하지 않는 mode: ${mode}`);
  const date = kstDate(now);
  const activeRules = rules ?? parseRegistry(readFileSync(join(root, VAULT_REL.registryFile), 'utf8'));
  const startedAt = clock();
  const jobBudgetMs = mode === 'auto' ? Math.max(0, Math.min(MAX_JOB_MS,
    new Date(`${date}T05:30:00+09:00`).getTime() - now.getTime())) : MAX_JOB_MS;
  const previousStates = knownHashes(root).states;
  const { selected, oversized, exhausted, remaining } = collectInbox(root, { maxItems, maxChars });
  if (preview) {
    const pending = mode === 'auto' ? applicablePlans(root) : [];
    return { date, items: [], retryCandidates: selected.length, applyCandidates: pending.length,
      applySources: pending.map(({ item }) => item.source), remaining, written: false, sent: false };
  }
  const reportRel = `${VAULT_REL.clioLog}/${date.slice(0, 7)}.md`;
  const reportPath = join(root, reportRel);
  const existingReport = existsSync(reportPath) ? readFileSync(reportPath, 'utf8') : null;
  const planRel = `${VAULT_REL.inboxIngestPlans}/${date}.json`;
  const previousPlan = readJson(join(root, planRel), null);
  const recordedMode = previousPlan?.mode === 'auto' ? 'auto' : mode;
  const olderPendingPlans = pendingPlans(root).filter(({ path }) => path !== join(root, planRel));
  const olderPendingItems = olderPendingPlans.flatMap(({ plan }) => plan.pendingMessageItems);
  const olderPendingApplyResults = olderPendingPlans.flatMap(({ plan }) => plan.notificationPending
    ? plan.pendingApplyResults ?? plan.applyResults ?? [] : []);
  const sectionStart = `<!-- clio-inbox-ingest:${date}:start -->`;
  const plannedSection = previousPlan ? renderReport(date, previousPlan.items ?? [], previousPlan.remaining ?? 0,
    { mode: previousPlan.mode ?? 'report', applyResults: previousPlan.applyResults ?? [], applyRemaining: previousPlan.applyRemaining ?? 0 }) : null;
  const plannedVersion = plannedSection?.split('\n')[1];
  const needsReportRecovery = previousPlan && (!existingReport?.includes(sectionStart)
    || !existingReport.includes(plannedVersion));
  const previousPending = previousPlan?.pendingMessageItems ?? [];
  const recoverOlderReports = () => {
    for (const { date: oldDate, plan, reportPath: oldReportPath, needsRecovery } of olderPendingPlans) {
      if (!needsRecovery) continue;
      const oldReport = existsSync(oldReportPath) ? readFileSync(oldReportPath, 'utf8') : null;
      const oldSection = renderReport(oldDate, plan.items ?? [], plan.remaining ?? 0,
        { mode: plan.mode ?? 'report', applyResults: plan.applyResults ?? [], applyRemaining: plan.applyRemaining ?? 0 });
      const recovered = monthlyReport(oldDate, oldSection, oldReport, plan.reportBaseSection ?? oldSection);
      const problems = checkNote(`${VAULT_REL.clioLog}/${oldDate.slice(0, 7)}.md`, recovered, activeRules);
      if (problems.length) throw new Error(`이전 리포트 등록부 위반: ${problems.join(' / ')}`);
      mkdirSync(dirname(oldReportPath), { recursive: true });
      write(oldReportPath, recovered);
    }
  };
  const clearPendingMessages = (paths) => {
    for (const path of paths) {
      const plan = readJson(path, null);
      if (plan?.pendingMessageItems?.length || plan?.notificationPending)
        write(path, `${JSON.stringify({ ...plan, pendingMessageItems: [], pendingApplyResults: [],
          notificationPending: false }, null, 2)}\n`);
    }
  };
  if (!selected.length && !oversized.length && !exhausted.length && !remaining && !needsReportRecovery && !previousPending.length
      && !previousPlan?.notificationPending
      && (mode !== 'auto' || !applicablePlans(root).length)) {
    const message = telegramMessage(olderPendingItems, remaining, { mode, applyResults: olderPendingApplyResults });
    if (!dryRun) {
      refreshWikiCandidates(root, write);
      recoverOlderReports();
    }
    const sent = !dryRun && !noSend && await sendWithinDeadline(message, send, clock, startedAt, MAX_JOB_MS);
    if (sent) clearPendingMessages(olderPendingPlans.map(({ path }) => path));
    return { date, items: [], remaining, sent, written: !dryRun && !!olderPendingPlans.length, message };
  }
  const previousSection = needsReportRecovery && previousPlan.reportBaseSection
    ? previousPlan.reportBaseSection : plannedSection;
  const preflight = checkNote(reportRel, monthlyReport(date, renderReport(date, [], remaining), existingReport, previousSection), activeRules);
  if (preflight.length) return { date, items: [], remaining: selected.length + remaining, sent: false, written: false,
    blocked: `리포트 등록부 위반: ${preflight.join(' / ')}` };
  let applyResults = [...(previousPlan?.applyResults ?? [])];
  let applyRemaining = previousPlan?.applyRemaining ?? 0;
  let notificationApplyResults = previousPlan?.notificationPending
    ? [...(previousPlan.pendingApplyResults ?? previousPlan.applyResults ?? [])] : [];
  if (mode === 'auto' && !dryRun) {
    const batch = applyPendingPlans(root, activeRules, { dryRun: false, write, now, clock, startedAt, jobBudgetMs,
      onResult: (result, pendingCount) => {
        applyResults = [...applyResults.filter((item) => item.source !== result.source), result];
        notificationApplyResults = [...notificationApplyResults.filter((item) => item.source !== result.source), result];
        applyRemaining = pendingCount;
        const checkpoint = { date, mode: recordedMode, remaining: previousPlan?.remaining ?? remaining,
          items: previousPlan?.items ?? [], reportBaseSection: previousSection,
          pendingMessageItems: previousPending, notificationPending: true,
          pendingApplyResults: notificationApplyResults, applyResults, applyRemaining };
        const path = join(root, planRel);
        mkdirSync(dirname(path), { recursive: true });
        write(path, `${JSON.stringify(checkpoint, null, 2)}\n`);
      } });
    applyRemaining = batch.remaining;
  }
  const requiredRules = activeRules.filter((rule) => rule.path.startsWith(`${VAULT_REL.recordsRoot}/`));
  const registrySummary = activeRules.filter((r) => r.path.startsWith(`${VAULT_REL.recordsRoot}/`) || r.path.startsWith(`${VAULT_REL.knowledge}/`))
    .map((r) => `${r.type}: ${r.path}; 필수 ${[...r.required.bundle, ...r.required.extra].join(', ')}`).join('\n');
  const categories = selected.length ? homeCategories(root) : [];
  const conversationKinds = activeRules.find((rule) => rule.type === 'conversation')?.allowedValues?.convKind ?? [];
  const wikiIndex = selected.length ? readWikiIndex(root) : { paths: new Set(), prompt: '' };
  const agent = selected.length ? (charter ?? loadAgent('clio', { fallbackModel: 'sonnet' })) : null;
  if (agent?.warning) console.warn(agent.warning);
  const systemPrompt = `${agent?.systemPrompt ?? ''}\n\n글 메모는 note, 실제 통화·대면·회의·녹음 기록만 conversation. category는 ${VAULT_REL.homeDir} 링크 배열.\n\n경로 등록부 요약:\n${registrySummary}\n\n기존 Wiki 색인 (인물: 폴더 · 제목 · 관계 · 별칭 · 설명):\n${wikiIndex.prompt || '없음'}`;
  const decide = judge ?? (async (prompt) => {
    try {
      return headlessResult(await runHeadlessClaude(prompt, agent.model, '', {
        lean: true, appendSystemPrompt: systemPrompt, tools: '', maxTurns: 1,
        timeoutMs: Math.max(1, Math.min(5 * 60_000, jobBudgetMs - (clock() - startedAt))),
      }));
    } catch (error) {
      error.executionFailure = true;
      throw error;
    }
  });
  const items = [];
  for (const item of selected) {
    if (clock() - startedAt >= jobBudgetMs) break;
    if (cooldown()) break;
    let failure;
    let attempts = item.attempts;
    let validationError = '';
    let rawPreview;
    for (let attempt = 0; attempt < 2 && attempts < 3 && clock() - startedAt < jobBudgetMs; attempt += 1) {
      rawPreview = undefined;
      try {
        const prompt = promptFor(item, registrySummary, requiredRules, categories, conversationKinds) + (validationError ? `\n직전 검증 오류: ${validationError}\n오류를 고쳐 JSON 객체만 다시 출력하라.` : '');
        let raw;
        try {
          raw = await decide(prompt, item, systemPrompt);
        } catch (error) {
          error.executionFailure = true;
          throw error;
        }
        let judgment;
        try {
          judgment = validateJudgment(raw, { rules: activeRules, root, date, sourceContent: item.content, wikiIndex });
        } catch (error) {
          attempts += 1;
          rawPreview = (typeof raw === 'string' ? raw : JSON.stringify(raw))?.slice(0, 500);
          throw error;
        }
        items.push({ source: item.source, hash: item.hash, attemptedAt: now.toISOString(),
          status: judgment.unclassifiable ? '분류 불가' : '계획함',
          attempts, ...(judgment.unclassifiable ? { reason: judgment.unclassifiable }
            : { judgment, sourceMeta: sourceMeta(item.content, date, parseFrontmatter) }) });
        failure = null;
        break;
      } catch (error) {
        failure = error;
        validationError = String(error.message).slice(0, 200);
        if (error.executionFailure || error.isLimit) break;
      }
    }
    if (failure) items.push({ source: item.source, hash: item.hash, attemptedAt: now.toISOString(),
      status: failure.executionFailure || failure.isLimit
        ? item.executionFailures + 1 >= MAX_EXECUTION_FAILURES
          ? '보류(실행 장애 반복)' : '판단 보류(실행 장애)' : '판단 실패', attempts,
      executionFailures: item.executionFailures + (failure.executionFailure || failure.isLimit ? 1 : 0),
      reason: failure.isLimit ? '사용량 한도' : String(failure.message).slice(0, 200),
      ...(rawPreview === undefined ? {} : { rawPreview }) });
    if (failure?.executionFailure || failure?.isLimit) break;
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
  const planContent = (pending) => `${JSON.stringify({ date, mode: recordedMode, remaining: finalRemaining, items: allItems,
    reportBaseSection: previousSection, pendingMessageItems: pending,
    notificationPending: pending.length > 0 || notificationApplyResults.length > 0,
    pendingApplyResults: notificationApplyResults, applyResults, applyRemaining }, null, 2)}\n`;
  const reportFor = (base = existingReport) => monthlyReport(date, renderReport(date, allItems, finalRemaining,
    { mode: recordedMode, applyResults, applyRemaining }), base, previousSection);
  let report = reportFor();
  const problems = checkNote(reportRel, report, activeRules);
  if (problems.length) return { date, items, remaining: finalRemaining, sent: false, written: false,
    blocked: `리포트 등록부 위반: ${problems.join(' / ')}`, report };
  if (!dryRun) {
    // 후보 갱신 실패 시 보고서를 아직 쓰지 않아 pending 발송을 다음 실행에서 복구한다.
    mkdirSync(dirname(join(root, planRel)), { recursive: true });
    write(join(root, planRel), planContent(pendingMessageItems));
    refreshWikiCandidates(root, write);
    if (mode === 'auto') {
      const batch = applyPendingPlans(root, activeRules, { dryRun: false, write, now, clock, startedAt, jobBudgetMs,
        onResult: (result, pendingCount) => {
          applyResults = [...applyResults.filter((item) => item.source !== result.source), result];
          notificationApplyResults = [...notificationApplyResults.filter((item) => item.source !== result.source), result];
          applyRemaining = pendingCount;
          write(join(root, planRel), planContent(pendingMessageItems));
        } });
      applyRemaining = batch.remaining;
      report = reportFor(existsSync(reportPath) ? readFileSync(reportPath, 'utf8') : null);
    }
    write(join(root, planRel), planContent(pendingMessageItems));
    mkdirSync(dirname(reportPath), { recursive: true });
    write(reportPath, report);
    recoverOlderReports();
  }
  if (dryRun && mode === 'auto') {
    const batch = applyPendingPlans(root, activeRules, { dryRun: true, write, now, clock, startedAt, jobBudgetMs });
    const updatedSources = new Set(batch.results.map((item) => item.source));
    applyResults = [...applyResults.filter((item) => !updatedSources.has(item.source)), ...batch.results];
    notificationApplyResults = [...notificationApplyResults.filter((item) => !updatedSources.has(item.source)), ...batch.results];
    applyRemaining = batch.remaining;
    report = reportFor();
  }
  const message = telegramMessage([...olderPendingItems, ...pendingMessageItems], finalRemaining,
    { mode: recordedMode, applyResults: [...olderPendingApplyResults, ...notificationApplyResults], applyRemaining });
  const sent = !dryRun && !noSend && await sendWithinDeadline(message, send, clock, startedAt, MAX_JOB_MS);
  if (sent) clearPendingMessages([join(root, planRel), ...olderPendingPlans.map(({ path }) => path)]);
  return { date, items, remaining: finalRemaining, sent,
    written: !dryRun, report, reportRel, planRel, message, applyResults, applyRemaining };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = Object.fromEntries(process.argv.slice(2).map((arg) => { const text = arg.replace(/^--/, ''); const at = text.indexOf('=');
    return at < 0 ? [text, true] : [text.slice(0, at), text.slice(at + 1)]; }));
  const cli = async () => {
    if (Object.hasOwn(args, 'retry')) {
      const result = retryMemo({ source: args.retry, dryRun: args['dry-run'] === true });
      console.log(`Inbox 재시도 ${result.written ? '등록' : '미리보기(쓰기 없음)'}: ${result.source}`);
    } else if (args.apply) {
      const result = applyPlans({ ids: args.ids, dryRun: args['dry-run'] === true, noWiki: args['no-wiki'] === true });
      for (const item of result.items) console.log(JSON.stringify(item));
      console.log(result.written ? 'Inbox apply 완료' : 'Inbox apply 미리보기(쓰기 없음)');
    } else {
      const result = await run({ mode: args.mode ?? 'report', dryRun: args['dry-run'] === true,
        preview: args['dry-run'] === true, noSend: args['no-send'] === true });
      if (result.blocked) { console.error(result.blocked); process.exitCode = 1; }
      else if (args['dry-run']) console.log(`Inbox 미리보기: 다시 판단 ${result.retryCandidates}건, 적용 대상 ${result.applyCandidates}건, 남은 ${result.remaining}건`);
      else console.log(`Inbox 계획 ${result.items.length}건, 적용 ${result.applyResults?.filter((item) => item.written).length ?? 0}건, 남은 ${result.remaining}건`);
    }
  };
  const lockBase = join(tmpdir(), `clio-inbox-ingest-${hashOf(VAULT_PATHS.root)}.job`);
  withLock(lockBase, cli, { retries: 0 }).catch((error) => {
    console.error(`Inbox ingest 중단: ${error.message}`);
    process.exitCode = 1;
  });
}
