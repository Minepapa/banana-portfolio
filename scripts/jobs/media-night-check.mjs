#!/usr/bin/env node
// 매일 05:00 밤 점검(2026-10-18 오너 지시): 그날 밤 음성(01:00 전사·02:00 화자 분리)·사진(03:00 장면·03:30 얼굴)·
// 영상(04:00) 블록과 공통 잡(매시 보관·순간 노트, 00:00 원본 백업)이 정상으로 끝났는지 확인하고,
// 내일로 넘길 남은 일을 현황판의 '밤 점검' 칸에 덮어쓴다. 로컬 확인만 한다(LLM·텔레그램 없음).
// 실패가 있으면 종료코드 1 — health-watcher가 기존 경로로 알린다.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFrontmatter } from '../lib/vault-frontmatter.mjs';
import { VAULT_PATHS, VAULT_REL } from '../lib/vault-paths.mjs';
import { withLock, writeAtomic } from '../lib/state-writer.mjs';

export const STATUS_BOARD_REL = VAULT_REL.mineStatusBoard;
const START = '<!-- night-check:start -->';
const END = '<!-- night-check:end -->';

// 블록 순서는 시간표 그대로. sinceHours: 이 시간 안에 돌았어야 정상.
export const NIGHT_BLOCKS = Object.freeze([
  { block: '공통', time: '매시', job: 'media-archive', label: '폰 파일 보관', sinceHours: 2 },
  { block: '공통', time: '매시', job: 'media-moments', label: '순간 노트', sinceHours: 2 },
  { block: '공통', time: '00:00', job: 'media-audio-offsite-backup', label: '원본 암호화 백업', sinceHours: 6 },
  { block: '🎙 음성', time: '01:00', job: 'media-transcribe', label: '통화·녹음 전사', sinceHours: 6 },
  { block: '🎙 음성', time: '02:00', job: 'media-diarize', label: '화자 분리', sinceHours: 6 },
  { block: '📷 사진', time: '03:00', job: 'media-vision', label: '장면 분석', sinceHours: 6 },
  { block: '📷 사진', time: '03:30', job: 'media-faces-nightly', label: '얼굴 이름표', sinceHours: 6 },
  { block: '🎬 영상', time: '04:00', job: 'media-video', label: '분석·이름표·하이라이트·말소리 전사', sinceHours: 6 },
]);

function readHealth(root, job) {
  const path = join(root, VAULT_REL.jobHealth, `${job}.md`);
  if (!existsSync(path)) return null;
  return parseFrontmatter(readFileSync(path, 'utf8'));
}

export function judgeBlocks(root, now = new Date()) {
  return NIGHT_BLOCKS.map((entry) => {
    const health = readHealth(root, entry.job);
    const last = health?.lastRun ? Date.parse(health.lastRun) : NaN;
    const fresh = Number.isFinite(last) && now.getTime() - last <= entry.sinceHours * 3600_000;
    const ok = fresh && health?.status === 'OK';
    const detail = String(health?.detail ?? '').replace(/\s+/g, ' ').trim().slice(0, 160);
    return { ...entry, ok, fresh, status: health?.status ?? '기록 없음', lastRun: health?.lastRun ?? null, detail };
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

export function renderNightCheck(blocks, backlog, now = new Date()) {
  const kst = new Date(now.getTime() + 9 * 3600_000).toISOString().replace('T', ' ').slice(0, 16);
  const rows = blocks.map((b) => `| ${b.time} | ${b.block} | ${b.label} | ${b.ok ? '✔' : '✖'} ${b.ok ? '' : `(${b.fresh ? b.status : '이번 밤 실행 기록 없음'})`} | ${b.detail.replace(/\|/g, '/') || '-'} |`);
  const todo = [];
  for (const b of blocks.filter((x) => !x.ok)) todo.push(`${b.time} ${b.label} 점검·재실행(${b.fresh ? b.status : '실행 기록 없음'})`);
  if (backlog.video?.count) todo.push(`영상 말소리 전사 백필 남음 ${backlog.video.count}개(${backlog.video.hours}시간 분량) — 낮 백필·04:00 블록이 이어서 처리`);
  if (backlog.untitledRecent) todo.push(`주제 없는 최근 통화 노트 ${backlog.untitledRecent}개 — 통화 주제 자동은 LLM 판단 보류 중`);
  if (backlog.speakerCheck) todo.push(`'[화자 확인 필요]' 통화 노트 ${backlog.speakerCheck}개 — 오너 확인 시트 대기`);
  return [START, `### 밤 점검 ${kst} (자동, 05:00 media-night-check)`, '',
    '| 시각 | 블록 | 작업 | 결과 | 내용 |', '|---|---|---|---|---|', ...rows, '',
    '**내일로 넘기는 일**', ...(todo.length ? todo.map((t) => `- ${t}`) : ['- 없음']), END].join('\n');
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
  write = writeAtomic, videoDryRun } = {}) {
  const blocks = judgeBlocks(root, now);
  const backlog = countBacklog(root, now, { videoDryRun });
  const block = renderNightCheck(blocks, backlog, now);
  const failed = blocks.filter((b) => !b.ok).length;
  output.log(`[media-night-check] 블록 ${blocks.length}개 중 이상 ${failed}개, 영상 전사 남음 ${backlog.video?.count ?? '?'}개`);
  if (dryRun) { output.log(block); return { failed, backlog }; }
  const path = join(root, STATUS_BOARD_REL);
  await withLock(path, () => {
    const content = readFileSync(path, 'utf8');
    const next = replaceBlock(content, block);
    if (next !== content) write(path, next);
  });
  return { failed, backlog };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runNightCheck({ dryRun: process.argv.includes('--dry-run') })
    .then((r) => { if (r.failed) process.exitCode = 1; })
    .catch((error) => { console.error(`[media-night-check] ${error.message}`); process.exitCode = 1; });
}
