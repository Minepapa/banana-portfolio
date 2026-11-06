// 텔레그램 관문 진행 표시 — 메시지 하나를 단계별로 고쳐 "지금 무엇을 하는지"를 보여 준다(2026-10-30, 관문 2단계. 설계 7절, Q1 오너 안).
// 단계: 메시지 받음 → 처리 중(+도구 문구) → 답변 준비 중. 완료되면 지우고 최종 답은 새 메시지(푸시)로 보낸다.
// 이 파일은 순수 함수와 편집 간격 제한기만 둔다. 실제 발송·편집은 관문 데몬이 발송 관문(editAgentMessage)으로 한다.
// 진행 문구는 스크립트가 만든 사실이라 가는 선이다(결정 `텔레그램-메시지-구분`). 이모지는 렌더러가 지우므로 글로만 쓴다.
import { escapeHtml } from './telegram.mjs';
import { AGENT_IDS, agentTitle } from './agent-registry.mjs';

export const STAGE_RECEIVED = '메시지 받음';
export const STAGE_WORKING = '처리 중';
export const STAGE_ANSWERING = '답변 준비 중';
export const EDIT_MIN_INTERVAL_MS = 3000;
export const MAX_EDITS_FAST = 60;
export const SLOW_EDIT_INTERVAL_MS = 30_000;

// 관문 MCP 도구 이름표. 표에 없으면 도구 이름을 그대로 보인다(고정 목록을 늘려 가지 않는다).
const GATE_TOOL_LABELS = {
  calendar_add_event: '일정 등록',
  tasks_add: '할 일 등록',
  tasks_delete: '할 일 삭제',
  place_register: '장소 등록',
  photo_record: '사진 판독 기록',
  proposal_reply: '제안 답장 처리',
  wiki_question_resolve: '질문 큐 기록',
  department_facts: '담당 자료 조회',
  facts_tool: '사실 조회',
  order_stage: '주문 확인 준비',
  request_record: '개발 요청 기록',
};

function baseName(path) {
  const name = String(path ?? '').split('/').filter(Boolean).at(-1) ?? '';
  return name.replace(/\.md$/, '').slice(0, 30);
}

// 순수 함수: stream-json 이벤트 하나 → { stage?, step? } (해당 없으면 null).
// 하위 에이전트 안의 도구(parent_tool_use_id 있음)는 "담당이 일하는 중"으로 보고 단계 문구만 바꾼다.
export function describeEvent(event) {
  if (!event) return null;
  if (event.type === 'system' && event.subtype === 'init') return { stage: STAGE_WORKING };
  if (event.type === 'stream_event') {
    const block = event.event?.content_block;
    if (event.event?.type === 'content_block_start' && block?.type === 'text' && !event.parent_tool_use_id) return { stage: STAGE_ANSWERING };
    if (event.event?.type === 'content_block_start' && block?.type === 'thinking' && !event.parent_tool_use_id) return { stage: STAGE_WORKING, step: '생각 정리 중' };
    return null;
  }
  if (event.type === 'assistant') {
    const uses = (event.message?.content ?? []).filter((c) => c?.type === 'tool_use');
    if (!uses.length) return null;
    const use = uses.at(-1);
    const name = String(use.name ?? '');
    const inSub = Boolean(event.parent_tool_use_id);
    if (name === 'StructuredOutput') return { stage: STAGE_ANSWERING };
    let step;
    if (name.startsWith('mcp__gate__')) step = GATE_TOOL_LABELS[name.slice('mcp__gate__'.length)] ?? `도구 실행: ${name.slice('mcp__gate__'.length)}`;
    else if (name === 'Agent') {
      const type = String(use.input?.subagent_type ?? '');
      step = AGENT_IDS.includes(type) ? `${agentTitle(type)} 호출 중` : '도우미 호출 중';
    } else if (name === 'Read') step = `읽는 중: ${baseName(use.input?.file_path)}`;
    else if (name === 'Grep' || name === 'Glob') step = `볼트 검색(${String(use.input?.pattern ?? '').slice(0, 20)})`;
    else step = `도구 실행: ${name}`;
    return { stage: STAGE_WORKING, step: inSub ? `담당 작업 중 · ${step}` : step };
  }
  if (event.type === 'user') {
    const errored = (event.message?.content ?? []).some((c) => c?.type === 'tool_result' && c.is_error);
    if (errored && !event.parent_tool_use_id) return { stage: STAGE_WORKING, step: '도구 오류 → 다시 판단 중' };
  }
  return null;
}

// 상태: { stage, steps(최근 2개), stepCount, startedAt, queued, slow }
// ── 실시간 답 미리보기(속도 개선 2차 B-7) ─────────────────────────────────────────
// 실측(2026-11-06, sonnet): --json-schema 최종 답은 StructuredOutput 도구 입력으로 오고, --include-partial-messages면
// 그 입력이 input_json_delta 조각으로 흘러나온다({"messages": [{"body":"서울 … 처럼 글자 단위). 출력 계약을 바꾸지 않고
// 이 조각을 이어 붙여 지금 쓰고 있는 body(판단형이면 conclusion)를 꺼내 진행 메시지에 보여 준다. 최종 메시지는 지금처럼 발송 관문으로.
export const PREVIEW_MAX_CHARS = 600;
const PREVIEW_KEY_RE = /"(?:body|conclusion)"\s*:\s*"/g;

// 순수 함수: 덜 끝난 JSON 조각에서 마지막 body/conclusion 문자열 값을 지금까지 온 만큼 풀어 낸다. 없으면 null.
export function extractPartialBody(partialJson) {
  const text = String(partialJson ?? '');
  let start = -1;
  for (const m of text.matchAll(PREVIEW_KEY_RE)) start = m.index + m[0].length;
  if (start < 0) return null;
  let out = '';
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '"') break;
    if (ch !== '\\') { out += ch; continue; }
    const next = text[i + 1];
    if (next === undefined) break; // 이스케이프가 잘림 — 다음 조각에서
    if (next === 'u') {
      const hex = text.slice(i + 2, i + 6);
      if (hex.length < 4) break;
      out += String.fromCharCode(parseInt(hex, 16));
      i += 5;
      continue;
    }
    out += { n: '\n', t: '\t', r: '', '"': '"', '\\': '\\', '/': '/', b: '', f: '' }[next] ?? next;
    i += 1;
  }
  return out;
}

// 이벤트 → 미리보기 글(바뀌었을 때만) 또는 null. 최상위(하위 에이전트 아님) StructuredOutput 블록만 본다.
export function createAnswerPreview() {
  const blocks = new Map(); // 블록 index → 지금까지의 partial_json
  let last = null;
  return {
    feed(event) {
      if (event?.type !== 'stream_event' || event.parent_tool_use_id) return null;
      const ev = event.event ?? {};
      if (ev.type === 'message_start') { blocks.clear(); return null; }
      if (ev.type === 'content_block_start' && ev.content_block?.type === 'tool_use' && ev.content_block.name === 'StructuredOutput') { blocks.set(ev.index, ''); return null; }
      if (ev.type !== 'content_block_delta' || ev.delta?.type !== 'input_json_delta' || !blocks.has(ev.index)) return null;
      blocks.set(ev.index, blocks.get(ev.index) + String(ev.delta.partial_json ?? ''));
      const body = extractPartialBody(blocks.get(ev.index));
      if (body === null || body === last) return null;
      last = body;
      return body;
    },
  };
}

// 순수 함수: 미리보기 글 → 진행 메시지에 넣을 안전한 줄(HTML 태그·덜 끝난 태그 제거, 끝 600자, 이스케이프).
export function previewText(body) {
  const plainText = String(body ?? '').replace(/<[^>]*>/g, '').replace(/<[^>]*$/, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&').trim();
  if (!plainText) return '';
  const tail = plainText.length > PREVIEW_MAX_CHARS ? `…${plainText.slice(-PREVIEW_MAX_CHARS)}` : plainText;
  return escapeHtml(tail);
}

export function initialProgress({ startedAt, queued = 0 }) {
  return { stage: STAGE_RECEIVED, steps: [], stepCount: 0, startedAt, queued, slow: false };
}

export function applyProgress(state, change) {
  if (!change) return state;
  const next = { ...state, stage: change.stage ?? state.stage };
  if (change.step && change.step !== state.steps.at(-1)) {
    next.steps = [...state.steps, change.step].slice(-2);
    next.stepCount = state.stepCount + 1;
  }
  return next;
}

function elapsed(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

const LINE_WIDTH = 44;
const width = (s) => [...s].reduce((w, ch) => w + (/[\u1100-\uFFDC]/.test(ch) ? 2 : 1), 0);
function fit(line) {
  if (width(line) <= LINE_WIDTH) return line;
  let out = '';
  for (const ch of line) {
    if (width(`${out}${ch}…`) > LINE_WIDTH) break;
    out += ch;
  }
  return `${out}…`;
}

// 순수 함수: 진행 메시지 본문(헤더는 렌더러가 붙인다). 폰 한 줄 44칸 안(넘치면 줄 끝을 자른다).
export function renderProgress(state, nowMs) {
  const head = [state.stage, elapsed(nowMs - state.startedAt)];
  if (state.stepCount) head.push(`${state.stepCount}단계`);
  if (state.queued) head.push(`대기 ${state.queued}건`);
  const lines = [fit(head.join(' · '))];
  const [prev, last] = state.steps.length === 2 ? state.steps : [null, state.steps[0]];
  // 자른 뒤에 이스케이프한다(엔티티 중간에서 자르지 않게).
  if (last) lines.push(escapeHtml(fit(`· ${last}`)));
  if (prev) lines.push(escapeHtml(fit(`· 직전: ${prev}`)));
  const preview = state.preview ? previewText(state.preview) : '';
  if (preview) lines.push('', `<i>쓰는 중</i>\n${preview}`, '');
  if (state.slow) lines.push('오래 걸리고 있음 — 멈추려면 "취소"');
  else if (state.stage !== STAGE_RECEIVED) lines.push('취소하려면 "취소"');
  return lines.join('\n');
}

// 편집 간격 제한기: 최소 3초, 같은 문구면 건너뜀, 60회 넘으면 30초 간격. 429면 retry_after 동안 편집을 버린다.
// edit(text)는 Promise. flush()는 마지막 대기 문구를 즉시 보낸다(완료 직전에는 쓰지 않음 — 완료면 지운다).
// initialText: 진행 메시지를 처음 보낼 때의 문구(같은 문구로 다시 편집하지 않게).
export function createEditThrottle({ edit, now = () => Date.now(), setTimer = setTimeout, clearTimer = clearTimeout, log = () => {}, initialText = null }) {
  let lastSentText = initialText;
  // 진행 메시지는 만들자마자(sendMessage) 이 제한기를 붙인다 — 첫 편집도 그 발송에서 3초 뒤.
  let lastSentAt = now();
  let pending = null;
  let timer = null;
  let edits = 0;
  let blockedUntil = 0;
  let closed = false;
  let inflight = null;

  async function sendNow() {
    timer = null;
    if (closed || pending === null || pending === lastSentText) { pending = null; return; }
    if (now() < blockedUntil) { schedule(); return; }
    const text = pending;
    pending = null;
    lastSentAt = now();
    edits += 1;
    try {
      inflight = edit(text);
      await inflight;
      lastSentText = text;
    } catch (error) {
      if (/not modified/i.test(error?.message ?? '')) { lastSentText = text; return; }
      const retry = Number(error?.retryAfterSec ?? (/retry after (\d+)/i.exec(error?.message ?? '')?.[1]));
      if (Number.isFinite(retry)) blockedUntil = now() + retry * 1000;
      log(`진행 편집 실패: ${error?.message ?? error}`);
    } finally {
      inflight = null;
    }
  }

  function schedule() {
    if (timer || closed) return;
    const interval = edits >= MAX_EDITS_FAST ? SLOW_EDIT_INTERVAL_MS : EDIT_MIN_INTERVAL_MS;
    const wait = Math.max(0, lastSentAt + interval - now(), blockedUntil - now());
    timer = setTimer(() => { sendNow(); }, wait);
  }

  return {
    update(text) {
      if (closed) return;
      pending = text;
      schedule();
    },
    // 닫은 뒤 진행 중이던 편집이 끝날 때까지 기다릴 수 있게 Promise를 돌려준다 — 마지막 문구(취소함 등)를
    // 늦게 도착한 옛 편집이 덮지 않게(2단계 리뷰 LOW).
    close() {
      closed = true;
      if (timer) clearTimer(timer);
      timer = null;
      pending = null;
      return (inflight ?? Promise.resolve()).catch(() => {});
    },
    stats: () => ({ edits, lastSentText }),
  };
}
