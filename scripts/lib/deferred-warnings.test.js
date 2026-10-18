import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deferWarning } from './deferred-warnings.mjs';
import { redactWarningDetail, sanitizeWarningDetail } from './warning-event-journal.mjs';

test('보류 경고의 여러 사실을 각각 가리고 내용은 보존한다', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'deferred-warning-facts-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const queueFile = join(root, 'queue.json');
  const facts = [
    '첫 번째 사실: 오류 원장 확인',
    '두 번째 사실: token=secret-value 재시도 필요',
    '세 번째 사실: 조치 담당자 확인',
  ];

  const entry = await deferWarning({ queueFile, detail: '야간 요약 실패', facts });
  const queued = JSON.parse(readFileSync(queueFile, 'utf8')).pending[0];
  const expected = [facts[0], '두 번째 사실: [REDACTED] 재시도 필요', facts[2]];
  assert.deepEqual(entry.facts, expected);
  assert.deepEqual(queued.facts, expected);
  assert.deepEqual(facts.map(sanitizeWarningDetail), expected);
});

test('가림 함수는 200자 뒤의 경고 내용도 보존한다', () => {
  const detail = `${'정상 '.repeat(75)}오류 token=secret-value`;
  assert.match(redactWarningDetail(detail), /오류 \[REDACTED\]$/);
  assert.equal(sanitizeWarningDetail(detail).length, 200);
  assert.doesNotMatch(sanitizeWarningDetail(detail), /오류/);
});
