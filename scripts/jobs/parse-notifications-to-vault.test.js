import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareExecutionConfirmation, readHoldings } from './parse-notifications-to-vault.mjs';
import { rejectExecutionConfirmation } from '../lib/execution-confirmation-queue.mjs';

test('readHoldings: State/Holdings frontmatter를 계좌 판정 입력으로 읽는다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'banana-holdings-'));
  try {
    writeFileSync(join(dir, 'ISA-테스트.md'), '---\naccount: "ISA"\nname: "테스트 종목"\nticker: "000001"\n---\n');
    assert.deepEqual(readHoldings(dir), [{ account: 'ISA', name: '테스트 종목', ticker: '000001' }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('prepareExecutionConfirmation: 계좌가 겹치는 카카오 체결은 확인 대기와 표준 답장 형식으로 만든다', () => {
  const event = {
    broker: 'NH투자증권', tradeDate: '2026-09-29 09:27:53', tradeType: '매수',
    stockCode: '329200', stockName: 'TIGER 리츠', quantity: 10, price: 4037, currency: 'KRW', orderNo: '847026',
  };
  const result = prepareExecutionConfirmation({
    id: 'doc-1', event,
    holdings: [{ account: 'ISA', name: 'TIGER 리츠', ticker: '329200' }, { account: '위탁', name: 'TIGER 리츠', ticker: '329200' }],
    now: new Date('2026-09-29T00:00:00Z'), random: () => 'ABC123',
  });
  assert.equal(result.kind, 'account-assignment');
  assert.equal(result.confirmation.record.id, 'EC-20260929-ABC123');
  assert.match(result.telegramBody, /■ 체결/);
  assert.match(result.telegramBody, /체결확인 EC-20260929-ABC123 ISA/);
  assert.equal(result.shouldDeleteFirestore, false);
  assert.equal(result.shouldSendTelegram, true);
});

test('prepareExecutionConfirmation: 같은 원문은 기존 대기 건을 재사용하고 재알림하지 않는다', () => {
  const event = { broker: 'NH투자증권', tradeType: '매수', stockName: 'TIGER 리츠', stockCode: '329200', quantity: 10, price: 4037 };
  const holdings = [{ account: 'ISA', name: 'TIGER 리츠', ticker: '329200' }, { account: '위탁', name: 'TIGER 리츠', ticker: '329200' }];
  const first = prepareExecutionConfirmation({ id: 'doc-1', event, holdings, now: new Date('2026-09-29T00:00:00Z'), random: () => 'ABC123' });
  const repeated = prepareExecutionConfirmation({ id: 'doc-1', event, holdings, confirmations: [{ ...first.confirmation.record, notifiedAt: '2026-09-29T00:01:00Z' }] });
  assert.equal(repeated.confirmation.record.id, first.confirmation.record.id);
  assert.equal(repeated.shouldSendTelegram, false);
});

test('prepareExecutionConfirmation: 무시한 동일 원문은 새 확인 대기·재알림·일반 경고를 만들지 않는다', () => {
  const event = { broker: 'NH투자증권', tradeType: '매수', stockName: 'TIGER 리츠', stockCode: '329200', quantity: 10, price: 4037 };
  const holdings = [{ account: 'ISA', name: 'TIGER 리츠', ticker: '329200' }, { account: '위탁', name: 'TIGER 리츠', ticker: '329200' }];
  const first = prepareExecutionConfirmation({ id: 'doc-1', event, holdings, now: new Date('2026-09-29T00:00:00Z'), random: () => 'ABC123' });
  const ignored = rejectExecutionConfirmation(first.confirmation.record, new Date('2026-09-29T00:01:00Z'));
  const repeated = prepareExecutionConfirmation({ id: 'doc-1', event, holdings, confirmations: [ignored] });
  assert.equal(repeated.confirmation.record.status, '기각');
  assert.equal(repeated.shouldSendTelegram, false);
  assert.equal(repeated.shouldWriteConfirmation, false);
});

test('prepareExecutionConfirmation: 파일 메타데이터는 대기 레코드 frontmatter로 재저장하지 않는다', async () => {
  const { serializeExecutionConfirmation } = await import('../lib/execution-confirmation-queue.mjs');
  const event = { broker: 'NH투자증권', tradeType: '매수', stockName: 'TIGER 리츠', stockCode: '329200', quantity: 10, price: 4037 };
  const holdings = [{ account: 'ISA', name: 'TIGER 리츠', ticker: '329200' }, { account: '위탁', name: 'TIGER 리츠', ticker: '329200' }];
  const first = prepareExecutionConfirmation({ id: 'doc-1', event, holdings, now: new Date('2026-09-29T00:00:00Z'), random: () => 'ABC123' });
  const repeated = prepareExecutionConfirmation({
    id: 'doc-1', event, holdings,
    confirmations: [{ filename: first.confirmation.filename, content: first.confirmation.content, ...first.confirmation.record }],
  });
  assert.doesNotMatch(serializeExecutionConfirmation(repeated.confirmation.record), /^(filename|content):/m);
});

test('prepareExecutionConfirmation: 같은 Firestore 문서의 체결 내용이 바뀌면 ID를 유지하고 재확인한다', () => {
  const event = { broker: 'NH투자증권', tradeType: '매수', stockName: 'TIGER 리츠', stockCode: '329200', quantity: 10, price: 4037 };
  const holdings = [{ account: 'ISA', name: 'TIGER 리츠', ticker: '329200' }, { account: '위탁', name: 'TIGER 리츠', ticker: '329200' }];
  const first = prepareExecutionConfirmation({ id: 'doc-1', event, holdings, now: new Date('2026-09-29T00:00:00Z'), random: () => 'ABC123' });
  const changed = prepareExecutionConfirmation({
    id: 'doc-1', event: { ...event, quantity: 11 }, holdings,
    confirmations: [{ filename: first.confirmation.filename, content: first.confirmation.content, ...first.confirmation.record, notifiedAt: '2026-09-29T00:01:00Z' }],
    now: new Date('2026-09-29T00:02:00Z'),
  });
  assert.equal(changed.confirmation.record.id, first.confirmation.record.id);
  assert.equal(changed.confirmation.record.quantity, 11);
  assert.equal(changed.shouldSendTelegram, true);
  assert.equal(changed.shouldWriteConfirmation, true);
});

test('prepareExecutionConfirmation: 같은 원문에 대기 건이 여러 개면 새 대기 건을 추정해 만들지 않는다', () => {
  const event = { broker: 'NH투자증권', tradeType: '매수', stockName: 'TIGER 리츠', stockCode: '329200', quantity: 10, price: 4037 };
  const holdings = [{ account: 'ISA', name: 'TIGER 리츠', ticker: '329200' }, { account: '위탁', name: 'TIGER 리츠', ticker: '329200' }];
  const first = prepareExecutionConfirmation({ id: 'doc-1', event, holdings, now: new Date('2026-09-29T00:00:00Z'), random: () => 'ABC123' });
  const confirmations = [
    { ...first.confirmation.record },
    { ...first.confirmation.record, id: 'EC-20260929-DEF456' },
  ];
  const result = prepareExecutionConfirmation({ id: 'doc-1', event: { ...event, quantity: 11 }, holdings, confirmations });
  assert.equal(result.confirmation, null);
  assert.equal(result.shouldSendTelegram, false);
});
