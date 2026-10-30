#!/usr/bin/env node
/**
 * 아테나 주간 묶음 — 201 미네 대화 노트 중 아테나 필드가 없는 노트에
 * emotions·primaryEmotion·importance(아테나 제안)와 mineAge(코드 계산)를 쓴다.
 * Claude(v1.0)는 기록마다 두 번 묻고, 두 답이 다르면 노트에 쓰지 않고 판단 기록에 '애매함'으로 남긴다
 * (오너 검수 대기 — 검수 시트로 꺼내 오는 길은 후속, 기억 판단 체계 §15.3).
 * 옛 판(0.0)이 판단 근거 없음으로 비운 노트는 상태 파일에 남아 있어 다시 묻지 않는다.
 * 텔레그램은 보내지 않는다. 결과는 로그와 상태 파일에 남는다(요청 2026-10-14 미네 녹음 아테나 필드 주간 묶음).
 */
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { attachAudioCues } from '../lib/media-audio-cues.mjs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VAULT_PATHS, VAULT_REL, categoryLink } from '../lib/vault-paths.mjs';
import { assertFrontmatterRoundTrip, parseFrontmatter } from '../lib/vault-frontmatter.mjs';
import { checkNote, parseRegistry } from '../lib/vault-registry.mjs';
import { withLock, writeAtomic } from '../lib/state-writer.mjs';
import { cooldownActive } from '../lib/quota-cooldown.mjs';
import { loadAgent } from '../lib/agent-loader.mjs';
import { parseJsonBlock, runHeadlessClaude } from '../lib/headless-claude.mjs';
import { loadEmotionCriteria, validateEmotionResult } from '../lib/mine-emotion-criteria.mjs';
import { OLLAMA_MODELS, runOllama, unloadOllamaModel } from '../lib/ollama-client.mjs';
import { mineConversation } from '../lib/mine-record-input.mjs';
import { EMOTION_REQUIRED, appendJudgment, assertEngine, callsOn, emotionProperties, judgedNotes, noteKeys, ownerDecided, readJudgments } from '../lib/mine-judgment.mjs';
import { SCORE_REQUIRED, deriveEmotionFields, judgmentPreamble, loadEmotionAnchors, scoreProperties } from '../lib/mine-judgment-prompt.mjs';

// 인사이드 아웃 감정 어휘(아테나 헌장). 이 밖의 값은 쓰지 않는다.
export const IMPORTANCE_GUIDE = '1 일상 안부, 3 기억할 만한 일, 5 평생 남을 핵심 기억(첫 경험·큰 사건). 대부분은 1~3이다.';
export const MINE_BIRTH = '2016-11-04';
export const MINE_CATEGORY = categoryLink('201 미네');
export const CONVERSATIONS_REL = VAULT_REL.mediaConversations;
export const STATE_REL = VAULT_REL.mineAthenaState;
export const EMOTION_KEYS = ['emotions', 'primaryEmotion', 'emotionIntensity', 'emotionEvidence', 'secondFilmSignal'];
export const ATHENA_KEYS = [...EMOTION_KEYS, 'importance', 'mineAge'];
export const RECLASSIFY_ROOT = join(homedir(), 'Pantheon', 'Media', 'MemoryOrb');
// 최근 노트는 밀린 녹음 전사가 며칠 뒤 더 붙을 수 있어(전사 잡 회당 50분 상한) 이 날수만큼 기다린다.
export const SETTLE_DAYS = 2;
export const MAX_NOTES = 30;
export const MAX_NOTE_CHARS = 2_500;
export const MAX_JOB_MS = 30 * 60_000;
// 프롬프트 판(엔진별). 0.0 = 기억 판단 체계 §10.5 초안(v0.1) 전. Claude는 지금까지 쓰던 프롬프트,
// Ollama는 같은 규칙에 입력만 미네 발화로 추린 것(1단계 ④). 프롬프트나 입력을 바꾸면 올린다.
// ollama-0.2(2026-10-29): 감정별 세기 단어·상태·기준 예시(scripts/lib/mine-judgment-prompt.mjs). Claude는 0.0 그대로.
// ollama-0.3(2026-10-30): 화자 표시 없는 한 사람 녹음의 화자 줄 — 노래·혼잣말은 대개 미네 것(전엔 "감정 없음"으로 몰아
//   기준 예시 #21 노래·#31 기도를 Claude도 틀림). 이 프롬프트 계열은 이제 Claude 판단의 바탕이다(결정 §1 보강, 시험 도구 --engine=claude).
// ollama-0.4(2026-10-30): 협상·조르기와 싫음 표현(음식 투정 = 까칠 옅음)의 경계 한 줄(통화·녹음만, 사진 프롬프트는 그대로).
// ollama-0.5(2026-10-30): 억울한 일에 화를 직접 말하면 '속상해'가 붙어도 버럭(통화·녹음만).
// claude 1.0(2026-10-30 오너 동결): ollama-0.5와 같은 프롬프트(기준 예시 넣음)를 Claude가 기록마다 두 번 답한다.
//   검수 24개 중 두 번 모두 오너와 같음 20, 두 답 갈림 2, 같게 틀림 2(기억 판단 체계 §15.3). 묶음 프롬프트 0.0은 걷어냄.
export const PROMPT_VERSIONS = Object.freeze({ claude: 'athena-fields/1.0', ollama: 'athena-fields/ollama-0.5' });
// Claude 헤드리스는 온도를 못 정해 같은 기록도 답이 흔들린다(기준 예시 22개 중 약 3개). 그래서 두 번 묻는다.
export const CLAUDE_RUNS = 2;
// 하루 Claude 호출 상한(2026-10-30 오너 "두 번씩, 하루 상한 두고 나눠"): 기록 100개 × 두 번. 대화 세션과 같은 구독 한도를 나눠 쓴다.
// 이 잡의 판단 기록(at = 회차를 시작한 KST 날짜)으로만 센다. 검수·시험 도구 호출까지 포함한 공유 한도는 쿨다운 가드가 지킨다.
export const DAILY_CLAUDE_CALLS = 200;
// 기록 한 건 호출 상한. 실측 약 15초.
export const CLAUDE_CALL_MS = 5 * 60_000;

// 화자 줄. 화자 표시 없는 한 사람 녹음은 따로 안내한다(0.3~).
function speakerLine(item) {
  if (/^미네: /m.test(noteText(item.content))) return '화자 분리: 미네: 발화가 표시됨. 다른 화자는 맥락만';
  if (item.fields?.convKind === '녹음') {
    return '화자 분리: 화자 표시 없는 한 사람 녹음 — 노래·혼잣말·말소리는 대개 미네 것이다. 어른이 이끄는 말이 섞이면 그 말은 맥락으로만 쓰고, 미네가 따라 하거나 스스로 낸 말·소리를 근거로 쓴다.';
  }
  return '화자 분리: 확실한 미네 발화가 표시되지 않으면 감정 없음';
}
export const JUDGMENTS_FILE = 'athena-judgments.jsonl';

// 판단 기록은 볼트 밖(Media/MemoryOrb). 시험용 볼트(임시 폴더)인데 out을 따로 주지 않았으면
// 그 임시 폴더 안에 두어, 진짜 기록에 시험 줄이 섞이지 않게 한다.
// 진짜 볼트인지는 실제 경로로 가린다(끝 슬래시·옛 링크 ~/banana-vault로 불러도 볼트 안에 쓰지 않게).
export function defaultJudgmentsPath(root, out = RECLASSIFY_ROOT) {
  const real = (path) => { try { return realpathSync(resolve(path)); } catch { return resolve(path); } };
  if (out === RECLASSIFY_ROOT && real(root) !== real(VAULT_PATHS.root)) return join(root, '.mine-judgments', JUDGMENTS_FILE);
  return join(out, JUDGMENTS_FILE);
}

const kstDate = (now) => new Date(now.getTime() + 9 * 3_600_000).toISOString().slice(0, 10);
const readJson = (path, fallback) => existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : fallback;

// TMPDIR가 저장소·볼트 안을 가리켜도 Claude의 cwd는 그 밖의 빈 시스템 임시 폴더에 둔다.
export async function restrictedDecision(prompt, agent, { invoke = runHeadlessClaude, output = console } = {}) {
  const cwd = mkdtempSync('/tmp/mine-athena-claude-');
  try {
    const raw = await invoke(prompt, agent.model, '', {
      appendSystemPrompt: agent.systemPrompt, lean: true, tools: '', maxTurns: 1,
      cwd, timeoutMs: CLAUDE_CALL_MS,
    });
    const envelope = JSON.parse(raw);
    if (typeof envelope.result !== 'string') throw new Error('Claude JSON 결과 오류');
    const usage = envelope.usage ?? {};
    const inputTokens = ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens']
      .reduce((sum, key) => sum + (Number(usage[key]) || 0), 0);
    const outputTokens = Number(usage.output_tokens) || 0;
    output.log(`[mine-athena-fields] Claude usage ${JSON.stringify({ inputTokens, outputTokens, usage })}`);
    return envelope.result;
  } catch (error) {
    if (error.usage) output.log(`[mine-athena-fields] Claude usage ${JSON.stringify({ usage: error.usage, error: error.message })}`);
    throw error;
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

// occurred를 KST 날짜로. 시간대가 Z로 적혀 있어도 KST 기준 날짜가 된다.
export function occurredDate(occurred) {
  const time = Date.parse(String(occurred ?? ''));
  return Number.isFinite(time) ? kstDate(new Date(time)) : null;
}

// occurred 날짜(KST) 기준 만 나이.
export function mineAge(occurred, birth = MINE_BIRTH) {
  const date = occurredDate(occurred);
  if (!date) return null;
  let age = Number(date.slice(0, 4)) - Number(birth.slice(0, 4));
  if (date.slice(5) < birth.slice(5)) age -= 1;
  return age >= 0 ? age : null;
}

function listNotes(root, rel) {
  const absolute = join(root, rel);
  if (!existsSync(absolute)) return [];
  return readdirSync(absolute, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name.startsWith('99_')) return [];
    const child = `${rel}/${entry.name}`;
    if (entry.isDirectory()) return listNotes(root, child);
    return entry.isFile() && entry.name.endsWith('.md') ? [child] : [];
  });
}

// 대상: 201 미네 category, 아테나 필드가 하나도 없음, 건너뜀 기록 없음, cutoff(KST) 이전 날짜.
// judged: 지금 판으로 이미 판단한 노트 경로(애매함 포함) — 다시 묻지 않는다.
// since: 이 날짜(KST) 이후 기록만 — 2023년~ 먼저 전수(오너 결정 F-2, 기억 판단 체계 §10.2).
export function findTargets(root, { skipped = {}, cutoff, reclassify = false, ids, kind = '녹음', includeUnclassified = false, judged = new Set(), since } = {}) {
  const targets = [];
  for (const rel of listNotes(root, CONVERSATIONS_REL)) {
    const content = readFileSync(join(root, rel), 'utf8');
    const fm = parseFrontmatter(content);
    const unclassified = fm.emotions === undefined || fm.primaryEmotion === undefined;
    if (skipped[rel] && (!reclassify || includeUnclassified && unclassified)) continue;
    const category = Array.isArray(fm.category) ? fm.category : [fm.category];
    if (!category.includes(MINE_CATEGORY)) continue;
    // --ids로 고른 노트는 오너·운영자가 일부러 다시 묻는 것이라 같은 판이어도 고른다.
    // 오너가 검수 시트로 정한 노트(머리말 표식)는 --ids로도 모델이 덮지 않는다.
    if (ownerDecided(fm) || !ids && noteKeys(rel, fm).some((key) => judged.has(key))) continue;
    if (reclassify) {
      const noteIds = [...content.matchAll(/<!-- media-transcribe:id ([a-f0-9]{16}) -->/gi)].map((match) => match[1]);
      if (!['녹음', '통화'].includes(fm.convKind) || kind !== 'all' && fm.convKind !== kind
        // 기본은 이미 분류된 노트만 다시 분류한다. --include-unclassified면 감정 필드가 없는 노트도 처음 분류한다
        // (미네 통화 473개 중 365개가 미분류 — 주간 잡의 30개/주 속도로는 1년 걸림, 2026-10-17).
        || (!includeUnclassified && (fm.emotions === undefined || fm.primaryEmotion === undefined)) ||
        (ids && !ids.some((id) => noteIds.includes(id) || rel === id))) continue;
    } else if (ATHENA_KEYS.some((key) => fm[key] !== undefined)) continue;
    const date = occurredDate(fm.occurred);
    if (!date || (!reclassify && date >= cutoff) || (since && date < since)) continue;
    targets.push({ rel, content, occurred: String(fm.occurred), date, fields: fm });
  }
  return targets.sort((a, b) => a.date.localeCompare(b.date) || a.rel.localeCompare(b.rel, 'ko'));
}

// 머리말과 HTML 주석을 뺀 본문(전사·오너 메모).
export function noteText(content, maxChars = MAX_NOTE_CHARS) {
  const end = content.startsWith('---\n') ? content.indexOf('\n---', 4) : -1;
  const body = end === -1 ? content : content.slice(end + 4);
  const text = body.replace(/<!--[\s\S]*?-->/g, '').replace(/\n{3,}/g, '\n\n').trim();
  return text.length > maxChars ? `${text.slice(0, maxChars)}…(이하 생략)` : text;
}

export function ownerMemoEmotions(content) {
  const memo = content.split(/^## 오너 메모\s*$/m)[1]?.split(/^## /m)[0] ?? '';
  const explicit = memo.match(/(?:^|\n)\s*(?:감정|느낌)\s*[:：]\s*([^\n]+)/)?.[1] ?? '';
  return [...new Set(explicit.split(/[,，·\s]+/).filter(Boolean))];
}

// 본문 대신 미네 발화와 바로 앞 맥락 한 줄만(mine-record-input), 오너 메모는 따로.
function recordText(item) {
  const { text, mode } = mineConversation(item.content);
  const memo = item.content.split(/^## 오너 메모\s*$/m)[1]?.split(/^## /m)[0].trim() ?? '';
  const heading = { mine: '전사(미네 발화와 그 바로 앞 다른 화자 한 줄만 추림):', whole: '전사(화자 표시 없음, 본문 전체):',
    mixed: '전사(화자 표시된 구간은 미네 발화와 그 바로 앞 한 줄만, 화자 표시 없는 구간은 전체):' }[mode];
  return [heading, text,
    memo ? `오너 메모: ${memo.slice(0, 500)}` : ''].filter(Boolean).join('\n');
}

// 기록 한 건(제목·날짜·화자·소리 근거·전사).
function noteBlock(item, criteria) {
  return [
    `### ${item.rel.split('/').pop().replace(/\.md$/, '')}`,
    `날짜 ${item.date} · 미네 만 ${mineAge(item.occurred)}세`,
    speakerLine(item),
    item.fields?.convKind === '통화' ? '통화 규칙: 대화 형식의 미네: 줄과 확인된 미네 구간 소리만 감정 근거. 나: 등 다른 화자의 말은 맥락 해석에만 쓴다.' : '',
    `오너 메모 감정: ${ownerMemoEmotions(item.content, criteria).join('·') || '(없음)'}`,
    item.audioCues?.text ?? '',
    recordText(item),
  ].filter((line) => line !== '').join('\n');
}

// 소리 근거를 읽는 법.
const AUDIO_CUE_RULE = '소리 근거: 노트에 맥 안 기계 감지 결과(웃음·울음·소리 지름·노래·목소리 높이·세기)가 있으면 근거로 함께 쓴다. \'미네 구간\'은 화자 분리로 확인된 미네 소리라 전사에 글자가 없어도 웃음·울음이 근거가 된다. \'전체(한 사람 녹음)\'는 화자 분리를 하지 않는 비대화형 녹음(노래·혼잣말·동화 등)이라 대개 미네 소리지만, 전사에 다른 사람 말이 보이면 누구 소리인지 알 수 없으므로 보조 근거로만 쓰고 단독 근거로 쓰지 않는다. 대화형인데 화자 분리 전이면 소리 근거를 주지 않는다. 노래 구간만으로는 감정이 아니지만, 웃음·높아진 목소리·커진 소리와 함께 신나게 부르는 노래는 근거가 된다. 기계 감지는 틀릴 수 있으니 전사 내용과 어긋나면 전사를 우선하고, 근거로 썼으면 emotionEvidence에 적는다.';

// 판단 프롬프트(Claude 1.0·Ollama 0.5 공통, 이름은 Ollama 때 붙은 것): 바뀌지 않는 앞부분(역할·감정 기준·기준 예시·
// 판단 순서·답 양식) 뒤에 기록 한 건. exclude는 기준 예시 시험 도구만 넘긴다(시험 대상과 같은 날짜 예시를 뺀다).
export function buildOllamaPrompt(items, { reclassify = false, criteria = loadEmotionCriteria(), signalTrend, anchors = loadEmotionAnchors(), exclude } = {}) {
  if (items.length !== 1) throw new Error('Ollama 0.2 프롬프트는 기록 하나씩 만든다');
  const [item] = items;
  const trendText = !reclassify && signalTrend ? `# 최근 사춘기 신호 관찰 (${signalTrend.start}~${signalTrend.end}): ${signalTrend.total}건 — `
    + `${Object.entries(signalTrend.counts).map(([name, count]) => `${name} ${count}건`).join('·') || '없음'}. 사춘기 경보 발령은 오너가 확정한다.` : '';
  return [
    judgmentPreamble({ criteria, recordDate: item.date, anchors, exclude, medium: 'text' }),
    `# 소리 근거 읽는 법\n${AUDIO_CUE_RULE}`,
    reclassify ? '' : `# 중요도(답 양식에 importance 추가)\n- importance: 1~5 정수. ${IMPORTANCE_GUIDE}`,
    trendText,
    `# 기록\n${noteBlock(item, criteria)}`,
  ].filter(Boolean).join('\n\n');
}

export function ollamaProposalSchema(items, { reclassify = false, criteria = loadEmotionCriteria() } = {}) {
  if (items.length !== 1) throw new Error('Ollama 0.2 답 모양은 기록 하나씩 만든다');
  const required = [...SCORE_REQUIRED, ...(reclassify ? [] : ['importance'])];
  return { type: 'object', additionalProperties: false, required, properties: { ...scoreProperties(items[0].date, criteria),
    ...(reclassify ? {} : { importance: { type: 'integer', minimum: 1, maximum: 5 } }) } };
}

// 답 하나 → Map(1 → { fields, scores, levels, emotionState, … } | { error, formatFailure }).
export function validateOllamaProposals(raw, items, { reclassify = false, criteria = loadEmotionCriteria() } = {}) {
  const [item] = items;
  try {
    const derived = deriveEmotionFields(raw, { recordDate: item.date, criteria, ownerEmotions: ownerMemoEmotions(item.content, criteria) });
    if (!reclassify && (!Number.isInteger(raw.importance) || raw.importance < 1 || raw.importance > 5)) throw new Error('importance 1~5 아님');
    const { fields, ...rest } = derived;
    return new Map([[1, { fields: { ...fields, ...(!reclassify ? { importance: raw.importance } : {}) }, ...rest }]]);
  } catch (error) {
    return new Map([[1, { error: error.message, formatFailure: true }]]);
  }
}

// 옛 Ollama 답 모양(묶음 프롬프트 0.0·0.1의 배열). skip은 넣지 않는다: 로컬 모델이 프롬프트 예시의
// skip 문구를 따라 쓰면 판단할 수 있는 노트가 상태 파일에 영구 제외되기 때문이다(2026-10-24 리뷰).
// 판단할 근거가 없으면 빈 감정·강도 null로 답한다.
export function proposalSchema(items, { reclassify = false, criteria = loadEmotionCriteria() } = {}) {
  const dates = new Set(items.map((item) => item.date));
  if (dates.size !== 1) throw new Error('Ollama 답 모양은 한 날짜 기록만 만든다');
  const required = ['id', ...EMOTION_REQUIRED, ...(reclassify ? [] : ['importance'])];
  return { type: 'array', minItems: items.length, maxItems: items.length, items: {
    type: 'object', additionalProperties: false, required,
    properties: { id: { type: 'integer', minimum: 1, maximum: items.length }, ...emotionProperties(items[0].date, criteria),
      ...(reclassify ? {} : { importance: { type: 'integer', minimum: 1, maximum: 5 } }) },
  } };
}

// Ollama 판단: 기록 하나에 한 번(§3) 부르고, 검증은 Claude와 같은 길(parseJsonBlock → validateProposals)로 보낸다.
export function ollamaDecision({ criteria, invoke = runOllama, output = console } = {}) {
  return async (prompt, { items, reclassify = false }) => {
    const { json } = await invoke({ model: OLLAMA_MODELS.text, prompt, schema: ollamaProposalSchema(items, { reclassify, criteria }),
      usageLogger: (line) => output.log(`[mine-athena-fields] ${line}`) });
    return JSON.stringify(json);
  };
}

// 두 답이 같은지 — 상태(있음·감정 없음·모름)와 대표 감정·강도만 본다(검수 시트와 같은 기준).
// 같으면 첫 답을 쓴다. 곁 감정·2편 신호·중요도의 흔들림은 판단 기록 answers에 두 답을 남겨 나중에 볼 수 있게 한다.
const answerKey = (answer) => [answer.emotionState, answer.fields.primaryEmotion, answer.fields.emotionIntensity].join('|');

// 기록 하나씩 runs번 묻는다(Claude 2·Ollama 1). 형식 실패·호출 오류는 그 기록만 재시도로 두고(formatFailure는 §10.4의
// 2회 실패 집계용), 두 답이 다르면 { ambiguous }. 시간 상한·쿨다운이면 남은 기록을 연기하고, Ollama가 멈추면(unavailable)
// 남은 기록을 연기하고 그 회차를 끝낸다(조용히 다른 엔진으로 넘기지 않음). calls는 실제로 부른 횟수(하루 상한용).
export async function judgeItems(items, { decide, prompt, validate, reclassify = false, runs = 1, quota = () => false,
  deadline = Infinity, now = Date.now }) {
  const proposals = new Map();
  for (const [index, item] of items.entries()) {
    if (now() >= deadline) { proposals.set(index + 1, { error: '잡 시간 상한', deferred: true }); continue; }
    const answers = [];
    let calls = 0;
    try {
      while (answers.length < runs && !answers.some((answer) => answer.error)) {
        if (quota()) break;
        if (answers.length && now() >= deadline) { answers.push({ error: '잡 시간 상한', deferred: true }); break; }
        calls += 1;
        answers.push(validate(parseJsonBlock(await decide(prompt([item]), { items: [item], reclassify })), [item]).get(1) ?? { error: '제안 없음' });
      }
    } catch (error) {
      if (error.unavailable) {
        for (let rest = index; rest < items.length; rest += 1) proposals.set(rest + 1, { error: error.message, deferred: true, unavailable: true });
        break;
      }
      proposals.set(index + 1, { error: error.message, calls, ...(error.formatFailure ? { formatFailure: true } : {}) });
      continue;
    }
    if (answers.length < runs && !answers.some((answer) => answer.error)) {
      for (let rest = index; rest < items.length; rest += 1) {
        proposals.set(rest + 1, { error: '쿨다운', deferred: true, cooldown: true, ...(rest === index && calls ? { calls } : {}) });
      }
      break;
    }
    const failure = answers.find((answer) => answer.error);
    if (failure) proposals.set(index + 1, { ...failure, calls });
    else if (new Set(answers.map(answerKey)).size > 1) proposals.set(index + 1, { ambiguous: true, answers, calls });
    else proposals.set(index + 1, { ...answers[0], calls, ...(answers.length > 1 ? { answers } : {}) });
  }
  return proposals;
}

// 판단 기록 쓰기. 노트가 정본이라 기록 실패가 노트 쓰기 흐름을 끊지 않게 오류는 세어 두고 회차 끝에 실패로 본다.
function judgmentRecorder(path, summary, output) {
  return (row) => {
    try { appendJudgment(path, row); } catch (error) {
      summary.recordErrors = (summary.recordErrors ?? 0) + 1;
      output.error(`[mine-athena-fields] 판단 기록 실패 ${row.rel}: ${error.message}`);
    }
  };
}

// 판단 기록 한 줄. status: applied(노트에 씀) · same(지금 값과 같음) · skip(판단 불가) · retry(다음 회차에 다시)
// · ambiguous(두 답이 달라 오너 확인 대기 — answers에 두 답).
const answerRow = (answer) => ({ fields: answer.fields, emotionState: answer.emotionState, levels: answer.levels, nearestAnchor: answer.nearestAnchor });
function judgmentRow(item, proposal, status, { version, mode, today, reason }) {
  return { rel: item.rel, at: today, mode, ...version, status, calls: proposal?.calls ?? 0,
    ...(proposal?.answers ? { answers: proposal.answers.map(answerRow) } : {}),
    ...(proposal?.fields ? { fields: proposal.fields } : {}), ...(proposal?.scores ? { scores: proposal.scores } : {}),
    ...(proposal?.levels ? { levels: proposal.levels } : {}),
    ...(proposal?.emotionState ? { emotionState: proposal.emotionState } : {}),
    ...(proposal?.nearestAnchor ? { nearestAnchor: proposal.nearestAnchor } : {}),
    ...(proposal?.stateConflict ? { stateConflict: true } : {}),
    ...(proposal?.formatFailure ? { formatFailure: true } : {}), ...(reason ? { reason } : {}) };
}

// 닫는 --- 앞에 필드를 붙이고 modified만 바꾼다. 나머지 머리말·본문은 그대로 둔다.
// 네 키 중 하나라도 이미 있으면(그 사이 손으로 채운 경우) 키가 겹치지 않게 null.
export function applyFields(content, fields, age, today) {
  if (!content.startsWith('---\n')) return null;
  const end = content.indexOf('\n---', 4);
  if (end === -1) return null;
  const lines = content.slice(4, end).split('\n');
  if (lines.some((line) => ATHENA_KEYS.some((key) => line.startsWith(`${key}:`)))) return null;
  const head = lines.map((line) => line.startsWith('modified:') ? `modified: "${today}"` : line);
  head.push(...EMOTION_KEYS.map((key) => `${key}: ${JSON.stringify(fields[key] ?? null)}`),
    `importance: ${fields.importance}`, `mineAge: ${age}`);
  return `---\n${head.join('\n')}${content.slice(end)}`;
}

export function replaceEmotionFields(content, fields, today) {
  if (!content.startsWith('---\n')) throw new Error('머리말 없음');
  const end = content.indexOf('\n---', 4);
  if (end < 0) throw new Error('머리말 닫힘 없음');
  const lines = content.slice(4, end).split('\n').filter((line) => !EMOTION_KEYS.some((key) => line.startsWith(`${key}:`)));
  const previous = parseFrontmatter(content);
  if (EMOTION_KEYS.every((key) => JSON.stringify(previous[key] ?? null) === JSON.stringify(fields[key] ?? null))) return content;
  const next = lines.map((line) => line.startsWith('modified:') ? `modified: "${today}"` : line);
  next.push(...EMOTION_KEYS.map((key) => `${key}: ${JSON.stringify(fields[key] ?? null)}`));
  return `---\n${next.join('\n')}${content.slice(end)}`;
}

function firstClassification(item) {
  return item.fields.emotions === undefined || item.fields.primaryEmotion === undefined;
}

function applyInitialFields(content, fields, age, today) {
  const previous = parseFrontmatter(content);
  if (ATHENA_KEYS.every((key) => previous[key] === undefined)) return applyFields(content, fields, age, today);
  if (!content.startsWith('---\n')) return null;
  const end = content.indexOf('\n---', 4);
  if (end < 0) return null;
  const keepImportance = Number.isInteger(previous.importance)
    && previous.importance >= 1 && previous.importance <= 5;
  const keepAge = Number.isInteger(previous.mineAge) && previous.mineAge >= 0;
  const lines = content.slice(4, end).split('\n')
    .filter((line) => !EMOTION_KEYS.some((key) => line.startsWith(`${key}:`))
      && (keepImportance || !line.startsWith('importance:'))
      && (keepAge || !line.startsWith('mineAge:')))
    .map((line) => line.startsWith('modified:') ? `modified: "${today}"` : line);
  lines.push(...EMOTION_KEYS.map((key) => `${key}: ${JSON.stringify(fields[key] ?? null)}`));
  if (!keepImportance) lines.push(`importance: ${fields.importance}`);
  if (!keepAge) lines.push(`mineAge: ${age}`);
  return `---\n${lines.join('\n')}${content.slice(end)}`;
}

async function reclassificationProposals(batch, decide, criteria, signalTrend, cooldown, { engine = 'claude', deadline, anchors } = {}) {
  const proposals = new Map();
  for (const initial of [true, false]) {
    const group = batch.map((item, index) => ({ item, index }))
      .filter(({ item }) => firstClassification(item) === initial);
    if (!group.length) continue;
    if (cooldown()) return null;
    const items = group.map(({ item }) => item);
    const trend = initial ? signalTrend : undefined;
    const parsed = await judgeItems(items, { decide, reclassify: !initial, deadline, quota: cooldown,
      runs: engine === 'claude' ? CLAUDE_RUNS : 1,
      prompt: (subset) => buildOllamaPrompt(subset, { reclassify: !initial, criteria, signalTrend: trend, anchors }),
      validate: (raw, subset) => validateOllamaProposals(raw, subset, { reclassify: !initial, criteria }) });
    for (const [index, { index: originalIndex }] of group.entries()) {
      proposals.set(originalIndex + 1, parsed.get(index + 1));
    }
  }
  return proposals;
}

function distribution(targets, field = 'fields') {
  const counts = {};
  for (const item of targets) for (const emotion of item[field].emotions ?? []) counts[emotion] = (counts[emotion] ?? 0) + 1;
  return counts;
}

function signalDistribution(targets, field = 'fields') {
  const counts = {};
  for (const item of targets) {
    const signal = item[field].secondFilmSignal;
    if (signal) counts[signal] = (counts[signal] ?? 0) + 1;
  }
  return counts;
}

export function recentSignalTrend(root, today, criteria = loadEmotionCriteria()) {
  const start = new Date(Date.parse(`${today}T00:00:00Z`) - 6 * 86_400_000).toISOString().slice(0, 10);
  const counts = {};
  const examples = [];
  let total = 0;
  for (const rel of listNotes(root, CONVERSATIONS_REL)) {
    const fields = parseFrontmatter(readFileSync(join(root, rel), 'utf8'));
    const category = Array.isArray(fields.category) ? fields.category : [fields.category];
    const recordDate = occurredDate(fields.occurred);
    if (!category.includes(MINE_CATEGORY) || !recordDate || recordDate < start || recordDate > today ||
      (criteria.pubertyAlarmDate !== null && recordDate >= criteria.pubertyAlarmDate) ||
      !fields.secondFilmSignal) continue;
    counts[fields.secondFilmSignal] = (counts[fields.secondFilmSignal] ?? 0) + 1;
    total += 1;
    if (examples.length < 2 && fields.emotionEvidence) {
      examples.push({ signal: fields.secondFilmSignal, evidence: fields.emotionEvidence, rel });
    }
  }
  return { start, end: today, total, counts, examples };
}

function changeReason(before, after) {
  if (JSON.stringify(before.emotions ?? []) !== JSON.stringify(after.emotions)) {
    return after.emotions.length ? '감정 구성 변경' : '감정 없음으로 변경';
  }
  if (before.primaryEmotion !== after.primaryEmotion) return '대표 감정 변경';
  if (before.emotionIntensity !== after.emotionIntensity) return '강도 변경';
  if ((before.secondFilmSignal ?? null) !== (after.secondFilmSignal ?? null)) return '2편 감정 신호 변경';
  return '판단 근거 보완';
}

// Claude 하루 상한 안에서 이번에 고를 수 있는 기록 수(기록 하나에 CLAUDE_RUNS번 부른다). Ollama는 상한 없음.
function dailyRoom(engine, rows, today) {
  if (engine !== 'claude') return Infinity;
  return Math.floor(Math.max(0, DAILY_CLAUDE_CALLS - callsOn(rows, { engine, date: today })) / CLAUDE_RUNS);
}

async function reclassifyUnlocked({ root = VAULT_PATHS.root, out = RECLASSIFY_ROOT, dryRun = false,
  ids, kind = '녹음', includeUnclassified = false, since, maxNotes = MAX_NOTES, now = new Date(), judge, cooldown = cooldownActive, charter,
  rules, write = writeAtomic, criteria = loadEmotionCriteria(), output = console, cues = attachAudioCues, anchors,
  engine = 'claude', judgmentsPath, unload = unloadOllamaModel, invoke } = {}) {
  const today = kstDate(now);
  if (!['녹음', '통화', 'all'].includes(kind)) throw new Error('--kind는 통화, 녹음, all 중 하나');
  assertEngine(engine);
  const statePath = join(root, STATE_REL);
  const state = includeUnclassified ? readJson(statePath, { skipped: {} }) : { skipped: {} };
  const recordPath = judgmentsPath ?? defaultJudgmentsPath(root, out);
  // Claude 모델 이름은 헌장에서 온다. 같은 판 확인에 쓰므로 대상 고르기 전에 정한다
  // (그래서 Claude 재분류는 dry-run에서도 헌장을 읽는다 — 2026-10-24부터).
  const agent = engine === 'claude' ? charter ?? loadAgent('athena', { fallbackModel: 'sonnet' }) : null;
  const version = { engine, model: engine === 'ollama' ? OLLAMA_MODELS.text : agent.model,
    criteriaRef: criteria.ref ?? null, promptVersion: PROMPT_VERSIONS[engine] };
  const rows = readJudgments(recordPath);
  const targets = findTargets(root, { reclassify: true, ids, kind, includeUnclassified, since,
    skipped: state.skipped ?? {}, cutoff: today, judged: judgedNotes(rows, version) });
  const room = dailyRoom(engine, rows, today);
  const batch = targets.slice(0, Math.min(maxNotes, room));
  const quota = engine === 'claude' ? cooldown : () => false; // 쿨다운은 Claude 구독 사용량 가드다.
  const signalTrend = batch.some(firstClassification) ? recentSignalTrend(root, today, criteria) : undefined;
  const summary = { targets: targets.length, selected: batch.length, changed: 0, unchanged: 0,
    invalid: [], ambiguous: [], before: distribution(batch), after: {}, beforeSignals: signalDistribution(batch),
    afterSignals: {}, reasons: {}, ...(room < Math.min(maxNotes, targets.length) ? { capped: true } : {}) };
  if (summary.capped) output.log(`[mine-athena-fields] Claude 하루 상한(${DAILY_CLAUDE_CALLS}번): 오늘 남은 기록 ${room}개만 고름`);
  const activeAnchors = () => anchors ?? loadEmotionAnchors();
  if (dryRun) {
    if (judge && batch.length) {
      // dry-run도 소리 분석은 실제로 하고 볼트 밖 캐시만 쓴다(볼트 쓰기는 없음).
      await cues(batch, { root });
      const preview = await reclassificationProposals(batch, judge, criteria, signalTrend, quota, { engine, anchors: activeAnchors() });
      if (!preview) return { ...summary, cooldown: true };
      for (const [index, item] of batch.entries()) {
        const proposal = preview.get(index + 1);
        if (proposal?.ambiguous) summary.ambiguous.push({ rel: item.rel, answers: proposal.answers.map(answerKey) });
        if (proposal?.cooldown) summary.cooldown = true;
        if (!proposal?.fields) continue;
        const owner = ownerMemoEmotions(item.content, criteria);
        const fields = { ...proposal.fields };
        if (owner.length) {
          fields.emotions = owner;
          fields.primaryEmotion = owner.includes(item.fields.primaryEmotion) ? item.fields.primaryEmotion : owner[0];
        }
        validateEmotionResult(fields, { recordDate: item.date, ownerEmotions: owner, criteria });
        const age = firstClassification(item) ? mineAge(item.occurred) : null;
        if (firstClassification(item) && age === null) continue;
        const next = firstClassification(item)
          ? applyInitialFields(item.content, fields, age, today)
          : replaceEmotionFields(item.content, fields, today);
        if (next && next !== item.content) summary.changed += 1;
      }
    }
    output.log(`[mine-athena-fields] 재분류 dry-run 대상 ${kind} ${targets.length}개(이번 묶음 ${batch.length}개), 쓰기·Claude 호출 없음`);
    return summary;
  }
  if (!batch.length) return summary;
  if (quota()) return { ...summary, cooldown: true };
  const decide = judge ?? (engine === 'ollama' ? ollamaDecision({ criteria, output, invoke })
    : (prompt) => restrictedDecision(prompt, agent, { output }));
  await cues(batch, { root });
  if (quota()) return { ...summary, cooldown: true };
  let proposals;
  try {
    proposals = await reclassificationProposals(batch, decide, criteria, signalTrend, quota,
      { engine, deadline: Date.now() + MAX_JOB_MS, anchors: activeAnchors() });
  } finally {
    // 16GB라 다음 잡(이미지 모델)이 올라오기 전에 내린다. 시험 주입(judge)이면 부르지 않는다.
    if (engine === 'ollama' && !judge) await unload(OLLAMA_MODELS.text).catch((error) => output.error(`[mine-athena-fields] 모델 내리기 실패: ${error.message}`));
  }
  if (!proposals) return { ...summary, cooldown: true };
  const append = judgmentRecorder(recordPath, summary, output);
  const record = (item, proposal, status, reason) => append(
    judgmentRow(item, proposal, status, { version, mode: firstClassification(item) ? 'initial' : 'reclassify', today, reason }));
  const activeRules = rules ?? parseRegistry(readFileSync(join(root, VAULT_REL.registryFile), 'utf8'));
  const backupPath = join(out, `reclassify-backup-${today}.jsonl`);
  const reportPath = join(out, `reclassify-report-${today}.md`);
  mkdirSync(out, { recursive: true, mode: 0o700 });
  // 백업은 첫 볼트 쓰기 전에 완성한다. 같은 날짜 재실행에서 바뀐 사전 상태도 추가한다.
  if (existsSync(backupPath)) chmodSync(backupPath, 0o600);
  const backed = existsSync(backupPath) ? new Set(readFileSync(backupPath, 'utf8').split('\n').filter(Boolean)
    .map((line) => JSON.stringify(JSON.parse(line)))) : new Set();
  const missing = batch.map((item) => JSON.stringify({ rel: item.rel,
    fields: Object.fromEntries([...ATHENA_KEYS, 'modified'].map((key) => [key, item.fields[key] ?? null])) }))
    .filter((line) => !backed.has(line));
  if (!existsSync(backupPath)) writeFileSync(backupPath, '', { mode: 0o600, flag: 'wx' });
  if (missing.length) appendFileSync(backupPath, `${missing.join('\n')}\n`, { mode: 0o600 });
  chmodSync(backupPath, 0o600);
  const afterItems = [];
  for (const [index, item] of batch.entries()) {
    const proposal = proposals.get(index + 1);
    if (proposal?.ambiguous) {
      summary.ambiguous.push({ rel: item.rel, answers: proposal.answers.map(answerKey) });
      record(item, proposal, 'ambiguous');
      afterItems.push(item);
      continue;
    }
    if (!proposal?.fields) {
      const reason = proposal?.error ?? proposal?.skip ?? '제안 없음';
      // 쿨다운으로 미룬 기록은 실패가 아니다 — 다음 회차에 다시 묻는다.
      if (proposal?.cooldown) summary.cooldown = true;
      else summary.invalid.push({ rel: item.rel, reason });
      if (proposal?.unavailable) summary.unavailable = true;
      record(item, proposal, proposal?.skip ? 'skip' : 'retry', reason);
      afterItems.push(item);
      continue;
    }
    const owner = ownerMemoEmotions(item.content, criteria);
    const proposed = { ...proposal.fields };
    if (owner.length) {
      proposed.emotions = owner;
      proposed.primaryEmotion = owner.includes(item.fields.primaryEmotion) ? item.fields.primaryEmotion : owner[0];
    }
    const absolute = join(root, item.rel);
    try {
      validateEmotionResult(proposed, { recordDate: item.date, ownerEmotions: owner, criteria });
      const age = firstClassification(item) ? mineAge(item.occurred) : null;
      if (firstClassification(item) && age === null) throw new Error(`나이 계산 불가(occurred ${item.occurred})`);
      const outcome = await withLock(absolute, () => {
        const latest = readFileSync(absolute, 'utf8');
        if (latest !== item.content) throw new Error('판단 중 노트가 바뀜');
        const next = firstClassification(item)
          ? applyInitialFields(latest, proposed, age, today)
          : replaceEmotionFields(latest, proposed, today);
        if (!next) throw new Error('처음 분류할 필드를 쓸 수 없음');
        if (next === latest) return 'unchanged';
        assertFrontmatterRoundTrip(next, Object.fromEntries(EMOTION_KEYS.map((key) => [key, proposed[key] ?? null])));
        const problems = checkNote(item.rel, next, activeRules);
        if (problems.length) throw new Error(`쓰기 관문: ${problems.join('; ')}`);
        write(absolute, next);
        return 'changed';
      });
      summary[outcome] += 1;
      record(item, { ...proposal, fields: proposed }, outcome === 'changed' ? 'applied' : 'same');
      if (outcome === 'changed') {
        const reason = changeReason(item.fields, proposed);
        summary.reasons[reason] = (summary.reasons[reason] ?? 0) + 1;
      }
      afterItems.push({ ...item, fields: { ...item.fields, ...(outcome === 'changed' ? proposed : {}) } });
    } catch (error) {
      summary.invalid.push({ rel: item.rel, reason: error.message });
      record(item, proposal, 'retry', error.message);
      afterItems.push(item);
    }
  }
  summary.after = distribution(afterItems);
  summary.afterSignals = signalDistribution(afterItems);
  const report = [`# 미네 ${kind} 감정 재분류`, '', `대상 ${summary.targets}개, 처리 ${summary.selected}개, 변경 ${summary.changed}개, 동일 ${summary.unchanged}개, 애매함 ${summary.ambiguous.length}개, 실패 ${summary.invalid.length}개.`,
    '', '## 감정 분포 (이번 처리 묶음)', `이전: ${JSON.stringify(summary.before)}`, `이후: ${JSON.stringify(summary.after)}`,
    '', '## secondFilmSignal 분포 (이번 처리 묶음)', `이전: ${JSON.stringify(summary.beforeSignals)}`, `이후: ${JSON.stringify(summary.afterSignals)}`,
    '', '## 변경 사유 상위',
    ...Object.entries(summary.reasons).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([reason, count]) => `- ${reason}: ${count}개`),
    '', '## 애매함 (두 답이 다름 — 노트에 쓰지 않음, 오너 확인)', ...summary.ambiguous.map((item) => `- ${item.rel}: ${item.answers.join(' / ')}`),
    '', '## 실패', ...summary.invalid.map((item) => `- ${item.rel}: ${item.reason}`), ''].join('\n');
  if (existsSync(reportPath)) chmodSync(reportPath, 0o600);
  appendFileSync(reportPath, `${report}\n`, { mode: 0o600 });
  chmodSync(reportPath, 0o600);
  output.log(report);
  return summary;
}

export async function reclassify(options = {}) {
  if (options.dryRun) return reclassifyUnlocked(options);
  const statePath = join(options.root ?? VAULT_PATHS.root, STATE_REL);
  mkdirSync(dirname(statePath), { recursive: true });
  return withLock(statePath, () => reclassifyUnlocked(options), { retries: 0 });
}

export async function run({ root = VAULT_PATHS.root, dryRun = false, now = new Date(), judge, cooldown = cooldownActive,
  charter, write = writeAtomic, maxNotes = MAX_NOTES, rules, criteria = loadEmotionCriteria(), output = console,
  cues = attachAudioCues, engine = 'claude', judgmentsPath, unload = unloadOllamaModel, invoke, anchors } = {}) {
  assertEngine(engine);
  const today = kstDate(now);
  const recordPath = judgmentsPath ?? defaultJudgmentsPath(root);
  const quota = engine === 'claude' ? cooldown : () => false; // 쿨다운은 Claude 구독 사용량 가드다.
  const cutoff = kstDate(new Date(now.getTime() - SETTLE_DAYS * 86_400_000));
  const statePath = join(root, STATE_REL);
  const job = async () => {
    const state = readJson(statePath, { skipped: {} });
    state.skipped ??= {};
    // Claude 모델 이름은 헌장에서 온다. 같은 판(애매함 포함) 거르기에 쓰므로 대상 고르기 전에 정한다.
    const agent = engine === 'claude' ? charter ?? loadAgent('athena', { fallbackModel: 'sonnet' }) : null;
    const version = { engine, model: engine === 'ollama' ? OLLAMA_MODELS.text : agent.model,
      criteriaRef: criteria.ref ?? null, promptVersion: PROMPT_VERSIONS[engine] };
    const rows = readJudgments(recordPath);
    const targets = findTargets(root, { skipped: state.skipped, cutoff, judged: judgedNotes(rows, version) });
    const summary = { today, targets: targets.length, written: [], skipped: [], invalid: [], ambiguous: [], unchanged: [], errors: 0, remaining: 0 };
    if (!targets.length) {
      output.log('[mine-athena-fields] 대상 없음');
      if (!dryRun) {
        summary.secondFilmSignalTrend = recentSignalTrend(root, today, criteria);
        output.log(`[mine-athena-fields] 최근 신호 추이 ${JSON.stringify(summary.secondFilmSignalTrend)}`);
      }
      return summary;
    }
    const room = dailyRoom(engine, rows, today);
    const batch = targets.slice(0, Math.min(maxNotes, room));
    summary.remaining = targets.length - batch.length;
    if (room < Math.min(maxNotes, targets.length)) {
      summary.capped = true;
      output.log(`[mine-athena-fields] Claude 하루 상한(${DAILY_CLAUDE_CALLS}번): 오늘 남은 기록 ${room}개만 고름`);
    }
    if (!batch.length) return summary;
    if (dryRun) {
      output.log(`[mine-athena-fields] 대상 ${targets.length}개(이번 묶음 ${batch.length}개, dry-run — 판단 호출·쓰기 없음)`);
      for (const item of batch) output.log(`  ${item.rel}`);
      return summary;
    }
    if (quota()) return { ...summary, cooldown: true };

    if (agent?.warning) output.error(`[mine-athena-fields] ${agent.warning}`);
    const decide = judge ?? (engine === 'ollama' ? ollamaDecision({ criteria, output, invoke })
      : (prompt) => restrictedDecision(prompt, agent, { output }));
    const signalTrendBefore = recentSignalTrend(root, today, criteria);
    await cues(batch, { root });
    if (quota()) return { ...summary, cooldown: true };
    let proposals;
    try {
      const activeAnchors = anchors ?? loadEmotionAnchors();
      proposals = await judgeItems(batch, { decide, deadline: Date.now() + MAX_JOB_MS, quota,
        runs: engine === 'claude' ? CLAUDE_RUNS : 1,
        prompt: (items) => buildOllamaPrompt(items, { criteria, signalTrend: signalTrendBefore, anchors: activeAnchors }),
        validate: (raw, items) => validateOllamaProposals(raw, items, { criteria }) });
    } finally {
      if (engine === 'ollama' && !judge) await unload(OLLAMA_MODELS.text).catch((error) => output.error(`[mine-athena-fields] 모델 내리기 실패: ${error.message}`));
    }
    const append = judgmentRecorder(recordPath, summary, output);
    const record = (item, proposal, status, reason) => append(judgmentRow(item, proposal, status, { version, mode: 'initial', today, reason }));
    const activeRules = rules ?? parseRegistry(readFileSync(join(root, VAULT_REL.registryFile), 'utf8'));

    for (const [index, item] of batch.entries()) {
      const proposal = proposals.get(index + 1);
      if (proposal?.ambiguous) {
        summary.ambiguous.push({ rel: item.rel, answers: proposal.answers.map(answerKey) });
        record(item, proposal, 'ambiguous');
        continue;
      }
      if (!proposal || proposal.error) {
        // 쿨다운으로 미룬 기록은 실패가 아니다 — 다음 회차에 다시 묻는다.
        if (proposal?.cooldown) summary.cooldown = true;
        else summary.invalid.push({ rel: item.rel, reason: proposal?.error ?? '제안 없음' });
        if (proposal?.unavailable) summary.unavailable = true;
        record(item, proposal, 'retry', proposal?.error ?? '제안 없음');
        continue;
      }
      const age = mineAge(item.occurred);
      if (age === null) {
        summary.invalid.push({ rel: item.rel, reason: `나이 계산 불가(occurred ${item.occurred})` });
        record(item, proposal, 'retry', `나이 계산 불가(occurred ${item.occurred})`);
        continue;
      }
      const absolute = join(root, item.rel);
      try {
        const owner = ownerMemoEmotions(item.content, criteria);
        const fields = { ...proposal.fields };
        if (owner.length) {
          fields.emotions = owner;
          fields.primaryEmotion = owner.includes(item.fields.primaryEmotion) ? item.fields.primaryEmotion : owner[0];
        }
        validateEmotionResult(fields, { recordDate: item.date, ownerEmotions: owner, criteria });
        // 야간 전사 잡과 같은 노트 단위 락. 판단에 사용한 내용과 지금 내용이 다르면 쓰지 않고 다음 주에 다시 본다.
        const outcome = await withLock(absolute, () => {
          const latest = readFileSync(absolute, 'utf8');
          if (latest !== item.content) return 'changed';
          const next = applyFields(latest, fields, age, today);
          if (!next) return 'unchanged';
          assertFrontmatterRoundTrip(next, { ...fields, mineAge: age });
          const problems = checkNote(item.rel, next, activeRules);
          if (problems.length) throw new Error(`쓰기 관문: ${problems.join('; ')}`);
          write(absolute, next);
          return 'written';
        });
        if (outcome === 'written') summary.written.push({ rel: item.rel, ...fields });
        else if (outcome === 'changed') summary.invalid.push({ rel: item.rel, reason: '판단 중 노트가 바뀜' });
        else summary.unchanged.push(item.rel);
        record(item, { ...proposal, fields }, outcome === 'written' ? 'applied' : 'retry',
          outcome === 'written' ? undefined : outcome === 'changed' ? '판단 중 노트가 바뀜' : '쓸 수 없는 머리말');
      } catch (error) {
        summary.errors += 1;
        summary.invalid.push({ rel: item.rel, reason: error.message });
        record(item, proposal, 'retry', error.message);
      }
    }
    output.log(`[mine-athena-fields] 기록 ${summary.written.length}, 애매함 ${summary.ambiguous.length}, 다음 주 재시도 ${summary.invalid.length}, 그대로 ${summary.unchanged.length}, 남은 대상 ${summary.remaining}`);
    for (const item of summary.ambiguous) output.log(`  애매함 ${item.rel} — ${item.answers.join(' / ')}`);
    for (const item of summary.invalid) output.log(`  재시도 ${item.rel} — ${item.reason}`);
    summary.secondFilmSignalTrend = recentSignalTrend(root, today, criteria);
    output.log(`[mine-athena-fields] 최근 신호 추이 ${JSON.stringify(summary.secondFilmSignalTrend)}`);
    return summary;
  };
  if (dryRun) return job();
  // 잡 단위 락 — launchd와 수동 실행이 겹치면 두 번째는 바로 실패한다(claude 중복 호출·상태 파일 덮어쓰기 방지).
  mkdirSync(dirname(statePath), { recursive: true });
  return withLock(statePath, job, { retries: 0 });
}

// 쓰기 관문·락 오류가 있거나, 대상이 있었는데 하나도 처리하지 못하면 실패로 본다(health-watcher가 알 수 있게).
// Ollama가 멈춘 회차(unavailable)는 사람이 봐야 하므로 실패로 본다. 애매함은 처리한 것이다(오너에게 넘김).
export function failed(summary) {
  if (summary.unavailable || summary.recordErrors || summary.errors > 0) return true;
  if (summary.cooldown || !summary.targets) return false;
  return summary.errors > 0 || (summary.invalid.length > 0 && !summary.written.length && !summary.skipped.length && !summary.ambiguous?.length);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  if (!args.every((arg) => ['--dry-run', '--reclassify'].includes(arg) || /^--limit=\d+$/.test(arg) || /^--engine=(claude|ollama)$/.test(arg)
    || /^--ids=[^=]+$/.test(arg) || /^--kind=(통화|녹음|all)$/.test(arg) || arg === '--include-unclassified' || /^--since=\d{4}-\d{2}-\d{2}$/.test(arg) && occurredDate(arg.slice(8)) === arg.slice(8)) ||
    (args.some((arg) => arg.startsWith('--ids=') || arg.startsWith('--kind=') || arg.startsWith('--since=') || arg === '--include-unclassified') && !args.includes('--reclassify'))) {
    console.error('usage: mine-athena-fields.mjs [--engine=claude|ollama] [--reclassify] [--kind=통화|녹음|all] [--include-unclassified] [--since=YYYY-MM-DD] [--dry-run] [--ids=id1,id2] [--limit=N]');
    process.exit(2);
  }
  const limit = args.find((arg) => arg.startsWith('--limit='));
  const options = { dryRun: args.includes('--dry-run'), maxNotes: limit ? Number(limit.slice(8)) : MAX_NOTES,
    engine: args.find((arg) => arg.startsWith('--engine='))?.slice(9) ?? 'claude' };
  const ids = args.find((arg) => arg.startsWith('--ids='))?.slice(6).split(',');
  const kind = args.find((arg) => arg.startsWith('--kind='))?.slice(7) ?? '녹음';
  const since = args.find((arg) => arg.startsWith('--since='))?.slice(8);
  (args.includes('--reclassify') ? reclassify({ ...options, ids, kind, since, includeUnclassified: args.includes('--include-unclassified') }) : run(options))
    .then((summary) => { if (args.includes('--reclassify') ? summary.invalid.length || summary.unavailable || summary.recordErrors : failed(summary)) process.exitCode = 1; })
    .catch((error) => { console.error(`[mine-athena-fields] 실패: ${error.message}`); process.exitCode = 1; });
}
