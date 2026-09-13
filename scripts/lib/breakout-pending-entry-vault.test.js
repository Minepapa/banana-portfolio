import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPendingEntryRecord, updatePendingEntryRecord, parsePendingEntry,
  findUnprocessedPendingEntries, PENDING_ENTRY_STATUS,
} from './breakout-pending-entry-vault.mjs';

const now = new Date('2026-09-13T00:00:00.000Z');

test('buildPendingEntryRecord: 생성 시 status=pending, id는 code-signalDate', () => {
  const { id, filename, content } = buildPendingEntryRecord({
    code: '005930', name: '삼성전자', signalDate: '2026-09-13', investedWon: 10_000_000,
    afterHoursOrderNo: '123', reason: '장후시간외 미체결(0주)', now,
  });
  const p = parsePendingEntry(content);
  assert.equal(id, '005930-2026-09-13');
  assert.equal(filename, '005930-2026-09-13.md');
  assert.equal(p.status, PENDING_ENTRY_STATUS.PENDING);
  assert.equal(p.investedWon, 10_000_000);
  assert.equal(p.afterHoursOrderNo, '123');
});

test('buildPendingEntryRecord: afterHoursOrderNo 생략 시 null(장후시간외 주문 자체가 실패해도 폴백 큐잉 가능)', () => {
  const { content } = buildPendingEntryRecord({
    code: '005930', signalDate: '2026-09-13', investedWon: 10_000_000, now,
  });
  assert.equal(parsePendingEntry(content).afterHoursOrderNo, null);
});

test('updatePendingEntryRecord: 처리완료 반영 — 다른 필드는 보존', () => {
  const { content } = buildPendingEntryRecord({
    code: '005930', name: '삼성전자', signalDate: '2026-09-13', investedWon: 10_000_000, now,
  });
  const updated = updatePendingEntryRecord(content, { status: PENDING_ENTRY_STATUS.PLACED, updatedAt: '2026-09-14T00:00:00.000Z' });
  const p = parsePendingEntry(updated);
  assert.equal(p.status, PENDING_ENTRY_STATUS.PLACED);
  assert.equal(p.name, '삼성전자'); // 보존 확인
  assert.equal(p.investedWon, 10_000_000);
});

test('findUnprocessedPendingEntries: pending만 남기고 placed/failed는 제외', () => {
  const entries = [
    { code: 'A', status: PENDING_ENTRY_STATUS.PENDING },
    { code: 'B', status: PENDING_ENTRY_STATUS.PLACED },
    { code: 'C', status: PENDING_ENTRY_STATUS.FAILED },
  ];
  const result = findUnprocessedPendingEntries(entries);
  assert.deepEqual(result.map((e) => e.code), ['A']);
});
