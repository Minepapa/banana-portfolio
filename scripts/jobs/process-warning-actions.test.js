import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendWarningEvent } from '../lib/warning-event-journal.mjs';
import { processWarningActions } from './process-warning-actions.mjs';

test('자동조치 잡은 등록된 원장 사건만 고르고 기본 모드에서는 조회하지 않는다', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'warning-action-job-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  for (const [warningCode, subjectKey] of [
    ['MACRO_YFINANCE_QUERY_FAILED', 'macro:yfinance'],
    ['MARKET_THRESHOLD_BREACHED', 'market:signal'],
  ]) {
    await appendWarningEvent({
      eventId: randomUUID(), occurredAt: '2026-09-30T01:00:00.000Z',
      incidentId: randomUUID(), jobName: 'intraday-market-move-monitor',
      warningCode, subjectKey, kind: 'operational', severity: 'medium',
      eventType: 'detected',
    }, { rootDir });
  }
  const modes = [];
  const result = await processWarningActions({
    rootDir, execute: async (_id, options) => {
      modes.push(options.mode);
      return { executed: false, wouldRun: true };
    },
  });
  assert.deepEqual(modes, ['dry-run']);
  assert.deepEqual(result, { mode: 'dry-run', candidates: 1, executed: 0, eligible: 1, deferred: 0 });
});
