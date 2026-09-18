import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPendingEntryRecord, updatePendingEntryRecord, parsePendingEntry,
  findUnprocessedPendingEntries, isPendingEntryStale, PENDING_ENTRY_STATUS,
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

// [취소시도 신설, 2026-09-19] afterHoursOrgNo·afterHoursOrderQty가 왕복 보존되는지
// 확인 — 없으면 place-breakout-fallback-entry.mjs의 취소시도가 항상 스킵된다.
test('buildPendingEntryRecord: afterHoursOrgNo·afterHoursOrderQty 왕복 보존', () => {
  const { content } = buildPendingEntryRecord({
    code: '005930', name: '삼성전자', signalDate: '2026-09-13', investedWon: 10_000_000,
    afterHoursOrderNo: '123', afterHoursOrgNo: '06010', afterHoursOrderQty: 5, now,
  });
  const p = parsePendingEntry(content);
  assert.equal(p.afterHoursOrgNo, '06010');
  assert.equal(p.afterHoursOrderQty, 5);
});

test('buildPendingEntryRecord: afterHoursOrgNo·afterHoursOrderQty 생략 시 null(과거 레코드와 하위호환)', () => {
  const { content } = buildPendingEntryRecord({
    code: '005930', signalDate: '2026-09-13', investedWon: 10_000_000, afterHoursOrderNo: '123', now,
  });
  const p = parsePendingEntry(content);
  assert.equal(p.afterHoursOrgNo, null);
  assert.equal(p.afterHoursOrderQty, null);
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

// 2026-09-18 코드리뷰 HIGH 지적 — 킬스위치가 여러 날 켜져 있다가 꺼지면 묵은
// 대기항목이 조건 재검증 없이 한꺼번에 발주될 위험. isPendingEntryStale이 그
// 임계값을 정확히 지키는지 검증.
test('isPendingEntryStale: 정상 범위(주말 포함 3일)는 stale 아님', () => {
  const now = new Date('2026-09-21T00:03:00+09:00'); // 월요일 09:03 KST 실행
  assert.equal(isPendingEntryStale({ signalDate: '2026-09-18' }, { now }), false); // 금요일 신호 → 월요일 처리
});

test('isPendingEntryStale: maxAgeDays(기본 5일)를 넘으면 stale', () => {
  const now = new Date('2026-09-24T00:03:00+09:00');
  assert.equal(isPendingEntryStale({ signalDate: '2026-09-18' }, { now }), true); // 6일 경과
});

test('isPendingEntryStale: 경계값(정확히 maxAgeDays)은 stale 아님', () => {
  const now = new Date('2026-09-18T00:00:00+09:00');
  assert.equal(isPendingEntryStale({ signalDate: '2026-09-13' }, { maxAgeDays: 5, now }), false);
});

test('isPendingEntryStale: signalDate 없으면 판단 근거 없어 false(기존 처리 경로에 맡김)', () => {
  assert.equal(isPendingEntryStale({}), false);
});

test('isPendingEntryStale: maxAgeDays를 좁게 넘기면 그 값으로 판정', () => {
  const now = new Date('2026-09-19T00:00:00+09:00');
  assert.equal(isPendingEntryStale({ signalDate: '2026-09-18' }, { maxAgeDays: 1, now }), false);
  assert.equal(isPendingEntryStale({ signalDate: '2026-09-17' }, { maxAgeDays: 1, now }), true);
});
