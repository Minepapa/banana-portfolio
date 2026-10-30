// 기억 구슬 일일 집계(2026-10-31 오너 승인, 올림푸스 대시보드가 읽기만 함). 05:00 밤 점검이 같이 쓴다.
// 정본은 노트 머리말이다: 감정 필드가 채워진 미네 통화·녹음·순간 노트 하나가 구슬 하나.
// days는 기록이 일어난 날짜(occurred, KST) 기준 최근 30일(제우스 확인 — "그날 무슨 감정의 일이 있었나").
// LLM은 부르지 않는다. 개인 경로·파일 이름·근거 문장은 넣지 않는다(숫자만).
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative } from 'node:path';
import { parseFrontmatter } from './vault-frontmatter.mjs';
import { VAULT_REL, categoryLink } from './vault-paths.mjs';

export const ORB_DAILY_SCHEMA_VERSION = 1;
export const ORB_DAYS = 30;
export const ORB_EMOTIONS = Object.freeze(['기쁨', '슬픔', '버럭', '까칠', '소심', '감정 없음', '모름']);
// 미네 판단 잡(mine-athena-fields)의 판단 기록 — 볼트 밖. 없으면 애매함 대기 0.
// 아래 세 값은 판단 잡 브랜치(worktree -mj, 아직 main에 안 합침)의 정본을 옮겨 적은 것이다:
// 판단 기록 경로, Claude 판(PROMPT_VERSIONS.claude), 오너 표식(mine-judgment OWNER_EVIDENCE).
// -mj를 main에 합치면 그쪽 상수를 import하고 이 사본은 지운다.
export const JUDGMENTS_PATH = join(homedir(), 'Pantheon', 'Media', 'MemoryOrb', 'athena-judgments.jsonl');
export const CLAUDE_PROMPT_VERSION = 'athena-fields/1.0';
const OWNER_EVIDENCE = '오너 판단(검수 시트)';
const MINE = categoryLink('201 미네');

const kstDate = (ms) => new Date(ms + 9 * 3_600_000).toISOString().slice(0, 10);
const emptyCounts = () => Object.fromEntries(ORB_EMOTIONS.map((name) => [name, 0]));

function listNotes(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name.startsWith('.') || entry.name.startsWith('99_')) return [];
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return listNotes(path);
    return entry.isFile() && entry.name.endsWith('.md') ? [path] : [];
  });
}

// 노트 머리말 → 구슬 하나(감정 필드가 없으면 null). 감정 칸: 대표 감정, 없으면 근거가 '모름: '이면 모름, 아니면 감정 없음.
export function orbOf(fields) {
  const category = Array.isArray(fields?.category) ? fields.category : [fields?.category];
  if (!category.includes(MINE) || !Array.isArray(fields.emotions)) return null;
  const time = Date.parse(String(fields.occurred ?? ''));
  if (!Number.isFinite(time)) return null;
  const emotion = ORB_EMOTIONS.includes(fields.primaryEmotion) ? fields.primaryEmotion
    : String(fields.emotionEvidence ?? '').startsWith('모름') ? '모름' : '감정 없음';
  return { date: kstDate(time), emotion, candidate: fields.coreMemoryCandidate === true, core: fields.coreMemory === true,
    owner: String(fields.emotionEvidence ?? '').replace(/^모름: /, '').startsWith(OWNER_EVIDENCE) };
}

// 오너 확인을 기다리는 애매함 — 검수 시트(mine-review-sheet pendingAmbiguous)와 같은 정의: 오너 줄과 지금 Claude 판 줄만
// 보고, 노트별 마지막이 ambiguous(두 답 있음)인 것. 노트에 오너 표식이 이미 있으면(기록만 빠진 경우) 뺀다.
export function ambiguousPending(rows, ownerDecided = new Set(), promptVersion = CLAUDE_PROMPT_VERSION) {
  const latest = new Map();
  for (const row of rows) {
    if (typeof row?.rel !== 'string') continue;
    if (row.engine === 'owner' || (row.engine === 'claude' && row.promptVersion === promptVersion)) latest.set(row.rel, row);
  }
  return [...latest].filter(([rel, row]) => row.status === 'ambiguous' && Array.isArray(row.answers) && !ownerDecided.has(rel)).length;
}

function readRows(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; } // 쓰는 도중 끊긴 줄은 세지 않는다
  });
}

export function buildOrbDaily(root, { now = new Date(), judgmentsPath = JUDGMENTS_PATH } = {}) {
  const totals = { orbs: 0, byEmotion: emptyCounts(), coreCandidates: 0, coreMemories: 0, ambiguousPending: 0 };
  const today = kstDate(now.getTime());
  const noon = Date.parse(`${today}T12:00:00+09:00`);
  const days = Array.from({ length: ORB_DAYS }, (_, index) => ({
    date: kstDate(noon - (ORB_DAYS - 1 - index) * 86_400_000), orbs: 0, byEmotion: emptyCounts(), coreCandidates: 0, coreMemories: 0 }));
  const byDate = new Map(days.map((day) => [day.date, day]));
  const owners = new Set();
  for (const rel of [VAULT_REL.mediaConversations, VAULT_REL.mediaMoments]) {
    for (const path of listNotes(join(root, rel))) {
      let orb;
      try { orb = orbOf(parseFrontmatter(readFileSync(path, 'utf8'))); } catch { continue; }
      if (!orb) continue;
      if (orb.owner) owners.add(relative(root, path));
      for (const bucket of [totals, byDate.get(orb.date)].filter(Boolean)) {
        bucket.orbs += 1;
        bucket.byEmotion[orb.emotion] += 1;
        if (orb.candidate) bucket.coreCandidates += 1;
        if (orb.core) bucket.coreMemories += 1;
      }
    }
  }
  totals.ambiguousPending = ambiguousPending(readRows(judgmentsPath), owners);
  return { schemaVersion: ORB_DAILY_SCHEMA_VERSION, generatedAt: now.toISOString(), totals, days };
}
