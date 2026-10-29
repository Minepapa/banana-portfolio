#!/usr/bin/env node
/**
 * 미네 판단 1단계 ⑤: 기준 예시(앵커) 시험 — 로컬 모델(Ollama)로 오너가 확정한 기준 예시를 판단해 보고
 * 정답과 맞춰 본다. 볼트·노트·판단 기록은 쓰지 않고, 결과는 볼트 밖 `Media/MemoryOrb/trial-anchors/`에만 남긴다.
 *
 * 왜(기억 판단 체계 §15.3 1단계 ⑤, 2026-10-29 오너 "1번부터 이어서"): 2단계 프롬프트를 다듬으려면
 * 기준 예시(시트 48개, §10 표 34행)로 첫 수치를 내야 한다. 기준 예시를 프롬프트에 넣으면 시험하는 그 예시가
 * 정답지로 새므로, 잡의 Ollama 프롬프트가 넣는 결정 문서 §10 표에서 시험 대상과 **같은 날짜의 예시를 모두** 빼고 넣는다
 * (같은 날 사진 세 장처럼 형제 예시가 남으면 날짜만 맞춰도 답이 나온다 — 2026-10-29 리뷰 HIGH).
 *
 * 정답이 새는 다른 길(리뷰 HIGH): 감정 기준 본문(§3~§7)에는 기준 예시에서 나온 규칙과 미네 말 원문 인용이
 * 들어 있다(예: "엄마 나한테 전화 안 왔어" → 까칠 1). 잡도 같은 기준을 보므로 그대로 두되, 기준 본문의 따옴표
 * 인용이 노트에 그대로 나오는 항목은 `기준 문장 겹침`으로 표시하고 보고서를 전체/겹침 제외로 나눠 센다.
 * 오너 메모에 감정이 적힌 항목도 `메모 누출 가능`으로 표시한다(지금 시험 노트들은 메모가 비어 있음).
 * 노트 제목에 감정 단어가 든 경우(외로움·속상함)는 잡도 보는 입력이라 표시하지 않는다 — 수치가 다소 후하다.
 *
 * 볼트·노트·판단 기록은 쓰지 않는다. 판단 결과는 trial-anchors에만 쓰고, 소리 근거 캐시(`Media/AudioCues`)는
 * 잡과 같은 공유 캐시를 쓴다(dry-run에서는 소리 분석을 하지 않는다).
 *
 * 판단 경로는 두 잡과 같다 — 같은 프롬프트·답 모양·검증을 다시 쓴다:
 *   - 통화·녹음 → mine-athena-fields의 buildOllamaPrompt(현재 Ollama 판)·ollamaDecision·validateOllamaProposals
 *     (재분류 모양이라 옛 1~5 중요도는 묻지 않는다)
 *   - 사진 → media-memory-orb의 buildPrompt(engine 'ollama')·ollamaPhotoDecision·validateProposal.
 *     오너가 판정한 그 사진 한 장만 세운 사본으로 붙인다. 사진 설명(reason)은 잡과 같은 형식(미네 이름표·얼굴 점수).
 *   - 영상 → 판단 경로가 아직 없다(7단계 영상 구슬). '비교 불가'로 남긴다.
 * 서사적 무게(#39~48)는 지금 프롬프트가 묻지 않아 판단하지 않는다(2단계에서 넣는다).
 *
 * 사용:
 *   node scripts/tools/mine-anchor-trial.mjs --dry-run          # 대상·경로·프롬프트 길이만(모델 호출 없음)
 *   node scripts/tools/mine-anchor-trial.mjs                    # 잡의 현재 Ollama 프롬프트로, 하나 빼고 시험
 *   (0.0 기준선 수치는 2026-10-29 trial-anchors/*-plain·*-anchors 보고서에 남아 있다)
 *   옵션: --only=1,7,34 (시트 번호) · --kind=text|photo
 *   --engine=claude : 통화·녹음만 같은 프롬프트로 Claude에 물어 상한을 잰다(2026-10-29 오너 "Claude로 상한 재기").
 *     사진은 미네 사진을 집 밖으로 보내지 않으므로 '비교 불가'로 둔다. 쿨다운 가드를 지난다.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { VAULT_PATHS, VAULT_REL, MEDIA_FACES_PATHS } from '../lib/vault-paths.mjs';
import { parseFrontmatter } from '../lib/vault-frontmatter.mjs';
import { resolveDecision } from '../lib/decision-resolver.mjs';
import { loadEmotionCriteria } from '../lib/mine-emotion-criteria.mjs';
import { OLLAMA_MODELS, unloadOllamaModel } from '../lib/ollama-client.mjs';
import { loadMineFaces, faceBoxText } from '../lib/mine-record-input.mjs';
import { attachAudioCues } from '../lib/media-audio-cues.mjs';
import { parseJsonBlock } from '../lib/headless-claude.mjs';
import { cooldownActive } from '../lib/quota-cooldown.mjs';
import { loadAgent } from '../lib/agent-loader.mjs';
import { buildOllamaPrompt, restrictedDecision, ollamaDecision, validateOllamaProposals, occurredDate, PROMPT_VERSIONS as TEXT_VERSIONS } from '../jobs/mine-athena-fields.mjs';
import { ollamaPhotoDecision, buildOllamaOrbPrompt, validateOllamaOrb, OLLAMA_CALL_MS, PROMPT_VERSIONS as PHOTO_VERSIONS } from '../jobs/media-memory-orb.mjs';
import { makeCopy } from './media-memory-orb-trial.mjs';
import { parseAnchorTable } from '../lib/mine-judgment-prompt.mjs';

export const ANCHOR_ROOT = join(homedir(), 'Pantheon', 'Media', 'MemoryOrb', 'anchors');
export const ANCHOR_SET = '2026-10-19';
export const TRIAL_ANCHOR_ROOT = join(homedir(), 'Pantheon', 'Media', 'MemoryOrb', 'trial-anchors');
const NO_EMOTION = '감정 없음';
const UNKNOWN = '모름';

// §10 기준 예시 표 파서는 잡과 같이 쓰도록 lib로 옮겼다(mine-judgment-prompt). 테스트 호환으로 다시 내보낸다.
export { parseAnchorTable };

// 시트 항목 + 오너 답 → 시험 대상. route: text(통화·녹음 노트) · photo(사진 한 장) · none(판단 경로 없음/정답 없음)
export function planAnchors(items, answers) {
  return items.map((item) => {
    const answer = answers[String(item.no)] ?? {};
    const base = { no: item.no, group: item.group, kind: item.kind, ref: item.ref ?? '', date: item.date ?? '', answer };
    if (answer.skip) return { ...base, route: 'none', reason: '오너가 예시로 쓰지 않음' };
    if (!answer.emo) return { ...base, route: 'none', reason: answer.nw != null ? '서사적 무게 — 지금 프롬프트가 묻지 않음' : '정답 없음' };
    if (/^20_Records\/.+\.md$/.test(item.ref ?? '')) return { ...base, route: 'text' };
    if (/^photo:[a-f0-9]{16}$/.test(item.ref ?? '')) return { ...base, route: 'photo', photoId: item.ref.slice(6) };
    if (/^video:/.test(item.ref ?? '')) return { ...base, route: 'none', reason: '영상 — 판단 경로 없음(7단계 영상 구슬)' };
    return { ...base, route: 'none', reason: '기록 없음' };
  });
}

// 오너 답과 모델 판단 비교. outcome: 일치 · 감정만 일치(강도 다름) · 근접(대표는 다르나 목록에 있음, 또는 모름을 감정 없음으로) · 불일치 · 비교 불가
export function compareAnswer(answer, fields) {
  if (!fields) return { outcome: '비교 불가', note: '판단 결과 없음' };
  const emotions = fields.emotions ?? [];
  const got = fields.primaryEmotion ? `${fields.primaryEmotion} ${fields.emotionIntensity}` : NO_EMOTION;
  if (answer.emo === NO_EMOTION) return { outcome: emotions.length ? '불일치' : '일치', got };
  if (fields.emotionState === UNKNOWN) {
    return { outcome: answer.emo === UNKNOWN ? '일치' : '불일치', got: UNKNOWN };
  }
  if (answer.emo === UNKNOWN) {
    // 모름 대신 감정 없음으로 답하면 가장 가까운 답이다(둘 다 빈 감정).
    return { outcome: emotions.length ? '불일치' : '근접', got, note: emotions.length ? null : '모름 대신 감정 없음으로 답함' };
  }
  if (fields.primaryEmotion === answer.emo) {
    return answer.int == null || fields.emotionIntensity === answer.int ? { outcome: '일치', got } : { outcome: '감정만 일치', got };
  }
  return { outcome: emotions.includes(answer.emo) ? '근접' : '불일치', got };
}

export const OUTCOMES = Object.freeze(['일치', '감정만 일치', '근접', '불일치', '형식 실패', '시간 초과', '오류', '비교 불가']);

// 기준 본문(§3~§7)의 따옴표 인용 중 노트에 그대로 나오는 것 — 정답이 기준 문장으로 새는 항목 표시용.
// 짧은 인용("싫어" 등)은 우연히 겹치므로 공백 뺀 6자 이상만 본다.
export function criteriaQuotes(criteria) {
  const text = Object.values(criteria.sections ?? {}).join('\n');
  const quotes = [...text.matchAll(/[‘'“"]([^'’"”\n]{4,80})[’'”"]/g)].map((match) => match[1].trim());
  return [...new Set(quotes.filter((quote) => quote.replace(/\s/g, '').length >= 6))];
}

export function quoteOverlap(content, quotes) {
  const squash = (value) => value.replace(/[\s.,!?…~·'"‘’“”]/g, '');
  const body = squash(content);
  return quotes.filter((quote) => body.includes(squash(quote)));
}

// 오너 메모에 감정이 적혀 있거나 정답 감정 이름이 들어 있으면 정답이 메모로 샐 수 있다.
export function memoLeak(memo, answer) {
  if (!memo) return false;
  return /(?:^|\n)\s*(?:감정|느낌)\s*[:：]/.test(memo) || Boolean(answer.emo && memo.includes(answer.emo));
}

export function summarize(rows) {
  const counts = Object.fromEntries(OUTCOMES.map((name) => [name, 0]));
  for (const row of rows) counts[row.outcome] = (counts[row.outcome] ?? 0) + 1;
  const judged = rows.filter((row) => row.route !== 'none' && row.reason !== 'dry-run');
  const hits = (list) => ({ judged: list.length,
    emotionHits: list.filter((row) => ['일치', '감정만 일치'].includes(row.outcome)).length,
    exactHits: list.filter((row) => row.outcome === '일치').length });
  const clean = hits(judged.filter((row) => !row.leaks?.length));
  return { total: rows.length, ...hits(judged), counts, clean };
}

export function renderReport(rows, { label, startedAt, models }) {
  const summary = summarize(rows);
  const answerText = (answer) => answer.emo ? `${answer.emo}${answer.int ? ` ${answer.int}` : ''}` : answer.nw != null ? `서사 ${answer.nw}` : '-';
  return [`# 미네 기준 예시 시험 ${startedAt.slice(0, 16).replace('T', ' ')}`, '',
    `- 프롬프트: ${label}`, `- 모델: ${models.join(', ')}`, `- 기준 예시 묶음: ${ANCHOR_SET}`,
    `- 판단 ${summary.judged}개 / 전체 ${summary.total}개 — 감정 일치 ${summary.emotionHits}개(강도까지 일치 ${summary.exactHits}개)`,
    `- 정답 누출 표시 제외: 판단 ${summary.clean.judged}개 — 감정 일치 ${summary.clean.emotionHits}개(강도까지 일치 ${summary.clean.exactHits}개)`,
    `- 결과별: ${OUTCOMES.map((name) => `${name} ${summary.counts[name]}`).join(' · ')}`,
    '- 누출 표시: 기준 문장 겹침 = 감정 기준 본문의 따옴표 인용이 노트에 그대로 있음 · 메모 누출 가능 = 오너 메모에 감정이 적힘',
    '- 감정 기준 본문에는 기준 예시에서 나온 일반 규칙(노래 부르는 기쁨, 울음 그친 얼굴 등)도 있어, 표시가 없어도 수치가 다소 후하다.', '',
    '| # | 묶음 | 종류 | 정답 | 모델 | 결과 | 누출 | 근거·메모 | 초 |', '|---|---|---|---|---|---|---|---|---|',
    ...rows.map((row) => `| ${row.no} | ${row.group} | ${row.kind || '-'} | ${answerText(row.answer)} | ${row.got ?? '-'} | ${row.outcome} | ${
      (row.leaks ?? []).join(', ')} | ${
      String(row.evidence ?? row.reason ?? row.note ?? '').replace(/\|/g, '/').slice(0, 120)} | ${row.seconds ?? ''} |`),
    ''].join('\n');
}

function jsonLines(path) {
  return existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [];
}

// 사진 id → 그 사진이 든 순간 노트(제목·앨범·오너 메모 등 사건 정보). 순간 노트를 한 번만 훑는다.
function momentsForPhotos(root, photoIds) {
  const wanted = new Set(photoIds);
  const found = new Map();
  const walk = (rel) => readdirSync(join(root, rel), { withFileTypes: true }).flatMap((entry) => {
    const child = `${rel}/${entry.name}`;
    return entry.isDirectory() ? walk(child) : entry.name.endsWith('.md') ? [child] : [];
  });
  for (const rel of walk(VAULT_REL.mediaMoments)) {
    const content = readFileSync(join(root, rel), 'utf8');
    if (![...wanted].some((id) => content.includes(id))) continue;
    const fields = parseFrontmatter(content);
    for (const id of [fields.mediaIds].flat()) {
      if (!wanted.has(id) || found.has(id)) continue;
      found.set(id, { rel, fields, memo: content.split(/^## 오너 메모\s*$/m)[1]?.split(/^## /m)[0]?.trim().slice(0, 2500) ?? '' });
    }
  }
  return found;
}

// 시험 한 행의 판단 실패를 결과 칸으로. 모델 품질(형식 실패)과 인프라(시간 초과·오류)를 나눈다.
function failureOutcome(error) {
  if (error.formatFailure || error.validation) return '형식 실패';
  if (error.timeout) return '시간 초과';
  return '오류';
}

export async function run({ root = VAULT_PATHS.root, mediaRoot = MEDIA_FACES_PATHS.mediaRoot, anchorRoot = ANCHOR_ROOT,
  out = TRIAL_ANCHOR_ROOT, only, kind, dryRun = false, criteria = loadEmotionCriteria(),
  anchorBody, invoke, unload = unloadOllamaModel, cues = attachAudioCues, copyPhoto = makeCopy, mineFaces,
  now = () => Date.now(), output = console, engine = 'ollama', charter, claude, cooldown = cooldownActive } = {}) {
  if (!['ollama', 'claude'].includes(engine)) throw new Error(`판단 엔진은 ollama·claude 중 하나: ${engine}`);
  const items = JSON.parse(readFileSync(join(anchorRoot, `items-${ANCHOR_SET}.json`), 'utf8'));
  const answers = JSON.parse(readFileSync(join(anchorRoot, `anchor-answers-${ANCHOR_SET}.json`), 'utf8'));
  const anchors = parseAnchorTable(anchorBody ?? resolveDecision('미네-감정-분류').body);
  let plan = planAnchors(items, answers);
  if (only) plan = plan.filter((row) => only.includes(row.no));
  if (kind) plan = plan.filter((row) => row.route === kind);
  const startedAt = new Date(now()).toISOString();
  const versions = `${TEXT_VERSIONS.ollama} · ${PHOTO_VERSIONS.ollama}`;
  const runDir = join(out, `${startedAt.replace(/[:.]/g, '-')}-${TEXT_VERSIONS.ollama.split('/').pop()}${engine === 'claude' ? '-claude' : ''}`);
  const agent = engine === 'claude' ? charter ?? loadAgent('athena', { fallbackModel: 'sonnet' }) : null;
  const label = `${versions} (기준 예시 넣음, 시험 대상과 같은 날짜 예시는 뺌)${engine === 'claude'
    ? ` — 같은 텍스트 프롬프트를 Claude(${agent.model})로, 사진은 판단 안 함` : ''}`;
  // 하나 빼고 시험: 잡과 같은 프롬프트에서 시험 대상·같은 날짜 기준 예시만 뺀다.
  const exclude = (row) => ({ excludeNo: row.no, excludeDate: row.date || undefined });
  const quotes = criteriaQuotes(criteria);
  const rows = [];
  const record = (row) => {
    rows.push(row);
    if (!dryRun) appendFileSync(join(runDir, 'results.jsonl'), `${JSON.stringify(row)}\n`, { mode: 0o600 });
  };
  if (!dryRun) mkdirSync(join(runDir, 'prompts'), { recursive: true, mode: 0o700 });
  const savePrompt = (no, prompt) => { if (!dryRun) writeFileSync(join(runDir, 'prompts', `${no}.txt`), prompt, { mode: 0o600 }); };
  for (const row of plan.filter((entry) => entry.route === 'none')) record({ ...row, outcome: '비교 불가' });
  if (engine === 'claude') {
    for (const row of plan.filter((entry) => entry.route === 'photo')) record({ ...row, route: 'none', outcome: '비교 불가', reason: '사진은 Claude로 보내지 않음' });
    plan = plan.filter((entry) => entry.route !== 'photo');
  }

  // Ollama가 멈추면(unavailable) 남은 행을 오류로 적고 부분 보고서를 쓴 뒤 멈춘다.
  let stopped = null;
  const stopRest = (pending, error) => {
    stopped = error;
    for (const row of pending) record({ ...row, outcome: '오류', reason: `Ollama 멈춤: ${error.message}` });
  };

  // 1) 통화·녹음 — 텍스트 모델. 잡과 같은 입력(미네 발화 추림 + 소리 근거).
  const textRows = plan.filter((row) => row.route === 'text');
  if (textRows.length) {
    const decide = engine === 'claude'
      ? (prompt) => (claude ?? ((text) => restrictedDecision(text, agent, { output })))(prompt)
      : ollamaDecision({ criteria, output, ...(invoke ? { invoke } : {}) });
    try {
      for (const [index, row] of textRows.entries()) {
        // Claude 구독 사용량 가드: 쿨다운이면 남은 행을 멈추고 부분 보고서를 쓴다.
        if (engine === 'claude' && !dryRun && cooldown()) {
          for (const rest of textRows.slice(index)) record({ ...rest, outcome: '오류', reason: 'Claude 쿨다운' });
          break;
        }
        const path = join(root, row.ref);
        if (!existsSync(path)) { record({ ...row, outcome: '오류', reason: '노트 없음' }); continue; }
        const content = readFileSync(path, 'utf8');
        const fields = parseFrontmatter(content);
        const item = { rel: row.ref, content, occurred: String(fields.occurred), date: occurredDate(fields.occurred), fields };
        if (!item.date) { record({ ...row, outcome: '오류', reason: '날짜 없음' }); continue; }
        const memo = content.split(/^## 오너 메모\s*$/m)[1]?.split(/^## /m)[0]?.trim() ?? '';
        const leaks = [...(quoteOverlap(content, quotes).length ? ['기준 문장 겹침'] : []), ...(memoLeak(memo, row.answer) ? ['메모 누출 가능'] : [])];
        // dry-run은 소리 분석(파이썬·캐시 쓰기)을 하지 않는다.
        if (dryRun) item.audioCues = { text: '소리 근거: (dry-run 생략)', ok: false };
        else await cues([item], { root });
        const prompt = buildOllamaPrompt([item], { reclassify: true, criteria, anchors, exclude: exclude(row) });
        savePrompt(row.no, prompt);
        if (dryRun) {
          output.log(`#${row.no} 텍스트 ${row.ref.split('/').pop()} — 프롬프트 ${prompt.length}자${leaks.length ? ` (${leaks.join(', ')})` : ''}`);
          record({ ...row, outcome: '비교 불가', reason: 'dry-run', leaks }); continue;
        }
        const started = now();
        try {
          const proposal = validateOllamaProposals(parseJsonBlock(await decide(prompt, { items: [item], reclassify: true })), [item],
            { reclassify: true, criteria }).get(1);
          const seconds = Math.round((now() - started) / 1000);
          if (!proposal?.fields) { record({ ...row, outcome: '형식 실패', reason: proposal?.error ?? '제안 없음', leaks, seconds }); continue; }
          record({ ...row, ...compareAnswer(row.answer, { ...proposal.fields, emotionState: proposal.emotionState }),
            evidence: proposal.fields.emotionEvidence, secondFilmSignal: proposal.fields.secondFilmSignal, scores: proposal.scores,
            nearestAnchor: proposal.nearestAnchor, ...(proposal.stateConflict ? { stateConflict: true } : {}), leaks, seconds });
        } catch (error) {
          if (error.unavailable) { stopRest(textRows.slice(index), error); break; }
          if (error.isLimit) { for (const rest of textRows.slice(index)) record({ ...rest, outcome: '오류', reason: 'Claude 사용 한도' }); break; }
          record({ ...row, outcome: failureOutcome(error), reason: error.message, leaks, seconds: Math.round((now() - started) / 1000) });
        }
        output.log(`#${row.no} ${rows.at(-1).outcome} (${rows.at(-1).got ?? rows.at(-1).reason})`);
      }
    } finally {
      if (!dryRun && engine === 'ollama') await unload(OLLAMA_MODELS.text).catch(() => {});
    }
  }

  // 2) 사진 — 이미지 모델. 오너가 판정한 그 사진 한 장을 세워 붙이고 순간 노트의 사건 정보를 함께 준다.
  const photoRows = stopped ? [] : plan.filter((row) => row.route === 'photo');
  if (stopped) for (const row of plan.filter((entry) => entry.route === 'photo')) record({ ...row, outcome: '오류', reason: `Ollama 멈춤: ${stopped.message}` });
  if (photoRows.length) {
    const media = [...jsonLines(join(root, VAULT_REL.mediaArchiveIndex)), ...jsonLines(join(root, VAULT_REL.mediaImportsIndex))];
    const mediaById = new Map(media.map((entry) => [entry.id, entry]));
    const faces = mineFaces ?? loadMineFaces({ ids: photoRows.map((row) => row.photoId) });
    const moments = momentsForPhotos(root, photoRows.map((row) => row.photoId));
    const decide = ollamaPhotoDecision({ criteria, output, ...(invoke ? { invoke } : {}) });
    const copyDir = join(runDir, 'copies');
    try {
      for (const [index, row] of photoRows.entries()) {
        const source = mediaById.get(row.photoId);
        const sourcePath = source?.archivePath ?? source?.importPath;
        if (!sourcePath) { record({ ...row, outcome: '오류', reason: '미디어 색인에 사진 없음' }); continue; }
        const moment = moments.get(row.photoId);
        const date = occurredDate(moment?.fields.occurred) ?? row.date;
        const fields = { ...(moment?.fields ?? {}), occurred: moment?.fields.occurred ?? row.date };
        const item = { id: fields.momentId ?? row.photoId, fields, memo: moment?.memo ?? '', album: source.album ?? source.albumLabel ?? null };
        const leaks = memoLeak(item.memo, row.answer) ? ['메모 누출 가능'] : [];
        // 잡(choosePhotos)과 같은 형식의 사진 설명. 시험용이라는 말은 넣지 않는다.
        const face = faces.get(row.photoId);
        const reason = face ? `미네 이름표 확인; 얼굴 점수 ${(Number(face.score) || 0).toFixed(3)}` : '201 미네 앨범 근거(얼굴 미확인)';
        const copyPath = join(copyDir, `${row.no}.jpg`);
        if (dryRun) {
          output.log(`#${row.no} 사진 ${sourcePath} (순간 노트 ${moment ? '있음' : '없음'}) — 프롬프트 ${
            buildOllamaOrbPrompt(item, [{ path: copyPath, reason }], criteria, { anchors, exclude: exclude(row) }).length}자`);
          record({ ...row, outcome: '비교 불가', reason: 'dry-run', leaks }); continue;
        }
        const started = now();
        try {
          mkdirSync(copyDir, { recursive: true, mode: 0o700 });
          const size = copyPhoto(resolve(mediaRoot, sourcePath), copyPath);
          const copies = [{ path: copyPath, reason, face: faceBoxText(face?.bbox, size) }];
          const prompt = buildOllamaOrbPrompt(item, copies, criteria, { anchors, exclude: exclude(row) });
          savePrompt(row.no, prompt);
          const answer = await decide(prompt, copyDir, OLLAMA_CALL_MS, { imagePaths: [copyPath], recordDate: date });
          let proposal;
          try { proposal = validateOllamaOrb(answer.result, [], null, date, criteria); }
          catch (error) { error.validation = true; throw error; }
          record({ ...row, ...compareAnswer(row.answer, proposal), evidence: proposal.emotionEvidence, scores: proposal.scores,
            nearestAnchor: proposal.nearestAnchor, scene: proposal.scene, leaks, seconds: Math.round((now() - started) / 1000) });
        } catch (error) {
          if (error.unavailable) { stopRest(photoRows.slice(index), error); break; }
          record({ ...row, outcome: failureOutcome(error), reason: error.message, leaks, seconds: Math.round((now() - started) / 1000) });
        }
        output.log(`#${row.no} ${rows.at(-1).outcome} (${rows.at(-1).got ?? rows.at(-1).reason})`);
      }
    } finally {
      if (!dryRun) await unload(OLLAMA_MODELS.vision).catch(() => {});
    }
  }

  rows.sort((a, b) => a.no - b.no);
  const report = renderReport(rows, { label, startedAt, models: engine === 'claude' ? [`claude ${agent.model}`] : [OLLAMA_MODELS.text, OLLAMA_MODELS.vision] });
  if (!dryRun) writeFileSync(join(runDir, 'report.md'), report, { mode: 0o600 });
  output.log(dryRun ? '\ndry-run — 모델 호출·파일 쓰기 없음' : `\n결과: ${runDir}/report.md`);
  const summary = summarize(rows);
  if (!dryRun) output.log(`판단 ${summary.judged}개 · 감정 일치 ${summary.emotionHits} · 강도까지 일치 ${summary.exactHits}`
    + ` · 누출 표시 제외 ${summary.clean.emotionHits}/${summary.clean.judged}`);
  if (stopped) throw new Error(`Ollama 멈춤으로 중단 — 부분 결과 ${runDir}/report.md (${stopped.message})`);
  return { rows, summary, runDir };
}

const USAGE = '사용: node scripts/tools/mine-anchor-trial.mjs [--dry-run] [--only=1,7,34] [--kind=text|photo] [--engine=ollama|claude]';

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const unknown = args.filter((value) => value !== '--dry-run' && !/^--(only|kind)=/.test(value) && !/^--engine=(ollama|claude)$/.test(value));
  if (unknown.length) { console.error(`모르는 인자: ${unknown.join(' ')}\n${USAGE}`); process.exit(2); }
  const arg = (name) => args.find((value) => value.startsWith(`--${name}=`))?.split('=')[1];
  const only = arg('only')?.split(',').map(Number);
  if (only && (!only.length || only.some((no) => !Number.isInteger(no)))) { console.error(`--only는 시트 번호 목록\n${USAGE}`); process.exit(2); }
  const kind = arg('kind');
  if (kind && !['text', 'photo'].includes(kind)) { console.error(`--kind는 text 또는 photo\n${USAGE}`); process.exit(2); }
  run({ dryRun: process.argv.includes('--dry-run'), only, kind, engine: arg('engine') ?? 'ollama' })
    .catch((error) => { console.error(`❌ ${error.message}`); process.exit(1); });
}
