import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOrderExecutor, createOrderLedger, describeOrderFailure, fakeOrderExecutor, orderKey, ORDER_TOOLS } from './telegram-gate-order-executor.mjs';
import { GATE_TOOLS, LLM_GATE_TOOLS, isGateToolAllowed } from './telegram-gate-handlers.mjs';

const confirmOf = (fields = {}) => ({ id: 'CF-1', action: '매수', params: { asset: '삼성전자', quantity: 10 }, summary: '삼성전자 10주 매수',
  sourceChatId: '31337', sourceMessageId: 7, ...fields });

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'gate-order-'));
  const calls = [];
  let behavior = async () => '✅ 주문 접수';
  const runTool = async (tool, args, opts) => { calls.push({ tool, args, opts }); return behavior(tool, args, opts); };
  const ledger = createOrderLedger({ stateDir: dir, now: () => new Date('2026-11-03T01:00:00Z') });
  return { dir, calls, ledger, runTool, setBehavior: (fn) => { behavior = fn; }, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('I1: 실전이 아니면 도구를 띄우지 않는다(시험 볼트 체결모드와 무관)', async () => {
  const s = setup();
  try {
    for (const mode of ['test', undefined, 'self-test', 'LIVE']) {
      const exec = createOrderExecutor({ mode, ledger: s.ledger, runTool: s.runTool });
      assert.equal(exec, fakeOrderExecutor);
      const r = await exec(confirmOf());
      assert.equal(r.executed, false);
      assert.match(r.text, /시험 모드라 실제로 실행하지 않았습니다/);
    }
    assert.equal(s.calls.length, 0);
    assert.deepEqual(s.ledger.read(), {});
  } finally { s.cleanup(); }
});

test('실전: 확인 대기 내용으로 만든 명령만 order 그룹·주문 도구 허용 목록으로 실행', async () => {
  const s = setup();
  try {
    const exec = createOrderExecutor({ mode: 'live', ledger: s.ledger, runTool: s.runTool });
    const r = await exec(confirmOf());
    assert.equal(r.executed, true);
    assert.equal(r.status, '실행됨');
    assert.match(r.text, /주문 접수/);
    assert.equal(s.calls.length, 1);
    const [c] = s.calls;
    assert.equal(c.tool, 'place-nh-direct-order.mjs');
    assert.ok(c.args.includes('--request-id=telegram:31337:7'));
    assert.equal(c.opts.group, 'order');
    assert.equal(c.opts.allowed('place-nh-direct-order.mjs'), true);
    assert.equal(c.opts.allowed('kill-switch-cli.mjs'), false, '주문 실행 경로로 다른 도구를 부르지 못함');
    assert.equal(s.ledger.get(orderKey(confirmOf())).status, '성공');
  } finally { s.cleanup(); }
});

test('I2: 같은 원본 메시지는 한 번만 — 정정·취소(자체 멱등키 없음)도, 다른 확인 id로 다시 와도, 창구가 다시 떠도', async () => {
  const s = setup();
  try {
    const cancel = confirmOf({ id: 'CF-A', action: '취소', params: { orderNo: '847026', account: '위탁', code: '005930', name: '삼성전자', side: '매수' }, summary: '취소' });
    const exec = createOrderExecutor({ mode: 'live', ledger: s.ledger, runTool: s.runTool });
    assert.equal((await exec(cancel)).executed, true);
    const again = await exec({ ...cancel, id: 'CF-B' });
    assert.equal(again.executed, false);
    assert.equal(again.status, '실행 안 함(이미 실행)');
    // 재시작(새 원장 객체·새 실행기)에서도 파일 원장이 막는다.
    const exec2 = createOrderExecutor({ mode: 'live', ledger: createOrderLedger({ stateDir: s.dir }), runTool: s.runTool });
    assert.equal((await exec2({ ...cancel, id: 'CF-C', action: '정정', params: { ...cancel.params, price: 70000 } })).executed, false);
    assert.equal(s.calls.length, 1);
    assert.equal(s.calls[0].tool, 'modify-cancel-nh-order.mjs');
  } finally { s.cleanup(); }
});

test('I2: 실패도 다시 실행하지 않고, 원장을 먼저 남긴 뒤에만 도구를 띄운다', async () => {
  const s = setup();
  try {
    const exec = createOrderExecutor({ mode: 'live', ledger: s.ledger, runTool: s.runTool });
    let ledgerAtSpawn = null;
    s.setBehavior(async () => { ledgerAtSpawn = JSON.parse(readFileSync(s.ledger.path, 'utf8')); throw new Error('NH 오류'); });
    const r = await exec(confirmOf());
    assert.equal(ledgerAtSpawn['31337:7'].status, '실행중', '도구가 뜨는 시점에 원장이 이미 디스크에 있다');
    assert.equal(r.status, '실패(체결 잡 재시도 가능)');
    assert.match(r.text, /같은 주문을 다시 지시하지 마세요/);
    assert.equal(s.ledger.get('31337:7').status, '실패(체결 잡 재시도 가능)');
    assert.equal((await exec(confirmOf({ id: 'CF-2' }))).executed, false);
    assert.equal(s.calls.length, 1);
  } finally { s.cleanup(); }
});

test('I2: 원장이 깨졌거나 못 쓰면 실행하지 않는다(빈 원장으로 보지 않음)', async () => {
  const s = setup();
  try {
    writeFileSync(s.ledger.path, '{깨짐');
    const exec = createOrderExecutor({ mode: 'live', ledger: s.ledger, runTool: s.runTool });
    const r = await exec(confirmOf());
    assert.equal(r.executed, false);
    assert.equal(r.status, '실행 안 함(원장 오류)');
    assert.equal(s.calls.length, 0);
    assert.throws(() => s.ledger.markInterrupted());
  } finally { s.cleanup(); }
});

test('창구 재시작: 결과 못 받은 실행은 결과 불명으로 바뀌고 다시 실행하지 않는다', async () => {
  const s = setup();
  try {
    s.ledger.claim('31337:7', { confirmId: 'CF-1', summary: '삼성전자 10주 매수' });
    const changed = createOrderLedger({ stateDir: s.dir }).markInterrupted();
    assert.equal(changed.length, 1);
    assert.equal(s.ledger.get('31337:7').status, '결과 불명(창구 재시작)');
    assert.deepEqual(createOrderLedger({ stateDir: s.dir }).markInterrupted(), []);
    const exec = createOrderExecutor({ mode: 'live', ledger: s.ledger, runTool: s.runTool });
    assert.equal((await exec(confirmOf())).executed, false);
    assert.equal(s.calls.length, 0);
  } finally { s.cleanup(); }
});

test('I3: 주문 도구는 창구 결정론·LLM 허용 목록 어디에도 없다(확인 대기 뒤 실행기만 부름)', () => {
  for (const tool of ORDER_TOOLS) {
    assert.equal(GATE_TOOLS.includes(tool), false, tool);
    assert.equal(LLM_GATE_TOOLS.includes(tool), false, tool);
    assert.equal(isGateToolAllowed(tool, { factsFiles: () => [] }), false, tool);
  }
});

test('원장: 90일 지난 기록은 새 기록 때 정리', () => {
  const s = setup();
  try {
    writeFileSync(s.ledger.path, JSON.stringify({ old: { status: '성공', startedAt: '2026-07-01T00:00:00Z' }, recent: { status: '성공', startedAt: '2026-10-01T00:00:00Z' } }));
    s.ledger.claim('new', {});
    assert.deepEqual(Object.keys(s.ledger.read()).sort(), ['new', 'recent']);
  } finally { s.cleanup(); }
});

test('실패 안내(리뷰 HIGH-2): 매수·매도는 체결 잡 재시도 가능·다시 지시 금지, 정정·취소는 창구 재시도 없음, 시간 초과는 결과 불명', () => {
  const buy = describeOrderFailure(confirmOf(), new Error('⚠️ 다음 10분 크론이 재시도함'));
  assert.equal(buy.status, '실패(체결 잡 재시도 가능)');
  assert.match(buy.text, /10분 체결 잡이 다시 실행할 수 있습니다/);
  assert.doesNotMatch(buy.text, /자동으로 다시 시도하지 않습니다/, '도구 안내와 반대되는 문구 없음');
  const cancel = describeOrderFailure(confirmOf({ action: '취소' }), new Error('NH 거부'));
  assert.equal(cancel.status, '실패');
  assert.match(cancel.text, /창구는 자동으로 다시 시도하지 않습니다/);
  const timeout = Object.assign(new Error('시간 초과'), { code: 'GATE_TOOL_TIMEOUT' });
  const t = describeOrderFailure(confirmOf({ action: '정정' }), timeout);
  assert.equal(t.status, '결과 불명(시간 초과)');
  assert.match(t.text, /다시 지시하지 말고/);
  assert.ok(describeOrderFailure(confirmOf(), new Error('x'.repeat(5000))).text.length < 1800, '답장은 끝부분만');
});

test('I5: 앞 주문 도구가 아직 돌면(시간 초과 뒤 포함) 실행하지 않고 원장도 남기지 않는다 / 로그 파일 경로를 넘긴다', async () => {
  const s = setup();
  try {
    let busy = true;
    const exec = createOrderExecutor({ mode: 'live', ledger: s.ledger, runTool: s.runTool, isBusy: () => busy, logDir: join(s.dir, 'order-logs') });
    const r = await exec(confirmOf());
    assert.equal(r.status, '실행 안 함(앞 주문 진행 중)');
    assert.equal(s.calls.length, 0);
    assert.deepEqual(s.ledger.read(), {});
    busy = false;
    s.setBehavior(async () => { throw Object.assign(new Error('시간 초과'), { code: 'GATE_TOOL_TIMEOUT' }); });
    const t = await exec(confirmOf());
    assert.equal(t.status, '결과 불명(시간 초과)');
    assert.equal(s.calls[0].opts.logFile, join(s.dir, 'order-logs', 'CF-1.log'));
    assert.equal(s.ledger.get('31337:7').status, '결과 불명(시간 초과)');
  } finally { s.cleanup(); }
});
