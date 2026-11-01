#!/usr/bin/env node
/**
 * 미네 사진 글 판단 평가(2026-11-01 오너 결정 "로컬은 장면 낱말, 감정은 Claude", scripts/lib/mine-photo-scene.mjs).
 *
 * 사진 검수 시트(mine-photo-review-sheet.mjs)의 번호표 카드마다 장면 낱말(Ollama, 이 맥 안) → Claude 감정 판단(글만)을 돌려
 * `model-answers-<판>-<시트 판>.jsonl`을 쓴다. 한 줄 { no, photoId, title, state, primaryEmotion, intensity, … } —
 * `mine-photo-review-sheet.mjs --compare <오너 답> <번호표> <이 파일>`이 읽는다. 두 답이 다르면(애매함) error 줄로 남겨
 * 대조에서 빠진다(오너 질문 대상).
 *
 * 카드는 사진 한 장이다(시트가 사진 한 장씩 묻는다). 그래서 순간 하나 = 그 카드 사진 한 장 + 시트를 만든 때의 순간 노트
 * 사본(photo-moments-*.json)으로 잡과 같은 판단 함수(judgeSceneMoment)를 부른다. 사진 종류·미네 얼굴 위치는 번호표 값을 쓴다.
 * 표정을 읽을 수 없는 카드(멀리서·가려짐, 마스크로 정정된 것 포함)는 감정이 코드로 모름이라 Claude를 부르지 않는다
 * (잡은 중요도를 받으려 한 번 묻지만 평가에는 감정만 쓴다).
 *
 * 단계(--stage, 기본 all = anchors → scene → judge). 모두 이어 하기가 된다 — 끝난 사진·카드는 다시 하지 않는다.
 *   anchors: 기준 예시 사진(결정 §10의 사진 행)의 장면 낱말 → Media/MemoryOrb/anchors/photo-anchor-scenes-<판>.json.
 *            Claude 프롬프트의 사진 기준 예시를 사진 대신 이 글로 보여 준다(없으면 사진 기준 예시를 뺀다).
 *   scene:   카드마다 장면 낱말 → 시트 폴더 photo-scenes-<판>-<시트 판>.jsonl(Claude 재판단 때 사진을 다시 보지 않는다).
 *   judge:   Claude 두 번(athena 헌장, 도구 없음·한 턴·빈 임시 cwd). 매 호출 전 쿨다운·06:20~07:30 가드, 하루 상한은
 *            잡과 같은 판단 기록(Media/MemoryOrb/photo-text-judgments.jsonl, mode review)으로 센다. --max-calls로 이번 회차를 더 줄인다.
 * 볼트는 읽기만 한다(기준 예시 사진 경로·얼굴 색인). 텔레그램은 보내지 않는다.
 *
 * 사용:
 *   node scripts/tools/mine-photo-scene-eval.mjs <photo-cards-*.json> [--stage=anchors|scene|judge|all] [--max-calls=N] [--limit=N] [--ignore-window] [--dry-run]
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, appendFileSync, chmodSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VAULT_PATHS, VAULT_REL, MEDIA_FACES_PATHS } from '../lib/vault-paths.mjs';
import { cooldownActive } from '../lib/quota-cooldown.mjs';
import { loadAgent } from '../lib/agent-loader.mjs';
import { loadEmotionCriteria } from '../lib/mine-emotion-criteria.mjs';
import { loadEmotionAnchors } from '../lib/mine-judgment-prompt.mjs';
import { appendJudgment, readJudgments } from '../lib/mine-judgment.mjs';
import { OLLAMA_MODELS, unloadOllamaModel } from '../lib/ollama-client.mjs';
import { faceBoxText, loadMineFaces } from '../lib/mine-record-input.mjs';
import { loadPhotoFaces, photoKind } from '../lib/mine-photo-kind.mjs';
import { BLOCKED_WINDOW, DAILY_PHOTO_TEXT_CALLS, PHOTO_TEXT_JUDGMENTS_FILE, PHOTO_TEXT_PROMPT_VERSION, SCENE_PROMPT_VERSION, anchorScenesPath,
  effectiveKind, extractScene, faceEmotionUnknown, inBlockedWindow, kstDay, photoTextRoom, promptSlug } from '../lib/mine-photo-scene.mjs';
import { CLAUDE_RUNS, mineAge, restrictedDecision } from '../jobs/mine-athena-fields.mjs';
import { OLLAMA_CALL_MS, RUN_ROOT, judgeSceneMoment, loadAnchorScenes } from '../jobs/media-memory-orb.mjs';
import { makeCopy } from './media-memory-orb-trial.mjs';
import { ANCHOR_ROOT } from './mine-anchor-trial.mjs';
import { fileStamp } from './mine-photo-review-sheet.mjs';

export const STAGES = Object.freeze(['anchors', 'scene', 'judge', 'all']);
// 같은 카드가 장면 낱말·Claude 형식 실패를 이만큼 하면 이 판에서는 다시 묻지 않는다(잡의 2회 실패 보류와 같은 뜻).
export const MAX_FAILURES = 2;

export const scenesFileFor = (dir, stamp) => join(dir, `photo-scenes-${promptSlug(SCENE_PROMPT_VERSION)}-${stamp}.jsonl`);
export const answersFileFor = (dir, stamp) => join(dir, `model-answers-${promptSlug(PHOTO_TEXT_PROMPT_VERSION)}-${stamp}.jsonl`);

function jsonLines(path) {
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, 'utf8').split('\n');
  if (lines.at(-1) !== '') lines.pop(); // 끝 줄이 덜 쓰였으면 버린다
  return lines.filter(Boolean).map((line) => JSON.parse(line));
}
function appendRow(path, row) {
  appendFileSync(path, `${JSON.stringify(row)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

// 카드별 상태: 끝남(성공 줄) · 실패 횟수. 줄의 사진 id가 번호표와 다르면 다른 시트 줄이라 오류.
export function progress(rows, cards, { done }) {
  const byNo = new Map(cards.map((card) => [card.no, card]));
  const finished = new Map(); const failures = new Map();
  for (const row of rows) {
    const card = byNo.get(row.no);
    if (!card || card.photoId !== row.photoId) throw new Error(`${row.no}번 줄의 사진이 번호표와 다름 — 다른 시트 판의 파일인지 확인`);
    if (done(row)) finished.set(row.no, row);
    else failures.set(row.no, (failures.get(row.no) ?? 0) + 1);
  }
  return { finished, failures };
}

// 모델 답 한 줄(검수 시트 --compare가 읽는 모양 + 감사용 칸).
export function answerLine(card, judged, { forcedKind } = {}) {
  const base = { no: card.no, photoId: card.photoId, title: card.title, promptVersion: PHOTO_TEXT_PROMPT_VERSION, sceneVersion: SCENE_PROMPT_VERSION,
    photoKind: forcedKind?.kind ?? null, kindCorrected: Boolean(forcedKind?.corrected), calls: judged?.calls ?? 0 };
  if (!judged) return { ...base, state: '모름', primaryEmotion: null, intensity: null, emotions: [], forcedUnknown: true };
  const key = (answer) => ({ state: answer.emotionState, primaryEmotion: answer.fields.primaryEmotion, intensity: answer.fields.emotionIntensity });
  if (judged.ambiguous) return { ...base, error: '애매함', ambiguous: true, answers: judged.answers.map(key) };
  if (judged.error) return { ...base, error: judged.error, ...(judged.formatFailure ? { formatFailure: true } : {}), ...(judged.deferred ? { deferred: true } : {}) };
  return { ...base, ...key(judged), emotions: judged.fields.emotions, evidence: judged.fields.emotionEvidence, nearestAnchor: judged.nearestAnchor ?? null,
    ...(judged.answers ? { answers: judged.answers.map(key) } : {}) };
}

// 기준 예시 사진(결정 §10 사진 행) → 사진 id. 기록 칸이 "사진 <id>, 날짜 …".
export function anchorPhotoIds(anchors) {
  return anchors.flatMap((anchor) => {
    const id = anchor.record.match(/^사진 ([a-f0-9]{16}),/)?.[1];
    return id ? [{ anchorId: anchor.id, photoId: id, date: anchor.record.match(/(\d{4}-\d{2}-\d{2})/)?.[1] ?? null }] : [];
  });
}

const ageOn = (date) => (date ? mineAge(`${date}T12:00:00+09:00`) : null);

async function sceneFor({ source, target, age, kind, kindReason, face, copyPhoto, readImage, invoke, output }) {
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  try {
    const size = copyPhoto(source, target);
    const started = Date.now();
    const { scene, usage } = await extractScene({ image: readImage(target), age, kind: kind(size)?.kind ?? null, kindReason: kind(size)?.reason ?? null,
      face: face(size), ...(invoke ? { invoke } : {}), timeoutMs: OLLAMA_CALL_MS, usageLogger: (line) => output.log(`[photo-scene-eval] ${line}`) });
    return { scene, usage, size, seconds: Math.round((Date.now() - started) / 1000) };
  } finally {
    rmSync(target, { force: true });
  }
}

export async function run({ cardsPath, stage = 'all', maxCalls = DAILY_PHOTO_TEXT_CALLS, limit = Infinity, ignoreWindow = false, dryRun = false,
  root = VAULT_PATHS.root, mediaRoot = MEDIA_FACES_PATHS.mediaRoot, anchorRoot = ANCHOR_ROOT, ledgerPath = join(RUN_ROOT, PHOTO_TEXT_JUDGMENTS_FILE),
  now = () => Date.now(), cooldown = cooldownActive, invoke, judge, copyPhoto = makeCopy, readImage = (path) => readFileSync(path).toString('base64'),
  criteria = loadEmotionCriteria(), anchors = loadEmotionAnchors(), charter, unload = unloadOllamaModel, output = console } = {}) {
  if (!STAGES.includes(stage)) throw new Error(`--stage는 ${STAGES.join('|')} 중 하나`);
  const stamp = fileStamp(cardsPath, 'photo-cards');
  if (!stamp) throw new Error(`번호표 이름이 photo-cards-<판>.json이 아님: ${basename(cardsPath)}`);
  const dir = dirname(resolve(cardsPath));
  // limit은 이번에 할 카드 수에만 건다 — 이어 하기 대조(progress)는 번호표 전체로(리뷰 2026-11-01).
  const cards = JSON.parse(readFileSync(cardsPath, 'utf8'));
  const moments = JSON.parse(readFileSync(join(dir, `photo-moments-${stamp}.json`), 'utf8'));
  const scenesPath = scenesFileFor(dir, stamp);
  const answersPath = answersFileFor(dir, stamp);
  const anchorPath = anchorScenesPath(anchorRoot);
  const blocked = () => !ignoreWindow && inBlockedWindow(now());
  const summary = { stage, cards: cards.length, anchorScenes: 0, scenes: 0, sceneFailures: 0, judged: 0, forced: 0, ambiguous: 0, judgeFailures: 0,
    calls: 0, skipped: 0, capped: false, cooldown: false, blockedWindow: false, scenesPath, answersPath, anchorPath };
  if (!dryRun && blocked()) {
    output.error(`[photo-scene-eval] ${BLOCKED_WINDOW.text}(KST)은 mine-athena-fields 회차 시간 — 돌리지 않음(--ignore-window로 무시)`);
    return { ...summary, blockedWindow: true };
  }
  const want = (name) => stage === 'all' || stage === name;
  const copyDir = join(dir, 'scene-copies');
  let ollamaUsed = false;
  try {
    // 1) 기준 예시 사진의 장면 낱말
    if (want('anchors')) {
      const targets = anchorPhotoIds(anchors);
      const saved = existsSync(anchorPath) ? JSON.parse(readFileSync(anchorPath, 'utf8')) : {};
      const missing = targets.filter((target) => saved[target.photoId]?.sceneVersion !== SCENE_PROMPT_VERSION);
      output.log(`[photo-scene-eval] 기준 예시 사진 ${targets.length}장 중 장면 낱말 없음 ${missing.length}장`);
      if (missing.length && !dryRun) {
        const media = new Map([...jsonLines(join(root, VAULT_REL.mediaArchiveIndex)), ...jsonLines(join(root, VAULT_REL.mediaImportsIndex))].map((row) => [row.id, row]));
        const ids = missing.map((target) => target.photoId);
        const allFaces = loadPhotoFaces({ ids }); const mine = loadMineFaces({ ids });
        for (const target of missing) {
          const record = media.get(target.photoId);
          const path = record?.archivePath ?? record?.importPath;
          if (!path) { output.error(`[photo-scene-eval] 기준 예시 ${target.anchorId}: 미디어 색인에 사진 없음`); continue; }
          const face = mine.get(target.photoId);
          const kindOf = (size) => photoKind({ analyzed: allFaces.has(target.photoId), faces: allFaces.get(target.photoId) ?? [], mineIndex: face?.i, size });
          try {
            ollamaUsed = true;
            const result = await sceneFor({ source: resolve(mediaRoot, path), target: join(copyDir, `anchor-${target.photoId}.jpg`), age: ageOn(target.date),
              kind: kindOf, face: (size) => faceBoxText(face?.bbox, size), copyPhoto, readImage, invoke, output });
            const kind = kindOf(result.size);
            saved[target.photoId] = { anchorId: target.anchorId, sceneVersion: SCENE_PROMPT_VERSION, model: OLLAMA_MODELS.vision,
              ...effectiveKind(kind?.kind ?? null, result.scene, kind?.reason ?? null), scene: result.scene, seconds: result.seconds, at: new Date(now()).toISOString() };
            mkdirSync(dirname(anchorPath), { recursive: true, mode: 0o700 });
            writeFileSync(anchorPath, `${JSON.stringify(saved, null, 1)}\n`, { mode: 0o600 });
            summary.anchorScenes += 1;
            output.log(`[photo-scene-eval] 기준 예시 ${target.anchorId}: ${saved[target.photoId].kind ?? '종류 없음'} (${result.seconds}초)`);
          } catch (error) {
            if (error.unavailable) throw error;
            output.error(`[photo-scene-eval] 기준 예시 ${target.anchorId}: ${error.message}`);
          }
        }
      }
    }

    // 2) 카드마다 장면 낱말
    if (want('scene')) {
      const { finished, failures } = progress(jsonLines(scenesPath), cards, { done: (row) => Boolean(row.scene) && row.sceneVersion === SCENE_PROMPT_VERSION });
      const todo = cards.filter((card) => !finished.has(card.no) && (failures.get(card.no) ?? 0) < MAX_FAILURES).slice(0, limit);
      output.log(`[photo-scene-eval] 장면 낱말: 카드 ${cards.length}장 중 끝남 ${finished.size}, 할 것 ${todo.length}${dryRun ? ' (dry-run — 호출 없음)' : ''}`);
      if (!dryRun) for (const card of todo) {
        const moment = moments[card.momentId];
        try {
          ollamaUsed = true;
          const result = await sceneFor({ source: resolve(mediaRoot, card.path), target: join(copyDir, `${card.no}.jpg`), age: ageOn(card.date),
            kind: () => (card.kind ? { kind: card.kind, reason: card.kindReason } : null), face: () => faceBoxText(card.mineBox, card.size),
            copyPhoto, readImage, invoke, output });
          appendRow(scenesPath, { no: card.no, photoId: card.photoId, title: card.title, momentId: moment?.id ?? card.momentId, sceneVersion: SCENE_PROMPT_VERSION,
            model: OLLAMA_MODELS.vision, kind: card.kind ?? null, scene: result.scene, seconds: result.seconds, usage: result.usage, at: new Date(now()).toISOString() });
          summary.scenes += 1;
          output.log(`[photo-scene-eval] #${card.no} 장면 낱말 (${result.seconds}초)`);
        } catch (error) {
          if (error.unavailable) throw error;
          summary.sceneFailures += 1;
          appendRow(scenesPath, { no: card.no, photoId: card.photoId, title: card.title, sceneVersion: SCENE_PROMPT_VERSION, error: error.message,
            ...(error.formatFailure ? { formatFailure: true } : {}), at: new Date(now()).toISOString() });
          output.error(`[photo-scene-eval] #${card.no} 장면 낱말 실패: ${error.message}`);
        }
      }
    }
  } finally {
    if (ollamaUsed && !invoke) await unload(OLLAMA_MODELS.vision).catch((error) => output.error(`[photo-scene-eval] 모델 내리기 실패: ${error.message}`));
    rmSync(copyDir, { recursive: true, force: true });
  }

  // 3) Claude 감정 판단(글만)
  if (want('judge')) {
    const sceneRows = new Map(jsonLines(scenesPath).filter((row) => row.scene && row.sceneVersion === SCENE_PROMPT_VERSION).map((row) => [row.no, row]));
    const { finished, failures } = progress(jsonLines(answersPath), cards, { done: (row) => !row.error || row.ambiguous });
    const anchorScenes = loadAnchorScenes(anchorPath);
    const agent = charter ?? loadAgent('athena', { fallbackModel: 'sonnet' });
    const version = { engine: 'claude', model: agent.model, criteriaRef: criteria.ref ?? null, promptVersion: PHOTO_TEXT_PROMPT_VERSION,
      sceneEngine: 'ollama', sceneModel: OLLAMA_MODELS.vision, scenePromptVersion: SCENE_PROMPT_VERSION };
    const decide = judge ?? ((prompt) => restrictedDecision(prompt, agent, { output }));
    const quota = () => cooldown() || blocked();
    const todo = cards.filter((card) => !finished.has(card.no) && (failures.get(card.no) ?? 0) < MAX_FAILURES).slice(0, limit);
    const noScene = todo.filter((card) => !sceneRows.has(card.no));
    output.log(`[photo-scene-eval] Claude 판단: 카드 ${cards.length}장 중 끝남 ${finished.size}, 할 것 ${todo.length}(장면 낱말 없음 ${noScene.length} 건너뜀), `
      + `기준 예시 사진 장면 낱말 ${Object.keys(anchorScenes).length}개, 오늘 남은 호출 ${photoTextRoom(readJudgments(ledgerPath), now())}번${dryRun ? ' (dry-run — 호출 없음)' : ''}`);
    summary.skipped = noScene.length;
    for (const card of todo) {
      const sceneRow = sceneRows.get(card.no);
      if (!sceneRow) continue;
      const moment = moments[card.momentId];
      if (!moment) { output.error(`[photo-scene-eval] #${card.no}: 순간 노트 사본 없음`); continue; }
      const photo = { kind: card.kind ?? null, kindReason: card.kindReason ?? null, face: faceBoxText(card.mineBox, card.size), scene: sceneRow.scene };
      Object.assign(photo, effectiveKind(photo.kind, photo.scene, photo.kindReason));
      const item = { id: moment.id, rel: moment.rel, date: moment.date, fields: moment.fields, memo: moment.memo ?? '', album: moment.album ?? null };
      // 표정을 읽을 수 없는 카드: 감정은 코드가 모름(Claude 부르지 않음).
      if (faceEmotionUnknown([photo.kind])) {
        if (!dryRun) appendRow(answersPath, answerLine(card, null, { forcedKind: photo }));
        summary.forced += 1;
        continue;
      }
      if (dryRun) continue;
      const room = Math.min(maxCalls - summary.calls, photoTextRoom(readJudgments(ledgerPath), now()));
      if (room < CLAUDE_RUNS) { summary.capped = true; output.log(`[photo-scene-eval] 호출 상한(이번 ${maxCalls}·하루 ${DAILY_PHOTO_TEXT_CALLS}) — 여기서 멈춤, 다시 돌리면 이어서`); break; }
      if (quota()) { summary[blocked() ? 'blockedWindow' : 'cooldown'] = true; break; }
      const judged = await judgeSceneMoment(item, [photo], { criteria, anchors, anchorScenes, decide, quota });
      summary.calls += judged.calls ?? 0;
      if (judged.calls) {
        appendJudgment(ledgerPath, { mode: 'review', sheet: stamp, no: card.no, photoId: card.photoId, at: kstDay(now()), ...version, calls: judged.calls,
          status: judged.ambiguous ? 'ambiguous' : judged.error ? 'retry' : 'judged', photoKinds: [photo.kind], kindCorrected: [Boolean(photo.corrected)],
          redactions: judged.built.redactions, photoAnchors: judged.built.photoAnchorsUsed.length, ...(judged.error ? { reason: judged.error } : {}) });
      }
      if (judged.deferred) { summary[blocked() ? 'blockedWindow' : judged.cooldown ? 'cooldown' : 'capped'] = true; break; }
      if (judged.error && cooldown()) { summary.cooldown = true; break; }
      appendRow(answersPath, answerLine(card, judged, { forcedKind: photo }));
      if (judged.ambiguous) summary.ambiguous += 1;
      else if (judged.error) { summary.judgeFailures += 1; output.error(`[photo-scene-eval] #${card.no} 판단 실패: ${judged.error}`); }
      else summary.judged += 1;
      output.log(`[photo-scene-eval] #${card.no} ${judged.ambiguous ? '애매함' : judged.error ? '실패' : `${judged.emotionState}${judged.fields.primaryEmotion ? ` ${judged.fields.primaryEmotion} ${judged.fields.emotionIntensity}` : ''}`} (호출 ${judged.calls})`);
    }
  }
  output.log(`[photo-scene-eval] ${JSON.stringify(summary)}`);
  return summary;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const args = process.argv.slice(2);
  const cardsPath = args.find((arg) => !arg.startsWith('--'));
  const value = (name) => args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
  const valid = args.every((arg) => !arg.startsWith('--') || ['--dry-run', '--ignore-window'].includes(arg)
    || /^--stage=(anchors|scene|judge|all)$/.test(arg) || /^--(max-calls|limit)=\d+$/.test(arg));
  if (!cardsPath || !valid || args.filter((arg) => !arg.startsWith('--')).length !== 1) {
    console.error('사용: node scripts/tools/mine-photo-scene-eval.mjs <photo-cards-*.json> [--stage=anchors|scene|judge|all] [--max-calls=N] [--limit=N] [--ignore-window] [--dry-run]');
    process.exitCode = 2;
  } else {
    run({ cardsPath, stage: value('stage') ?? 'all', dryRun: args.includes('--dry-run'), ignoreWindow: args.includes('--ignore-window'),
      ...(value('max-calls') ? { maxCalls: Number(value('max-calls')) } : {}), ...(value('limit') ? { limit: Number(value('limit')) } : {}) })
      .catch((error) => { console.error(`[photo-scene-eval] 실패: ${error.message}`); process.exitCode = 1; });
  }
}
