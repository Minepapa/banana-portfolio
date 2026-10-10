import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFailureAlertBody } from './record-heartbeat-vault.mjs';

test('하트비트 텔레그램 본문은 detail을 가린 뒤 HTML 이스케이프한다', () => {
  const body = buildFailureAlertBody({ job: 'health-watcher', failStreak: 2,
    detail: '<b>205-0159-6019</b> eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sig' });
  assert.match(body, /연속 2회/);
  assert.match(body, /\[REDACTED\]/);
  assert.doesNotMatch(body, /205-0159-6019|eyJhbGciOiJIUzI1NiJ9/);
  assert.match(body, /&lt;b&gt;/);
});
