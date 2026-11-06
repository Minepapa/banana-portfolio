import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GATE_COMMON_MCP_TOOLS, GATE_READ_TOOLS, GATE_TOOL_TABLE, VAULT_RECORD_TOOLS, gateBuiltinTools, gateMcpToolsFor } from './telegram-gate-tool-table.mjs';
import { calendarRangeText, createGateMcpTools, gateMcpToolsForAgent } from './telegram-gate-mcp-tools.mjs';
import { AGENT_IDS } from './agent-registry.mjs';
import { parseAgentArg } from '../tools/telegram-gate-mcp.mjs';
import { buildGateMcpConfig } from './telegram-gate-llm.mjs';

const toolNames = createGateMcpTools().map((t) => t.name);

test('도구 표: 모든 담당이 있고, 표의 도구는 창구 MCP에 실제로 있으며, 창구 MCP 도구는 누군가에게 배정돼 있다', () => {
  assert.deepEqual(Object.keys(GATE_TOOL_TABLE).sort(), [...AGENT_IDS].sort());
  for (const [agent, tools] of Object.entries(GATE_TOOL_TABLE)) {
    for (const t of tools) assert.ok(toolNames.includes(t), `${agent}: ${t}`);
    assert.equal(new Set(tools).size, tools.length, `${agent} 중복`);
  }
  for (const t of toolNames) assert.ok(Object.values(GATE_TOOL_TABLE).some((tools) => tools.includes(t)), `배정 안 된 도구: ${t}`);
});

test('도구 표 B안: 모든 담당 읽기·사실·요청 기록, 볼트 기록 쓰기는 클리오만, 직접 쓰기·셸 도구는 아무에게도 없다', () => {
  for (const agent of AGENT_IDS) {
    for (const t of GATE_COMMON_MCP_TOOLS) assert.ok(gateMcpToolsFor(agent).includes(t), `${agent}: ${t}`);
    for (const t of GATE_READ_TOOLS) assert.ok(gateBuiltinTools(agent).includes(t), `${agent}: ${t}`);
    for (const t of ['Write', 'Edit', 'Bash', 'NotebookEdit', 'WebFetch', 'WebSearch']) assert.equal(gateBuiltinTools(agent).includes(t), false, `${agent}: ${t}`);
    const hasRecord = VAULT_RECORD_TOOLS.some((t) => gateMcpToolsFor(agent).includes(t));
    assert.equal(hasRecord, agent === 'clio', `${agent} 볼트 기록 도구`);
  }
  for (const t of VAULT_RECORD_TOOLS) assert.ok(toolNames.includes(t));
  assert.deepEqual(gateBuiltinTools('zeus'), ['Read', 'Grep', 'Glob', 'Agent'], '하위 에이전트는 제우스만');
  // 돈: 접수 대기는 제우스·플루토스만, 실제 주문 도구는 없다.
  assert.deepEqual(AGENT_IDS.filter((a) => gateMcpToolsFor(a).includes('order_stage')).sort(), ['plutus', 'zeus']);
  assert.equal(toolNames.some((t) => /place.*order|execute|modify_cancel/.test(t)), false);
  // 헤르메스: 캘린더 조회·등록·할 일.
  for (const t of ['calendar_list', 'calendar_add_event', 'tasks_add', 'tasks_delete']) assert.ok(gateMcpToolsFor('hermes').includes(t));
  assert.deepEqual(gateMcpToolsFor('themis'), [...GATE_COMMON_MCP_TOOLS], '테미스는 조회만');
  assert.throws(() => gateMcpToolsFor('executor'), /도구 표/);
});

test('MCP 서버 --agent: 그 담당 도구만 내보낸다(없으면 전부), MCP 설정에 담당 인자를 싣는다', () => {
  const all = createGateMcpTools();
  assert.deepEqual(gateMcpToolsForAgent(all, 'themis').map((t) => t.name).sort(), [...GATE_COMMON_MCP_TOOLS].sort());
  assert.equal(gateMcpToolsForAgent(all, null).length, all.length);
  assert.equal(parseAgentArg(['--agent=hermes']), 'hermes');
  assert.equal(parseAgentArg([]), null);
  assert.deepEqual(JSON.parse(buildGateMcpConfig({ nodePath: '/n', serverPath: '/s', agent: 'clio' })).mcpServers.gate.args, ['/s', '--agent=clio']);
});

test('calendar_list: 볼트 일정 정본을 날짜 범위로 읽는다(파일 없음·빈 날 구분, 31일 한도, 형식 검사)', async () => {
  const days = { '2026-11-07': { events: [{ allDay: true, title: '가족 나들이', person: '가족' }] }, '2026-11-08': { events: [] } };
  const text = calendarRangeText({ from: '2026-11-07', to: '2026-11-09' }, (d) => days[d] ?? null);
  assert.match(text, /2026-11-07: 1건\n- 종일 \[가족\] 가족 나들이/);
  assert.match(text, /2026-11-08: 일정 없음/);
  assert.match(text, /2026-11-09: 일정 파일 없음/);
  assert.throws(() => calendarRangeText({ from: '2026-11-01', to: '2026-12-15' }, () => null), /31일/);
  assert.throws(() => calendarRangeText({ from: '11/07' }, () => null), /YYYY-MM-DD/);
  assert.throws(() => calendarRangeText({ from: '2026-11-08', to: '2026-11-07' }, () => null), /앞/);
  const tool = createGateMcpTools({ readCalendarDay: (d) => days[d] ?? null }).find((t) => t.name === 'calendar_list');
  assert.match(await tool.handler({ from: '2026-11-07' }), /가족 나들이/);
});

test('memo_record: 📜 메모와 같은 도구에 원문을 JSON으로 넘긴다(셸 해석 없음)', async () => {
  const calls = [];
  const tool = createGateMcpTools({ run: async (t, args, opts) => { calls.push({ t, args, input: opts?.input }); return '기록함'; } }).find((t) => t.name === 'memo_record');
  await tool.handler({ text: '따옴표 " $(x)' });
  assert.deepEqual(calls, [{ t: 'inbox-memo.mjs', args: ['--json=-'], input: JSON.stringify({ text: '따옴표 " $(x)' }) }]);
});
