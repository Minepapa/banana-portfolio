import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('동선 계산 실패해도 실패 문구를 쓰고 확정한다', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'd89-daily-retry-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  process.env.VAULT_PATH = root;
  const { VAULT_REL } = await import('../lib/vault-paths.mjs');
  const { processDay, planActions } = await import('./daily-note.mjs');
  const { inspectExisting } = await import('../lib/daily-note.mjs');
  mkdirSync(join(root, VAULT_REL.location), { recursive: true });
  const rules = [{ type: 'daily', path: VAULT_REL.dailyNotes, pathRegex: new RegExp(`^${VAULT_REL.dailyNotes}/\\d{4}/[^/]+\\.md$`),
    required: { bundle: [], extra: [] } }];
  const date = '2026-10-09';
  const deps = { summarize: async () => ({ summary: '- 요약', summaryStatus: 'ok', model: 'none' }),
    fetchEvents: async () => [], computeRoute: async () => { throw new Error('offline'); },
    updateCandidates: () => { throw new Error('후보 갱신 금지'); }, send: async () => { throw new Error('발송 금지'); } };
  const first = await processDay({ mode: 'finalize', date, today: '2026-10-10', rules, noSend: true, deps });
  assert.equal(first.failed, false);
  const path = join(root, VAULT_REL.dailyNotes, '2026', `${date}.md`);
  assert.equal(existsSync(path), true);
  const status = () => inspectExisting(readFileSync(path, 'utf8')).prev.fields.dailyStatus;
  assert.equal(status(), '확정');
  assert.match(readFileSync(path, 'utf8'), /동선 계산 실패/);
  assert.deepEqual(planActions({ now: new Date('2026-10-10T12:00:00Z'), noteStatus: status }), [{ mode: 'draft', date: '2026-10-10' }]);
  const second = await processDay({ mode: 'finalize', date, today: '2026-10-10', rules, noSend: true,
    deps: { ...deps, computeRoute: async () => [], updateCandidates: () => {} } });
  assert.equal(second.failed, false);
  assert.equal(status(), '확정');
  let sent = 0;
  const result = await processDay({ mode: 'finalize', date: '2026-10-08', today: '2026-10-10', rules,
    deps: { summarize: async () => ({ summary: '- 요약', summaryStatus: 'ok', model: 'none' }), fetchEvents: async () => [],
      computeRoute: async () => [], updateCandidates: () => { throw new Error('12.3,34.5 저장 실패'); }, send: async () => { sent += 1; } } });
  assert.equal(result.candidatesFailed, true);
  assert.equal(result.failed, false);
  assert.equal(sent, 1);
  assert.match(readFileSync(join(root, VAULT_REL.dailyNotes, '2026', '2026-10-08.md'), 'utf8'), /dailyStatus: "확정"/);
});
