import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyExecutionConfirmation,
  validateConfirmationDecision,
  validateConfirmationSource,
} from './resolve-execution-confirmation.mjs';
import { buildExecutionConfirmation } from '../lib/execution-confirmation-queue.mjs';

const event = {
  broker: 'NH투자증권', tradeDate: '2026-09-29 09:27:53', tradeType: '매수',
  stockCode: '329200', stockName: 'TIGER 리츠', quantity: 10, price: 4037, currency: 'KRW', orderNo: '847026',
};

function confirmation() {
  return buildExecutionConfirmation({
    firestoreDocId: 'doc-1', event, sourceBody: '원문 체결 알림', allowedAccounts: ['ISA'], reason: '계좌번호 없음',
    now: new Date('2026-09-29T00:00:00Z'), random: () => 'ABC123',
  }).record;
}

test('validateConfirmationDecision: 대기 중인 허용 계좌만 확인할 수 있다', () => {
  assert.deepEqual(validateConfirmationDecision({ confirmation: confirmation(), answer: 'ISA' }), { ok: true, account: 'ISA' });
  assert.equal(validateConfirmationDecision({ confirmation: confirmation(), answer: '위탁' }).ok, false);
  assert.equal(validateConfirmationDecision({ confirmation: { ...confirmation(), status: '확인됨' }, answer: 'ISA' }).ok, false);
});

test('validateConfirmationSource: 원본 문서와 지문이 바뀌면 중단한다', () => {
  assert.equal(validateConfirmationSource({ confirmation: confirmation(), firestoreDocId: 'doc-1', event, sourceBody: '원문 체결 알림' }).ok, true);
  assert.equal(validateConfirmationSource({ confirmation: confirmation(), firestoreDocId: 'doc-1', event: { ...event, quantity: 11 }, sourceBody: '원문 체결 알림' }).ok, false);
  assert.equal(validateConfirmationSource({ confirmation: confirmation(), firestoreDocId: 'doc-1', event, sourceBody: '바뀐 원문' }).ok, false);
});

test('applyExecutionConfirmation: Ledger 기록 뒤 기록됨 체크포인트를 저장하고 원문을 삭제한다', async () => {
  const calls = [];
  const result = await applyExecutionConfirmation({
    confirmation: confirmation(), account: 'ISA', firestoreDocId: 'doc-1', event, sourceBody: '원문 체결 알림',
    existsLedger: () => false,
    writeLedger: async (ledger) => { calls.push(`ledger:${ledger.filename}`); },
    deleteSource: async () => { calls.push('source-delete'); },
    writeConfirmation: async (updated) => { calls.push(`confirmation:${updated.status}`); },
    now: new Date('2026-09-29T00:01:00Z'),
  });
  assert.equal(calls[0].startsWith('ledger:'), true);
  assert.deepEqual(calls.slice(1), ['confirmation:기록됨', 'source-delete', 'confirmation:확인됨']);
  assert.equal(result.confirmation.status, '확인됨');
  assert.equal(result.ledger.filename.endsWith('-doc-1.md'), true);
});

test('applyExecutionConfirmation: 이미 같은 Ledger가 있으면 기록됨부터 복구해 원문 삭제를 재개한다', async () => {
  const calls = [];
  const result = await applyExecutionConfirmation({
    confirmation: confirmation(), account: 'ISA', firestoreDocId: 'doc-1', event, sourceBody: '원문 체결 알림',
    existsLedger: (filepath) => !filepath.includes('doc-1'),
    writeLedger: async () => { calls.push('ledger'); },
    deleteSource: async () => { calls.push('source-delete'); },
    writeConfirmation: async (updated) => { calls.push(`confirmation:${updated.status}`); },
  });
  assert.equal(result.confirmation.status, '확인됨');
  assert.deepEqual(calls, ['confirmation:기록됨', 'source-delete', 'confirmation:확인됨']);
});

test('applyExecutionConfirmation: 기존·신규 Ledger가 함께 있으면 원문 삭제 전에 중단한다', async () => {
  const calls = [];
  await assert.rejects(() => applyExecutionConfirmation({
    confirmation: confirmation(), account: 'ISA', firestoreDocId: 'doc-1', event, sourceBody: '원문 체결 알림',
    existsLedger: () => true,
    writeLedger: async () => { calls.push('ledger'); },
    deleteSource: async () => { calls.push('source-delete'); },
    writeConfirmation: async () => { calls.push('confirmation'); },
  }), /기존·신규 Ledger/);
  assert.deepEqual(calls, []);
});

test('applyExecutionConfirmation: Ledger 쓰기 실패면 원문 삭제와 완료 상태 변경을 하지 않는다', async () => {
  const calls = [];
  await assert.rejects(() => applyExecutionConfirmation({
    confirmation: confirmation(), account: 'ISA', firestoreDocId: 'doc-1', event, sourceBody: '원문 체결 알림',
    existsLedger: () => false,
    writeLedger: async () => { throw new Error('disk unavailable'); },
    deleteSource: async () => { calls.push('source-delete'); },
    writeConfirmation: async () => { calls.push('confirmation'); },
  }), /disk unavailable/);
  assert.deepEqual(calls, []);
});
