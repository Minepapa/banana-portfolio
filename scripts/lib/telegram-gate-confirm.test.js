import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildOrderCommand, confirmPromptBody, createConfirmStore, describeOrder, findSourceMessage, validateOrderParams, CONFIRM_TTL_MS } from './telegram-gate-confirm.mjs';

// 가짜 수신 대기열(임시 폴더)만 쓴다. 주문 도구·증권사 API를 부르지 않는다.
const OWNER = 31337;
// status: 처리 상태(기본 '처리중' — 대화 줄이 지금 넘긴 메시지).
function inboxLines(messages, status = '처리중') {
  return messages.flatMap((message, i) => [
    JSON.stringify({ type: 'update', updateId: i + 1, receivedAt: 't', update: { update_id: i + 1, message } }),
    ...(status ? [JSON.stringify({ type: 'status', updateId: i + 1, status, at: 't' })] : []),
  ]).join('\n');
}
const textMsg = (id, text, extra = {}) => ({ message_id: id, date: 1, chat: { id: OWNER, type: 'private' }, from: { id: OWNER }, text, ...extra });

test('validateOrderParams: 매수·매도·정정·취소·손절재시도 정상 입력을 정규화한다', () => {
  assert.deepEqual(validateOrderParams('매수', { asset: ' 삼성전자 ', quantity: 10 }), { asset: '삼성전자', quantity: 10 });
  assert.deepEqual(validateOrderParams('매도', { asset: '005930', quantity: 3, price: 70000 }), { asset: '005930', quantity: 3, price: 70000 });
  assert.deepEqual(validateOrderParams('정정', { orderNo: '123', account: '위탁', code: '005930', name: '삼성전자', side: '매수', price: 69000 }),
    { orderNo: '123', account: '위탁', code: '005930', name: '삼성전자', side: '매수', price: 69000 });
  assert.equal(validateOrderParams('취소', { orderNo: '123', account: '금현물', code: '04020K', name: '금', side: '매도' }).price, undefined);
  assert.deepEqual(validateOrderParams('손절재시도', { code: '005930' }), { code: '005930' });
});

test('validateOrderParams: 틀린 입력은 이유와 함께 거부한다', () => {
  const bad = [
    ['주문', {}], ['매수', { asset: '', quantity: 1 }], ['매수', { asset: '-rf', quantity: 1 }], ['매수', { asset: '삼성', quantity: 0 }],
    ['매수', { asset: '삼성', quantity: 1.5 }], ['매수', { asset: '삼성', quantity: 1, price: -1 }],
    ['정정', { orderNo: '12a', account: '위탁', code: '005930', name: 'x', side: '매수', price: 1 }],
    ['정정', { orderNo: '1', account: 'ISA', code: '005930', name: 'x', side: '매수', price: 1 }],
    ['정정', { orderNo: '1', account: '위탁', code: '005930', name: 'x', side: '매수' }],
    ['손절재시도', {}], ['손절재시도', { code: '005930', positionId: 'p' }], ['손절재시도', { code: '59' }],
  ];
  for (const [action, params] of bad) assert.throws(() => validateOrderParams(action, params), Error, `${action} ${JSON.stringify(params)}`);
});

test('buildOrderCommand: request-id는 원본 지시 메시지로 만든다(같은 지시는 다시 주문되지 않음)', () => {
  const confirm = { action: '매수', params: { asset: '삼성전자', quantity: 10, price: 70000 }, sourceChatId: '31337', sourceMessageId: 77 };
  assert.deepEqual(buildOrderCommand(confirm), { tool: 'place-nh-direct-order.mjs', args: ['--side=매수', '--asset=삼성전자', '--quantity=10', '--request-id=telegram:31337:77', '--price=70000'] });
  assert.equal(buildOrderCommand({ action: '취소', params: { orderNo: '1', account: '위탁', code: '005930', name: '삼성', side: '매도' } }).tool, 'modify-cancel-nh-order.mjs');
  assert.deepEqual(buildOrderCommand({ action: '손절재시도', params: { positionId: 'P1' } }), { tool: 'retry-breakout-protection.mjs', args: ['--position-id=P1'] });
});

test('describeOrder·confirmPromptBody: 코드가 만든 확인 문구, 실전이면 실제 주문 경고', () => {
  assert.equal(describeOrder('매수', { asset: '삼성전자', quantity: 10 }), '삼성전자 10주 매수(현재가 지정가)');
  const body = confirmPromptBody({ summary: '삼성전자 10주 매수(현재가 지정가)' }, { live: true });
  assert.match(body, /접수할까요\? 삼성전자 10주 매수/);
  assert.match(body, /바로 실제 주문/);
  assert.match(confirmPromptBody({ summary: 'x' }, { live: false }), /섀도우/);
});

test('findSourceMessage: 오너가 직접 친 글만 인정(전달·음성·사진·없음은 거부)', () => {
  const records = inboxLines([
    textMsg(1, '삼성전자 10주 사줘'),
    textMsg(2, '삼성전자 10주 사줘', { forward_origin: { type: 'user' } }),
    { message_id: 3, chat: { id: OWNER, type: 'private' }, from: { id: OWNER }, voice: { file_id: 'v' } },
  ]).split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(findSourceMessage(records, 1), { chatId: '31337', messageId: 1, updateId: 1, text: '삼성전자 10주 사줘', replyTo: null });
  assert.throws(() => findSourceMessage(records, 2), /전달된 메시지/);
  assert.throws(() => findSourceMessage(records, 3), /글 메시지가 아닌/);
  assert.throws(() => findSourceMessage(records, 9), /찾지 못했습니다/);
  const done = inboxLines([textMsg(1, '예전 지시')], '완료').split('\n').map((l) => JSON.parse(l));
  assert.throws(() => findSourceMessage(done, 1), /지금 처리 중인 오너 메시지가 아니라/, '예전 메시지로는 접수 못 함');
});

test('isAnswerToConfirm: 확인 질문을 보낸 초보다 엄격히 뒤의 메시지만, 미발표·대기 아님은 거부', async () => {
  const { isAnswerToConfirm } = await import('./telegram-gate-confirm.mjs');
  const c = { status: '대기', announced: true, announcedAt: '2026-10-30T05:00:00.700Z' };
  const sec = Date.parse('2026-10-30T05:00:00Z') / 1000;
  assert.equal(isAnswerToConfirm(c, sec + 1), true);
  assert.equal(isAnswerToConfirm(c, sec), false, '같은 초는 질문 전일 수 있어 거부');
  assert.equal(isAnswerToConfirm(c, sec - 1), false);
  assert.equal(isAnswerToConfirm({ ...c, announced: false }, sec + 5), false);
  assert.equal(isAnswerToConfirm({ ...c, status: '거절' }, sec + 5), false);
  assert.equal(isAnswerToConfirm(null, sec), false);
});

test('update는 id가 맞을 때만 바꾼다(새 접수를 덮지 않음)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-confirm-id-'));
  try {
    writeFileSync(join(dir, 'inbox.jsonl'), `${inboxLines([textMsg(5, '삼성 10주 사')])}\n`);
    const store = createConfirmStore({ stateDir: dir });
    const c = store.stage({ action: '매수', params: { asset: '삼성전자', quantity: 1 }, sourceMessageId: 5 });
    assert.equal(store.update({ status: '실행됨' }, { id: 'CF-other' }), null);
    assert.equal(store.read().status, '대기');
    assert.equal(store.update({ status: '거절' }, { id: c.id }).status, '거절');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('확인 대기 저장소: 접수 → 대기 → 10분 뒤 만료, 새 접수는 이전 건을 대체', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-confirm-'));
  try {
    writeFileSync(join(dir, 'inbox.jsonl'), `${inboxLines([textMsg(5, '삼성 10주 사'), textMsg(6, '하이닉스 1주 사')])}\n`);
    let clock = new Date('2026-10-30T05:00:00Z');
    const store = createConfirmStore({ stateDir: dir, now: () => clock });
    const first = store.stage({ action: '매수', params: { asset: '삼성전자', quantity: 10 }, sourceMessageId: 5 });
    assert.equal(store.pending().id, first.id);
    assert.equal(first.summary, '삼성전자 10주 매수(현재가 지정가)');
    const second = store.stage({ action: '매수', params: { asset: 'SK하이닉스', quantity: 1 }, sourceMessageId: 6 });
    assert.equal(store.pending().id, second.id);
    clock = new Date(clock.getTime() + CONFIRM_TTL_MS + 1);
    assert.equal(store.pending(), null);
    assert.equal(store.expired().id, second.id);
    assert.throws(() => store.stage({ action: '매수', params: { asset: '삼성', quantity: 1 }, sourceMessageId: 99 }), /찾지 못했습니다/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('대체 알림·대화 묶음 제한: 물은 확인을 새 접수가 바꾸면 알리고, 지금 대화 묶음 밖 메시지로는 접수하지 않는다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-confirm-batch-'));
  try {
    writeFileSync(join(dir, 'inbox.jsonl'), `${inboxLines([textMsg(5, '삼성 10주 사'), textMsg(6, '하이닉스 1주 사'), textMsg(7, '📜 메모')])}\n`);
    const store = createConfirmStore({ stateDir: dir });
    store.setActiveBatch([5, 6]);
    const first = store.stage({ action: '매수', params: { asset: '삼성전자', quantity: 10 }, sourceMessageId: 5 });
    store.update({ announced: true, announcedAt: new Date().toISOString() }, { id: first.id });
    const second = store.stage({ action: '매수', params: { asset: 'SK하이닉스', quantity: 1 }, sourceMessageId: 6 });
    assert.deepEqual(second.replaced, { id: first.id, summary: first.summary });
    assert.match(confirmPromptBody(second, { live: false }), /앞서 물은 확인\(삼성전자 10주 매수/);
    assert.throws(() => store.stage({ action: '매수', params: { asset: '삼성', quantity: 1 }, sourceMessageId: 7 }), /지금 대화로 넘긴 메시지가 아니라/);
    store.setActiveBatch(null);
    assert.equal(store.stage({ action: '매수', params: { asset: '삼성', quantity: 1 }, sourceMessageId: 7 }).sourceMessageId, 7, '묶음 정보가 없으면 처리중 조건만');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
