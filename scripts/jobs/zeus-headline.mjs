#!/usr/bin/env node
/**
 * 제우스 종합 헤드라인(2026-10-31 오너 결정 안 C — Requests `2026-10-31 홈 헤드라인 설계`): 매일 07:40, 판테온 전체에서
 * "오늘 가장 중요한 일" 한 줄과 근거를 골라 `95_Etna/Zeus/headline.json`에 남긴다. 올림푸스 홈 맨 위가 읽는다.
 *
 * - 데이터는 Node, 판단은 LLM(공통 헌장 §2-11): 후보는 각 정본이 스스로 남긴 상태(질문 긴급·대기 시각, 잡 실패·낡음,
 *   일정 시각, 플루토스 제안·킬스위치, 테미스 판정, 아테나 판단 대기)를 그대로 모은다. 무엇이 가장 중요한지 고르고
 *   문장으로 쓰는 일만 경량 모델에 맡긴다 — 고정 우선순위표를 두지 않는다.
 * - 후보가 0이면 호출하지 않는다(status empty). 쿨다운 중이면 호출하지 않는다(status cooldown).
 * - 출력 검증(llm-guard 원칙): 고른 refId가 후보에 있어야 하고, 문장에 후보에 없는 숫자·경로·민감값이 있으면 버린다.
 *   담당(agent)은 LLM이 아니라 후보에서 정한다.
 * - 단발 잡이다(재실행·마커 없음, 그 회차가 지나면 끝) → llm-run-outcome retryable: false. 한도·쿨다운으로 멈춰도
 *   잡 실패로 두어 health-watcher가 알게 한다(화면은 올림푸스가 '자동 요약'으로 대신한다).
 * - 텔레그램 발송 없음. 볼트에는 이 파일 하나만 원자적으로(같은 폴더 점 임시 파일 → fsync → rename) 쓴다.
 *
 * 사용법: node scripts/jobs/zeus-headline.mjs [--dry-run]
 */
import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VAULT_PATHS, VAULT_REL } from '../lib/vault-paths.mjs';
import { parseFrontmatter } from '../lib/vault-frontmatter.mjs';
import { ACTIVE_STATUSES } from '../lib/wiki-question-status.mjs';
import { JOB_OWNERS } from '../lib/job-owners.mjs';
import { EXPECTED_INTERVALS_MS, EXPECTED_INTERVAL_DEFAULT_MS, isInactiveJob } from '../lib/job-schedule.mjs';
import { isStale } from '../lib/job-health.mjs';
import { calendarDayPath, CALENDAR_DAY_SCHEMA, kstDate } from '../lib/calendar-days.mjs';
import { assertNoSensitive, parseVerdictLines } from '../lib/themis-verdict-ledger.mjs';
import { ACTIVE_PROPOSAL_STATUSES } from '../lib/proposal-vault.mjs';
import { cooldownActive } from '../lib/quota-cooldown.mjs';
import { runHeadlessClaude, headlessResult, parseJsonBlock } from '../lib/headless-claude.mjs';
import { markLlmRunOutcome } from '../lib/llm-run-outcome.mjs';

export const JOB = 'zeus-headline';
export const MODEL = 'haiku'; // 경량으로 시작(오너 결정 2026-10-31)
export const HEADLINE_SCHEMA = 1;
const TEXT_MAX = 50;
const SUB_MAX = 80;
const CANDIDATE_TITLE_MAX = 100;
const PER_SOURCE_LIMIT = 5;
const TOTAL_LIMIT = 10; // 설계: 후보표 최대 10건(출처 순서대로 채운다)
const THEMIS_LOOKBACK_MS = 48 * 3_600_000; // 07:40에 돌아 '오늘' 판정만 보면 늘 비므로 최근 48시간 보류·거부
const QUESTION_FILE = /^WQ-\d{8}-[0-9a-f]{8}\.md$/i;
const PENDING_CONFIRMATION = new Set(['대기', '기록됨']); // execution-confirmation-queue: 오너 확인 대기·정리 미완
const SECRET_VAULT = [/(?:^|[^\p{L}\p{N}])9{2}_[\p{L}\p{N}]/u, new RegExp(['A', 'dyton'].join(''), 'i'), /아디톤/];
// 오너가 이미 답한 질문(승인·반영대기)은 오너 행동이 필요 없어 후보에서 뺀다.
const OWNER_ANSWERED = new Set(['승인', '반영대기']);
const ALLOWED_AGENTS = new Set(['zeus', 'hermes', 'athena', 'plutus', 'clio', 'themis']);

export const headlinePath = (root = VAULT_PATHS.root) => join(root, ...VAULT_REL.zeusHeadline.split('/'));

const oneLine = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
const clip = (text, max) => { const chars = Array.from(text); return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : text; };
function readJson(path) { return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null; }
function mdFiles(dir) { return existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith('.md') && !name.startsWith('.')).sort() : []; }
const kstClock = (date) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date);
const hoursSince = (iso, now) => { const at = Date.parse(iso); return Number.isFinite(at) ? Math.max(0, Math.round((now - at) / 3_600_000)) : null; };
// 대기 시간 사실: 48시간까지는 시간, 넘으면 일 단위만 준다 — '382시간'처럼 사람이 읽기 어려운 숫자를 문장에 못 쓰게(아는 숫자도 일 단위가 된다).
const WAITING_DAYS_AFTER_HOURS = 48;
function waitingFacts(iso, now) {
  const hours = hoursSince(iso, now);
  return hours !== null && hours > WAITING_DAYS_AFTER_HOURS ? { waitingDays: Math.round(hours / 24) } : { waitingHours: hours };
}
const waitingOrder = (facts) => facts.waitingHours ?? (facts.waitingDays ?? 0) * 24;

// 후보 제목에 볼트 경로·위키링크가 들어가지 않게(본문 첫 줄을 쓰는 질문 등) 보이는 이름만 남긴다.
function plainTitle(text) {
  return clip(oneLine(String(text ?? '')
    .replace(/!?\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
    .replace(/!?\[\[([^\]]+)\]\]/g, (_, target) => target.split('/').at(-1))
    .replace(/[^\s'"`]+/gu, (token) => (token.includes('/') && /\p{L}/u.test(token) ? token.split('/').filter(Boolean).at(-1) ?? '' : token))
    .replace(/\.md\b/g, '')), CANDIDATE_TITLE_MAX);
}
function firstBodyLine(text) {
  const body = String(text ?? '').replace(/^---\n[\s\S]*?\n---\n?/, '');
  return body.split('\n').map((line) => line.trim()).find((line) => line && !line.startsWith('#')) ?? '';
}

// ── 후보 수집: 각 정본이 스스로 남긴 상태를 그대로 옮긴다(무게 판단은 하지 않는다) ──
export function collectCandidates({ root = VAULT_PATHS.root, now = new Date(), sourceErrors = [], log = console } = {}) {
  const at = now.getTime();
  const today = kstDate(now);
  const rel = (key) => join(root, ...VAULT_REL[key].split('/'));
  const abs = (absolutePath) => join(root, relative(VAULT_PATHS.root, absolutePath)); // VAULT_PATHS 상수를 요청 볼트 기준으로
  const candidates = [];
  // 후보 제목에 민감값(금고·자격증명·긴 숫자)이 있으면 그 후보는 프롬프트에 넣지 않는다.
  const titleSafe = (item) => { try { assertNoSensitive('title', item.title); return !SECRET_VAULT.some((p) => p.test(item.title)); } catch { return false; } };
  const add = (source, list) => {
    const kept = list.filter(titleSafe);
    if (kept.length < list.length) log.error(`[${JOB}] 후보 출처 ${source}: 민감값 때문에 ${list.length - kept.length}건 뺌`);
    candidates.push(...kept.slice(0, PER_SOURCE_LIMIT).map((item) => ({ source, ...item })));
  };
  // 출처 하나가 깨져도 나머지 후보는 모은다 — 대신 출처 이름을 남긴다(조용한 실패 금지, 전부 비면 잡 실패로).
  let currentSource = '';
  // 늘 있어야 하는 폴더(잡 상태·질문 큐)가 없으면 볼트 루트나 경로가 틀린 것이다 — 조용히 '할 일 없음'이 되지 않게 출처 오류로 센다.
  for (const [source, key] of [['job', 'jobHealth'], ['question', 'stateWikiQuestions']]) {
    if (!existsSync(rel(key))) { sourceErrors.push(source); log.error(`[${JOB}] 후보 출처 ${source} 폴더 없음`); }
  }
  const safe = (fn) => { try { return fn(); } catch (error) {
    sourceErrors.push(currentSource);
    log.error(`[${JOB}] 후보 출처 ${currentSource} 읽기 실패: ${error?.code || error?.name || 'error'}`);
    return [];
  } };
  const from = (source) => { currentSource = source; return source; };

  add(from('question'), safe(() => mdFiles(rel('stateWikiQuestions')).filter((name) => QUESTION_FILE.test(name)).flatMap((name) => {
    const text = readFileSync(join(rel('stateWikiQuestions'), name), 'utf8');
    const record = parseFrontmatter(text);
    if (!ACTIVE_STATUSES.has(record.status) || OWNER_ANSWERED.has(record.status)) return [];
    if (record.expiresAt && Date.parse(record.expiresAt) <= at) return [];
    return [{ refId: String(record.questionId ?? name.replace(/\.md$/, '')), owner: record.asker || 'zeus',
      title: plainTitle(firstBodyLine(text)) || '오너 확인 질문', facts: { urgent: record.urgent !== false, ...waitingFacts(record.createdAt, at), status: record.status } }];
  }).sort((a, b) => waitingOrder(b.facts) - waitingOrder(a.facts))));

  add(from('confirmation'), safe(() => mdFiles(abs(VAULT_PATHS.state.executionConfirmations)).flatMap((name) => {
    const record = parseFrontmatter(readFileSync(join(abs(VAULT_PATHS.state.executionConfirmations), name), 'utf8'));
    if (!PENDING_CONFIRMATION.has(record.status)) return [];
    return [{ refId: String(record.id ?? name.replace(/\.md$/, '')), owner: 'plutus',
      title: plainTitle(`체결 기록 확인 대기 — ${[record.stockName, record.tradeType].filter(Boolean).join(' ')}`), facts: waitingFacts(record.createdAt, at) }];
  })));

  add(from('job'), safe(() => mdFiles(rel('jobHealth')).flatMap((name) => {
    const job = name.replace(/\.md$/, '');
    if (isInactiveJob(job) || job === JOB) return [];
    const record = parseFrontmatter(readFileSync(join(rel('jobHealth'), name), 'utf8'));
    const interval = Object.hasOwn(EXPECTED_INTERVALS_MS, job) ? EXPECTED_INTERVALS_MS[job] : EXPECTED_INTERVAL_DEFAULT_MS;
    const failed = Boolean(record.status) && record.status !== 'OK';
    const stale = isStale({ lastRun: record.lastRun, expectedIntervalMs: interval, now });
    if (!failed && !stale) return [];
    return [{ refId: `job-${job}`, owner: JOB_OWNERS[job] ?? 'zeus', title: `잡 ${job} ${failed ? '실패' : '오래 안 돎'}`,
      facts: { failStreak: Number(record.failStreak) || 0, stale } }];
  }).sort((a, b) => b.facts.failStreak - a.facts.failStreak)));

  add(from('calendar'), safe(() => {
    const day = readJson(calendarDayPath(today, root));
    if (!day || day.schemaVersion !== CALENDAR_DAY_SCHEMA || day.date !== today || !Array.isArray(day.events)) return [];
    return day.events.flatMap((event, index) => {
      const startsAt = event.allDay ? null : Date.parse(event.start);
      if (!event.allDay && (!Number.isFinite(startsAt) || startsAt < at)) return []; // 이미 시작한 시간 일정은 뺀다
      return [{ refId: `cal-${today}-${index}`, owner: 'hermes', title: plainTitle(`${event.owner ?? ''} ${event.title ?? ''}`),
        facts: { allDay: Boolean(event.allDay), startsAtKst: startsAt ? kstClock(new Date(startsAt)) : null,
          startsInMinutes: startsAt ? Math.round((startsAt - at) / 60_000) : null } }];
    });
  }));

  add(from('plutus'), safe(() => {
    const list = [];
    const killSwitchPath = abs(VAULT_PATHS.state.killSwitch);
    const killSwitch = existsSync(killSwitchPath) ? parseFrontmatter(readFileSync(killSwitchPath, 'utf8')) : null;
    if (killSwitch?.active === true) list.push({ refId: 'killswitch', owner: 'plutus', title: '킬스위치 켜짐', facts: {} });
    for (const name of mdFiles(rel('decisionsProposals'))) {
      const record = parseFrontmatter(readFileSync(join(rel('decisionsProposals'), name), 'utf8'));
      if (!ACTIVE_PROPOSAL_STATUSES.has(record.status)) continue;
      list.push({ refId: `proposal-${name.replace(/\.md$/, '')}`, owner: 'plutus', title: plainTitle(`주문 제안 ${record.status} — ${name.replace(/^\d{4}-\d{2}-\d{2}-/, '').replace(/-\d{6}Z?\.md$/, '').replace(/\.md$/, '')}`),
        facts: { status: record.status } });
    }
    return list;
  }));

  add(from('themis'), safe(() => {
    const path = rel('themisVerdicts');
    if (!existsSync(path)) return [];
    return parseVerdictLines(readFileSync(path, 'utf8'))
      .filter((item) => item.verdict !== '통과' && Date.parse(item.at) >= at - THEMIS_LOOKBACK_MS)
      .map((item) => ({ refId: item.id, owner: 'themis', title: plainTitle(`${item.verdict} — ${item.subject}`), facts: { kind: item.kind } }));
  }));

  add(from('athena'), safe(() => {
    const orb = readJson(rel('mediaOrbDailyFeed'));
    const pending = orb?.totals?.ambiguousPending;
    const core = orb?.totals?.coreCandidates;
    const list = [];
    if (Number.isFinite(core) && core > 0) list.push({ refId: 'orb-core', owner: 'athena', title: `핵심기억 후보 ${core}개`, facts: { coreCandidates: core } });
    if (Number.isFinite(pending) && pending > 0) list.push({ refId: 'orb-pending', owner: 'athena', title: `기억 구슬 판단 대기 ${pending}개`, facts: { ambiguousPending: pending } });
    return list;
  }));

  // 담당은 판테온 6인 중 하나로(질문의 asker 등이 비었거나 옛 이름이면 제우스). 후보 안에서는 owner로 들고 다니다
  // 여기서 계약 이름(agent)으로 옮긴다.
  // 전체 상한은 출처별로 번갈아 채운다(각 출처의 1번째, 그다음 2번째 …) — 출처 순서가 우선순위표가 되지 않게.
  const bySource = new Map();
  for (const item of candidates) { if (!bySource.has(item.source)) bySource.set(item.source, []); bySource.get(item.source).push(item); }
  const picked = [];
  for (let round = 0; picked.length < TOTAL_LIMIT && [...bySource.values()].some((list) => list.length > round); round += 1) {
    for (const list of bySource.values()) if (list[round] && picked.length < TOTAL_LIMIT) picked.push(list[round]);
  }
  return picked.map(({ owner, ...item }) => ({ ...item, agent: ALLOWED_AGENTS.has(owner) ? owner : 'zeus' }));
}

export function buildPrompt(candidates, today) {
  const rows = candidates.map((item) => JSON.stringify({ refId: item.refId, source: item.source, agent: item.agent, title: item.title, facts: item.facts }));
  return [
    `오늘(${today}) 판테온 오너에게 가장 중요한 일 하나를 아래 후보에서 고른다.`,
    '기준: 오늘 오너가 직접 결정·행동해야 하고, 미루면 손해가 크거나 기한이 가까운 것. 정보성·이미 자동으로 처리되는 것은 뒤로.',
    '후보(JSON 한 줄씩):',
    ...rows,
    '',
    `출력은 JSON 하나만: {"refId": "후보의 refId 그대로", "text": "오너에게 보일 한 줄(한국어, ${TEXT_MAX}자 이내)", "sub": "왜 이것인지 근거 한 줄(${SUB_MAX}자 이내)"}`,
    '후보에 없는 사실·숫자·종목·경로를 지어내지 않는다. 금액·계좌번호·링크·이메일·ID(refId)·날짜는 문장에 쓰지 않는다. 시각은 후보의 startsAtKst만 쓴다.',
  ].join('\n');
}

// 출력 검증: refId가 후보에 있는가, 길이, 민감값(금고·자격증명·긴 숫자 — 테미스 원장과 같은 기준·링크·이메일·금액),
// 경로, 그리고 문장의 숫자가 고른 후보에 있는 숫자인가(시각 HH:MM과 12시간제 '오후 3시'의 3은 허용).
const CREDENTIAL_LIKE = /\b(?:api[_-]?key|access[_-]?key|token|secret|password|passwd|bearer)\b\s*[:=]?|\bsk-[a-z]{2,}-/i; // 원장 기준에 더해 api_key·sk- 꼴
const URL_OR_EMAIL = /:\/\/|\bwww\.|[\w.+-]+@[\w-]+\.[\w.]+/i;
// 숫자 바로 뒤의 원·만원·억·조, 또는 만·천·억이 들어간 두 글자 이상 한글 수사 뒤의 원·억(‘구조’·‘사원’ 같은 낱말은 통과).
const MONEY = /\d[\d,.]*\s*(?:원|만원|억|조)(?![\p{L}])|[일이삼사오육칠팔구십백]*[천만억][일이삼사오육칠팔구십백천만억]*\s*(?:원|억)(?![\p{L}])/u;
// 한글로 쓴 수(‘일곱 건’·‘세 번’)는 숫자 대조를 빠져나가므로 거부한다.
const KOREAN_COUNT = /(?:^|\s)(?:한|두|세|네|다섯|여섯|일곱|여덟|아홉|열|스무)\s*(?:건|번|개|명|회|시간|분|일)(?![\p{L}])/u;
const ID_OR_DATE = /\b(?:TV|WQ|EC)-\d{8}-[0-9a-f]{8}\b|\d{4}-\d{2}-\d{2}(?:T[\d:.]+Z?)?/gi;
const PATH_LIKE = /\b\d\d_[^\s/]+\/|\S+\/\S+\/\S+/; // 볼트 경로(NN_폴더/…)나 슬래시 둘 이상 — '매수/매도' 같은 한 번은 통과

function knownNumbers(pick) {
  const numbers = new Set(String(pick.title).match(/\d+/g) ?? []);
  for (const value of Object.values(pick.facts ?? {})) {
    if (typeof value === 'number') numbers.add(String(value));
  }
  if (Number.isFinite(pick.facts?.startsInMinutes)) numbers.add(String(Math.round(pick.facts.startsInMinutes / 60))); // '8시간 뒤'
  for (const value of Object.values(pick.facts ?? {})) {
    if (typeof value === 'string' && /^\d{2}:\d{2}$/.test(value)) {
      const [hour, minute] = value.split(':').map(Number);
      for (const n of [hour, hour % 12 || 12, minute]) numbers.add(String(n));
      numbers.add(value.slice(0, 2));
      numbers.add(value.slice(3));
    }
  }
  return numbers;
}

export function validatePick(raw, candidates, today = kstDate(new Date())) {
  if (!raw || typeof raw !== 'object') throw new Error('판단 출력이 객체가 아님');
  const pick = candidates.find((item) => item.refId === raw.refId);
  if (!pick) throw new Error('후보에 없는 refId');
  const text = oneLine(raw.text);
  const sub = oneLine(raw.sub);
  if (!text || Array.from(text).length > TEXT_MAX) throw new Error('text 길이 오류');
  if (Array.from(sub).length > SUB_MAX) throw new Error('sub 길이 오류');
  for (const value of [text, sub]) {
    if (SECRET_VAULT.some((pattern) => pattern.test(value))) throw new Error('금고 경로·이름');
    if (URL_OR_EMAIL.test(value)) throw new Error('링크·이메일');
    if (CREDENTIAL_LIKE.test(value)) throw new Error('민감값(자격증명)');
    if (MONEY.test(value)) throw new Error('금액');
    if (PATH_LIKE.test(value)) throw new Error('경로');
    // 판정·질문 ID와 날짜는 지운 뒤 본다(ID 숫자를 계좌번호로 오인하지 않게).
    try { assertNoSensitive('headline', value.replace(ID_OR_DATE, ' ')); } catch { throw new Error('민감값(자격증명·긴 숫자)'); }
  }
  // 문장 속 ID는 고른 후보의 refId일 때만, 날짜는 오늘(today)일 때만 허용 — 지어낸 날짜·ID가 숫자 검사를 빠져나가지 않게.
  for (const token of `${text} ${sub}`.match(ID_OR_DATE) ?? []) {
    const isId = /^(?:TV|WQ|EC)-/i.test(token);
    if (isId ? token !== pick.refId : token.slice(0, 10) !== today) throw new Error('후보에 없는 날짜·ID');
  }
  if (KOREAN_COUNT.test(`${text} ${sub}`)) throw new Error('한글로 쓴 수');
  const known = knownNumbers(pick);
  for (const number of `${text} ${sub}`.replace(ID_OR_DATE, ' ').match(/\d+/g) ?? []) {
    if (!known.has(number)) throw new Error('후보에 없는 숫자');
  }
  return { pick, text, sub };
}

// 같은 폴더 점 임시 파일 → fsync → rename(LiveSync는 완성된 내용만 본다).
function writeVaultJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}-${randomUUID().slice(0, 8)}.tmp`);
  const fd = openSync(tmp, 'wx', 0o644);
  try {
    writeSync(fd, `${JSON.stringify(value, null, 2)}\n`);
    fsyncSync(fd);
    closeSync(fd);
    renameSync(tmp, path);
  } catch (error) {
    try { closeSync(fd); } catch { /* 이미 닫힘 */ }
    try { unlinkSync(tmp); } catch { /* 없음 */ }
    throw error;
  }
  try { const dirFd = openSync(dirname(path), 'r'); try { fsyncSync(dirFd); } finally { closeSync(dirFd); } } catch { /* 폴더 fsync 미지원 */ }
}

function sameDayOk(path, today) {
  try { const current = readJson(path); return current?.status === 'ok' && current?.date === today; } catch { return false; }
}

export async function runZeusHeadline({ root = VAULT_PATHS.root, now = new Date(), dryRun = false, cooldown = cooldownActive,
  judge = (prompt) => runHeadlessClaude(prompt, MODEL, '', { lean: true, tools: '', maxTurns: 1 }), log = console } = {}) {
  const today = kstDate(now);
  const sourceErrors = [];
  const candidates = collectCandidates({ root, now, sourceErrors, log });
  const base = { schemaVersion: HEADLINE_SCHEMA, generatedAt: now.toISOString(), date: today, candidates: candidates.length, model: MODEL,
    sourceErrors };
  const counts = { succeeded: 0, failed: 0, limited: 0, retryable: false }; // 단발 잡(재실행·마커 없음)
  let result;
  if (!candidates.length && sourceErrors.length) {
    // 출처가 깨져 후보가 0이면 '할 일 없음'이 아니라 실패다(조용한 empty 금지).
    counts.failed = 1;
    result = { ...base, status: 'failed', pick: null, agent: null, text: '', sub: '' };
  } else if (!candidates.length) {
    result = { ...base, status: 'empty', pick: null, agent: null, text: '', sub: '' };
  } else if (dryRun) {
    // dry-run은 claude를 부르지 않는다(구독 사용량을 쓰지 않게) — 후보표와 프롬프트만 보인다.
    log.log(buildPrompt(candidates, today));
    result = { ...base, status: 'dry-run', pick: null, agent: null, text: '', sub: '' };
  } else if (cooldown()) {
    counts.limited = 1;
    result = { ...base, status: 'cooldown', pick: null, agent: null, text: '', sub: '' };
  } else {
    try {
      const { pick, text, sub } = validatePick(parseJsonBlock(headlessResult(await judge(buildPrompt(candidates, today)))), candidates, today);
      counts.succeeded = 1;
      result = { ...base, status: 'ok', pick: { source: pick.source, refId: pick.refId }, agent: pick.agent, text, sub };
    } catch (error) {
      if (error.isLimit) counts.limited = 1; else counts.failed = 1;
      log.error(`[${JOB}] 판단 실패: ${error.isLimit ? '사용량 한도' : error.message}`);
      result = { ...base, status: error.isLimit ? 'cooldown' : 'failed', pick: null, agent: null, text: '', sub: '' };
    }
  }
  if (dryRun) log.log(JSON.stringify(result, null, 2));
  else if (result.status !== 'ok' && sameDayOk(headlinePath(root), today)) {
    // 같은 날 이미 좋은 헤드라인이 있으면(수동 재실행 실패 등) 덮어쓰지 않는다.
    log.log(`[${JOB}] 오늘 헤드라인이 이미 있어 ${result.status} 결과로 덮어쓰지 않음`);
  } else writeVaultJson(headlinePath(root), result);
  log.log(`[${JOB}] ${result.status} · 후보 ${candidates.length}${result.pick ? ` · ${result.pick.source}` : ''}`);
  return { result, counts };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runZeusHeadline({ dryRun: process.argv.includes('--dry-run') })
    .then(({ counts }) => { markLlmRunOutcome(counts, { job: JOB }); })
    .catch((error) => { console.error(`[${JOB}] 실패: ${error.message}`); process.exitCode = 1; });
}
