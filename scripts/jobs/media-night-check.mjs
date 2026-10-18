#!/usr/bin/env node
// 매일 05:00 밤 점검(2026-10-18 오너 지시): 그날 밤 음성(02:00 전사 → 화자 분리)·사진(03:00 장면 분석 → 얼굴 이름표)·
// 영상(04:00) 블록과 공통 잡(매시 보관·순간 노트, 00:00 원본 백업)이 정상으로 끝났는지 확인하고,
// 내일로 넘길 남은 일을 현황판의 '밤 점검' 칸에 덮어쓰고 오너에게 결과를 보낸다(LLM 없음).
// 블록 이상·현황판 쓰기·발송 실패는 종료코드 1. run.sh가 FAIL 하트비트로 기록한다.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFrontmatter } from '../lib/vault-frontmatter.mjs';
import { sendAgentMessage } from '../lib/pantheon-send.mjs';
import { redactWarningDetail } from '../lib/warning-event-journal.mjs';
import { VAULT_PATHS, VAULT_REL } from '../lib/vault-paths.mjs';
import { withLock, writeAtomic } from '../lib/state-writer.mjs';

export const STATUS_BOARD_REL = VAULT_REL.mineStatusBoard;
const START = '<!-- night-check:start -->';
const END = '<!-- night-check:end -->';
const SENDER_AGENT = 'zeus';
const SIMPLE_JOB_TAGS = new Set(['audio', 'photo', 'video', 'backup']);
const JOB_TAG = /(^|\s)\[([a-z][a-z0-9-]*)\](?=\s|$)/g;
const PROBLEM = /실패\s*[1-9]\d*|오류|FAIL/i;

// 블록 순서는 시간표 그대로. sinceHours: 이 시간 안에 돌았어야 정상.
export const NIGHT_BLOCKS = Object.freeze([
  { block: '공통', time: '매시', job: 'media-archive', label: '폰 파일 보관', sinceHours: 2 },
  { block: '공통', time: '매시', job: 'media-moments', label: '순간 노트', sinceHours: 2 },
  { block: '공통', time: '00:00', job: 'media-audio-offsite-backup', label: '원본 암호화 백업', sinceHours: 6 },
  { block: '🎙 음성', time: '02:00', job: 'media-audio', label: '통화·녹음 전사·화자 분리', sinceHours: 6 },
  { block: '📷 사진', time: '03:00', job: 'media-photo', label: '장면 분석·얼굴 이름표', sinceHours: 6 },
  { block: '🎬 영상', time: '04:00', job: 'media-video', label: '분석·이름표·하이라이트·말소리 전사', sinceHours: 6 },
]);

function readHealth(root, job) {
  const path = join(root, VAULT_REL.jobHealth, `${job}.md`);
  if (!existsSync(path)) return null;
  return parseFrontmatter(readFileSync(path, 'utf8'));
}

function detailParts(detail) {
  const normalized = String(detail ?? '').replace(/\s+/g, ' ').trim();
  const tags = [...normalized.matchAll(JOB_TAG)]
    .filter((match) => match[2].includes('-') || SIMPLE_JOB_TAGS.has(match[2]));
  const clean = (value) => value.split('🫀', 1)[0].trim();
  if (!tags.length) return [clean(normalized)].filter(Boolean);
  const latest = new Map();
  const prefix = clean(normalized.slice(0, tags[0].index));
  for (let index = 0; index < tags.length; index += 1) {
    const text = clean(normalized.slice(tags[index].index + tags[index][0].length,
      tags[index + 1]?.index ?? normalized.length));
    if (!text) continue;
    const tag = tags[index][2];
    latest.delete(tag);
    latest.set(tag, { tag, text });
  }
  return [...(prefix ? [prefix] : []), ...[...latest.values()].map(({ tag, text }) => `[${tag}] ${text}`)];
}

export function summarizeDetail(detail, maxLength = 160) {
  const parts = detailParts(detail);
  if (!parts.length) return '-';
  // 경계를 넘는 뒤쪽 태그는 통째로 버려, 다른 잡의 내용처럼 보이는 반쪽 태그를 남기지 않는다.
  const kept = [];
  for (const part of parts) {
    if (part.length > maxLength && !kept.length) continue;
    if (kept.join(' ').length + (kept.length ? 1 : 0) + part.length > maxLength) {
      break;
    }
    kept.push(part);
  }
  return kept.join(' ') || '-';
}

export function judgeBlocks(root, now = new Date()) {
  return NIGHT_BLOCKS.map((entry) => {
    const health = readHealth(root, entry.job);
    const last = health?.lastRun ? Date.parse(health.lastRun) : NaN;
    const fresh = Number.isFinite(last) && now.getTime() - last <= entry.sinceHours * 3600_000;
    const ok = fresh && health?.status === 'OK';
    const detail = summarizeDetail(health?.detail);
    return { ...entry, ok, fresh, status: health?.status ?? '기록 없음', lastRun: health?.lastRun ?? null,
      detail, rawDetail: health?.detail ?? '' };
  });
}

function listConversationNotes(root) {
  const base = join(root, VAULT_REL.mediaConversations);
  if (!existsSync(base)) return [];
  return readdirSync(base).filter((y) => /^\d{4}$/.test(y))
    .flatMap((y) => readdirSync(join(base, y)).filter((n) => n.endsWith('.md')).map((n) => join(base, y, n)));
}

export function countBacklog(root, now = new Date(), { videoDryRun } = {}) {
  const notes = listConversationNotes(root);
  let speakerCheck = 0; let untitledRecent = 0;
  const recentFrom = new Date(now.getTime() + 9 * 3600_000 - 3 * 86_400_000).toISOString().slice(0, 10);
  for (const path of notes) {
    const content = readFileSync(path, 'utf8');
    if (content.includes('[화자 확인 필요]')) speakerCheck += 1;
    const name = path.split('/').pop().replace(/\.md$/, '');
    if (/ 통화$/.test(name) && name.slice(0, 10) >= recentFrom) untitledRecent += 1;
  }
  let video = null;
  try {
    const text = videoDryRun ? videoDryRun() : execFileSync(process.execPath,
      [join(fileURLToPath(new URL('.', import.meta.url)), 'media-video-transcribe.mjs'), '--dry-run'],
      { encoding: 'utf8', timeout: 120_000 });
    const m = text.match(/대상 (\d+), 총 ([\d.]+)시간/);
    if (m) video = { count: Number(m[1]), hours: Number(m[2]) };
  } catch { video = null; }
  return { speakerCheck, untitledRecent, video };
}

export function remainingWork(blocks, backlog) {
  const todo = [];
  for (const b of blocks.filter((x) => !x.ok)) todo.push(`${b.time} ${b.label} 점검·재실행(${b.fresh ? b.status : '실행 기록 없음'})`);
  if (backlog.video?.count) todo.push(`영상 말소리 전사 백필 남음 ${backlog.video.count}개(${backlog.video.hours}시간 분량) — 낮 백필·04:00 블록이 이어서 처리`);
  if (backlog.untitledRecent) todo.push(`주제 없는 최근 통화 노트 ${backlog.untitledRecent}개 — LLM 판단 재개 뒤 처리(보류)`);
  if (backlog.speakerCheck) todo.push(`'[화자 확인 필요]' 통화 노트 ${backlog.speakerCheck}개 — 대화 경계 개선 뒤 다시 판정(보류)`);
  return todo;
}

export function renderNightCheck(blocks, backlog, now = new Date()) {
  const kst = new Date(now.getTime() + 9 * 3600_000).toISOString().replace('T', ' ').slice(0, 16);
  const rows = blocks.map((b) => `| ${b.time} | ${b.block} | ${b.label} | ${b.ok ? '✔' : '✖'} ${b.ok ? '' : `(${b.fresh ? b.status : '이번 밤 실행 기록 없음'})`} | ${b.detail.replace(/\|/g, '/') || '-'} |`);
  const todo = remainingWork(blocks, backlog);
  return [START, `### 밤 점검 ${kst} (자동, 05:00 media-night-check)`, '',
    '| 시각 | 블록 | 작업 | 결과 | 내용 |', '|---|---|---|---|---|', ...rows, '',
    '**내일로 넘기는 일**', ...(todo.length ? todo.map((t) => `- ${t}`) : ['- 없음']), END].join('\n');
}

function messageSummary(detail) {
  const parts = detailParts(detail).map((part) => part.replace(/^\[[a-z][a-z0-9-]*\]\s*/, ''));
  const sentences = parts.flatMap((part) => part.split(';').map((sentence) => sentence.trim()).filter(Boolean));
  const clauses = [...sentences.filter((sentence) => PROBLEM.test(sentence)),
    ...sentences.filter((sentence) => !PROBLEM.test(sentence))];
  const safeClauses = clauses.map((sentence) => {
    // 전체 문장을 정제한 뒤에만 발췌한다. 먼저 자르면 토큰 키나 경로의 앞부분이 잘릴 수 있다.
    const safe = redactWarningDetail(sentence)
      .replace(/(?:~\/|\/|[\p{L}\p{N}._-]+\/)[^\s;,]+/gu, '[REDACTED]');
    const problemAt = safe.search(PROBLEM);
    return problemAt > 25 ? safe.slice(problemAt - 25) : safe;
  });
  const kept = [];
  for (const clause of safeClauses) {
    if (kept.join('; ').length + (kept.length ? 2 : 0) + clause.length > 60) break;
    kept.push(clause);
  }
  if (kept.length) return kept.join('; ');
  const first = safeClauses[0];
  if (!first) return '-';
  const boundary = Math.max(first.lastIndexOf(', ', 59), first.lastIndexOf(' ', 59));
  return `${first.slice(0, boundary > 35 ? boundary : 59).trimEnd()}…`;
}

export function buildNightMessage(blocks, backlog, { boardWriteFailed = false } = {}) {
  const failures = blocks.filter((b) => !b.ok).length;
  const lines = blocks.map((b) => {
    const name = b.block === '공통' ? b.label : b.block.replace(/^[^\s]+\s/, '');
    const short = messageSummary(b.rawDetail ?? b.detail);
    const status = b.ok ? '' : `(${b.fresh ? b.status : '실행 기록 없음'}) `;
    return `${b.ok ? '정상' : '이상'} ${b.time} ${name} — ${status}${short}`;
  });
  const todo = remainingWork(blocks, backlog);
  // 정보성 헤더와 항목만 보낸다. 종료코드 1은 기존 운영 경고 경로에 맡긴다.
  // 현재 health-watcher는 실행 중단을 감시하고, FAIL 하트비트는 연속 실패 시 별도로 경고한다.
  return [boardWriteFailed ? '현황판 쓰기 실패' : null,
    failures ? `이상 ${failures}개 — 자세한 판단은 경고 알림` : null, '■ 결과', '', ...lines, '', '■ 남은 일', '',
    ...(todo.length ? todo : ['없음'])].filter((line) => line !== null).join('\n');
}

export function replaceBlock(content, block) {
  const s = content.indexOf(START); const e = content.indexOf(END);
  if (s >= 0 && e > s) return `${content.slice(0, s)}${block}${content.slice(e + END.length)}`;
  const anchor = '## ■ 한눈에 보기';
  const at = content.indexOf(anchor);
  const section = `## ■ 밤 점검 (매일 05:00 자동)\n\n${block}\n\n`;
  return at >= 0 ? `${content.slice(0, at)}${section}${content.slice(at)}` : `${content.trimEnd()}\n\n${section}`;
}

export async function runNightCheck({ root = VAULT_PATHS.root, now = new Date(), dryRun = false, output = console,
  noSend = false, send = sendAgentMessage, write = writeAtomic, videoDryRun } = {}) {
  const blocks = judgeBlocks(root, now);
  const backlog = countBacklog(root, now, { videoDryRun });
  const block = renderNightCheck(blocks, backlog, now);
  const failed = blocks.filter((b) => !b.ok).length;
  let boardWriteFailed = false;
  output.log(`[media-night-check] 블록 ${blocks.length}개 중 이상 ${failed}개, 영상 전사 남음 ${backlog.video?.count ?? '?'}개`);
  if (dryRun) {
    const body = buildNightMessage(blocks, backlog);
    output.log(body);
    return { failed, backlog, body, boardWriteFailed };
  }
  const path = join(root, STATUS_BOARD_REL);
  try {
    await withLock(path, () => {
      const content = readFileSync(path, 'utf8');
      const next = replaceBlock(content, block);
      if (next !== content) write(path, next);
    });
  } catch (error) {
    boardWriteFailed = true;
    output.error?.(`[media-night-check] 현황판 쓰기 실패: ${error.message}`);
  }
  const body = buildNightMessage(blocks, backlog, { boardWriteFailed });
  if (!noSend) {
    await send({ agent: SENDER_AGENT, kind: '정보', topic: '밤 점검', body });
  }
  return { failed, backlog, body, boardWriteFailed };
}

export async function main(args = process.argv.slice(2), options = {}) {
  try {
    const result = await runNightCheck({ ...options, dryRun: args.includes('--dry-run'),
      noSend: args.includes('--no-send') });
    return result.failed || result.boardWriteFailed ? 1 : 0;
  } catch (error) {
    (options.errorOutput ?? console).error(`[media-night-check] ${error.message}`);
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => { process.exitCode = code; });
}
