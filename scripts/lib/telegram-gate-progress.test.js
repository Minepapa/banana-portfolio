import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyProgress, createEditThrottle, describeEvent, initialProgress, renderProgress, STAGE_ANSWERING, STAGE_RECEIVED, STAGE_WORKING } from './telegram-gate-progress.mjs';

const toolUse = (name, input = {}, parent = null) => ({ type: 'assistant', parent_tool_use_id: parent, message: { content: [{ type: 'tool_use', name, input }] } });

test('이벤트 → 단계·문구: 받음 → 처리 중(도구 문구) → 답변 준비 중', () => {
  assert.deepEqual(describeEvent({ type: 'system', subtype: 'init' }), { stage: STAGE_WORKING });
  assert.deepEqual(describeEvent(toolUse('mcp__gate__calendar_add_event')), { stage: STAGE_WORKING, step: '일정 등록' });
  assert.deepEqual(describeEvent(toolUse('mcp__gate__new_tool')), { stage: STAGE_WORKING, step: '도구 실행: new_tool' });
  assert.deepEqual(describeEvent(toolUse('Agent', { subagent_type: 'clio' })), { stage: STAGE_WORKING, step: '클리오 호출 중' });
  assert.deepEqual(describeEvent(toolUse('Agent', { subagent_type: 'Explore' })), { stage: STAGE_WORKING, step: '도우미 호출 중' });
  assert.deepEqual(describeEvent(toolUse('Read', { file_path: '/v/90_Delphi/Channels/텔레그램 입력 규칙.md' })), { stage: STAGE_WORKING, step: '읽는 중: 텔레그램 입력 규칙' });
  assert.deepEqual(describeEvent(toolUse('Grep', { pattern: '창구' }, 'parent')), { stage: STAGE_WORKING, step: '담당 작업 중 · 볼트 검색(창구)' });
  assert.deepEqual(describeEvent(toolUse('StructuredOutput')), { stage: STAGE_ANSWERING });
  assert.deepEqual(describeEvent({ type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'text' } } }), { stage: STAGE_ANSWERING });
  assert.equal(describeEvent({ type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'text' } }, parent_tool_use_id: 'p' }), null);
  assert.deepEqual(describeEvent({ type: 'user', message: { content: [{ type: 'tool_result', is_error: true }] } }), { stage: STAGE_WORKING, step: '도구 오류 → 다시 판단 중' });
  assert.equal(describeEvent({ type: 'system', subtype: 'hook_started' }), null);
  assert.equal(describeEvent({ type: 'rate_limit_event' }), null);
});

test('진행 상태: 단계 순서·최근 2개 문구·단계 수', () => {
  let s = initialProgress({ startedAt: 0, queued: 1 });
  assert.equal(s.stage, STAGE_RECEIVED);
  s = applyProgress(s, { stage: STAGE_WORKING });
  s = applyProgress(s, { stage: STAGE_WORKING, step: '일정 등록' });
  s = applyProgress(s, { stage: STAGE_WORKING, step: '일정 등록' });
  s = applyProgress(s, { stage: STAGE_WORKING, step: '클리오 호출 중' });
  s = applyProgress(s, { stage: STAGE_WORKING, step: '읽는 중: a' });
  assert.deepEqual(s.steps, ['클리오 호출 중', '읽는 중: a']);
  assert.equal(s.stepCount, 3);
  const text = renderProgress(s, 84_000);
  assert.equal(text.split('\n')[0], '처리 중 · 1:24 · 3단계 · 대기 1건');
  assert.match(text, /· 읽는 중: a\n· 직전: 클리오 호출 중\n취소하려면 "취소"/);
  assert.match(renderProgress(initialProgress({ startedAt: 0 }), 0), /^메시지 받음 · 0:00$/);
  assert.match(renderProgress({ ...s, slow: true }, 200_000), /오래 걸리고 있음/);
});

test('진행 메시지 한 줄은 44칸(한글 2칸) 이내', () => {
  const width = (l) => [...l].reduce((w, ch) => w + (/[ᄀ-ￜ]/.test(ch) ? 2 : 1), 0);
  const s = { ...initialProgress({ startedAt: 0, queued: 3 }), stage: STAGE_ANSWERING, stepCount: 12, steps: ['담당 작업 중 · 읽는 중: 2026-10-30 텔레그램 창구 설계 문서', '사실 조회'] };
  for (const l of renderProgress(s, 754_000).split('\n')) assert.ok(width(l) <= 44, `${l} (${width(l)})`);
});

function fakeClock() {
  const timers = [];
  const clock = { ms: 0 };
  return {
    clock,
    now: () => clock.ms,
    setTimer: (fn, ms) => { const t = { at: clock.ms + ms, fn }; timers.push(t); return t; },
    clearTimer: (t) => { const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1); },
    async advance(ms) {
      clock.ms += ms;
      for (;;) {
        const due = timers.filter((t) => t.at <= clock.ms).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        timers.splice(timers.indexOf(due), 1);
        await due.fn();
      }
    },
  };
}

test('편집 제한: 3초 간격, 사이 변경은 마지막만, 같은 문구는 건너뜀', async () => {
  const fc = fakeClock();
  const edits = [];
  const t = createEditThrottle({ edit: async (text) => { edits.push([fc.clock.ms, text]); }, now: fc.now, setTimer: fc.setTimer, clearTimer: fc.clearTimer });
  t.update('A');
  await fc.advance(3000);
  t.update('B'); t.update('C');
  await fc.advance(1000);
  assert.deepEqual(edits, [[3000, 'A']], '진행 메시지 발송 3초 뒤 첫 편집');
  await fc.advance(2000);
  assert.deepEqual(edits, [[3000, 'A'], [6000, 'C']]);
  t.update('C');
  await fc.advance(5000);
  assert.equal(edits.length, 2, '같은 문구는 다시 보내지 않음');
});

test('편집 제한: 429면 retry_after 동안 기다리고, "not modified"는 성공으로 본다, close 뒤에는 보내지 않는다', async () => {
  const fc = fakeClock();
  const edits = [];
  let fail = Object.assign(new Error('Too Many Requests: retry after 10'), {});
  const t = createEditThrottle({ edit: async (text) => { if (fail) { const f = fail; fail = null; throw f; } edits.push([fc.clock.ms, text]); }, now: fc.now, setTimer: fc.setTimer, clearTimer: fc.clearTimer });
  t.update('A');
  await fc.advance(3000);
  t.update('B');
  await fc.advance(5000);
  assert.deepEqual(edits, []);
  await fc.advance(6000);
  assert.equal(edits.length, 1);
  assert.equal(edits[0][1], 'B');
  assert.ok(edits[0][0] >= 13000, '실패(3초) + retry after 10초가 지난 뒤');
  fail = new Error('Bad Request: message is not modified');
  t.update('C');
  await fc.advance(3000);
  t.close();
  t.update('D');
  await fc.advance(10_000);
  assert.equal(edits.length, 1, 'not modified는 성공 처리, close 뒤엔 보내지 않음');
});
