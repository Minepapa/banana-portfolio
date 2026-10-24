#!/usr/bin/env node
/** Nightly photo memory orbs. The dry run is entirely read only. */
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, rmSync, truncateSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VAULT_PATHS, VAULT_REL, MEDIA_FACES_PATHS } from '../lib/vault-paths.mjs';
import { assertFrontmatterRoundTrip, parseFrontmatter, yamlValue } from '../lib/vault-frontmatter.mjs';
import { parseRegistry, checkNote } from '../lib/vault-registry.mjs';
import { withLock, writeAtomic } from '../lib/state-writer.mjs';
import { cooldownActive } from '../lib/quota-cooldown.mjs';
import { loadAgent } from '../lib/agent-loader.mjs';
import { parseJsonBlock, runHeadlessClaude } from '../lib/headless-claude.mjs';
import { loadEmotionCriteria } from '../lib/mine-emotion-criteria.mjs';
import { OLLAMA_MODELS, runOllama, unloadOllamaModel } from '../lib/ollama-client.mjs';
import { EMOTION_REQUIRED, assertEngine, emotionProperties, validScores } from '../lib/mine-judgment.mjs';
import { loadCandidates, hasOrb } from '../lib/mine-memory-candidates.mjs';
import { mineAge, occurredDate } from './mine-athena-fields.mjs';
import { choosePhotos, makeCopy, makeGrid, buildPrompt, ownerEmotions, parseClaudeResult, validateProposal } from '../tools/media-memory-orb-trial.mjs';

export const NIGHTLY_LIMIT = 50;
export const MAX_JOB_MS = 90 * 60_000;
export const MAX_CALL_MS = 3 * 60_000;
export const RUN_ROOT = join(homedir(), 'Pantheon', 'Media', 'MemoryOrb');
// 프롬프트 판. 0.0 = 기억 판단 체계 §10.5 초안(v0.1) 전, 지금까지 쓰던 프롬프트. 프롬프트를 바꾸면 올린다.
export const PROMPT_VERSION = 'memory-orb/0.0';
export const ORB_FIELDS = Object.freeze([
  'emotions', 'primaryEmotion', 'emotionIntensity', 'emotionEvidence', 'secondFilmSignal',
  'importance', 'coreMemoryCandidate', 'mineAge',
]);

export function requireRegistryFields(registry) {
  // checkNote currently checks type/path/required fields, not allowed optional keys.
  // Read only the 201 Mine media schema paragraph, never incidental prose elsewhere.
  const mediaRow = registry.match(/^\| `media` \|[^\n]*$/m);
  const paragraph = registry.match(/^`201 미네`가 붙은 conversation·media[^\n]*(?:\n(?!\n)[^\n]+)*/m);
  const scoped = mediaRow && paragraph && paragraph.index > mediaRow.index
    && !/^#{2,3} /m.test(registry.slice(mediaRow.index, paragraph.index)) ? paragraph[0] : '';
  const missing = ORB_FIELDS.filter((key) => !scoped.includes(`\`${key}\``));
  if (missing.length) throw new Error(`사진 기억 구슬 머리말 등록 필요: ${missing.join(', ')}`);
}

// Ollama 답 모양 — buildPrompt의 출력 예시와 같은 객체. 검사는 validateProposal이 다시 한다.
export function orbSchema(recordDate, criteria) {
  const text = (maxLength) => ({ type: 'string', minLength: 1, maxLength });
  return { type: 'object', additionalProperties: false,
    required: [...EMOTION_REQUIRED, 'confidence', 'importance', 'scene', 'titleSuggestion', 'coreMemoryCandidate'],
    properties: { ...emotionProperties(recordDate, criteria), confidence: { enum: ['낮음', '보통', '높음'] },
      importance: { type: 'integer', minimum: 1, maximum: 5 }, scene: text(300), titleSuggestion: text(200),
      coreMemoryCandidate: { type: 'object', additionalProperties: false, required: ['value', 'reason'],
        properties: { value: { type: 'boolean' }, reason: text(200) } } } };
}

// Ollama 이미지 판단. 격자 사본을 base64로 붙이고(집 밖으로 나가지 않음), Claude 결과와 같은 모양으로 돌려준다.
export function ollamaPhotoDecision({ criteria, invoke = runOllama, readImage = (path) => readFileSync(path).toString('base64'), output = console } = {}) {
  return async (prompt, _cwd, timeoutMs, { imagePath, recordDate }) => {
    const { json, usage } = await invoke({ model: OLLAMA_MODELS.vision, prompt, images: [readImage(imagePath)],
      schema: orbSchema(recordDate, criteria), timeoutMs, usageLogger: (line) => output.log(`[media-memory-orb] ${line}`) });
    return { result: json, inputTokens: usage.promptTokens ?? 0, outputTokens: usage.outputTokens ?? 0, usage };
  };
}

const kstDay = (timestamp) => new Date(timestamp + 9 * 3_600_000).toISOString().slice(0, 10);

export function readRuns(path) {
  if (!existsSync(path)) return [];
  const content = readFileSync(path, 'utf8');
  const lastNewline = content.lastIndexOf('\n');
  // Only a torn final append is recoverable. A corrupt complete row fails closed;
  // repair runs.jsonl manually before restarting to avoid exceeding the quota.
  const rows = content.slice(0, lastNewline + 1).split('\n').filter(Boolean).map((line) => JSON.parse(line));
  if (lastNewline < content.length - 1) {
    let finalRow;
    try { finalRow = JSON.parse(content.slice(lastNewline + 1)); }
    catch { truncateSync(path, lastNewline + 1); }
    if (finalRow !== undefined) {
      appendFileSync(path, '\n'); // A failed append must leave the reservation intact and stop the job.
      rows.push(finalRow);
    }
  }
  return rows;
}

const WINDOW_MS = 24 * 60 * 60_000;
const RETRY_MS = 14 * WINDOW_MS;

export function attemptState(rows, timestamp) {
  const reserved = new Set();
  const failed = new Map();
  let count = 0;
  for (const row of rows) {
    const at = Date.parse(row?.at);
    if (!row || typeof row.id !== 'string' || !row.id ||
      !['reserved', 'error', 'deferred', 'written', 'already-written'].includes(row.status) ||
      !Number.isFinite(at) || at > timestamp) throw new Error('runs.jsonl 행 오류: 복구 필요');
    if (row.status === 'reserved' && at > timestamp - WINDOW_MS) { count += 1; reserved.add(row.id); }
    if (row.status === 'error' && at > timestamp - RETRY_MS) failed.set(row.id, (failed.get(row.id) ?? 0) + 1);
  }
  return { count, reserved, failed };
}

export function applyOrbFields(content, proposal, copies) {
  const fields = parseFrontmatter(content);
  if (hasOrb(fields)) return null;
  if (fields.mineAge == null && mineAge(fields.occurred) == null) throw new Error('미네 나이 계산 불가');
  if (!content.startsWith('---\n')) throw new Error('순간 노트 머리말 없음');
  const end = content.indexOf('\n---', 4);
  if (end < 0) throw new Error('순간 노트 머리말 끝 없음');
  const update = {
    emotions: proposal.emotions, primaryEmotion: proposal.primaryEmotion,
    emotionIntensity: proposal.emotionIntensity, emotionEvidence: proposal.emotionEvidence,
    secondFilmSignal: proposal.secondFilmSignal, importance: proposal.importance,
    coreMemoryCandidate: proposal.coreMemoryCandidate.value,
    ...(fields.mineAge == null ? { mineAge: mineAge(fields.occurred) } : {}),
  };
  const next = `${content.slice(0, end)}\n${Object.entries(update).map(([key, value]) => `${key}: ${yamlValue(value)}`).join('\n')}${content.slice(end)}`;
  assertFrontmatterRoundTrip(next, update);
  return next;
}

function replaceOrbIndex(path, content) {
  if (content === null) { unlinkSync(path); return; }
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try {
    writeFileSync(temporary, content, { mode: 0o600, flag: 'wx' });
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
  } catch (error) {
    try { unlinkSync(temporary); } catch { /* preserve the original error */ }
    throw error;
  }
}

export function upsertOrbIndex(path, row) {
  const previous = existsSync(path) ? readFileSync(path, 'utf8') : null;
  const lines = previous?.split('\n') ?? [];
  if (lines.at(-1) !== '') lines.pop(); // An unfinished append is not a complete JSONL row.
  const rows = lines.filter(Boolean).map((line) => JSON.parse(line));
  const next = [...rows.filter((existing) => existing.id !== row.id), row];
  replaceOrbIndex(path, `${next.map((entry) => JSON.stringify(entry)).join('\n')}\n`);
  return previous;
}

function logRow(path, row) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  appendFileSync(path, `${JSON.stringify(row)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

export async function run({ root = VAULT_PATHS.root, mediaRoot = MEDIA_FACES_PATHS.mediaRoot,
  out = RUN_ROOT, dryRun = false, limit = NIGHTLY_LIMIT, candidates,
  judge, cooldown = cooldownActive, copyPhoto = makeCopy, gridPhoto = makeGrid,
  write = writeAtomic, rules, registryText, criteria, charter, photoScores, visionRows,
  output = console, now = () => Date.now(), engine = 'claude', unload = unloadOllamaModel, invoke, readImage } = {}) {
  assertEngine(engine);
  const runStarted = now();
  const quota = engine === 'claude' ? cooldown : () => false; // 쿨다운은 Claude 구독 사용량 가드다.
  const allCandidates = candidates ?? loadCandidates({ root, mediaRoot });
  const selected = dryRun ? allCandidates.slice(0, Math.min(NIGHTLY_LIMIT, limit)) : allCandidates;
  const summary = { candidates: allCandidates.length, selected: Math.min(selected.length, NIGHTLY_LIMIT, limit), written: 0,
    failed: [], deferred: [], cooldown: false, timedOut: false };
  if (!selected.length && !dryRun) return summary;
  if (!dryRun && quota()) return { ...summary, cooldown: true };
  const registry = registryText ?? readFileSync(join(root, VAULT_REL.registryFile), 'utf8');
  requireRegistryFields(registry);
  const activeRules = rules ?? parseRegistry(registry);
  const activeCriteria = criteria ?? loadEmotionCriteria();
  const agent = engine === 'claude' ? charter ?? loadAgent('athena', { fallbackModel: 'sonnet' }) : null;
  // 판단 기록: 어느 엔진·모델·기준·프롬프트 판으로 판단했나(구슬 색인 행과 runs.jsonl에 남김).
  const version = { engine, model: engine === 'ollama' ? OLLAMA_MODELS.vision : agent.model,
    criteriaRef: activeCriteria.ref ?? null, promptVersion: PROMPT_VERSION };
  const decide = judge ?? (engine === 'ollama' ? ollamaPhotoDecision({ criteria: activeCriteria, output, ...(invoke ? { invoke } : {}), ...(readImage ? { readImage } : {}) })
    : (prompt, cwd, timeoutMs) => runHeadlessClaude(prompt, agent.model, `Read(/${cwd}/**)`, {
      appendSystemPrompt: agent.systemPrompt, lean: true, tools: 'Read', cwd, timeoutMs, maxTurns: 2,
    }));
  const runId = `${new Date(runStarted).toISOString().replace(/[:.]/g, '-')}-${process.pid}`;
  const copyDir = join(out, 'copies', runId);
  const logPath = join(out, 'runs.jsonl');
  const matchesPath = MEDIA_FACES_PATHS.matches;
  const scoreById = photoScores ?? new Map();
  if (!photoScores && existsSync(matchesPath)) for (const line of readFileSync(matchesPath, 'utf8').split('\n').slice(0, -1).filter(Boolean)) {
    const face = JSON.parse(line);
    if (face.person === '미네' || face.label === 'mine' && !face.person) {
      scoreById.set(face.id, Math.max(scoreById.get(face.id) ?? 0, Number(face.score) || 0));
    }
  }
  const visionById = visionRows ?? new Map();
  const visionPath = join(root, VAULT_REL.mediaVisionIndex);
  if (!visionRows && existsSync(visionPath)) for (const line of readFileSync(visionPath, 'utf8').split('\n').slice(0, -1).filter(Boolean)) {
    const row = JSON.parse(line); visionById.set(row.id, row);
  }
  if (dryRun) {
    output.log(`사진 기억 구슬 후보 ${summary.candidates}개; 오늘 상한 ${NIGHTLY_LIMIT}개; 읽기 전용 dry-run`);
    for (const item of selected) {
      try {
        const current = readFileSync(join(root, item.rel), 'utf8');
        if (hasOrb(parseFrontmatter(current))) throw new Error('이미 구슬 기록됨');
        if (current !== item.content) throw new Error('선정 뒤 노트가 바뀜');
        if (item.fields.mineAge == null && mineAge(item.fields.occurred) == null) throw new Error('미네 나이 계산 불가');
        const chosen = choosePhotos(item, scoreById, visionById);
        if (!chosen.length) throw new Error('대표 사진 없음');
        for (const photo of chosen) if (!existsSync(resolve(mediaRoot, photo.path))) {
          throw new Error(`대표 사진 원본 없음: ${photo.path}`);
        }
        buildPrompt(item, [{ path: join(copyDir, `${item.id}-grid.jpg`),
          reason: chosen.map((photo, index) => `${index + 1}번 ${photo.reason}`).join('; ') }], activeCriteria, { engine });
        output.log(`${item.id} ${item.title} 점수 ${item.score ?? 0}: ${(item.reasons ?? []).map((reason) => `${reason.signal}(${reason.evidence})`).join('; ')}`);
      } catch (error) {
        summary.failed.push({ id: item.id, reason: error.message });
        output.error(`${item.id}: dry-run 사전 검사 실패: ${error.message}`);
      }
    }
    return summary;
  }
  mkdirSync(out, { recursive: true, mode: 0o700 });
  // A job lock outside the vault prevents duplicate launches. Per-note locks protect
  // a concurrent media pipeline's edits while we apply the one-shot frontmatter patch.
  const job = withLock(logPath, async () => {
    const attempts = attemptState(readRuns(logPath), now());
    let attemptedThisRun = 0;
    for (const item of selected) {
      if (now() - runStarted >= MAX_JOB_MS) {
        summary.timedOut = true;
        summary.deferred.push({ id: item.id, reason: '잡 시간 상한' });
        logRow(logPath, { runId, id: item.id, rel: item.rel, status: 'deferred', ...version,
          error: '잡 시간 상한', at: new Date(now()).toISOString() });
        break;
      }
      if (quota()) {
        summary.cooldown = true;
        summary.deferred.push({ id: item.id, reason: '쿨다운 활성' });
        logRow(logPath, { runId, id: item.id, rel: item.rel, status: 'deferred', ...version,
          error: '쿨다운 활성', at: new Date(now()).toISOString() });
        break;
      }
      if (attempts.count >= Math.min(NIGHTLY_LIMIT, limit) || attemptedThisRun >= Math.min(NIGHTLY_LIMIT, limit)) break;
      if (attempts.reserved.has(item.id) || (attempts.failed.get(item.id) ?? 0) >= 2) continue;
      let measured;
      try {
        const current = readFileSync(join(root, item.rel), 'utf8');
        if (hasOrb(parseFrontmatter(current))) continue;
        if (current !== item.content) throw new Error('선정 뒤 노트가 바뀜');
        if (item.fields.mineAge == null && mineAge(item.fields.occurred) == null) throw new Error('미네 나이 계산 불가');
        const chosen = choosePhotos(item, scoreById, visionById);
        if (!chosen.length) throw new Error('대표 사진 없음');
        mkdirSync(copyDir, { recursive: true, mode: 0o700 });
        const copies = [];
        for (const [index, photo] of chosen.entries()) {
          if (now() - runStarted >= MAX_JOB_MS) throw new Error('잡 시간 상한');
          const path = join(copyDir, `${item.id}-${index + 1}.jpg`);
          copyPhoto(resolve(mediaRoot, photo.path), path, undefined, undefined, Math.max(1, MAX_JOB_MS - (now() - runStarted)));
          copies.push({ path, sourcePath: photo.path, reason: photo.reason });
        }
        const gridPath = join(copyDir, `${item.id}-grid.jpg`);
        if (now() - runStarted >= MAX_JOB_MS) throw new Error('잡 시간 상한');
        gridPhoto(copies, gridPath, undefined, undefined, Math.max(1, MAX_JOB_MS - (now() - runStarted)));
        const prompt = buildPrompt(item, [{ path: gridPath, reason: copies.map((copy, index) => `${index + 1}번 ${copy.reason}`).join('; ') }], activeCriteria, { engine });
        if (now() - runStarted >= MAX_JOB_MS) throw new Error('잡 시간 상한');
        const latestAttempts = attemptState(readRuns(logPath), now());
        if (latestAttempts.count >= Math.min(NIGHTLY_LIMIT, limit) || latestAttempts.reserved.has(item.id)) break;
        logRow(logPath, { runId, id: item.id, rel: item.rel, status: 'reserved', kstDate: kstDay(now()), ...version,
          at: new Date(now()).toISOString() });
        attempts.count += 1;
        attempts.reserved.add(item.id);
        attemptedThisRun += 1;
        const answer = await decide(prompt, copyDir, Math.min(MAX_CALL_MS, MAX_JOB_MS - (now() - runStarted)),
          { imagePath: gridPath, recordDate: item.date ?? occurredDate(item.fields.occurred) });
        measured = engine === 'ollama' ? answer : parseClaudeResult(answer);
        const owner = ownerEmotions(item.fields, item.memo);
        const proposal = validateProposal(measured.result, owner, item.fields.primaryEmotion, item.date, activeCriteria);
        const raw = typeof measured.result === 'string' ? parseJsonBlock(measured.result) : measured.result;
        const scores = validScores(raw?.scores, activeCriteria);
        const absolute = join(root, item.rel);
        const result = await withLock(absolute, () => {
          const latest = readFileSync(absolute, 'utf8');
          if (latest !== item.content) throw new Error('판단 중 노트가 바뀜');
          const next = applyOrbFields(latest, proposal, copies);
          if (!next) return 'already-written';
          const problems = checkNote(item.rel, next, activeRules);
          if (problems.length) throw new Error(`쓰기 관문: ${problems.join('; ')}`);
          // Persist the external scene first: a successful note must never lack its orb.
          // If the note write fails, the still-unprocessed candidate can replace this row on retry.
          const indexPath = join(out, 'orbs.jsonl');
          const previousIndex = upsertOrbIndex(indexPath, {
            id: item.id, rel: item.rel, orbScene: proposal.scene,
            orbTitleSuggestion: proposal.titleSuggestion,
            representativePhotos: copies.map((copy) => copy.sourcePath),
            representativePhotoEvidence: copies.map((copy) => copy.reason),
            coreMemoryReason: proposal.coreMemoryCandidate.reason,
            judgment: { ...version, ...(scores ? { scores } : {}), at: new Date(now()).toISOString() },
          });
          try {
            write(absolute, next);
          } catch (error) {
            // A write that actually committed despite throwing must keep its index row.
            if (readFileSync(absolute, 'utf8') === latest) replaceOrbIndex(indexPath, previousIndex);
            throw error;
          }
          return 'written';
        });
        if (result === 'written') summary.written += 1;
        logRow(logPath, { runId, id: item.id, rel: item.rel, status: result, ...version,
          inputTokens: measured.inputTokens, outputTokens: measured.outputTokens,
          usage: measured.usage, total_cost_usd: measured.total_cost_usd, at: new Date(now()).toISOString() });
        for (const copy of copies) rmSync(copy.path, { force: true });
        rmSync(gridPath, { force: true });
      } catch (error) {
        // Ollama가 멈추면(unavailable) 한도와 같이 연기하고 그 회차를 끝낸다. 형식 실패는 실패로 세어 2회면 14일 보류.
        const deferred = error.isLimit || error.unavailable || error.message === '잡 시간 상한';
        summary[deferred ? 'deferred' : 'failed'].push({ id: item.id, reason: error.message });
        logRow(logPath, { runId, id: item.id, rel: item.rel, status: deferred ? 'deferred' : 'error', error: error.message, ...version,
          ...(error.formatFailure ? { formatFailure: true } : {}),
          ...((measured || error.usage) ? { usage: measured?.usage ?? error.usage,
            inputTokens: measured?.inputTokens ?? (Number(error.usage?.input_tokens) || 0)
              + (Number(error.usage?.cache_creation_input_tokens) || 0)
              + (Number(error.usage?.cache_read_input_tokens) || 0),
            outputTokens: measured?.outputTokens ?? (Number(error.usage?.output_tokens) || 0),
            total_cost_usd: measured?.total_cost_usd ?? (Number(error.total_cost_usd) || 0) } : {}),
          at: new Date(now()).toISOString() });
        if (deferred) output.log(`${item.id}: 연기됨: ${error.message}`);
        else {
          output.error(`${item.id}: ${error.message}`);
          attempts.failed.set(item.id, (attempts.failed.get(item.id) ?? 0) + 1);
        }
        if (error.message === '잡 시간 상한') { summary.timedOut = true; break; }
        if (error.isLimit) { summary.cooldown = true; break; }
        if (error.unavailable) { summary.unavailable = true; break; }
      }
    }
    if (!summary.failed.length) rmSync(copyDir, { recursive: true, force: true });
    output.log(`[media-memory-orb] ${engine} 후보 ${summary.candidates}, 시도 ${attemptedThisRun}, 기록 ${summary.written}, 부분 실패 ${summary.failed.length}, 쿨다운 ${summary.cooldown}, 시간 상한 ${summary.timedOut}${summary.unavailable ? ', Ollama 멈춤' : ''}`);
    return summary;
  }, { retries: 0 });
  // 16GB라 다음 잡(텍스트 모델)이 올라오기 전에 내린다. 시험 주입(judge)이면 부르지 않는다.
  // 불변식: 두 판단 잡(텍스트·이미지 모델)은 같은 시각에 돌지 않는다 — 매일 켤 때(6단계) 시각을 나눠 등록한다.
  if (engine !== 'ollama' || judge) return job;
  return job.finally(() => unload(OLLAMA_MODELS.vision).catch((error) => output.error(`[media-memory-orb] 모델 내리기 실패: ${error.message}`)));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== '--dry-run' && !/^--engine=(claude|ollama)$/.test(arg))) {
    console.error('usage: media-memory-orb.mjs [--engine=claude|ollama] [--dry-run]'); process.exitCode = 2;
  } else run({ dryRun: args.includes('--dry-run'), engine: args.find((arg) => arg.startsWith('--engine='))?.slice(9) ?? 'claude' })
    .then((summary) => { if (summary.unavailable) process.exitCode = 1; })
    .catch((error) => { console.error(error.stack); process.exitCode = 1; });
}
