#!/usr/bin/env node
/**
 * 데일리 노트 잡(D85, 5단계 1번) — launchd가 매일 23:30·05:00에 부른다.
 *
 * 한 번 실행할 때 할 일(늦은 실행에도 꼬이지 않게, 리뷰 M-1):
 *   1) 어제 노트가 확정이 아니면(없으면 새로 만들어) 확정한다.
 *   2) KST 18시 이후 실행이면 오늘 초안을 쓴다.
 *   텔레그램(클리오)은 노트당 한 번만 보낸다(telegramSentAt). 23:30 실행을 놓쳐 확정이 먼저 오면 확정 때 보낸다.
 * 오너 글 보존(D19): AI 칸만 다시 쓰고 나머지는 원문 그대로. 오너가 AI 칸을 고쳤거나 형식이 다른 파일이면 쓰지 않고 실패로 알린다.
 * 쓰기 직전에 파일을 다시 읽어, 그 사이(LLM 호출 중) 바뀌었으면 최신 내용으로 다시 만든다. 내용이 같으면 쓰지 않는다.
 * LLM 요약은 쿨다운 가드 통과 후, 도구를 모두 끈 채로 부른다(개인 등급은 개수만 넘김, D84).
 *
 * 사용법: node scripts/jobs/daily-note.mjs [--mode=draft|finalize --date=YYYY-MM-DD] [--dry-run] [--no-send]
 *   --no-send: 노트는 쓰되 텔레그램을 보내지 않는다(수동 재실행·시험용). 텔레그램 발송 함수에는 시험 모드가 없으니 시험은 이걸로 한다.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VAULT_PATHS, VAULT_REL, vaultAbs } from '../lib/vault-paths.mjs';
import { writeAtomic } from '../lib/state-writer.mjs';
import { cooldownActive } from '../lib/quota-cooldown.mjs';
import { runHeadlessClaude } from '../lib/headless-claude.mjs';
import { loadAgent } from '../lib/agent-loader.mjs';
import { sendAgentMessage } from '../lib/pantheon-send.mjs';
import { isConfigured, getAccessToken, CALENDAR_READ_SCOPES } from '../lib/google-oauth.mjs';
import { listEventsForKstDay } from '../lib/google-calendar.mjs';
import { groupEventsByOwner, parseCalendarOwners } from '../lib/calendar-owners.mjs';
import { checkNote, parseRegistry } from '../lib/vault-registry.mjs';
import {
  DAILY_SKIP_TOP, buildDailyTelegramBody, buildSummaryPrompt, hasNormalSchedule, inspectExisting, recordHashOf, renderDailyNote, sameIgnoringModified,
  sanitizeSummary, toDayRecord,
} from '../lib/daily-note.mjs';

const SENDER_AGENT = 'clio'; // 데일리 요약(D85) — 기록 담당
const ROOT_RULE_FILES = new Set(['CLAUDE.md', 'AGENTS.md']);
// 데일리 시작일 — 자동 실행은 이 날짜 이전을 다루지 않는다(이관 작업일 2026-10-08의 대량 기록이 첫 실행에 나가지 않게).
export const DAILY_START = '2026-10-09';

export const kstDate = (d) => new Date(d.getTime() + 9 * 3600_000).toISOString().slice(0, 10);
const kstHour = (d) => Number(new Date(d.getTime() + 9 * 3600_000).toISOString().slice(11, 13));

// 실행할 일 목록(순수). 명시 --mode/--date가 있으면 그것 하나만.
export function planActions({ mode, date, now = new Date(), noteStatus = () => null }) {
  if (mode || date) {
    const m = mode ?? 'draft';
    if (!['draft', 'finalize'].includes(m)) throw new Error(`--mode는 draft 또는 finalize: ${m}`);
    const d = date ?? (m === 'draft' ? kstDate(now) : kstDate(new Date(now.getTime() - 24 * 3600_000)));
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || !Number.isFinite(Date.parse(`${d}T00:00:00Z`)) || new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) !== d) throw new Error(`--date 형식 오류: ${d}`);
    return [{ mode: m, date: d }];
  }
  const today = kstDate(now);
  const yesterday = kstDate(new Date(now.getTime() - 24 * 3600_000));
  const actions = [];
  if (yesterday >= DAILY_START && noteStatus(yesterday) !== '확정') actions.push({ mode: 'finalize', date: yesterday });
  if (kstHour(now) >= 18) actions.push({ mode: 'draft', date: today });
  return actions;
}

function walk(dir, root, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    const rel = relative(root, full);
    if (entry.isDirectory()) { if (!DAILY_SKIP_TOP.has(rel)) walk(full, root, out); } else if (entry.name.endsWith('.md') && !ROOT_RULE_FILES.has(rel)) out.push(rel);
  }
  return out;
}

export function collectRecords(root, date) {
  const records = [];
  for (const rel of walk(root, root)) {
    const full = join(root, rel);
    const content = readFileSync(full, 'utf8');
    // 머리말 없는 노트의 파일 생성일 판정은 사람 입력 폴더(00_Inbox)에만 쓴다(리뷰 M-2).
    const fallbackDate = rel.startsWith(`${VAULT_REL.inboxRoot}/`) && !/^﻿?---/.test(content) ? kstDate(statSync(full).birthtime) : null;
    const record = toDayRecord(rel, content, date, { fallbackDate });
    if (record) records.push(record);
  }
  return records.sort((a, b) => a.link.localeCompare(b.link));
}

const notePath = (date) => join(vaultAbs(VAULT_REL.dailyNotes), date.slice(0, 4), `${date}.md`);
const readOrNull = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : null);

async function summarize(date, records, prevFields, recordHash, dryRun) {
  if (prevFields?.summaryStatus === 'ok' && prevFields?.recordHash === recordHash) return { reuse: true };
  if (!records.length) return { summary: '- 오늘 볼트에 들어온 기록이 없습니다.', summaryStatus: 'empty', model: '없음' };
  if (dryRun) return { summary: '(dry-run: 요약 생략)', summaryStatus: 'skipped', model: '없음' };
  if (cooldownActive()) return { summary: '(사용량 한도 쿨다운으로 요약 보류 — 다음 실행에서 다시 시도)', summaryStatus: 'cooldown', model: '없음' };
  try {
    const clio = loadAgent('clio', { fallbackModel: 'sonnet' });
    const out = sanitizeSummary(await runHeadlessClaude(buildSummaryPrompt(date, records), clio.model, 'Read', {
      appendSystemPrompt: clio.systemPrompt, tools: '', timeoutMs: 5 * 60 * 1000,
    }));
    if (!out) throw new Error('요약 형식("- " 줄) 출력 없음');
    return { summary: out, summaryStatus: 'ok', model: clio.model };
  } catch (e) {
    console.error('  ❌ AI 요약 실패:', e.message);
    return { summary: '(AI 요약 실패 — 다음 실행에서 다시 시도)', summaryStatus: 'failed', model: '없음', failed: true };
  }
}

export async function processDay({ mode, date, dryRun, noSend, rules, today, deps: injected = {} }) {
  const deps = { send: sendAgentMessage, summarize, write: writeAtomic, fetchEvents: async (day) => {
    if (!isConfigured()) return null;
    return listEventsForKstDay(day, { token: await getAccessToken({ requiredScopes: CALENDAR_READ_SCOPES }) });
  }, readOwners: () => parseCalendarOwners(readFileSync(vaultAbs(VAULT_REL.calendarOwnersFile), 'utf8')), ...injected };
  const path = notePath(date);
  const first = readOrNull(path);
  const inspected = inspectExisting(first);
  if (!inspected.ok) { console.error(`  ⛔ ${date}: ${inspected.reason} — 쓰지 않음`); return { failed: true }; }
  const records = collectRecords(VAULT_PATHS.root, date);
  const recordHash = recordHashOf(records);
  console.log(`[daily-note] ${mode} ${date} — 기록 ${records.length}개${dryRun ? ' (dry-run)' : ''}`);
  const prevFields = inspected.prev?.fields;
  const s = await deps.summarize(date, records, prevFields, recordHash, dryRun);
  const summary = s.reuse ? (inspected.prev.sections.find((x) => x.title === 'AI 하루 요약')?.content ?? '') : s.summary;
  const summaryStatus = s.reuse ? prevFields.summaryStatus : s.summaryStatus;
  const model = s.reuse ? prevFields.model : s.model;
  let events;
  try { events = await deps.fetchEvents(date); }
  catch (error) { events = 'failed'; console.error('  ❌ 캘린더 조회 실패:', error.message); }
  let eventGroups = null;
  if (Array.isArray(events) && events.length) {
    try { eventGroups = groupEventsByOwner(events, await deps.readOwners()); }
    catch (error) { console.warn('  ⚠️ 캘린더 소유자 대응표 읽기 실패:', error.message); }
  }
  const statusOf = (prev) => mode === 'finalize' && (events !== 'failed' || hasNormalSchedule(prev)) ? '확정' : '초안';
  const render = (prev) => renderDailyNote({ date, records, summary, status: statusOf(prev), model, summaryStatus, recordHash, today, telegramSentAt: prev?.fields?.telegramSentAt ?? null, prev, events, eventGroups });

  let note = render(inspected.prev);
  const rel = relative(VAULT_PATHS.root, path);
  const problems = checkNote(rel, note, rules);
  if (problems.length) { console.error(`  ⛔ 등록부 위반으로 쓰지 않음: ${problems.join(' / ')}`); return { failed: true }; }
  if (dryRun) { console.log(note); return { failed: !!s.failed || events === 'failed' }; }

  // 쓰기 직전 다시 읽기 — LLM 호출 중 오너가 고쳤으면 최신 내용 기준으로 다시 만든다(리뷰 HIGH-3).
  const latest = readOrNull(path);
  if (latest !== first) {
    const again = inspectExisting(latest);
    if (!again.ok) { console.error(`  ⛔ ${date}: 쓰기 직전 변경 감지 — ${again.reason}`); return { failed: true }; }
    note = render(again.prev);
    const again2 = checkNote(rel, note, rules);
    if (again2.length) { console.error(`  ⛔ 등록부 위반으로 쓰지 않음: ${again2.join(' / ')}`); return { failed: true }; }
  }
  if (latest != null && sameIgnoringModified(latest, note)) console.log('  변경 없음 — 쓰지 않음');
  else { mkdirSync(dirname(path), { recursive: true }); deps.write(path, note); console.log(`  💾 ${rel} (${statusOf(inspectExisting(note).prev)})`); }

  const sentAt = inspectExisting(readOrNull(path)).prev?.fields?.telegramSentAt;
  if (sentAt || noSend) return { failed: !!s.failed || events === 'failed' };
  try {
    await deps.send({ agent: SENDER_AGENT, kind: '정보', topic: '데일리', body: buildDailyTelegramBody(date, records, summary, statusOf(inspectExisting(note).prev)) });
    console.log('  📨 클리오 데일리 요약 발송');
  } catch (e) {
    console.error('  ❌ 텔레그램 발송 실패:', e.message);
    return { failed: true };
  }
  // 발송 기록 — AI 칸 지문은 머리말과 무관해 그대로 유효하다. 다시 읽어 그 사이 변경을 보존한다.
  const current = readOrNull(path);
  const fmEnd = current?.indexOf('\n---', 4) ?? -1;
  if (!current || fmEnd < 0) { console.error('  ⚠️ 발송 기록을 남길 노트를 찾지 못함(다음 실행에서 다시 보낼 수 있음)'); return { failed: true }; }
  const head = current.slice(0, fmEnd).replace(/^(dailyStatus: .*)$/m, `$1\ntelegramSentAt: "${new Date().toISOString()}"`);
  deps.write(path, head + current.slice(fmEnd));
  return { failed: !!s.failed || events === 'failed' };
}

async function main() {
  const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')).map(([k, v]) => [k, v ?? true]));
  const dryRun = args['dry-run'] === true;
  const now = new Date();
  const noteStatus = (date) => inspectExisting(readOrNull(notePath(date))).prev?.fields?.dailyStatus ?? null;
  const actions = planActions({ mode: args.mode, date: args.date, now, noteStatus });
  if (!actions.length) { console.log('ℹ️ 할 일 없음(어제 확정 완료, 초안 시각 아님)'); return; }
  const rules = parseRegistry(readFileSync(vaultAbs(VAULT_REL.registryFile), 'utf8'));
  let failed = false;
  for (const action of actions) {
    const r = await processDay({ ...action, dryRun, noSend: args['no-send'] === true, rules, today: kstDate(now) });
    failed ||= r.failed;
  }
  if (failed) process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => { console.error('❌ 데일리 노트 실패:', e); process.exit(1); });
}
