#!/usr/bin/env node
// 매일 05:00 밤 점검(2026-10-18 오너 지시): 그날 밤 음성(02:00 전사 → 화자 분리)·사진(03:00 장면 분석 → 얼굴 이름표)·
// 영상(04:00) 블록과 공통 잡(매시 보관·순간 노트, 00:00 원본 백업)이 정상으로 끝났는지 확인하고,
// 내일로 넘길 남은 일을 현황판의 '밤 점검' 칸에 덮어쓰고 오너에게 결과를 보낸다(LLM 없음).
// 블록 이상·현황판 쓰기·발송 실패는 종료코드 1. run.sh가 FAIL 하트비트로 기록한다.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { checkDay } from '../tools/argos-health-check.mjs';
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
  { block: '공통', time: '00:20', job: 'vault-offsite-backup', label: '볼트 암호화 백업', sinceHours: 6 },
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


// ── 분류별 보고(2026-10-25 오너: "통화·녹음·사진·영상·노트·백업으로 나눠 결과를 구분해서") ──────────────
// 잡 로그의 마지막 실행 구간에서 숫자를 뽑아, 텔레그램에는 바뀐 것과 문제만 사람 말로 보낸다.
// '건너뜀'(바뀐 것 없음)은 보내지 않는다. 표는 현황판(볼트)에 둔다.
export const JOB_LOG_DIR = join(homedir(), 'Library', 'Logs', 'banana-portfolio-v2');
export const CATEGORIES = Object.freeze([
  { key: 'call', title: '📞 통화', jobs: ['media-audio'] },
  { key: 'recording', title: '🎙 녹음', jobs: ['media-audio'] },
  { key: 'photo', title: '📷 사진', jobs: ['media-photo'] },
  { key: 'video', title: '🎬 영상', jobs: ['media-video'] },
  { key: 'note', title: '📝 노트', jobs: ['media-moments'] },
  { key: 'backup', title: '💾 백업', jobs: ['media-archive', 'media-audio-offsite-backup', 'vault-offsite-backup'] },
]);
const categoryOf = (job) => CATEGORIES.find((c) => c.key !== 'recording' && c.jobs.includes(job))?.title.split(' ')[1] ?? '';

/** 잡 로그에서 마지막으로 끝난 실행의 줄들(하트비트 '🫀' 줄 사이). */
export function lastRunLines(job, dir = JOB_LOG_DIR, { notBefore = 0 } = {}) {
  const path = join(dir, `${job}.log`);
  let lines;
  try {
    // 로그가 이번 실행보다 오래됐으면(손으로 실행해 출력이 로그에 안 남은 경우 등) 지난 숫자를 오늘 것으로 보내지 않는다.
    if (!existsSync(path) || statSync(path).mtimeMs < notBefore) return [];
    lines = readFileSync(path, 'utf8').split('\n');
  } catch { return []; }
  const beats = lines.map((l, i) => (l.startsWith('🫀 ') ? i : -1)).filter((i) => i >= 0);
  if (!beats.length) return [];
  const end = beats.at(-1);
  if (beats.length < 2) return []; // 회차 경계를 모르면 숫자를 쓰지 않는다
  const start = beats.at(-2) + 1;
  return lines.slice(start, end).filter(Boolean);
}

const lastMatch = (lines, re) => {
  for (let i = lines.length - 1; i >= 0; i -= 1) { const m = lines[i].match(re); if (m) return m; }
  return null;
};
const n = (m, i = 1) => (m ? Number(m[i]) : null);
const json = (lines, tag) => {
  const m = lastMatch(lines, new RegExp(`^\\[${tag}\\] (\\{.*\\})\\s*$`));
  try { return m ? JSON.parse(m[1]) : null; } catch { return null; }
};

/** 잡별 마지막 실행 로그 → 분류 보고에 쓰는 숫자. 모르는 값은 null. */
export function runFacts(logs) {
  const audio = logs['media-audio'] ?? [];
  const photo = logs['media-photo'] ?? [];
  const video = logs['media-video'] ?? [];
  const moments = logs['media-moments'] ?? [];
  const archive = logs['media-archive'] ?? [];
  const offsite = logs['media-audio-offsite-backup'] ?? [];
  const vault = logs['vault-offsite-backup'] ?? [];
  const tr = lastMatch(audio, /\[media-transcribe\] 전사 (\d+)\(음성없음 \d+\), 실패 (\d+)/);
  const di = lastMatch(audio, /\[media-diarize\] 처리 (\d+),.*실패 (\d+)/);
  const vision = json(photo, 'media-vision');
  const faces = json(photo, 'media-faces');
  const labels = lastMatch(photo, /\[media-moments\] 이름표 갱신 (\d+), 건너뜀 \d+, 실패 (\d+)/);
  const vd = lastMatch(video, /\[media-video\] 대상 (\d+), 완료 (\d+), 실패 (\d+)/);
  const mo = lastMatch(moments, /\[media-moments\] 새 순간 (\d+), 갱신 (\d+)/);
  const geo = lastMatch(moments, /지오코딩 실패 (\d+)건(?: \(([^)]*)\))?/);
  const ar = lastMatch(archive, /\[media-archive\] 새로 보관 (\d+), 건너뜀 \d+, 실패 (\d+)/);
  const up = lastMatch(offsite, /올림 (\d+)건 ([\d.]+)MB.*실패 (\d+)/);
  const vb = lastMatch(vault, /백업 완료: .*\((\d+) bytes\)/);
  return {
    transcribed: n(tr), transcribeFailed: n(tr, 2), diarized: n(di), diarizeFailed: n(di, 2),
    sceneAnalyzed: vision?.analyzed ?? null, sceneFailed: vision?.failed ?? null,
    facesProcessed: faces?.processed ?? null, facesFailed: faces?.failed ?? null,
    labelsUpdated: n(labels), videoTarget: n(vd), videoDone: n(vd, 2), videoFailed: n(vd, 3),
    momentsNew: n(mo), momentsUpdated: n(mo, 2), geocodeFailed: n(geo), geocodeReasons: geo?.[2] ?? null,
    archived: n(ar), archiveFailed: n(ar, 2),
    uploaded: n(up), uploadedMB: up ? Number(up[2]) : null, uploadFailed: n(up, 3),
    vaultBackupMB: vb ? Math.round(Number(vb[1]) / 104857.6) / 10 : null,
  };
}

/**
 * 아르고스 전날(KST) 하루 점검(오너 2026-10-26: "아르고스 하루 점검 매일 텔레그램 발송"). 밤 점검 한 통에 싣는다.
 * 좌표·본문·파일명은 쓰지 않는다(시각·개수만). 이벤트 파일이 없으면 null.
 */
export function argosDayReport(root, now = new Date()) {
  const day = new Date(now.getTime() + 9 * 3600_000 - 86_400_000).toISOString().slice(0, 10);
  const path = join(root, VAULT_REL.argosEvents, day.slice(0, 4), `${day}.jsonl`);
  if (!existsSync(path)) return { day, missing: true };
  try {
    const events = readFileSync(path, 'utf8').split('\n').filter(Boolean)
      .flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
    return { day, ...checkDay(events) };
  } catch { return { day, missing: true }; }
}

/** 최근 24시간에 보관 색인에 새로 들어온 파일 수(매시 잡이라 마지막 1회 숫자는 밤 결과가 아니다). */
export function archivedLast24h(root, now = new Date()) {
  const path = join(root, VAULT_REL.mediaArchiveIndex);
  if (!existsSync(path)) return null;
  const since = now.getTime() - 24 * 3600_000;
  let count = 0;
  try {
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      const at = Date.parse(JSON.parse(line).archivedAt ?? '');
      if (Number.isFinite(at) && at >= since) count += 1;
    }
  } catch { return null; }
  return count;
}

/** 최근 24시간에 새로 만들어진 대화 노트를 통화·녹음으로 나눠 센다(convKind). created는 통화한 날짜라 쓰지 않는다. */
export function newConversationNotes(root, now = new Date(), { bornAt = (path) => statSync(path).birthtimeMs } = {}) {
  const since = now.getTime() - 24 * 3600_000;
  const counts = { 통화: 0, 녹음: 0 };
  for (const path of listConversationNotes(root)) {
    try {
      if (bornAt(path) < since) continue;
      const fm = parseFrontmatter(readFileSync(path, 'utf8'));
      // 화자 재배정·재작성으로 다시 써진 옛 노트는 새 노트가 아니다: 대화가 최근 3일 안인 것만.
      const occurred = Date.parse(String(fm.occurred ?? ''));
      if (!Number.isFinite(occurred) || occurred < now.getTime() - 3 * 86_400_000) continue;
      if (fm.convKind in counts) counts[fm.convKind] += 1;
    } catch { /* 읽지 못한 노트는 세지 않는다 */ }
  }
  return counts;
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
  const rows = blocks.map((b) => `| ${b.time} | ${categoryOf(b.job) || b.block} | ${b.label} | ${b.ok ? '✔' : '✖'} ${b.ok ? '' : `(${b.fresh ? b.status : '이번 밤 실행 기록 없음'})`} | ${b.detail.replace(/\|/g, '/') || '-'} |`);
  const todo = remainingWork(blocks, backlog);
  return [START, `### 밤 점검 ${kst} (자동, 05:00 media-night-check)`, '',
    '| 시각 | 분류 | 작업 | 결과 | 내용 |', '|---|---|---|---|---|', ...rows, '',
    '**내일로 넘기는 일**', ...(todo.length ? todo.map((t) => `- ${t}`) : ['- 없음']), END].join('\n');
}


/**
 * 실패 원인 한 마디. 경로·파일 이름이 든 문장은 통째로 뺀다(공백 있는 노트 경로가 가림 정규식을 빠져나가
 * 장소명이 보이던 문제, 리뷰 2026-10-25). 남는 게 없으면 경고 알림을 가리킨다.
 */
// 파일 이름처럼 보이는 단어: 경로 구분자, 또는 영문으로 시작하는 2~5자 확장자(25.3MB 같은 숫자는 제외).
const FILEISH = /\/|\.[A-Za-z][A-Za-z0-9]{1,4}\b/;
export function safeReason(detail) {
  const clauses = detailParts(detail)
    .map((part) => part.replace(/^\[[a-z][a-z0-9-]*\]\s*/, ''))
    .flatMap((part) => part.split(';').map((x) => x.trim()))
    // 경로·파일 이름이 시작되는 단어부터 끝까지 자른다(공백 든 경로도 통째로). 앞의 원인 문구는 남긴다.
    .map((x) => {
      const words = x.split(/\s+/);
      const at = words.findIndex((w) => FILEISH.test(w));
      if (at < 0) return x;
      // 경로는 폴더부터 시작하니 그 앞 단어는 안전하다.
      if (words[at].includes('/')) return words.slice(0, at).join(' ').replace(/[\s:,(-]+$/, '').trim();
      // 경로 없이 이름만 왔으면 이름 앞 단어(장소·사람 이름일 수 있다)도 믿지 않는다:
      // 문제 문구가 든 단어 끝이나 첫 ':' 앞까지만.
      const problem = x.match(PROBLEM);
      if (problem) {
        const after = problem.index + problem[0].length;
        const rest = x.slice(after).search(/[\s:]/); // 'failed'처럼 문제 문구가 단어 중간에서 끝나면 그 단어 끝까지
        return x.slice(0, rest < 0 ? x.length : after + rest).trim();
      }
      const colon = x.indexOf(':');
      return colon > 0 ? x.slice(0, colon).trim() : '';
    })
    .filter((x) => x && !x.startsWith('🫀'));
  const first = clauses.find((x) => PROBLEM.test(x)) ?? clauses[0];
  if (!first) return '원인은 경고 알림 참고';
  const safe = redactWarningDetail(first);
  return safe.length > 60 ? `${safe.slice(0, 59)}…` : safe;
}

export function buildNightMessage(blocks, backlog, { boardWriteFailed = false, facts = {}, notes = null, argos = null } = {}) {
  const byJob = new Map(blocks.map((b) => [b.job, b]));
  // 이번 밤에 돌지 않은 작업에는 지난 회차 기록을 원인처럼 붙이지 않는다.
  const failLine = (b) => (b.fresh
    ? `실패: ${b.label} 실패 (${b.status}) — ${safeReason(b.rawDetail ?? b.detail)}`
    : `실패: ${b.label} — 이번 밤 실행 기록 없음`);
  const known = (v) => v !== null && v !== undefined;
  const sections = [];
  let warnings = 0;
  const warn = (text) => { warnings += 1; return `주의: ${text}`; };
  const audio = byJob.get('media-audio');
  const audioOk = !audio || audio.ok;

  const call = [];
  if (!audioOk) call.push(failLine(audio));
  else {
    const made = notes ? `새 통화 노트 ${notes.통화}개` : '통화 처리 완료';
    const work = known(facts.transcribed) ? ` · 전사 ${facts.transcribed}건, 화자 분리 ${facts.diarized ?? 0}건(통화·녹음 합계)` : '';
    call.push(`정상: ${made}${work}`);
    if (facts.transcribeFailed || facts.diarizeFailed) call.push(warn(`전사 실패 ${facts.transcribeFailed ?? 0}건, 화자 분리 실패 ${facts.diarizeFailed ?? 0}건`));
  }
  if (backlog.untitledRecent) call.push(`보류: 주제 없는 최근 통화 노트 ${backlog.untitledRecent}개 — LLM 판단 재개 뒤`);
  if (backlog.speakerCheck) call.push(`보류: 화자 확인 필요 ${backlog.speakerCheck}개 — 대화 경계 개선 뒤`);
  sections.push(['통화', call]);

  const recording = [];
  if (!audioOk) recording.push('실패: 통화와 같은 작업이 실패해 처리되지 않음');
  else if (notes) recording.push(notes.녹음 ? `정상: 새 녹음 노트 ${notes.녹음}개` : '없음: 새 녹음 없음');
  else recording.push('정상: 녹음 처리 완료');
  sections.push(['녹음', recording]);

  const photoBlock = byJob.get('media-photo');
  const photo = [];
  if (photoBlock && !photoBlock.ok) photo.push(failLine(photoBlock));
  else {
    photo.push(known(facts.sceneAnalyzed)
      ? (facts.sceneAnalyzed || facts.facesProcessed ? `정상: 장면 분석 ${facts.sceneAnalyzed}장 · 얼굴 이름표 ${facts.facesProcessed ?? 0}장` : '없음: 새 사진 없음')
      : '정상: 사진 처리 완료');
    if (facts.sceneFailed || facts.facesFailed) photo.push(warn(`분석 실패 ${(facts.sceneFailed ?? 0) + (facts.facesFailed ?? 0)}장`));
  }
  sections.push(['사진', photo]);

  const videoBlock = byJob.get('media-video');
  const video = [];
  if (videoBlock && !videoBlock.ok) video.push(failLine(videoBlock));
  else {
    video.push(known(facts.videoTarget)
      ? (facts.videoTarget ? `정상: 영상 분석 ${facts.videoDone}/${facts.videoTarget}개` : '없음: 새 영상 없음')
      : '정상: 영상 처리 완료');
    if (facts.videoFailed) video.push(warn(`영상 분석 실패 ${facts.videoFailed}개`));
  }
  if (backlog.video?.count) video.push(`보류: 말소리 전사 남음 ${backlog.video.count}개(${backlog.video.hours}시간) — 낮·04:00에 이어서`);
  sections.push(['영상', video]);

  const momentsBlock = byJob.get('media-moments');
  const note = [];
  if (momentsBlock && !momentsBlock.ok) note.push(failLine(momentsBlock));
  else {
    // 매시 잡의 마지막 1회 숫자는 밤 결과가 아니라 보내지 않는다.
    note.push(`정상: 순간 노트 매시 갱신${facts.labelsUpdated ? ` · 사진 이름표 반영 ${facts.labelsUpdated}` : ''}`);
  }
  if (facts.geocodeFailed) note.push(warn(`장소 이름 못 찾음 ${facts.geocodeFailed}건${facts.geocodeReasons ? ` (${facts.geocodeReasons})` : ''}`));
  sections.push(['노트', note]);

  const backup = [];
  const archive = byJob.get('media-archive');
  if (archive && !archive.ok) backup.push(failLine(archive));
  else backup.push(known(facts.archived24h) ? `정상: 폰 파일 새로 보관 ${facts.archived24h}개(24시간)` : '정상: 폰 파일 보관 완료');
  const offsite = byJob.get('media-audio-offsite-backup');
  if (offsite && !offsite.ok) backup.push(failLine(offsite));
  else backup.push(known(facts.uploaded) ? `정상: 원본 암호화 백업 ${facts.uploaded}건 ${facts.uploadedMB}MB` : '정상: 원본 암호화 백업 완료');
  const vault = byJob.get('vault-offsite-backup');
  if (vault && !vault.ok) backup.push(failLine(vault));
  else if (vault) backup.push(known(facts.vaultBackupMB) ? `정상: 볼트 암호화 백업 ${facts.vaultBackupMB}MB` : '정상: 볼트 암호화 백업 완료');
  sections.push(['백업', backup]);

  if (argos) {
    const lines = [];
    if (argos.missing) lines.push(`주의: ${argos.day} 아르고스 기록 없음 — 폰 앱·맥 수신부 확인`);
    else {
      const f = argos.facts;
      lines.push(argos.issues.length ? `주의: 이상 신호 ${argos.issues.length}건 (${argos.day})` : `정상: 이상 신호 없음 (${argos.day})`);
      lines.push(`없음: 위치 ${f.points}개 · 체류 ${f.stays}번 · 미디어 ${f.mediaSent}개 · 알림 ${f.notifications}건`.replace(/^없음: /, '정상: '));
      for (const issue of argos.issues.slice(0, 5)) lines.push(`주의: ${issue}`);
      if (argos.issues.length > 5) lines.push(`주의: 그 밖에 ${argos.issues.length - 5}건 — argos-health-check로 확인`);
    }
    if (lines.some((l) => l.startsWith('주의'))) warnings += 1;
    sections.push(['아르고스', lines]);
  }

  const failures = blocks.filter((b) => !b.ok).length;
  const head = failures ? `확인 필요 ${failures}개 — 자세한 판단은 경고 알림`
    : warnings ? `전체 정상 (주의 ${warnings}개)` : '전체 정상';
  // 정보성 헤더와 항목만 보낸다. 종료코드 1은 기존 운영 경고 경로에 맡긴다.
  return [boardWriteFailed ? '현황판 쓰기 실패' : null, head, '',
    ...sections.flatMap(([title, lines]) => [`■ ${title}`, ...lines, ''])]
    .filter((line) => line !== null).join('\n').trimEnd();
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
  noSend = false, send = sendAgentMessage, write = writeAtomic, videoDryRun,
  readLogs = (job, options) => lastRunLines(job, JOB_LOG_DIR, options) } = {}) {
  const blocks = judgeBlocks(root, now);
  const backlog = countBacklog(root, now, { videoDryRun });
  const facts = runFacts(Object.fromEntries(blocks.map((b) => [b.job,
    b.fresh ? readLogs(b.job, { notBefore: Date.parse(b.lastRun) - 60_000 }) : []])));
  facts.archived24h = archivedLast24h(root, now);
  const notes = newConversationNotes(root, now);
  const argos = argosDayReport(root, now);
  const block = renderNightCheck(blocks, backlog, now);
  const failed = blocks.filter((b) => !b.ok).length;
  let boardWriteFailed = false;
  output.log(`[media-night-check] 블록 ${blocks.length}개 중 이상 ${failed}개, 영상 전사 남음 ${backlog.video?.count ?? '?'}개`);
  if (dryRun) {
    const body = buildNightMessage(blocks, backlog, { facts, notes, argos });
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
  const body = buildNightMessage(blocks, backlog, { boardWriteFailed, facts, notes, argos });
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
