import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rebuildSpendingSummaries } from './rebuild-spending-summaries.mjs';
import { lockFilesFor, withLock } from '../lib/state-writer.mjs';

test('기존 일별 원문은 dry-run에서 그대로 두고 명시 적용 시 요약만 생성한다', async (t) => {
  const spendingDir = mkdtempSync(join(tmpdir(), 'spending-rebuild-'));
  t.after(() => rmSync(spendingDir, { recursive: true, force: true }));
  mkdirSync(join(spendingDir, '2026'));
  const rawPath = join(spendingDir, '2026', '2026-10-10.jsonl');
  const summaryPath = join(spendingDir, '2026', '2026-10-10.summary.json');
  const raw = `${JSON.stringify({ ts: '2026-10-10 12:34:00', sender: '하나카드',
    body: '사용금액 : 2,500원\n가맹점 : 가상식당' })}\n`;
  writeFileSync(rawPath, raw);
  const logger = { log() {} };
  const preview = await rebuildSpendingSummaries({ spendingDir, logger });
  assert.deepEqual(preview, { dates: 1, changed: 1, dryRun: true });
  assert.equal(existsSync(summaryPath), false);
  const applied = await rebuildSpendingSummaries({ spendingDir, apply: true, logger });
  assert.deepEqual(applied, { dates: 1, changed: 1, dryRun: false });
  assert.equal(JSON.parse(readFileSync(summaryPath, 'utf8')).total, 2500);
  assert.equal(readFileSync(rawPath, 'utf8'), raw);
  assert.equal((await rebuildSpendingSummaries({ spendingDir, apply: true, logger })).changed, 0);
});

test('원문 락을 기다리는 동안 요약 락을 먼저 잡지 않는다', async (t) => {
  const spendingDir = mkdtempSync(join(tmpdir(), 'spending-rebuild-'));
  t.after(() => rmSync(spendingDir, { recursive: true, force: true }));
  mkdirSync(join(spendingDir, '2026'));
  const rawPath = join(spendingDir, '2026', '2026-10-10.jsonl');
  const summaryPath = join(spendingDir, '2026', '2026-10-10.summary.json');
  writeFileSync(rawPath, `${JSON.stringify({ ts: '2026-10-10 12:34:00', sender: '하나카드',
    body: '사용금액 : 2,500원\n가맹점 : 가상식당' })}\n`);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let entered;
  const held = withLock(rawPath, async () => {
    entered = true;
    await gate;
  });
  while (!entered) await new Promise((resolve) => setTimeout(resolve, 1));
  try {
    const rebuild = rebuildSpendingSummaries({ spendingDir, apply: true, logger: { log() {} } });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(lockFilesFor(summaryPath).some((lock) => existsSync(lock)), false);
    release();
    await held;
    await rebuild;
    assert.equal(JSON.parse(readFileSync(summaryPath, 'utf8')).total, 2500);
  } finally { release(); await held; }
});
