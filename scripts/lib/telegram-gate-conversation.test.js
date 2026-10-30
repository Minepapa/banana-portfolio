import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConversation, fakeOrderExecutor, buildHandoffSummaryArgs } from './telegram-gate-conversation.mjs';
import { createJournal } from './telegram-gate-journal.mjs';
import { businessDay, createSessionStore } from './telegram-gate-session.mjs';

// 발송·편집·삭제·claude 실행·볼트 쓰기는 전부 가짜. 상태(세션·기록)만 임시 폴더에 둔다.
const CHAT = '31337';
const flag = (args, f) => args[args.indexOf(f) + 1];

function memoryConfirmStore(initial = null) {
  let c = initial;
  return {
    read: () => c,
    pending: (at) => (c && c.status === '대기' && Date.parse(c.expiresAt) > at.getTime() ? c : null),
    expired: (at) => (c && c.status === '대기' && Date.parse(c.expiresAt) <= at.getTime() ? c : null),
    update: (fields) => { c = { ...c, ...fields }; return c; },
    set: (next) => { c = next; },
  };
}

function setup({ clock = new Date('2026-10-30T05:00:00Z'), results = [], events = [{ type: 'system', subtype: 'init' }], cooldown = null, handoffs = {}, confirm = null, summarize,
  sendImpl = null, downloadPhoto = null, isStopping = () => false, runnerHook = null, writeHandoffImpl = null, warns = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'gate-conv-'));
  const state = { now: clock };
  const sent = [];
  const edits = [];
  const deleted = [];
  const runs = [];
  const vault = { ...handoffs };
  const timers = [];
  const confirmStore = memoryConfirmStore(confirm);
  let n = 0;
  const conv = createConversation({
    send: async (message, chatId) => { if (sendImpl) await sendImpl(message); sent.push({ ...message, chatId }); return { result: { message_id: 1000 + sent.length } }; },
    edit: async (id, message) => { edits.push({ id, body: message.body }); },
    del: async (id) => { deleted.push(id); },
    downloadPhoto: downloadPhoto ?? (async (fileId) => `/media/${fileId}.jpg`),
    isStopping,
    runner: ({ args, onEvent }) => {
      runs.push(args);
      if (runnerHook) runnerHook();
      const res = results.shift() ?? { structured: { messages: [{ agent: 'zeus', topic: '답', kind: '정보', body: '네' }] }, isError: false, permissionDenials: [] };
      for (const e of (res.events ?? events)) onEvent(e);
      return { promise: Promise.resolve(res), cancel: () => {} };
    },
    spawnEnv: { CLAUDE_TELEGRAM_GATE: '1' },
    cooldown: () => cooldown,
    readRules: () => ({ inputRules: '입력 규칙', sessionRules: '## 4. 답장\n규칙' }),
    readHandoff: (day) => vault[day] ?? null,
    writeHandoff: (day, content) => { if (writeHandoffImpl) writeHandoffImpl(day, content); vault[day] = content.replace(/^---\n[\s\S]*?\n---\n/, '').trim(); },
    warn: async (m) => { warns?.push(m); },
    summarize: summarize ?? (async () => ({ decisions: [], summary: [] })),
    journal: createJournal({ stateDir: dir, now: () => state.now, dayOf: businessDay }),
    sessionStore: createSessionStore({ stateDir: dir, uuid: () => `S${++n}` }),
    confirmStore,
    isLive: () => true,
    mcpToolNames: ['mcp__gate__tasks_add'],
    now: () => state.now,
    log: () => {},
    setTimer: (fn, ms) => { const t = { fn, ms }; timers.push(t); return t; },
    clearTimer: () => {},
  });
  return { dir, conv, sent, edits, deleted, runs, vault, confirmStore, state, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
const item = (id, text, extra = {}) => ({ updateId: id, meta: { chatId: CHAT, messageId: id, date: 0 }, args: { kind: 'text', text, ...extra } });

test('대화 한 번: 진행 메시지(받음) → 최종 답은 새 메시지 → 진행 메시지 삭제, 세션 턴 기록', async () => {
  const s = setup({ events: [{ type: 'system', subtype: 'init', session_id: 'S1' },
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'mcp__gate__tasks_add', input: { title: '우유' } }] } }] });
  try {
    const result = await s.conv.processBatch([item(1, '우유 사야 해')]);
    assert.equal(result.status, '완료');
    assert.equal(s.sent[0].topic, '진행');
    assert.match(s.sent[0].body, /^메시지 받음/);
    assert.equal(s.sent[1].topic, '답');
    assert.equal(s.sent[1].llm, true);
    assert.deepEqual(s.deleted, [1001]);
    assert.equal(flag(s.runs[0], '--session-id'), 'S1');
    // 다음 메시지는 같은 세션을 이어 붙인다.
    await s.conv.processBatch([item(2, '그리고 계란도')]);
    assert.equal(flag(s.runs[1], '--resume'), 'S1');
    const journal = s.conv.state; // 상태 노출 확인
    assert.equal(journal.lastRun.status, '완료');
  } finally { s.cleanup(); }
});

test('Q7 맥락 연속(시계 주입): 전날 기록 → 04:00 넘으면 인수인계 노트 → 다음 날 첫 대화 프롬프트에 진행 중인 일·약속·결정', async () => {
  const s = setup({
    clock: new Date('2026-10-30T05:00:00Z'), // 10-30 14:00 KST
    summarize: async (day, entries) => {
      assert.equal(day, '2026-10-30');
      assert.ok(entries.some((e) => e.type === 'in' && /삼성전자/.test(e.text)));
      return { decisions: ['"주간 리포트는 일요일 아침에만" — 리포트 발송 시각 고정 지시'], summary: ['미결: 삼성전자 매수 확인 대기'] };
    },
  });
  try {
    s.conv.state.handoffDays.clear();
    await s.conv.processBatch([item(1, '주간 리포트는 일요일 아침에만 보내줘')]);
    // 대화 중 LLM이 order_stage로 접수 → 관문이 확인 질문을 보냄(기록에 '대기'로 남음)
    s.confirmStore.set({ id: 'CF-1', status: '대기', summary: '삼성전자 10주 매수(현재가 지정가)', createdAt: new Date('2026-10-30T05:10:00Z').toISOString(), expiresAt: new Date('2026-10-30T05:20:00Z').toISOString() });
    s.state.now = new Date('2026-10-30T05:10:00Z');
    await s.conv.processBatch([item(2, '삼성전자 10주 사줘')]);
    assert.ok(s.sent.some((m) => m.topic === '주문 확인'));
    // 다음 날 04:01 KST
    s.state.now = new Date('2026-10-30T19:01:00Z');
    const note = await s.conv.writeHandoffIfDue(s.state.now);
    assert.ok(note, '인수인계 노트를 썼다');
    assert.ok(s.vault['2026-10-30']);
    // 다음 날 첫 대화
    s.state.now = new Date('2026-10-30T23:00:00Z'); // 10-31 08:00 KST
    await s.conv.processBatch([item(3, '어제 하던 거 어떻게 됐어?')]);
    const prompt = flag(s.runs.at(-1), '-p');
    assert.equal(s.runs.at(-1).includes('--session-id'), true, '새 날은 새 세션');
    for (const re of [/전날 대화 인수인계/, /■ 진행 중인 일/, /확인 대기: 삼성전자 10주 매수/, /■ 약속/, /■ 오너 결정·지시/, /주간 리포트는 일요일 아침에만/, /미결: 삼성전자 매수 확인 대기/]) {
      assert.match(prompt, re);
    }
    assert.ok(prompt.indexOf('■ 진행 중인 일') < prompt.indexOf('어제 하던 거 어떻게 됐어?'));
    // 같은 날 두 번째 대화에는 인수인계를 다시 넣지 않는다.
    await s.conv.processBatch([item(4, '고마워')]);
    assert.doesNotMatch(flag(s.runs.at(-1), '-p'), /전날 대화 인수인계/);
    assert.equal(await s.conv.writeHandoffIfDue(s.state.now), null, '이미 쓴 날은 다시 쓰지 않음');
  } finally { s.cleanup(); }
});

test('인수인계 요약이 실패해도 노트의 앞 두 칸(진행 중인 일·약속)은 남는다', async () => {
  const s = setup({ summarize: async () => { throw new Error('요약 실행 실패'); } });
  try {
    await s.conv.processBatch([item(1, '메모')]);
    s.state.now = new Date('2026-10-30T19:01:00Z');
    await s.conv.writeHandoffIfDue(s.state.now);
    assert.match(s.vault['2026-10-30'], /■ 진행 중인 일/);
    assert.match(s.vault['2026-10-30'], /요약 실패: 요약 실행 실패/);
  } finally { s.cleanup(); }
});

test('첫 대화인데 전날 노트가 없으면 그렇다고 알린다(조용한 폴백 금지)', async () => {
  const s = setup();
  try {
    await s.conv.processBatch([item(1, '안녕하세요')]);
    assert.match(flag(s.runs[0], '-p'), /인수인계 노트가 없다/);
  } finally { s.cleanup(); }
});

test('쿨다운 중이면 claude를 부르지 않고 진행 메시지에 해제 시각을 남긴다', async () => {
  const s = setup({ cooldown: { resetAt: Date.parse('2026-10-30T06:30:00Z') } });
  try {
    const r = await s.conv.processBatch([item(1, '질문')]);
    assert.equal(s.runs.length, 0);
    assert.match(s.edits.at(-1).body, /15:30 이후 한도가 풀리면 관문이 알려 드립니다/);
    assert.equal(r.detail, '쿨다운 — 처리 안 함');
  } finally { s.cleanup(); }
});

test('취소·시간 초과·실패: 진행 메시지를 결과로 고쳐 남기고(지우지 않음), 실패 원문은 오너에게 보내지 않는다', async () => {
  const s = setup({ results: [
    { interrupted: 'cancel', isError: false },
    { interrupted: 'timeout', isError: false },
    { isError: true, errorText: 'Error: secret stack /Users/x' },
  ] });
  try {
    await s.conv.processBatch([item(1, 'a')]);
    assert.match(s.edits.at(-1).body, /취소함/);
    await s.conv.processBatch([item(2, 'b')]);
    assert.match(s.edits.at(-1).body, /시간 초과로 멈췄습니다/);
    await s.conv.processBatch([item(3, 'c')]);
    assert.match(s.edits.at(-1).body, /처리하지 못했습니다\(처리 중 오류/);
    assert.doesNotMatch(s.edits.at(-1).body, /secret stack/);
    assert.deepEqual(s.deleted, []);
    assert.equal(s.conv.state.lastRun.ok, false);
  } finally { s.cleanup(); }
});

test('출력 계약 위반이면 원문을 형식 오류 메시지로 감싸 보낸다', async () => {
  const s = setup({ results: [{ structured: null, result: '그냥 문장으로 답함', isError: false }] });
  try {
    await s.conv.processBatch([item(1, 'a')]);
    assert.equal(s.sent[1].topic, '답장(형식 오류)');
    assert.match(s.sent[1].body, /그냥 문장으로 답함/);
  } finally { s.cleanup(); }
});

test('이어 붙일 세션 기록이 없으면 같은 날 새 세션으로 한 번만 다시', async () => {
  const s = setup({ results: [
    { events: [{ type: 'system', subtype: 'init' }] },
    { isError: true, errorText: 'No conversation found with session ID: S1' },
  ] });
  try {
    await s.conv.processBatch([item(1, 'a')]);
    await s.conv.processBatch([item(2, 'b')]);
    assert.equal(flag(s.runs[1], '--resume'), 'S1');
    assert.equal(flag(s.runs[2], '--session-id'), 'S2');
    assert.equal(s.runs.length, 3);
  } finally { s.cleanup(); }
});

test('사진은 내려받아 프롬프트에 경로를 넣는다', async () => {
  const s = setup();
  try {
    await s.conv.processBatch([{ updateId: 1, meta: { chatId: CHAT, messageId: 1 }, args: { kind: 'photo', fileId: 'F1', caption: '영수증' } }]);
    assert.match(flag(s.runs[0], '-p'), /\[관문\] 사진: \/media\/F1.jpg/);
  } finally { s.cleanup(); }
});

test('확인 대기: 실행 중에 접수된 건만 고정 문구로 묻고(실전 경고), 응이면 가짜 실행기, 아니면 거절', async () => {
  const s = setup();
  try {
    s.confirmStore.set({ id: 'CF-1', action: '매수', params: { asset: '삼성전자', quantity: 10 }, sourceChatId: CHAT, sourceMessageId: 7, status: '대기',
      summary: '삼성전자 10주 매수(현재가 지정가)', createdAt: new Date('2026-10-30T05:00:00Z').toISOString(), expiresAt: new Date('2026-10-30T05:10:00Z').toISOString() });
    await s.conv.processBatch([item(7, '삼성전자 10주 사줘')]);
    const ask = s.sent.find((m) => m.topic === '주문 확인');
    assert.match(ask.body, /접수할까요\? 삼성전자 10주 매수/);
    assert.match(ask.body, /바로 실제 주문/);
    assert.equal(s.confirmStore.read().announced, true);
    const answerDate = Date.parse('2026-10-30T05:00:30Z') / 1000;
    const early = await s.conv.handleConfirm({ yes: true }, { chatId: CHAT, messageId: 6, date: answerDate - 60 });
    assert.equal(early.detail, '확인 질문 전 답 — 무시', '확인 질문보다 먼저 온 응은 실행하지 않음');
    const yes = await s.conv.handleConfirm({ yes: true }, { chatId: CHAT, messageId: 8, date: answerDate });
    assert.equal(yes.detail, '주문 확인(가짜 실행기)');
    assert.match(s.sent.at(-1).body, /실제로 실행하지 않았습니다/);
    assert.match(s.sent.at(-1).body, /--request-id=telegram:31337:7/);
    assert.equal(s.confirmStore.read().status, '실행 안 함(2단계)');
    await s.conv.handleConfirm({ yes: true }, { chatId: CHAT, messageId: 9, date: answerDate });
    assert.match(s.sent.at(-1).body, /확인을 기다리는 주문이 없습니다/);
  } finally { s.cleanup(); }
});

test('확인 대기 닫기: 다른 주제·10분 만료, 거절', async () => {
  const base = { id: 'CF-2', status: '대기', summary: '하이닉스 1주 매수', createdAt: '2026-10-30T05:00:00.000Z', expiresAt: '2026-10-30T05:10:00.000Z', announced: true, announcedAt: '2026-10-30T05:00:00.000Z' };
  const s = setup({ confirm: { ...base } });
  try {
    assert.equal(await s.conv.closeConfirm('다른 주제', CHAT), true);
    assert.match(s.sent.at(-1).body, /다른 이야기가 와서 접수하지 않았습니다/);
    s.confirmStore.set({ ...base });
    assert.equal(await s.conv.closeConfirm('만료', CHAT), false, '아직 만료 전');
    s.state.now = new Date('2026-10-30T05:11:00Z');
    assert.equal(await s.conv.closeConfirm('만료', CHAT), true);
    assert.match(s.sent.at(-1).body, /확인 시간\(10분\)이 지나/);
    s.state.now = new Date('2026-10-30T05:00:00Z');
    s.confirmStore.set({ ...base });
    await s.conv.handleConfirm({ yes: false }, { chatId: CHAT, messageId: 1, date: Date.parse('2026-10-30T05:01:00Z') / 1000 });
    assert.equal(s.confirmStore.read().status, '거절');
  } finally { s.cleanup(); }
});

test('fakeOrderExecutor는 실행하지 않고 명령만 보인다 / 인수인계 요약 인자는 세션·도구 없이', async () => {
  const r = await fakeOrderExecutor({ action: '손절재시도', params: { code: '005930' } });
  assert.equal(r.executed, false);
  assert.match(r.text, /retry-breakout-protection.mjs --code=005930/);
  const args = buildHandoffSummaryArgs('2026-10-30', [{ type: 'in', text: 'x' }]);
  assert.ok(args.includes('--no-session-persistence'));
  assert.equal(args[args.indexOf('--tools') + 1], '');
  assert.equal(args.includes('--restricted'), false);
});

test('실행이 끝나지 않으면(오류) 그 사이 접수된 확인 대기는 묻지 않은 채 닫는다', async () => {
  let s;
  s = setup({ results: [{ isError: true, errorText: 'boom' }], runnerHook: () => {
    s.confirmStore.set({ id: 'CF-9', status: '대기', summary: '삼성 1주', createdAt: s.state.now.toISOString(), expiresAt: new Date(s.state.now.getTime() + 600_000).toISOString() });
  } });
  try {
    await s.conv.processBatch([item(1, '삼성 1주 사줘')]);
    assert.equal(s.confirmStore.read().status, '닫힘(대화 미완료)');
    assert.equal(s.sent.some((m) => m.topic === '주문 확인'), false, '확인 질문을 보내지 않음');
  } finally { s.cleanup(); }
});

test('인수인계 요약은 한 번에 하나만(1분 점검이 겹쳐도 요약 1회)', async () => {
  let calls = 0;
  let release;
  const s = setup({ summarize: () => { calls += 1; return new Promise((r) => { release = () => r({ decisions: [], summary: [] }); }); } });
  try {
    await s.conv.processBatch([item(1, '메모')]);
    s.state.now = new Date('2026-10-30T19:01:00Z');
    const a = s.conv.writeHandoffIfDue(s.state.now);
    const b = s.conv.writeHandoffIfDue(s.state.now);
    await new Promise((r) => setImmediate(r));
    release();
    await Promise.all([a, b]);
    assert.equal(calls, 1);
    assert.equal(await s.conv.writeHandoffIfDue(s.state.now), null);
  } finally { s.cleanup(); }
});

test('업무일 첫 대화가 1분 점검보다 먼저 와도 전날 노트를 먼저 쓰고 주입한다', async () => {
  const s = setup({ summarize: async () => ({ decisions: ['전날 결정'], summary: [] }) });
  try {
    await s.conv.processBatch([item(1, '어제 대화')]);
    s.state.now = new Date('2026-10-30T19:00:30Z'); // 04:00:30 KST, 점검 전
    await s.conv.processBatch([item(2, '오늘 첫 대화')]);
    assert.match(flag(s.runs.at(-1), '-p'), /전날 결정/);
  } finally { s.cleanup(); }
});

test('실행 직전(사진 받는 중)에 온 취소도 claude를 띄우지 않고 취소로 끝난다', async () => {
  let s;
  s = setup({ downloadPhoto: async () => { s.conv.cancel(); return '/media/p.jpg'; } });
  try {
    const r = await s.conv.processBatch([{ updateId: 1, meta: { chatId: CHAT, messageId: 1 }, args: { kind: 'photo', fileId: 'F', caption: '' } }]);
    assert.equal(s.runs.length, 0);
    assert.equal(r.detail, '취소');
    assert.match(s.edits.at(-1).body, /취소함/);
  } finally { s.cleanup(); }
});

test('관문 종료로 끊긴 대화는 완료로 표시하지 않는다(재시작 확인 안내로)', async () => {
  const s = setup({ results: [{ interrupted: 'cancel', isError: false }], isStopping: () => true });
  try {
    const r = await s.conv.processBatch([item(1, 'a')]);
    assert.equal(r.interruptedByShutdown, true);
    assert.match(s.edits.at(-1).body, /다시 시작되느라 멈췄습니다/);
  } finally { s.cleanup(); }
});

test('최종 답 발송이 실패해도 확인 질문은 보내고(자기완결 문구), 실패로 남긴다', async () => {
  let s;
  s = setup({
    sendImpl: async (m) => { if (m.topic === '답') throw new Error('network down'); },
    runnerHook: () => { s.confirmStore.set({ id: 'CF-5', status: '대기', summary: 'x', createdAt: s.state.now.toISOString(), expiresAt: new Date(s.state.now.getTime() + 600_000).toISOString() }); },
  });
  try {
    const r = await s.conv.processBatch([item(1, 'a')]);
    assert.equal(r.status, '실패');
    assert.equal(s.conv.state.lastRun.status, '발송 실패');
    assert.equal(s.confirmStore.read().status, '대기');
    assert.equal(s.confirmStore.read().announced, true);
    assert.ok(s.sent.some((m) => m.topic === '주문 확인'));
    assert.match(s.edits.at(-1).body, /보내지 못했습니다/);
  } finally { s.cleanup(); }
});

test('인수인계 노트 쓰기 실패: 완료로 표시하지 않고 백오프 재시도, 3번 실패면 경고 1회, 다음 첫 대화에는 직접 넣는다', async () => {
  let fail = true;
  const warns = [];
  const s = setup({ writeHandoffImpl: () => { if (fail) throw new Error('등록부 검사 실패'); }, warns, summarize: async () => ({ decisions: ['어제 결정'], summary: [] }) });
  try {
    await s.conv.processBatch([item(1, '어제 대화')]);
    let t = Date.parse('2026-10-30T19:01:00Z');
    await s.conv.writeHandoffIfDue(new Date(t));
    assert.equal(s.conv.state.handoffDays.has('2026-10-30'), false, '실패한 날은 완료 아님');
    assert.equal(await s.conv.writeHandoffIfDue(new Date(t + 60_000)), null, '백오프(5분) 중에는 다시 쓰지 않음');
    await s.conv.writeHandoffIfDue(new Date(t += 5 * 60_000 + 1));
    await s.conv.writeHandoffIfDue(new Date(t += 10 * 60_000 + 1));
    assert.equal(warns.length, 1);
    assert.match(warns[0].body, /3번 쓰지 못했습니다/);
    await s.conv.writeHandoffIfDue(new Date(t += 20 * 60_000 + 1));
    assert.equal(warns.length, 1, '경고는 하루 한 번');
    // 다음 첫 대화: 노트 파일은 없지만 관문이 만든 본문을 직접 넣는다.
    s.state.now = new Date(t + 1000);
    await s.conv.processBatch([item(2, '어제 하던 거?')]);
    assert.match(flag(s.runs.at(-1), '-p'), /어제 결정/);
    // 회복되면 완료로 표시하고 대체 본문을 지운다.
    fail = false;
    await s.conv.writeHandoffIfDue(new Date(t + 3 * 3600_000));
    assert.equal(s.conv.state.handoffDays.has('2026-10-30'), true);
    assert.equal(s.conv.state.handoffFallback.size, 0);
  } finally { s.cleanup(); }
});

test('한도 해제 알림: 쿨다운으로 거절한 메시지가 있었고 한도가 풀리면 한 번만 알린다', async () => {
  const s = setup();
  try {
    // 한도 중 거절이 2건 있었고(setup의 cooldown은 null = 지금은 풀림) 이제 알린다.
    s.conv.state.cooldownRefused = 2;
    assert.equal(await s.conv.checkCooldownRelease(CHAT), true);
    assert.match(s.sent.at(-1).body, /사용량 한도가 풀렸습니다.*2건/);
    assert.equal(await s.conv.checkCooldownRelease(CHAT), false, '한 번만');
  } finally { s.cleanup(); }
});

test('한도 중에는 해제 알림을 보내지 않고, 거절 건수를 센다', async () => {
  const s = setup({ cooldown: { resetAt: Date.parse('2026-10-30T06:00:00Z') } });
  try {
    await s.conv.processBatch([item(1, 'a'), item(2, 'b')]);
    assert.equal(s.conv.state.cooldownRefused, 2);
    assert.equal(await s.conv.checkCooldownRelease(CHAT), false);
  } finally { s.cleanup(); }
});

test('약속 이행 입력(kind promise)은 message_id 없이 origin="promise"로 넘긴다', async () => {
  const s = setup();
  try {
    await s.conv.processBatch([{ updateId: null, meta: { chatId: CHAT, messageId: null }, args: { kind: 'promise', text: '약속 이행 시점이다: 전사 끝' } }]);
    const prompt = flag(s.runs[0], '-p');
    assert.match(prompt, /<telegram origin="promise">\n약속 이행 시점이다: 전사 끝/);
    assert.doesNotMatch(prompt, /message_id="null"/);
  } finally { s.cleanup(); }
});
