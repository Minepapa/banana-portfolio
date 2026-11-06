import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocationStore } from '../jobs/owntracks-receiver.mjs';
import { VAULT_REL } from '../lib/vault-paths.mjs';
import { forwardArgos, parseSpendingSince } from './argos-forward.mjs';
import { ENRICHMENT_VERSION } from '../lib/spending-enrich.mjs';

// 가상 좌표·문구(공개 저장소). 2040-02-03 KST.
const posted = Date.parse('2040-02-03T12:00:00+09:00');
const tst = posted / 1000;
const events = [
  { type: 'location.point_recorded', id: 'l1', occurred_at: posted, payload: { lat: 10.5, lon: 20.5, acc: 10, tst } },
  { type: 'location.point_recorded', id: 'l2', occurred_at: posted, payload: { lat: 10.6, lon: 20.6, acc: 10, tst: tst + 60 } },
  { type: 'notification.received', id: 'n1', occurred_at: posted, payload: { category: '소비', source: 'app',
    appLabel: '가상앱', sender: '', body: '가상 출금 1,000원', postedAt: posted } },
];

test('미리보기는 쓰지 않고, 적용은 두 번 돌아도 한 번만 쓴다', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'argos-forward-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const spendingDir = join(root, VAULT_REL.spending);
  mkdirSync(join(root, VAULT_REL.argosEvents, '2040'), { recursive: true });
  writeFileSync(join(root, VAULT_REL.argosEvents, '2040', '2040-02-03.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  // OwnTracks가 같은 측정값(tst)을 이미 저장했다.
  mkdirSync(join(root, VAULT_REL.location, '2040'), { recursive: true });
  writeFileSync(join(root, VAULT_REL.location, '2040', '2040-02-03.jsonl'), `${JSON.stringify({ tst, lat: 10.5, lon: 20.5 })}\n`);
  const store = createLocationStore({ root });
  const options = { date: '2040-02-03', root, spendingDir, store, spendingSinceMs: posted };

  const preview = await forwardArgos(options);
  assert.deepEqual(preview.location, { events: 2, fresh: 1, existing: 1, written: 0 });
  assert.deepEqual(preview.spending, { events: 1, beforeCutoff: 0, fresh: 1, existing: 0, written: 0 });

  const applied = await forwardArgos({ ...options, apply: true });
  assert.equal(applied.location.written, 1);
  assert.equal(applied.spending.written, 1);
  const again = await forwardArgos({ ...options, apply: true });
  assert.equal(again.location.written + again.spending.written, 0);

  const locationLines = readFileSync(join(root, VAULT_REL.location, '2040', '2040-02-03.jsonl'), 'utf8').trim().split('\n');
  assert.equal(locationLines.length, 2);
  const spendingLines = readFileSync(join(spendingDir, '2040', '2040-02-03.jsonl'), 'utf8').trim().split('\n');
  assert.equal(spendingLines.length, 1);
  assert.equal(JSON.parse(spendingLines[0]).ts, '2040-02-03 12:00:00');
  const summary = JSON.parse(readFileSync(join(spendingDir, '2040', '2040-02-03.summary.json'), 'utf8'));
  assert.equal(summary.hasSource, true); // 파생 요약도 함께 다시 만든다
  assert.equal(summary.enrichmentVersion, ENRICHMENT_VERSION, '수집 잡과 같은 길로 써서 화면 칸(보강)이 지워지지 않는다');
});

test('kinds로 한쪽만 넘긴다', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'argos-forward-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, VAULT_REL.argosEvents, '2040'), { recursive: true });
  writeFileSync(join(root, VAULT_REL.argosEvents, '2040', '2040-02-03.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  const result = await forwardArgos({ date: '2040-02-03', root, spendingDir: join(root, VAULT_REL.spending),
    store: createLocationStore({ root }), kinds: ['location'], apply: true });
  assert.equal(result.location.written, 2);
  assert.equal(result.spending.events, 0);
});

test('소비 컷오프: 없으면 하나도 안 넘기고, 있으면 그 시각 이후 결제만 넘긴다', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'argos-forward-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, VAULT_REL.argosEvents, '2040'), { recursive: true });
  const later = { type: 'notification.received', id: 'n2', occurred_at: posted + 3_600_000, payload: { category: '소비',
    source: 'app', appLabel: '가상앱', sender: '', body: '가상 출금 2,000원', postedAt: posted + 3_600_000 } };
  writeFileSync(join(root, VAULT_REL.argosEvents, '2040', '2040-02-03.jsonl'), [...events, later].map((e) => JSON.stringify(e)).join('\n') + '\n');
  const spendingDir = join(root, VAULT_REL.spending);
  const base = { date: '2040-02-03', root, spendingDir, store: createLocationStore({ root }), kinds: ['spending'], apply: true };

  const none = await forwardArgos(base);
  assert.deepEqual(none.spending, { events: 2, beforeCutoff: 2, fresh: 0, existing: 0, written: 0 });
  assert.throws(() => readFileSync(join(spendingDir, '2040', '2040-02-03.jsonl')), { code: 'ENOENT' });

  const cut = await forwardArgos({ ...base, spendingSinceMs: posted + 1 });
  assert.deepEqual(cut.spending, { events: 2, beforeCutoff: 1, fresh: 1, existing: 0, written: 1 });
  const lines = readFileSync(join(spendingDir, '2040', '2040-02-03.jsonl'), 'utf8').trim().split('\n');
  assert.deepEqual(lines.map((line) => JSON.parse(line).id), ['argos:n2']);
});

test('컷오프 값은 시간대가 붙은 ISO만 받는다', () => {
  assert.equal(parseSpendingSince(undefined), null);
  assert.equal(parseSpendingSince('2040-02-03T12:00:00+09:00'), posted);
  assert.equal(parseSpendingSince('2040-02-03T03:00:00Z'), posted);
  for (const bad of ['2040-02-03T12:00:00', '2040-02-03', 'yesterday', '', 123]) assert.throws(() => parseSpendingSince(bad));
});
