import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isKrxTradingDay, kstDateLabel, readKrxTradingDayStatus, writeKrxTradingDayStatus,
} from './krx-trading-calendar.mjs';

const SEP24 = new Date('2026-09-24T03:00:00.000Z');
const SEP25 = new Date('2026-09-25T03:00:00.000Z');

test('kstDateLabel uses KST calendar date', () => {
  assert.equal(kstDateLabel(new Date('2026-09-24T15:30:00.000Z')), '2026-09-25');
});

test('KRX calendar cache: missing, stale-date, and malformed data fail closed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'krx-calendar-'));
  try {
    assert.equal(readKrxTradingDayStatus(SEP24, { cacheDir: dir }).isOpen, null);
    writeKrxTradingDayStatus({ date: '2026-09-25', isOpen: true, queriedAt: '2026-09-25T03:00:00.000Z' }, { cacheDir: dir, now: SEP25 });
    assert.equal(readKrxTradingDayStatus(SEP24, { cacheDir: dir }).isOpen, null);
    assert.equal(isKrxTradingDay(SEP24, { cacheDir: dir }), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('KRX calendar cache: closed holiday blocks; open trading day passes only for matching date', () => {
  const dir = mkdtempSync(join(tmpdir(), 'krx-calendar-'));
  try {
    writeKrxTradingDayStatus({ date: '2026-09-24', isOpen: false, queriedAt: '2026-09-24T03:00:00.000Z' }, { cacheDir: dir, now: SEP24 });
    assert.equal(readKrxTradingDayStatus(SEP24, { cacheDir: dir }).isOpen, false);
    assert.equal(isKrxTradingDay(SEP24, { cacheDir: dir }), false);
    writeKrxTradingDayStatus({ date: '2026-09-25', isOpen: true, queriedAt: '2026-09-25T03:00:00.000Z' }, { cacheDir: dir, now: SEP25 });
    assert.equal(readKrxTradingDayStatus(SEP25, { cacheDir: dir, now: SEP25 }).isOpen, true);
    assert.equal(isKrxTradingDay(SEP25, { cacheDir: dir, now: SEP25 }), true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('KRX calendar cache with timestamp from another KST date fails closed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'krx-calendar-'));
  try {
    writeKrxTradingDayStatus({ date: '2026-09-25', isOpen: true, queriedAt: '2026-09-25T03:00:00.000Z' }, { cacheDir: dir, now: SEP25 });
    writeFileSync(join(dir, '2026-09-25.json'), JSON.stringify({
      date: '2026-09-25', status: 'open', queriedAt: '2026-09-24T14:59:59.000Z',
    }));
    assert.equal(readKrxTradingDayStatus(SEP25, { cacheDir: dir, now: SEP25 }).isOpen, null);
    assert.equal(isKrxTradingDay(SEP25, { cacheDir: dir, now: SEP25 }), false);
    assert.throws(() => writeKrxTradingDayStatus({
      date: '2026-09-25', isOpen: true, queriedAt: '2026-09-24T14:59:59.000Z',
    }, { cacheDir: dir, now: SEP25 }));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('KRX calendar cache rejects timestamps from the future', () => {
  const dir = mkdtempSync(join(tmpdir(), 'krx-calendar-'));
  try {
    const future = '2026-09-25T04:00:00.000Z';
    writeFileSync(join(dir, '2026-09-25.json'), JSON.stringify({
      date: '2026-09-25', status: 'open', queriedAt: future,
    }));
    assert.equal(readKrxTradingDayStatus(SEP25, { cacheDir: dir, now: SEP25 }).isOpen, null);
    assert.throws(() => writeKrxTradingDayStatus({
      date: '2026-09-25', isOpen: true, queriedAt: future,
    }, { cacheDir: dir, now: SEP25 }));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
