#!/usr/bin/env node
// 텔레그램 관문 MCP 서버(stdio, 2026-10-30 관문 2단계) — 관문이 띄우는 헤드리스 claude에만 --mcp-config로 붙는다.
// 도구 목록·검사는 lib/telegram-gate-mcp-tools.mjs. 이 파일은 MCP JSON-RPC(줄 단위) 입출력만 한다.
// 환경: 관문 spawn env(CLAUDE_TELEGRAM_GATE=1, TELEGRAM_GATE_STATE_DIR, 시험 모드면 VAULT_PATH=시험 볼트)를 claude가 물려준다.
import { createInterface } from 'node:readline';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createGateMcpTools, GATE_MCP_SERVER_NAME } from '../lib/telegram-gate-mcp-tools.mjs';

const PROTOCOL_FALLBACK = '2024-11-05';
const MAX_RESULT = 60_000;

// 순수에 가까운 처리기(시험용): 요청 하나 → 응답(알림이면 null).
export async function handleMcpMessage(msg, tools) {
  if (!msg || msg.jsonrpc !== '2.0' || msg.id === undefined || msg.id === null) return null;
  const reply = (result) => ({ jsonrpc: '2.0', id: msg.id, result });
  const fail = (code, message) => ({ jsonrpc: '2.0', id: msg.id, error: { code, message } });
  if (msg.method === 'initialize') {
    return reply({ protocolVersion: msg.params?.protocolVersion ?? PROTOCOL_FALLBACK, capabilities: { tools: {} }, serverInfo: { name: GATE_MCP_SERVER_NAME, version: '1' } });
  }
  if (msg.method === 'ping') return reply({});
  if (msg.method === 'tools/list') {
    return reply({ tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
  }
  if (msg.method === 'tools/call') {
    const tool = tools.find((t) => t.name === msg.params?.name);
    if (!tool) return fail(-32602, `없는 도구: ${msg.params?.name}`);
    try {
      const out = String(await tool.handler(msg.params?.arguments ?? {}) ?? '');
      return reply({ content: [{ type: 'text', text: out.slice(0, MAX_RESULT) || '(출력 없음)' }] });
    } catch (error) {
      // 도구 오류는 모델에게 그대로 보여 준다(추측해서 다시 시도하지 말라는 규칙은 시스템 프롬프트에 있다).
      return reply({ content: [{ type: 'text', text: `오류: ${String(error?.message ?? error).split('\n').slice(-3).join('\n')}` }], isError: true });
    }
  }
  return fail(-32601, `지원하지 않는 메서드: ${msg.method}`);
}

function main() {
  const tools = createGateMcpTools({ stateDir: process.env.TELEGRAM_GATE_STATE_DIR || null, testMode: process.env.TELEGRAM_GATE_MODE === 'test' });
  const rl = createInterface({ input: process.stdin });
  rl.on('line', async (line) => {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    const response = await handleMcpMessage(msg, tools);
    if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
  });
}

const invokedPath = (() => { try { return realpathSync(process.argv[1] ?? ''); } catch { return null; } })();
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) main();
