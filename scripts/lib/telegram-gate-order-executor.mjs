// 텔레그램 창구 주문 실행기 — 확인 대기(telegram-gate-confirm)에서 오너가 텍스트 "응"으로 확인한 돈 지시를 기존 실행 도구로
// 넘긴다(2026-11-03, 창구 4단계 전 배선. 설계 14절 4단계 "전환 전 반드시 할 것" 1번, 결정 `텔레그램-관문` 4항·Q3).
// 새 주문 로직은 없다. 매수·매도는 place-nh-direct-order(→ 자산분배 승인 흐름 execute-asset-allocation-proposal의 킬스위치·
// 체결모드·가격이탈·중복 방지를 그대로 탐), 정정·취소는 modify-cancel-nh-order, 손절 재시도는 retry-breakout-protection을 부른다.
//
// 불변식:
// I1 실전 모드(mode === 'live')에서만 도구를 띄운다. 시험 모드는 명령을 보여 주기만 한다 — 시험 볼트의 체결모드가 실전이어도
//    시험 봇의 "응"이 증권사 API에 닿지 않는다.
// I2 오너 원본 메시지 하나 = 실행 한 번. 키 `${sourceChatId}:${sourceMessageId}`를 실행 원장(창구 상태 폴더 order-ledger.json)에
//    fsync로 먼저 남긴 뒤에만 도구를 띄운다. 키가 이미 있으면 결과와 상관없이 다시 띄우지 않는다. 원장을 못 쓰면 띄우지 않는다.
//    정정·취소 도구에는 자체 멱등키가 없어서 이 원장이 유일한 중복 방지다(매수·매도는 도구의 --request-id 멱등과 이중).
// I3 실행할 도구·인자는 buildOrderCommand가 확인 대기 내용에서 만든다(LLM 문장 아님). ORDER_TOOLS 세 개 밖의 도구는 부르지 않는다.
// I4 주문 도구는 'order' 줄 그룹으로 띄운다 — 창구가 멈추거나 죽어도 끊지 않는다(killRunningGateTools가 건너뜀). 주문 중간에
//    끊으면 증권사 접수와 장부 기록이 갈라질 수 있어서다. 결과를 못 받은 건은 원장에 '실행중'으로 남고 다음 시작 때 '결과 불명'으로 바뀐다.
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { buildOrderCommand } from './telegram-gate-confirm.mjs';

export const ORDER_TOOLS = Object.freeze(['place-nh-direct-order.mjs', 'modify-cancel-nh-order.mjs', 'retry-breakout-protection.mjs']);
// place-nh-direct-order 안의 체결 잡이 60초, 현재가 조회·토큰까지 더한 여유. 넘으면 결과 불명으로 알린다.
export const ORDER_TOOL_TIMEOUT_MS = 5 * 60 * 1000;
const LEDGER_KEEP_MS = 90 * 24 * 60 * 60 * 1000;

export function orderKey(confirm) {
  return `${confirm.sourceChatId}:${confirm.sourceMessageId}`;
}

function commandText({ tool, args }) {
  return `${tool} ${args.join(' ')}`;
}

// 시험 모드(와 실전 전) 실행기: 실행할 명령을 보여 주기만 한다.
export async function fakeOrderExecutor(confirm) {
  return { executed: false, status: '실행 안 함(시험)', text: `시험 모드라 실제로 실행하지 않았습니다.\n· 실행할 명령: ${commandText(buildOrderCommand(confirm))}` };
}

function writeDurable(path, content) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  const fd = openSync(tmp, 'w', 0o600);
  try {
    writeSync(fd, content);
    fsyncSync(fd);
  } finally { closeSync(fd); }
  try { renameSync(tmp, path); } catch (error) { try { unlinkSync(tmp); } catch { /* 없음 */ } throw error; }
}

export function createOrderLedger({ stateDir, now = () => new Date() }) {
  const path = join(stateDir, 'order-ledger.json');
  // 읽기 실패(깨진 파일)는 빈 원장으로 보지 않는다 — 이미 실행한 키를 잊으면 중복 실행이 된다(I2). 던져서 실행을 막는다.
  const read = () => {
    if (!existsSync(path)) return {};
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('주문 실행 원장 형식이 올바르지 않습니다');
    return parsed;
  };
  const write = (entries) => writeDurable(path, `${JSON.stringify(entries)}\n`);
  return {
    path,
    read,
    get: (key) => read()[key] ?? null,
    // 키가 없을 때만 '실행중'으로 남긴다. 이미 있으면 그 기록을 돌려준다(새로 남기지 않음).
    claim(key, fields) {
      const entries = read();
      if (entries[key]) return { claimed: false, entry: entries[key] };
      const cutoff = now().getTime() - LEDGER_KEEP_MS;
      for (const [k, e] of Object.entries(entries)) if (Date.parse(e.startedAt) < cutoff) delete entries[k];
      entries[key] = { ...fields, status: '실행중', startedAt: now().toISOString() };
      write(entries);
      return { claimed: true, entry: entries[key] };
    },
    finish(key, fields) {
      const entries = read();
      if (!entries[key]) return;
      entries[key] = { ...entries[key], ...fields, finishedAt: now().toISOString() };
      write(entries);
    },
    // 창구 시작 때: 결과를 못 받고 끝난 실행은 '결과 불명'으로 바꾼다(다시 실행하지 않음). 바뀐 건 목록을 돌려준다.
    markInterrupted() {
      const entries = read();
      const changed = Object.entries(entries).filter(([, e]) => e.status === '실행중');
      if (!changed.length) return [];
      for (const [k] of changed) entries[k] = { ...entries[k], status: '결과 불명(창구 재시작)', finishedAt: now().toISOString() };
      write(entries);
      return changed.map(([k, e]) => ({ key: k, ...e }));
    },
  };
}

// runTool(tool, args, { timeoutMs, group, allowed }) → stdout(성공) | throw(종료코드≠0·시간 초과). 시험은 가짜를 넣는다.
export function createOrderExecutor({ mode, ledger, runTool, log = () => {} }) {
  if (mode !== 'live') return fakeOrderExecutor; // I1
  return async function realOrderExecutor(confirm) {
    const command = buildOrderCommand(confirm); // I3
    if (!ORDER_TOOLS.includes(command.tool)) throw new Error(`주문 도구 목록에 없는 도구: ${command.tool}`);
    const key = orderKey(confirm);
    let claim;
    try {
      claim = ledger.claim(key, { confirmId: confirm.id, action: confirm.action, summary: confirm.summary, command: commandText(command) });
    } catch (error) {
      log(`[gate] 주문 원장 기록 실패 — 실행 안 함: ${error.message}`);
      return { executed: false, status: '실행 안 함(원장 오류)', text: `주문 실행 기록을 남기지 못해 실행하지 않았습니다(창구 로그 참고).\n· ${confirm.summary}` };
    }
    if (!claim.claimed) { // I2
      return { executed: false, status: '실행 안 함(이미 실행)', text: `같은 지시는 이미 한 번 실행했습니다(${claim.entry.status}). 다시 실행하지 않습니다.\n· ${confirm.summary}` };
    }
    log(`[gate] 주문 실행 시작 ${confirm.id} ${commandText(command)}`);
    try {
      const out = await runTool(command.tool, command.args, { timeoutMs: ORDER_TOOL_TIMEOUT_MS, group: 'order', allowed: (t) => ORDER_TOOLS.includes(t) });
      safeFinish(ledger, key, { status: '성공', output: String(out ?? '').slice(-500) }, log);
      return { executed: true, status: '실행됨', text: `실행했습니다.\n${String(out ?? '').trim() || '(도구 출력 없음)'}` };
    } catch (error) {
      safeFinish(ledger, key, { status: '실패', output: String(error.message ?? '').slice(-500) }, log);
      // 실패여도 다시 실행하지 않는다 — 도구가 증권사에 접수한 뒤 실패했을 수 있다. 오너가 상태를 보고 새로 지시한다.
      return { executed: true, status: '실행 실패', text: `실행했지만 실패로 끝났습니다. 자동으로 다시 시도하지 않습니다 — NH 앱에서 주문 상태를 확인해 주세요.\n${error.message}` };
    }
  };
}

function safeFinish(ledger, key, fields, log) {
  try { ledger.finish(key, fields); } catch (error) { log(`[gate] 주문 원장 결과 기록 실패(키는 남아 있어 재실행 없음): ${error.message}`); }
}
