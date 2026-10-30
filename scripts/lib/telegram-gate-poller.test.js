import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyPollError, pollOnce, pollRetryDelayMs, shouldAlertPollError } from './telegram-gate-poller.mjs';
import { createGateInbox } from './telegram-gate-inbox.mjs';
import { TelegramApiError, getTelegramUpdates } from './telegram.mjs';

const FAKE_CONFIG = { botToken: 'FAKE:gate-test-token', chatId: '424242' };

// 가짜 fetch로 Bot API 응답을 흉내 낸다 — 실제 getUpdates는 부르지 않는다.
function apiError(status, body) {
  return async () => getTelegramUpdates({}, {
    config: FAKE_CONFIG,
    fetchImpl: async () => ({ ok: false, status, json: async () => body }),
  });
}

test('Bot API 오류 분류: 409 가로채기·429·5xx·연결 단절·그 밖', async () => {
  const conflict = await apiError(409, { ok: false, error_code: 409, description: 'Conflict: terminated by other getUpdates request' })().catch((e) => e);
  assert.ok(conflict instanceof TelegramApiError);
  assert.equal(classifyPollError(conflict), 'conflict');
  assert.doesNotMatch(conflict.message, /FAKE:gate-test-token/, '오류 메시지에 토큰이 없어야 함');
  const limited = await apiError(429, { ok: false, error_code: 429, description: 'Too Many Requests', parameters: { retry_after: 7 } })().catch((e) => e);
  assert.equal(classifyPollError(limited), 'rate-limited');
  assert.equal(pollRetryDelayMs(limited, 1), 7000);
  const server = await apiError(502, null)().catch((e) => e);
  assert.equal(classifyPollError(server), 'network');
  const offline = await getTelegramUpdates({}, { config: FAKE_CONFIG, fetchImpl: async () => { throw new TypeError('fetch failed'); } }).catch((e) => e);
  assert.equal(classifyPollError(offline), 'network');
  assert.doesNotMatch(offline.message, /FAKE:gate-test-token/);
  const unauthorized = await apiError(401, { ok: false, error_code: 401, description: 'Unauthorized' })().catch((e) => e);
  assert.equal(classifyPollError(unauthorized), 'fatal');
  const aborted = Object.assign(new Error('aborted'), { name: 'AbortError' });
  assert.equal(classifyPollError(aborted), 'aborted');
});

test('재시도 간격: 단절은 1초부터 두 배·최대 60초, 409는 5초부터·최대 60초, 치명은 5분', () => {
  const net = { network: true };
  assert.deepEqual([1, 2, 3, 7, 20].map((n) => pollRetryDelayMs(net, n)), [1000, 2000, 4000, 60000, 60000]);
  const conflict = { conflict: true };
  assert.deepEqual([1, 2, 5].map((n) => pollRetryDelayMs(conflict, n)), [5000, 10000, 60000]);
  assert.equal(pollRetryDelayMs({ status: 401 }, 1), 300000);
});

test('경보: 409·치명만, 같은 종류는 30분에 한 번', () => {
  const now = 1_000_000_000;
  assert.equal(shouldAlertPollError({ network: true }, { now }), false);
  assert.equal(shouldAlertPollError({ rateLimited: true }, { now }), false);
  assert.equal(shouldAlertPollError({ conflict: true }, { now }), true);
  assert.equal(shouldAlertPollError({ conflict: true }, { lastAlertAt: now - 60_000, lastKind: 'conflict', now }), false);
  assert.equal(shouldAlertPollError({ conflict: true }, { lastAlertAt: now - 31 * 60_000, lastKind: 'conflict', now }), true);
  assert.equal(shouldAlertPollError({ status: 401 }, { lastAlertAt: now - 60_000, lastKind: 'conflict', now }), true);
});

test('pollOnce: 저장한 뒤에만 offset을 넘기고, 다음 호출은 그 offset으로 한다', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-poll-'));
  try {
    const inbox = createGateInbox({ dir });
    const calls = [];
    const batches = [[{ update_id: 7, message: {} }, { update_id: 8, message: {} }], []];
    const getUpdates = async (params) => {
      calls.push({ params, pendingAtCall: inbox.pending().length });
      return batches.shift();
    };
    assert.deepEqual(await pollOnce({ inbox, getUpdates }), { received: 2, fresh: 2 });
    assert.equal(inbox.readOffset(), 9);
    await pollOnce({ inbox, getUpdates });
    assert.equal(calls[0].params.offset, undefined);
    assert.equal(calls[1].params.offset, 9);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('pollOnce: 저장이 실패하면 offset을 넘기지 않는다(서버가 업데이트를 지우지 않게)', async () => {
  const committed = [];
  const inbox = {
    readOffset: () => 3,
    appendUpdates: () => { throw new Error('디스크 가득'); },
    commitOffset: (n) => committed.push(n),
  };
  await assert.rejects(pollOnce({ inbox, getUpdates: async () => [{ update_id: 3 }] }), /디스크 가득/);
  assert.deepEqual(committed, []);
});

test('getTelegramUpdates: offset·timeout·allowed_updates를 보낸다', async () => {
  const bodies = [];
  await getTelegramUpdates({ offset: 9, timeoutSec: 50 }, {
    config: FAKE_CONFIG,
    fetchImpl: async (url, opts) => { bodies.push({ url, body: JSON.parse(opts.body) }); return { ok: true, json: async () => ({ ok: true, result: [] }) }; },
  });
  assert.equal(bodies[0].url, 'https://api.telegram.org/botFAKE:gate-test-token/getUpdates');
  assert.deepEqual(bodies[0].body, { timeout: 50, allowed_updates: ['message'], offset: 9 });
});
