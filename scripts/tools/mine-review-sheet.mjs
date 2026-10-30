#!/usr/bin/env node
/**
 * 미네 판단 3단계: 첫 검수 시트(기억 판단 체계 §15.3 3단계, §10.5 3단계 + §12 가족 라벨 표본을 한 시트로).
 * 2026-10-30 오너 "3단계 검수 시트 만들기".
 *
 * 하는 일(볼트·노트·판단 기록은 쓰지 않는다 — 결과는 볼트 밖 `Media/MemoryOrb/review/<판>/`에만.
 * 소리 근거가 없는 녹음은 잡과 같이 쓰는 `Media/AudioCues/` 캐시를 채운다):
 *   1. 표본: 기준 예시에 쓰지 않은 2023년~ 통화·녹음 노트에서 정해진 씨앗으로 24개(통화·녹음 비율 유지).
 *   2. 판단: 지금 Claude 판(시험 도구와 같은 프롬프트 — buildOllamaPrompt + 기준 예시, 재분류 모양)으로 기록마다
 *      **두 번** 묻는다(같은 질문에도 답이 흔들려서, 두 번 다르면 '애매함'). 쿨다운 가드를 지난다.
 *      다시 돌리면 이미 판단한 기록은 건너뛴다(results.jsonl).
 *   3. 시트: 미네 첫 발화 근처 90초 소리 + 모델이 본 전사. 오너가 먼저 감정·강도를 고르고 나서야 모델 답이 열린다.
 *      그다음 틀린 유형을 고른다. 답은 브라우저에 저장되고 JSON으로 내려받는다.
 *
 * 미네 목소리가 들어가므로 시트는 이 맥 안에서만 연다(외부 게시 금지). 소리는 Claude로 보내지 않는다 — Claude에는
 * 잡과 같은 글(전사·소리 근거 요약)만 간다(결정 `미네-감정-분류` §1 보강).
 *
 * 애매함 검수(2026-10-31 오너 "검수 시트로 모아서"): 잡(v1.0)이 두 답이 갈려 노트에 쓰지 않은 기록을 같은 모양의
 * 시트로 모으고(--ambiguous), 오너 답을 노트 감정 필드에 쓴다(--apply). 오너가 정한 노트는 판단 기록에 engine 'owner'로
 * 남아 어느 판으로도 다시 묻지 않는다. 첫 검수 24개의 오너 답도 같은 --apply로 쓴다.
 *
 * 사용:
 *   node scripts/tools/mine-review-sheet.mjs --dry-run   # 표본만 보여 줌(호출·파일 쓰기 없음)
 *   node scripts/tools/mine-review-sheet.mjs             # 판단(남은 것만) → 시트
 *   node scripts/tools/mine-review-sheet.mjs --ambiguous # 애매함 기록 → 시트(+ 번호표 cards-*.json)
 *   node scripts/tools/mine-review-sheet.mjs --apply <답.json> <cards-*.json> [--dry-run]  # 오너 답 → 노트
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, readdirSync, rmSync, mkdtempSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { VAULT_PATHS, VAULT_REL } from '../lib/vault-paths.mjs';
import { MAX_EVIDENCE_CHARS, loadEmotionCriteria, validateEmotionResult } from '../lib/mine-emotion-criteria.mjs';
import { OWNER_ENGINE, OWNER_EVIDENCE, appendJudgment, ownerDecided, readJudgments } from '../lib/mine-judgment.mjs';
import { assertFrontmatterRoundTrip, parseFrontmatter } from '../lib/vault-frontmatter.mjs';
import { checkNote, parseRegistry } from '../lib/vault-registry.mjs';
import { withLock, writeAtomic } from '../lib/state-writer.mjs';
import { parseJsonBlock } from '../lib/headless-claude.mjs';
import { cooldownActive } from '../lib/quota-cooldown.mjs';
import { loadAgent } from '../lib/agent-loader.mjs';
import { attachAudioCues, loadArchivePaths, noteMediaIds } from '../lib/media-audio-cues.mjs';
import { mineConversation } from '../lib/mine-record-input.mjs';
import { CONVERSATIONS_REL, EMOTION_KEYS, buildOllamaPrompt, defaultJudgmentsPath, findTargets, mineAge, occurredDate, replaceEmotionFields, restrictedDecision, validateOllamaProposals, PROMPT_VERSIONS } from '../jobs/mine-athena-fields.mjs';
import { loadEmotionAnchors } from '../lib/mine-judgment-prompt.mjs';
import { ANCHOR_ROOT, ANCHOR_SET } from './mine-anchor-trial.mjs';

export const REVIEW_ROOT = join(homedir(), 'Pantheon', 'Media', 'MemoryOrb', 'review');
export const SAMPLE_COUNT = 24;
export const SAMPLE_SINCE = '2023-01-01';
export const SAMPLE_SEED = 'review-2026-10-30';
export const RUNS = 2;
export const CLIP_SECONDS = 90;
// 오너가 고를 틀린 유형(§10.5 3단계의 다섯 유형을 감정 판단에 맞춰 풀어 씀).
export const FAILURE_TYPES = Object.freeze(['맞음', '강도만 다름', '감정이 다름', '감정 있음↔없음·모름', '근거가 기록에 없음', '기준을 잘못 읽음']);
export const EMOTION_CHOICES = Object.freeze(['기쁨', '슬픔', '버럭', '까칠', '소심', '감정 없음', '모름']);

const hash = (value) => createHash('sha256').update(value).digest('hex');

// 기준 예시로 쓴 노트(시트의 text 항목)는 표본에서 뺀다 — 정답이 이미 프롬프트에 있다.
export function anchorRefs(items) {
  return new Set(items.map((item) => item.ref).filter((ref) => /^20_Records\/.+\.md$/.test(ref ?? '')));
}

// 감정 낱말(기준 예시 확정 시트의 후보 고르기 목록, 2026-10-19 anchors/shortlist.py와 같음). 미네 발화에서만 찾는다.
export const EMOTION_HINT = /좋아|재밌|신나|최고|사랑해|ㅋㅋ|하하|헤헤|보고 ?싶|속상|흑|엉엉|서운|싫어|하지 ?마|짜증|아니라고|그만|무서|겁나|못 ?하겠|어떡해|떨려|냄새|더러|맛없|이상해|별로/;

export function emotionHint(content) {
  return EMOTION_HINT.test([...content.matchAll(/^미네: (.*)$/gm)].map((match) => match[1]).join('\n'));
}

// §10.5 2단계 "무작위 + 경계 사례": 절반은 무작위, 절반은 미네 말에 감정 낱말이 있는 기록. 정해진 씨앗으로 섞는다.
// 녹음은 전체 비율만큼(최소 1개) 먼저 채운다.
export function sampleRecords(targets, exclude, { count = SAMPLE_COUNT, since = SAMPLE_SINCE, seed = SAMPLE_SEED } = {}) {
  const pool = targets.filter((item) => item.date >= since && !exclude.has(item.rel))
    .sort((a, b) => hash(`${seed}:${a.rel}`).localeCompare(hash(`${seed}:${b.rel}`)));
  const recordings = pool.filter((item) => item.fields?.convKind === '녹음');
  const want = recordings.length ? Math.max(1, Math.round(count * recordings.length / pool.length)) : 0;
  const picked = [...recordings.slice(0, want)];
  const take = (list, limit) => { for (const item of list) { if (picked.length >= limit) break; if (!picked.includes(item)) picked.push(item); } };
  take(pool.filter((item) => emotionHint(item.content)), Math.ceil(count / 2) + picked.length);
  take(pool, count);
  return picked.sort((a, b) => a.date.localeCompare(b.date) || a.rel.localeCompare(b.rel, 'ko'));
}

// 첫 "미네:" 줄이 시작되는 녹음과 초. 전사 조각 글자와 겹치는 곳을 찾는다(띄어쓰기 무시). 못 찾으면 첫 녹음 0초.
export function firstMineStart(content, transcripts) {
  const squash = (text) => String(text ?? '').replace(/[\s.,!?…~]/g, '');
  const ids = noteMediaIds(content);
  const line = content.match(/^미네: (.+)$/m)?.[1];
  const probe = squash(line).slice(0, 8);
  if (probe.length >= 3) {
    for (const id of ids) {
      const segment = (transcripts.get(id)?.segments ?? []).find((seg) => squash(seg.text).includes(probe) || probe.includes(squash(seg.text)) && squash(seg.text).length >= 3);
      if (segment) return { id, seconds: Math.max(0, segment.start / 1000 - 2) };
    }
  }
  return { id: ids[0] ?? null, seconds: 0 };
}

function transcriptFor(root, id) {
  const base = join(root, VAULT_REL.mediaTranscripts);
  if (!existsSync(base)) return null;
  for (const year of readdirSync(base)) {
    const path = join(base, year, `${id}.json`);
    if (existsSync(path)) return JSON.parse(readFileSync(path, 'utf8'));
  }
  return null;
}

// 판단 한 번 → 시트에 보일 모양.
export function runView(proposal, error) {
  if (error) return { error };
  if (!proposal?.fields) return { error: proposal?.error ?? '제안 없음' };
  const { fields } = proposal;
  const got = fields.primaryEmotion ? `${fields.primaryEmotion} ${fields.emotionIntensity}`
    : proposal.emotionState === '모름' ? '모름' : '감정 없음';
  return { got, emotions: fields.emotions, evidence: fields.emotionEvidence, nearestAnchor: proposal.nearestAnchor ?? null };
}

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

// 시트 HTML. cards: [{ no, title, date, age, kind, text, audio(data URL|null), runs:[{got,evidence,error}] }]
export function renderSheet(cards, { title, storageKey, downloadName, promptVersion }) {
  const card = (c) => {
    const runs = c.runs.map((run, index) => `<li>${index + 1}회: <b>${escapeHtml(run.got ?? `오류 — ${run.error}`)}</b>${run.evidence ? ` — ${escapeHtml(run.evidence)}` : ''}</li>`).join('');
    const agree = new Set(c.runs.map((run) => run.got ?? 'error')).size === 1;
    return `<section class="card" data-no="${c.no}" data-title="${escapeHtml(c.title)}">
<h2>${c.no}. ${escapeHtml(c.title)}</h2>
<p class="meta">${escapeHtml(c.date)} · 미네 ${escapeHtml(c.age)} · ${escapeHtml(c.kind)}</p>
${c.audio ? `<audio controls preload="none" src="${c.audio}"></audio>` : '<p class="none">소리 없음</p>'}
<details><summary>모델이 본 전사</summary><pre>${escapeHtml(c.text)}</pre></details>
<div class="step"><b>① 오너 판단</b><div class="row emo">${EMOTION_CHOICES.map((emo) => `<button data-k="emo" data-v="${emo}">${emo}</button>`).join('')}</div>
<div class="row int">${[1, 2, 3].map((n) => `<button data-k="int" data-v="${n}">${['', '옅음 1', '보통 2', '짙음 3'][n]}</button>`).join('')}</div></div>
<div class="model" hidden><b>② 모델 답${agree ? '' : ' <span class="warn">두 번 답이 다름</span>'}</b><ul>${runs}</ul>
<b>③ 틀린 유형</b><div class="row type">${FAILURE_TYPES.map((type) => `<button data-k="type" data-v="${type}">${type}</button>`).join('')}</div></div>
<textarea data-k="memo" placeholder="메모(선택)"></textarea>
</section>`;
  };
  return `<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title>
<style>body{font-family:system-ui,sans-serif;margin:0;padding:16px;max-width:760px;margin:auto;background:#fafafa;color:#222}header{position:sticky;top:0;background:#fafafa;padding:8px 0;border-bottom:1px solid #ddd;z-index:1}
.card{background:#fff;border:1px solid #ddd;border-radius:10px;padding:12px 14px;margin:14px 0}.card.done{border-color:#2a8a4a}h2{font-size:1.05rem;margin:0 0 4px}.meta{color:#666;margin:0 0 6px;font-size:.9rem}
audio{width:100%;margin:6px 0}pre{white-space:pre-wrap;font-size:.85rem;background:#f4f4f4;padding:8px;border-radius:6px;max-height:320px;overflow:auto}
.row{display:flex;flex-wrap:wrap;gap:6px;margin:6px 0}button{font:inherit;padding:6px 10px;border:1px solid #bbb;border-radius:16px;background:#fff}button.on{background:#2a6fd6;color:#fff;border-color:#2a6fd6}button:disabled{opacity:.35}
.model{margin-top:8px;padding-top:8px;border-top:1px dashed #ccc}.warn{color:#b35b00;font-size:.85rem}textarea{width:100%;box-sizing:border-box;margin-top:6px;min-height:2.4rem}.none{color:#999}ul{padding-left:18px;margin:4px 0}</style>
<header><b>${escapeHtml(title)}</b> · 프롬프트 ${escapeHtml(promptVersion)}<br><span id="progress"></span> <button id="dl">답 내려받기</button> <span id="sync" style="font-size:.85rem;color:#2a8a4a"></span>
<p style="font-size:.85rem;color:#555;margin:4px 0">감정과 강도를 먼저 고르면 모델 답이 열립니다. 감정 없음·모름은 강도 없이 고르면 됩니다.</p></header>
${cards.map(card).join('\n')}
<script>
const KEY=${JSON.stringify(storageKey)};let A={};try{A=JSON.parse(localStorage.getItem(KEY)||'{}')}catch(e){}
const cards=[...document.querySelectorAll('.card')];
function clean(){for(const c of cards){const a=A[c.dataset.no];if(a&&a.t&&a.t!==c.dataset.title)delete A[c.dataset.no]}}clean();
const SERVED=location.protocol.startsWith('http');let pushT=null;
function push(){if(!SERVED)return;clearTimeout(pushT);pushT=setTimeout(()=>fetch('answers',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(A)})
.then((r)=>{document.getElementById('sync').textContent=r.ok?'맥에 저장됨':'맥 저장 실패'}).catch(()=>{document.getElementById('sync').textContent='맥 저장 실패(브라우저에는 남음)'}),800)}
function save(){try{localStorage.setItem(KEY,JSON.stringify(A))}catch(e){};render();push()}
function ready(a){return a&&a.emo&&(a.emo==='감정 없음'||a.emo==='모름'||a.int)}
function render(){let done=0;for(const c of cards){const no=c.dataset.no,a=A[no]||{};
for(const b of c.querySelectorAll('button[data-k]'))b.classList.toggle('on',String(a[b.dataset.k])===b.dataset.v);
const flat=a.emo==='감정 없음'||a.emo==='모름';for(const b of c.querySelectorAll('.int button'))b.disabled=flat;
c.querySelector('.model').hidden=!ready(a);const t=c.querySelector('textarea');if(document.activeElement!==t)t.value=a.memo||'';
const ok=ready(a)&&a.type;c.classList.toggle('done',!!ok);if(ok)done++}
document.getElementById('progress').textContent='끝낸 기록 '+done+' / '+cards.length}
for(const c of cards){const no=c.dataset.no;
for(const b of c.querySelectorAll('button[data-k]'))b.onclick=()=>{const a=A[no]=A[no]||{};a.t=c.dataset.title;a[b.dataset.k]=b.dataset.k==='int'?Number(b.dataset.v):b.dataset.v;if(a.emo==='감정 없음'||a.emo==='모름')delete a.int;save()};
c.querySelector('textarea').oninput=(e)=>{const a=A[no]=A[no]||{};a.t=c.dataset.title;a.memo=e.target.value;try{localStorage.setItem(KEY,JSON.stringify(A))}catch(err){};push()}}
document.getElementById('dl').onclick=()=>{const b=new Blob([JSON.stringify(A,null,1)],{type:'application/json'});const u=URL.createObjectURL(b);const a=document.createElement('a');a.href=u;a.download=${JSON.stringify(downloadName)};a.click()};
render();if(SERVED)fetch('answers').then((r)=>r.json()).then((s)=>{A={...s,...A};clean();try{localStorage.setItem(KEY,JSON.stringify(A))}catch(e){};render();if(Object.keys(A).length)push()}).catch(()=>{});
</script></html>
`;
}

function clipAudio(source, seconds, duration = CLIP_SECONDS) {
  const dir = mkdtempSync(join(tmpdir(), 'mine-review-'));
  try {
    const out = join(dir, 'clip.m4a');
    const result = spawnSync('ffmpeg', ['-loglevel', 'error', '-y', '-ss', String(seconds), '-t', String(duration), '-i', source,
      '-vn', '-ac', '1', '-c:a', 'aac', '-b:a', '32k', out], { encoding: 'utf8', timeout: 60_000 });
    if (result.status !== 0) throw new Error(`소리 자르기 실패: ${(result.stderr || '').slice(0, 200)}`);
    return `data:audio/mp4;base64,${readFileSync(out).toString('base64')}`;
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

// 시트 카드: 소리 90초 + 모델이 본 전사(잡과 같은 추림). runsOf(item) → 시트에 보일 답들.
function buildCards(items, runsOf, { root, mediaRoot, clip, output }) {
  const archive = loadArchivePaths(root);
  return items.map((item, index) => {
    const transcripts = new Map(noteMediaIds(item.content).map((id) => [id, transcriptFor(root, id)]));
    const start = firstMineStart(item.content, transcripts);
    const source = start.id && archive.get(start.id)?.archivePath;
    let audio = null;
    try { if (source && existsSync(join(mediaRoot, source))) audio = clip(join(mediaRoot, source), start.seconds); }
    catch (error) { output.error(`${item.rel}: ${error.message}`); }
    return { no: index + 1, rel: item.rel, title: item.rel.split('/').pop().replace(/\.md$/, ''), date: item.date, age: `만 ${mineAge(item.occurred)}세`,
      kind: item.fields.convKind, text: mineConversation(item.content).text, audio, runs: runsOf(item) };
  });
}

// 시트 번호 → 노트 경로·제목. --apply가 이 표로 오너 답을 노트에 잇고, 제목으로 어긋남을 막는다.
// 같은 이름이 이미 있으면 덮지 않는다(예전 답이 새 번호에 붙는 것을 막음).
function writeCardIndex(path, cards) {
  writeFileSync(path, `${JSON.stringify(cards.map(({ no, rel, title }) => ({ no, rel, title })), null, 1)}\n`, { mode: 0o600, flag: 'wx' });
}

export async function run({ root = VAULT_PATHS.root, mediaRoot = join(homedir(), 'Pantheon', 'Media'), anchorRoot = ANCHOR_ROOT,
  out = REVIEW_ROOT, dryRun = false, criteria = loadEmotionCriteria(), anchors, charter, claude, cooldown = cooldownActive,
  cues = attachAudioCues, clip = clipAudio, output = console, count = SAMPLE_COUNT } = {}) {
  const items = JSON.parse(readFileSync(join(anchorRoot, `items-${ANCHOR_SET}.json`), 'utf8'));
  const targets = findTargets(root, { reclassify: true, kind: 'all', includeUnclassified: true });
  const sample = sampleRecords(targets, anchorRefs(items), { count });
  const version = PROMPT_VERSIONS.ollama;
  output.log(`표본 ${sample.length}개(2023년~, 기준 예시 제외, 녹음 ${sample.filter((item) => item.fields.convKind === '녹음').length}개) — 프롬프트 ${version}`);
  if (dryRun) {
    for (const item of sample) output.log(`  ${item.date} ${item.fields.convKind} ${item.rel.split('/').pop()}`);
    return { sample };
  }
  const runDir = join(out, version.split('/').pop());
  mkdirSync(runDir, { recursive: true, mode: 0o700 });
  const resultsPath = join(runDir, 'results.jsonl');
  // 오류가 섞인 행은 끝난 것으로 치지 않는다(다시 돌리면 다시 묻고, 뒤에 쓴 행이 앞 행을 덮는다). 잘린 줄은 건너뛴다.
  const done = new Map();
  for (const line of existsSync(resultsPath) ? readFileSync(resultsPath, 'utf8').split('\n').filter(Boolean) : []) {
    let row;
    try { row = JSON.parse(line); } catch { output.error(`results.jsonl 깨진 줄 건너뜀: ${line.slice(0, 80)}`); continue; }
    if (row.runs.every((entry) => !entry.error)) done.set(row.rel, row);
  }
  const agent = charter ?? loadAgent('athena', { fallbackModel: 'sonnet' });
  const ask = claude ?? ((prompt) => restrictedDecision(prompt, agent, { output }));
  const activeAnchors = anchors ?? loadEmotionAnchors();
  let stopped = null;
  for (const item of sample) {
    if (done.has(item.rel)) continue;
    if (cooldown()) { stopped = 'Claude 쿨다운'; break; }
    await cues([item], { root });
    const prompt = buildOllamaPrompt([item], { reclassify: true, criteria, anchors: activeAnchors });
    const runs = [];
    for (let attempt = 0; attempt < RUNS; attempt += 1) {
      try {
        runs.push(runView(validateOllamaProposals(parseJsonBlock(await ask(prompt)), [item], { reclassify: true, criteria }).get(1)));
      } catch (error) {
        if (error.isLimit) { stopped = 'Claude 사용 한도'; break; }
        runs.push(runView(null, error.message));
      }
    }
    if (stopped) break;
    const row = { rel: item.rel, date: item.date, runs, at: new Date().toISOString() };
    appendFileSync(resultsPath, `${JSON.stringify(row)}\n`, { mode: 0o600 });
    done.set(item.rel, row);
    output.log(`${item.date} ${item.rel.split('/').pop()} — ${runs.map((run) => run.got ?? '오류').join(' / ')}`);
  }
  if (stopped) { output.log(`멈춤: ${stopped} — 다시 돌리면 남은 기록부터 이어서 한다`); return { sample, stopped }; }

  const cards = buildCards(sample, (item) => done.get(item.rel).runs, { root, mediaRoot, clip, output });
  const sheetPath = join(runDir, `review-sheet-${version.split('/').pop()}.html`);
  writeFileSync(sheetPath, renderSheet(cards, { title: '미네 감정 첫 검수', storageKey: `mine-review-${version}`,
    downloadName: `review-answers-${version.split('/').pop()}.json`, promptVersion: version }), { mode: 0o600 });
  // 번호표는 덮지 않는다. 오너가 정한 노트가 표본에서 빠지거나 새 노트가 들어오면 번호가 바뀌어,
  // 예전 답이 다른 노트에 붙을 수 있다 — 같은 번호표면 그대로 두고, 다르면 멈춘다.
  const cardsPath = join(runDir, `cards-${version.split('/').pop()}.json`);
  if (existsSync(cardsPath)) {
    const same = JSON.stringify(JSON.parse(readFileSync(cardsPath, 'utf8')).map(({ no, rel }) => [no, rel])) === JSON.stringify(cards.map(({ no, rel }) => [no, rel]));
    if (!same) throw new Error(`표본이 바뀌어 번호표가 달라짐 — 예전 답과 섞이지 않게 멈춤(새 판으로 만들 것): ${cardsPath}`);
  } else writeCardIndex(cardsPath, cards);
  const disagree = cards.filter((c) => new Set(c.runs.map((r) => r.got ?? 'error')).size > 1).length;
  output.log(`시트: ${sheetPath}\n기록 ${cards.length}개 · 두 번 답이 다른 기록 ${disagree}개 · 소리 없는 기록 ${cards.filter((c) => !c.audio).length}개`);
  return { sample, sheetPath, cards };
}

// 오너 확인을 기다리는 애매함: 지금 Claude 판의 마지막 기록이 ambiguous이고, 그 뒤에 오너 줄이 없는 노트.
export function pendingAmbiguous(rows, promptVersion = PROMPT_VERSIONS.claude) {
  const latest = new Map();
  for (const row of rows) {
    if (typeof row?.rel !== 'string') continue;
    if (row.engine === OWNER_ENGINE || (row.engine === 'claude' && row.promptVersion === promptVersion)) latest.set(row.rel, row);
  }
  return [...latest.values()].filter((row) => row.status === 'ambiguous' && Array.isArray(row.answers));
}

export async function ambiguousSheet({ root = VAULT_PATHS.root, mediaRoot = join(homedir(), 'Pantheon', 'Media'), out = REVIEW_ROOT,
  judgmentsPath = defaultJudgmentsPath(root), now = new Date(), clip = clipAudio, output = console } = {}) {
  const pending = pendingAmbiguous(readJudgments(judgmentsPath));
  if (!pending.length) { output.log('오너 확인을 기다리는 애매함 기록 없음'); return { cards: [] }; }
  const items = pending.flatMap((row) => {
    const path = join(root, row.rel);
    if (!existsSync(path)) { output.error(`노트 없음(옮겨졌으면 다음 판단 때 다시 잡힌다): ${row.rel}`); return []; }
    const content = readFileSync(path, 'utf8');
    const fields = parseFrontmatter(content);
    if (ownerDecided(fields)) return []; // 노트는 썼는데 판단 기록만 빠진 경우 — 이미 오너가 정했다.
    const date = occurredDate(fields.occurred);
    if (!date) { output.error(`날짜(occurred) 없음, 건너뜀: ${row.rel}`); return []; }
    return [{ rel: row.rel, content, fields, occurred: String(fields.occurred), date, answers: row.answers }];
  }).sort((a, b) => a.date.localeCompare(b.date) || a.rel.localeCompare(b.rel, 'ko'));
  // 만들 때마다 다른 이름(KST 분 단위) — 같은 날 다시 만들어도 앞 시트의 답·번호표와 섞이지 않는다.
  const stamp = new Date(now.getTime() + 9 * 3_600_000).toISOString().slice(0, 16).replace(/[T:]/g, '-');
  const dir = join(out, `ambiguous-${stamp}`);
  mkdirSync(out, { recursive: true, mode: 0o700 });
  try { mkdirSync(dir, { mode: 0o700 }); } catch (error) {
    if (error.code === 'EEXIST') throw new Error(`이미 있는 시트 폴더(1분 뒤 다시): ${dir}`);
    throw error;
  }
  const cards = buildCards(items, (item) => item.answers.map((answer) => runView(answer)), { root, mediaRoot, clip, output });
  const sheetPath = join(dir, `review-sheet-ambiguous-${stamp}.html`);
  writeFileSync(sheetPath, renderSheet(cards, { title: '미네 감정 애매함 검수', storageKey: `mine-ambiguous-${stamp}`,
    downloadName: `review-answers-ambiguous-${stamp}.json`, promptVersion: PROMPT_VERSIONS.claude }), { mode: 0o600 });
  const cardsPath = join(dir, `cards-ambiguous-${stamp}.json`);
  writeCardIndex(cardsPath, cards);
  output.log(`시트: ${sheetPath}\n번호표: ${cardsPath}\n애매함 ${cards.length}개 · 소리 없는 기록 ${cards.filter((c) => !c.audio).length}개`);
  return { sheetPath, cardsPath, cards };
}

// 시트 답 하나 → 노트 감정 필드. 근거는 오너 판단이라고 적고 메모를 붙인다.
export function ownerFields(answer) {
  const memo = String(answer?.memo ?? '').trim();
  const evidence = `${OWNER_EVIDENCE}${memo ? `: ${memo}` : ''}`;
  const empty = { emotions: [], primaryEmotion: null, emotionIntensity: null, secondFilmSignal: null };
  if (answer?.emo === '감정 없음') return { ...empty, emotionEvidence: evidence.slice(0, MAX_EVIDENCE_CHARS) };
  if (answer?.emo === '모름') return { ...empty, emotionEvidence: `모름: ${evidence}`.slice(0, MAX_EVIDENCE_CHARS) };
  if (!EMOTION_CHOICES.includes(answer?.emo) || ![1, 2, 3].includes(answer?.int)) return null;
  return { emotions: [answer.emo], primaryEmotion: answer.emo, emotionIntensity: answer.int, secondFilmSignal: null,
    emotionEvidence: evidence.slice(0, MAX_EVIDENCE_CHARS) };
}

// 오너 답을 노트에 쓴다: 감정 다섯 필드만 바꾸고(중요도·나이 등은 그대로), 쓰기 전에 사전 상태를 백업하며,
// 판단 기록에 오너 줄을 남긴다. 고르지 않은 카드는 건너뛴다.
// 번호표가 이 답 파일과 같은 시트에서 나왔는지: cards-<판>.json ↔ review-answers-<판>.json.
function sheetStem(path, prefix) {
  return basename(path).match(new RegExp(`^${prefix}-(.+?)(?: \\(\\d+\\))?\\.json$`))?.[1] ?? null;
}

// 첫 분류(아테나 필드가 하나도 없던 노트)면 나이만 채운다. 중요도는 v3 재계산 때 정한다(오너 답에는 없음).
function withMineAge(content, before) {
  if (before.mineAge !== undefined) return content;
  const age = mineAge(before.occurred);
  if (age === null) return content;
  const end = content.indexOf('\n---', 4);
  return `${content.slice(0, end)}\nmineAge: ${age}${content.slice(end)}`;
}

// 오너 답을 노트에 쓴다: 감정 다섯 필드만 바꾸고(첫 분류면 나이 추가, 중요도 등은 그대로), 쓰기 전에 원래 머리말을
// 백업하며, 판단 기록에 오너 줄을 남긴다. 근거가 '오너 판단(검수 시트)'로 시작해 노트 자체가 오너 결정 표식이 된다.
// 카드마다 노트 경로·제목·답에 남은 제목을 대조해 어긋나면 그 카드는 쓰지 않는다.
export async function applyAnswers({ answersPath, cardsPath, root = VAULT_PATHS.root, out = REVIEW_ROOT,
  judgmentsPath = defaultJudgmentsPath(root), now = new Date(), dryRun = false, criteria = loadEmotionCriteria(),
  rules, write = writeAtomic, output = console } = {}) {
  const stem = sheetStem(cardsPath, 'cards');
  if (!stem || stem !== sheetStem(answersPath, 'review-answers')) {
    throw new Error(`답 파일과 번호표가 같은 시트가 아님(내려받은 이름이 바뀌었으면 review-answers-<판>.json으로 고쳐서 다시): ${basename(answersPath)} ↔ ${basename(cardsPath)}`);
  }
  const answers = JSON.parse(readFileSync(answersPath, 'utf8'));
  const cards = JSON.parse(readFileSync(cardsPath, 'utf8'));
  const today = new Date(now.getTime() + 9 * 3_600_000).toISOString().slice(0, 10);
  const activeRules = rules ?? parseRegistry(readFileSync(join(root, VAULT_REL.registryFile), 'utf8'));
  const backupPath = join(out, `owner-apply-backup-${today}.jsonl`);
  const summary = { applied: [], same: [], unanswered: [], partial: [], errors: [] };
  for (const { no, rel, title } of cards) {
    const answer = answers[String(no)];
    const fields = ownerFields(answer);
    if (!fields) { summary[answer?.emo ? 'partial' : 'unanswered'].push(rel); continue; }
    const absolute = join(root, rel);
    try {
      if (!rel.startsWith(`${CONVERSATIONS_REL}/`) || !rel.endsWith('.md') || rel.split('/').includes('..')) throw new Error('대화 노트 경로가 아님');
      if (!title || basename(rel, '.md') !== title) throw new Error(`번호표 제목과 노트 이름이 다름(${title})`);
      // 애매함 시트는 처음부터 답에 제목을 남긴다 — 없으면 손으로 고쳤거나 다른 시트 답이다.
      if (stem.startsWith('ambiguous-') && answer.t === undefined) throw new Error('답에 기록 제목(t)이 없음');
      if (answer.t !== undefined && answer.t !== title) throw new Error(`답을 고른 기록(${answer.t})과 번호표 기록이 다름`);
      if (dryRun) output.log(`  ${no}. ${title} → ${fields.primaryEmotion ? `${fields.primaryEmotion} ${fields.emotionIntensity}` : answer.emo}`);
      const outcome = await withLock(absolute, () => {
        const content = readFileSync(absolute, 'utf8');
        const end = content.startsWith('---\n') ? content.indexOf('\n---', 4) : -1;
        if (end < 0) throw new Error('머리말 없음');
        const head = content.slice(4, end);
        // 들여쓴 줄·블록 목록(폰 속성 편집기가 쓰는 모양)은 줄 단위 교체가 깨뜨릴 수 있어 손으로 정리한 뒤 다시 한다.
        if (/^([ \t]+\S|- )/m.test(head)) throw new Error('머리말에 블록 목록·들여쓴 줄이 있음');
        const before = parseFrontmatter(content);
        validateEmotionResult(fields, { recordDate: occurredDate(before.occurred), criteria });
        const next = withMineAge(replaceEmotionFields(content, fields, today), before);
        if (next === content) return 'same';
        const age = before.mineAge === undefined ? mineAge(before.occurred) : undefined;
        assertFrontmatterRoundTrip(next, { ...fields, ...(age != null ? { mineAge: age } : {}) });
        const problems = checkNote(rel, next, activeRules);
        if (problems.length) throw new Error(`쓰기 관문: ${problems.join('; ')}`);
        if (dryRun) return 'applied';
        mkdirSync(out, { recursive: true, mode: 0o700 });
        appendFileSync(backupPath, `${JSON.stringify({ rel, frontmatter: head, fields: Object.fromEntries([...EMOTION_KEYS, 'modified', 'mineAge'].map((key) => [key, before[key] ?? null])) })}\n`, { mode: 0o600 });
        chmodSync(backupPath, 0o600);
        write(absolute, next);
        return 'applied';
      });
      if (!dryRun) {
        try { appendJudgment(judgmentsPath, { rel, at: today, engine: OWNER_ENGINE, status: 'applied', source: basename(answersPath), fields }); }
        catch (error) { throw new Error(`노트는 썼으나 판단 기록 실패(노트 표식으로 보호됨, --apply 다시 하면 기록됨): ${error.message}`); }
      }
      summary[outcome].push(rel);
    } catch (error) {
      summary.errors.push({ rel, reason: error.message });
    }
  }
  output.log(`오너 답 ${dryRun ? '미리보기' : '반영'}: 씀 ${summary.applied.length} · 같음 ${summary.same.length} · 안 고름 ${summary.unanswered.length} · 강도 빠짐 ${summary.partial.length} · 오류 ${summary.errors.length}`);
  for (const rel of summary.partial) output.error(`  강도 빠짐(시트에서 강도를 골라 다시) ${rel}`);
  for (const error of summary.errors) output.error(`  오류 ${error.rel} — ${error.reason}`);
  return summary;
}

/**
 * 폰에서 검수(2026-10-30 오너 "모바일에서 확인"): 시트를 테일넷 주소에만 띄운다(외부 게시 아님 — 오너 기기끼리만).
 * 주소에 임의 토큰을 넣어 경로를 모르면 열리지 않고, 시트가 고를 때마다 보내는 답을 시트 옆 JSON으로 저장한다.
 */
// 테일넷(100.64.0.0/10)과 이 맥(127.0.0.1)만. 0.0.0.0·집 공유기 주소에는 띄우지 않는다.
export function allowedHost(host) {
  const parts = String(host).split('.').map(Number);
  return host === '127.0.0.1' || (parts.length === 4 && parts[0] === 100 && parts[1] >= 64 && parts[1] < 128);
}

export function serveSheet({ sheetPath, host, port = 8765, token = randomBytes(9).toString('base64url'), output = console }) {
  if (!allowedHost(host)) throw new Error(`테일스케일 주소(100.64~127.x.x)만 쓸 수 있다: ${host}`);
  const match = basename(sheetPath).match(/^review-sheet-(.+)\.html$/);
  if (!match) throw new Error(`시트 이름은 review-sheet-<판>.html 이어야 한다: ${sheetPath}`);
  const answersPath = join(dirname(sheetPath), `review-answers-${match[1]}.json`);
  const stored = () => (existsSync(answersPath) ? JSON.parse(readFileSync(answersPath, 'utf8')) : {});
  const server = createServer((req, res) => {
    const end = (code, body = '', type = 'text/plain; charset=utf-8') => { res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' }); res.end(body); };
    try {
      if (req.url === `/${token}/` && req.method === 'GET') return end(200, readFileSync(sheetPath), 'text/html; charset=utf-8');
      if (req.url === `/${token}/answers` && req.method === 'GET') return end(200, JSON.stringify(stored()), 'application/json; charset=utf-8');
      if (req.url !== `/${token}/answers` || req.method !== 'POST') return end(404);
    } catch (error) { output.error(`요청 실패: ${error.message}`); return end(500); }
    const chunks = []; let size = 0;
    req.on('data', (chunk) => { size += chunk.length; if (size > 1_000_000) { end(413); req.destroy(); } else chunks.push(chunk); });
    req.on('end', () => {
      let answers;
      try { answers = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return end(400); }
      if (!answers || typeof answers !== 'object' || Array.isArray(answers)) return end(400);
      // 기록 번호 단위로 합친다 — 빈 브라우저에서 한 번 눌러도 앞서 저장한 답이 지워지지 않게.
      try { writeFileSync(answersPath, JSON.stringify({ ...stored(), ...answers }, null, 1), { mode: 0o600 }); }
      catch (error) { output.error(`답 저장 실패: ${error.message}`); return end(500); }
      end(204);
    });
  });
  server.on('error', (error) => output.error(`서버를 띄우지 못함: ${error.code === 'EADDRINUSE' ? `${port}번 포트를 이미 쓰는 중` : error.message}`));
  server.listen(port, host, () => output.log(`폰에서 열 주소: http://${host}:${server.address().port}/${token}/\n답 저장: ${answersPath}\n끝나면 Ctrl+C`));
  return { server, token, answersPath };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const serve = args.indexOf('--serve');
  if (serve >= 0) {
    const [sheetPath, host] = args.slice(serve + 1);
    if (!sheetPath || !host) { console.error('사용: node scripts/tools/mine-review-sheet.mjs --serve <시트.html> <테일스케일 IP>'); process.exit(2); }
    serveSheet({ sheetPath, host });
  } else if (args[0] === '--apply') {
    const [answersPath, cardsPath] = args.slice(1, 3);
    if (!answersPath || !cardsPath || [answersPath, cardsPath].some((arg) => arg.startsWith('--')) || args.slice(3).some((arg) => arg !== '--dry-run')) { console.error('사용: node scripts/tools/mine-review-sheet.mjs --apply <답.json> <cards-*.json> [--dry-run]'); process.exit(2); }
    applyAnswers({ answersPath, cardsPath, dryRun: args.includes('--dry-run') })
      .then((summary) => { if (summary.errors.length) process.exitCode = 1; })
      .catch((error) => { console.error(`❌ ${error.message}`); process.exit(1); });
  } else if (args[0] === '--ambiguous') {
    if (args.length !== 1) { console.error('사용: node scripts/tools/mine-review-sheet.mjs --ambiguous'); process.exit(2); }
    ambiguousSheet().catch((error) => { console.error(`❌ ${error.message}`); process.exit(1); });
  } else {
    if (args.some((arg) => arg !== '--dry-run')) { console.error('사용: node scripts/tools/mine-review-sheet.mjs [--dry-run | --ambiguous | --apply <답.json> <cards-*.json> | --serve <시트.html> <테일스케일 IP>]'); process.exit(2); }
    run({ dryRun: args.includes('--dry-run') }).catch((error) => { console.error(`❌ ${error.message}`); process.exit(1); });
  }
}
