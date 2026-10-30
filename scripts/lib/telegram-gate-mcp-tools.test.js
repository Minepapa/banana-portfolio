import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildRequestNote, createGateMcpTools, gateMcpToolNames } from './telegram-gate-mcp-tools.mjs';
import { handleMcpMessage } from '../tools/telegram-gate-mcp.mjs';
import { checkNote, parseRegistry } from './vault-registry.mjs';
import { vaultAbs, VAULT_REL } from './vault-paths.mjs';
import { existsSync, readdirSync } from 'node:fs';

// 도구 실행은 가짜 run으로 바꾼다. 실제 CLI·볼트·텔레그램을 건드리지 않는다.
function toolsWith(calls, extra = {}) {
  return createGateMcpTools({ run: async (tool, args, opts = {}) => { calls.push({ tool, args, input: opts.input ?? null }); return `${tool} ok`; }, ...extra });
}

test('관문 MCP 도구에는 돈 도구·셸·파일 쓰기 도구가 없다', () => {
  const names = gateMcpToolNames(toolsWith([]));
  assert.ok(names.every((n) => n.startsWith('mcp__gate__')));
  assert.equal(names.some((n) => /order(?!_stage)|direct|modify|retry|execute|breakout|bash|write|edit/i.test(n.replace('order_stage', ''))), false, names.join(' '));
});

test('도구 인자는 JSON 그대로 기존 CLI 표준입력·인자로 간다(셸 해석 없음)', async () => {
  const calls = [];
  const tools = Object.fromEntries(toolsWith(calls).map((t) => [t.name, t]));
  await tools.calendar_add_event.handler({ title: '치과 "예약" $(rm)', start: '2026-10-31T15:00', end: '2026-10-31T16:00' });
  await tools.place_register.handler({ correct: { date: '2026-10-29', time: '12:00' }, name: '헬스장' });
  await tools.photo_record.handler({ decoded: '영수증 12,000원', caption: '' });
  await tools.department_facts.handler({ agent: 'plutus' });
  assert.deepEqual(JSON.parse(calls[0].input), { title: '치과 "예약" $(rm)', start: '2026-10-31T15:00', end: '2026-10-31T16:00' });
  assert.equal(calls[0].tool, 'calendar-add-event.mjs');
  assert.deepEqual(JSON.parse(calls[1].input), { correct: { date: '2026-10-29', time: '12:00' }, name: '헬스장' });
  assert.deepEqual(JSON.parse(calls[2].input), { kind: '사진판독', decoded: '영수증 12,000원' });
  assert.deepEqual(calls[3], { tool: 'department-call-facts.mjs', args: ['plutus'], input: null });
});

test('facts_tool: 자기 선언 목록의 도구만, 입력은 입력을 받는 도구만', async () => {
  const calls = [];
  const tools = Object.fromEntries(toolsWith(calls).map((t) => [t.name, t]));
  await tools.facts_tool.handler({ filename: 'stock-facts.mjs', input: '삼성전자' });
  assert.deepEqual(calls[0], { tool: 'stock-facts.mjs', args: ['삼성전자'], input: null });
  await assert.rejects(tools.facts_tool.handler({ filename: 'quant-factor-facts.mjs' }), /목록에 없음/, '폐기된 도구');
  await assert.rejects(tools.facts_tool.handler({ filename: 'place-nh-direct-order.mjs' }), /목록에 없음/);
  await assert.rejects(tools.facts_tool.handler({ filename: 'rebalance-facts.mjs', input: 'x' }), /입력을 받지 않습니다/);
  await assert.rejects(tools.facts_tool.handler({ filename: 'stock-facts.mjs', input: '--all' }), /입력을 받지 않습니다/);
});

test('order_stage: 실행하지 않고 확인 대기만 만든다(원본 메시지 확인 포함)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-mcp-'));
  try {
    const message = { message_id: 9, date: 1, chat: { id: 1, type: 'private' }, from: { id: 1 }, text: '삼성 10주 사줘' };
    writeFileSync(join(dir, 'inbox.jsonl'), `${JSON.stringify({ type: 'update', updateId: 1, receivedAt: 't', update: { update_id: 1, message } })}\n${JSON.stringify({ type: 'status', updateId: 1, status: '처리중', at: 't' })}\n`);
    const calls = [];
    const tools = Object.fromEntries(toolsWith(calls, { stateDir: dir }).map((t) => [t.name, t]));
    const out = await tools.order_stage.handler({ action: '매수', sourceMessageId: 9, params: { asset: '삼성전자', quantity: 10 } });
    assert.match(out, /접수 대기로 넘김/);
    assert.equal(calls.length, 0, '어떤 도구도 실행하지 않음');
    assert.equal(JSON.parse(readFileSync(join(dir, 'confirm.json'), 'utf8')).status, '대기');
    const noState = Object.fromEntries(toolsWith([]).map((t) => [t.name, t]));
    await assert.rejects(noState.order_stage.handler({ action: '매수', sourceMessageId: 9, params: { asset: '삼성', quantity: 1 } }), /상태 폴더/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('buildRequestNote: 등록부 규칙을 통과하는 개발 요청 노트(제목 금지 문자 제거)', () => {
  const note = buildRequestNote({ title: '알림/설정 #바꾸기', what: '무엇', why: '왜', ownerText: '원문\n둘째 줄' }, { now: new Date('2026-10-30T05:00:00Z') });
  assert.equal(note.relPath, `${VAULT_REL.logDevRequests}/2026-10-30 알림 설정 바꾸기.md`);
  assert.match(note.content, /status: "예정"/);
  assert.match(note.content, /> 원문\n> 둘째 줄/);
  if (existsSync(vaultAbs(VAULT_REL.registryFile))) {
    assert.deepEqual(checkNote(note.relPath, note.content, parseRegistry(readFileSync(vaultAbs(VAULT_REL.registryFile), 'utf8'))), []);
  }
  assert.throws(() => buildRequestNote({ title: '', what: 'a', why: 'b', ownerText: 'c' }), /제목/);
  assert.throws(() => buildRequestNote({ title: 't', what: '', why: 'b', ownerText: 'c' }), /what/);
});

test('MCP 서버: initialize·tools/list·tools/call(성공·오류)·알림 무시·모르는 메서드', async () => {
  const tools = [{ name: 'echo', description: 'd', inputSchema: { type: 'object' }, handler: async (a) => `E:${a.x}` },
    { name: 'boom', description: 'd', inputSchema: { type: 'object' }, handler: async () => { throw new Error('줄1\n줄2'); } }];
  const init = await handleMcpMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }, tools);
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.deepEqual((await handleMcpMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, tools)).result.tools.map((t) => t.name), ['echo', 'boom']);
  assert.deepEqual((await handleMcpMessage({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'echo', arguments: { x: 1 } } }, tools)).result,
    { content: [{ type: 'text', text: 'E:1' }] });
  const err = await handleMcpMessage({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'boom' } }, tools);
  assert.equal(err.result.isError, true);
  assert.match(err.result.content[0].text, /오류: 줄1\n줄2/);
  assert.equal(await handleMcpMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }, tools), null);
  assert.equal((await handleMcpMessage({ jsonrpc: '2.0', id: 5, method: 'resources/list' }, tools)).error.code, -32601);
  assert.equal((await handleMcpMessage({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'nope' } }, tools)).error.code, -32602);
});

test('proposal_reply: 답장 원문·대상은 관문 수신 기록의 오너 메시지에서 가져온다(LLM이 승인 문구를 못 만듦)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-mcp-reply-'));
  try {
    const lines = [
      { message_id: 11, date: 1, chat: { id: 1, type: 'private' }, from: { id: 1 }, text: '승인', reply_to_message: { message_id: 55 } },
      { message_id: 12, date: 1, chat: { id: 1, type: 'private' }, from: { id: 1 }, text: '거부 결함' },
    ].flatMap((message, i) => [JSON.stringify({ type: 'update', updateId: i + 1, receivedAt: 't', update: { update_id: i + 1, message } }), JSON.stringify({ type: 'status', updateId: i + 1, status: '처리중', at: 't' })]);
    writeFileSync(join(dir, 'inbox.jsonl'), `${lines.join('\n')}\n`);
    const calls = [];
    const tools = Object.fromEntries(toolsWith(calls, { stateDir: dir }).map((t) => [t.name, t]));
    await tools.proposal_reply.handler({ sourceMessageId: 11 });
    await tools.proposal_reply.handler({ sourceMessageId: 12 });
    assert.deepEqual(calls.map((c) => c.args), [['--reply-to=55', '--text=승인'], ['--infer-pending', '--text=거부 결함']]);
    await assert.rejects(tools.proposal_reply.handler({ sourceMessageId: 99 }), /찾지 못했습니다/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('시험 모드: 구글 캘린더·할 일처럼 외부에 쓰는 도구는 실행하지 않는다', async () => {
  const calls = [];
  const tools = Object.fromEntries(toolsWith(calls, { testMode: true }).map((t) => [t.name, t]));
  assert.match(await tools.calendar_add_event.handler({ title: 'x', start: '2026-10-31T10:00', end: '2026-10-31T11:00' }), /시험 모드라 일정 등록을 실행하지 않았습니다/);
  assert.match(await tools.tasks_add.handler({ title: 'x' }), /시험 모드라/);
  assert.match(await tools.tasks_delete.handler({ id: 'x' }), /시험 모드라/);
  await tools.place_register.handler({ here: true, name: '회사' });
  assert.deepEqual(calls.map((c) => c.tool), ['place-register.mjs'], '시험 볼트로 격리되는 도구는 그대로');
});

test('promise_add·promise_cancel·promise_list: 검사 뒤 요청 파일만 쓰고(볼트에 쓰지 않음), 최종 id를 돌려준다', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-mcp-promise-'));
  try {
    const vaultFile = join(dir, 'vault-promises.jsonl');
    const tools = Object.fromEntries(toolsWith([], { stateDir: dir, promiseVaultFile: vaultFile }).map((t) => [t.name, t]));
    const out = await tools.promise_add.handler({ text: '밤 전사 끝나면 알려줘', trigger: { type: 'job', job: 'media-audio', status: 'ok' } });
    const id = /id (P-\d{8}-[0-9a-f]{6})/.exec(out)[1];
    await assert.rejects(tools.promise_add.handler({ text: 'x', trigger: { type: 'job', job: '없는-잡' } }), /모르는 잡/);
    await tools.promise_cancel.handler({ id });
    await assert.rejects(tools.promise_cancel.handler({ id: 'P-1' }), /형식/);
    const files = readdirSync(join(dir, 'promise-requests')).filter((n) => n.endsWith('.json'));
    assert.equal(files.length, 2);
    assert.equal(existsSync(vaultFile), false, 'MCP는 볼트 대기열에 쓰지 않음');
    assert.match(await tools.promise_list.handler({}), /대기 중인 약속 없음\n대기열에 오르기 전 요청 1건/);
    // 데몬이 옮긴 뒤에는 같은 id로 대기열에 있다.
    const { createPromiseStore } = await import('./telegram-gate-promises.mjs');
    const store = createPromiseStore({ vaultFile, requestDir: join(dir, 'promise-requests') });
    store.ingest({ knownJobs: ['media-audio'] });
    assert.equal(store.list()[0].promise.id, id);
    assert.equal(store.list()[0].status, '취소', '같은 묶음의 추가→취소도 반영');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
