import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { appendWarningEvent, readWarningEvents, rebuildWarningIncidents } from './warning-event-journal.mjs';

function tempRoot(t) {
  const rootDir = mkdtempSync(join(tmpdir(), 'warning-journal-test-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  return rootDir;
}

function detected(overrides = {}) {
  return {
    eventId: randomUUID(), occurredAt: new Date().toISOString(),
    incidentId: 'incident-1', jobName: 'intraday-market-move-monitor',
    warningCode: 'MACRO_YFINANCE_QUERY_FAILED', subjectKey: 'macro:yfinance',
    kind: 'operational', severity: 'medium', eventType: 'detected',
    ...overrides,
  };
}

test('경고 발생을 기록하면 같은 월 원장에서 다시 읽고, 파일 권한을 제한한다', async (t) => {
  const rootDir = tempRoot(t);
  const saved = await appendWarningEvent(detected({ occurredAt: '2026-09-29T16:10:00.000Z' }), { rootDir });
  const result = readWarningEvents({ rootDir });

  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].eventId, saved.eventId);
  assert.equal(result.events[0].occurredAt, '2026-09-29T16:10:00.000Z');
  assert.equal(result.events[0].incidentKey, 'intraday-market-move-monitor|MACRO_YFINANCE_QUERY_FAILED|macro:yfinance');
  assert.deepEqual(result.invalidRows, []);
  assert.equal(statSync(rootDir).mode & 0o777, 0o700);
  assert.equal(statSync(join(rootDir, '2026-09.jsonl')).mode & 0o777, 0o600);
});

test('중간의 손상 행과 중단된 마지막 행은 격리하고 다음 이벤트는 읽는다', async (t) => {
  const rootDir = tempRoot(t);
  const file = join(rootDir, '2026-09.jsonl');
  await appendWarningEvent(detected({ occurredAt: '2026-09-30T00:00:00.000Z' }), { rootDir });
  appendFileSync(file, '{"incomplete":');

  await appendWarningEvent(detected({ incidentId: 'incident-2', occurredAt: '2026-09-30T01:00:00.000Z' }), { rootDir });
  const result = readWarningEvents({ rootDir });
  assert.deepEqual(result.events.map((event) => event.incidentId), ['incident-1', 'incident-2']);
  assert.deepEqual(result.invalidRows, [{ file: '2026-09.jsonl', line: 2, reason: '손상되거나 지원하지 않는 행' }]);
  assert.match(readFileSync(file, 'utf8'), /\{"incomplete":\n/);
});

test('월을 넘어간 이벤트로 열린 사건의 횟수와 전달·해결 상태를 재생성한다', async (t) => {
  const rootDir = tempRoot(t);
  const first = await appendWarningEvent(detected({ occurredAt: '2026-09-30T14:59:00.000Z' }), { rootDir });
  await appendWarningEvent(detected({ eventType: 'delivery', deliveryStatus: 'suppressed', suppressedBy: 'recent-send', occurredAt: '2026-09-30T15:01:00.000Z' }), { rootDir });
  await appendWarningEvent(detected({ occurredAt: '2026-09-30T15:02:00.000Z' }), { rootDir });
  await appendWarningEvent(detected({ eventType: 'status', incidentStatus: 'resolved', occurredAt: '2026-09-30T15:03:00.000Z' }), { rootDir });
  appendFileSync(join(rootDir, '2026-09.jsonl'), `${JSON.stringify(first)}\n`);

  const result = rebuildWarningIncidents({ rootDir });
  assert.equal(result.incidents.length, 1);
  assert.deepEqual(result.incidents[0], {
    incidentId: 'incident-1', incidentKey: 'intraday-market-move-monitor|MACRO_YFINANCE_QUERY_FAILED|macro:yfinance',
    jobName: 'intraday-market-move-monitor', warningCode: 'MACRO_YFINANCE_QUERY_FAILED',
    subjectKey: 'macro:yfinance', kind: 'operational', severity: 'medium',
    firstSeen: '2026-09-30T14:59:00.000Z', lastSeen: '2026-09-30T15:03:00.000Z',
    detectedCount: 2, suppressedCount: 1, lastDeliveryStatus: 'suppressed', status: 'resolved',
  });
  assert.deepEqual(result.invalidRows, []);
  assert.equal(existsSync(join(rootDir, '2026-09.jsonl')), true);
  assert.equal(existsSync(join(rootDir, '2026-10.jsonl')), true);
  assert.deepEqual(readWarningEvents({ rootDir }).events.length, 5);
});

test('동시 발생 30건을 빠짐없이 기록하고 손상 행을 만들지 않는다', async (t) => {
  const rootDir = tempRoot(t);
  await Promise.all(Array.from({ length: 30 }, (_, index) => appendWarningEvent(
    detected({ incidentId: `incident-${index}` }),
    { rootDir, lockOptions: { retries: 100, retryDelayMs: 5 } },
  )));
  const result = readWarningEvents({ rootDir });
  assert.equal(result.events.length, 30);
  assert.equal(new Set(result.events.map((event) => event.eventId)).size, 30);
  assert.deepEqual(result.invalidRows, []);
});

test('서로 다른 프로세스의 append도 같은 원장을 손상시키지 않는다', async (t) => {
  const rootDir = tempRoot(t);
  const moduleUrl = new URL('./warning-event-journal.mjs', import.meta.url).href;
  const script = `
    import { randomUUID } from 'node:crypto';
    import { appendWarningEvent } from ${JSON.stringify(moduleUrl)};
    for (let i = 0; i < 12; i++) {
      await appendWarningEvent({
        eventId: randomUUID(), occurredAt: '2026-09-30T10:00:00.000Z',
        incidentId: randomUUID(), jobName: 'concurrent-test', warningCode: 'CONCURRENT_TEST',
        subjectKey: 'macro:yfinance', kind: 'operational', severity: 'medium', eventType: 'detected',
      }, { rootDir: process.argv[1] });
    }
  `;
  await Promise.all(Array.from({ length: 2 }, () => promisify(execFile)(process.execPath, [
    '--input-type=module', '-e', script, rootDir,
  ])));
  const result = readWarningEvents({ rootDir });
  assert.equal(result.events.length, 24);
  assert.deepEqual(result.invalidRows, []);
});

test('원본 오류·임의 필드와 생계좌번호를 저장 입력으로 받지 않는다', async (t) => {
  const rootDir = tempRoot(t);
  await assert.rejects(
    appendWarningEvent(detected({ rawError: 'Bearer secret' }), { rootDir }),
    /허용되지 않은 경고 이벤트 필드/,
  );
  await assert.rejects(
    appendWarningEvent(detected({ subjectKey: 'account:12345678901' }), { rootDir }),
    /식별자 형식 오류/,
  );
  await assert.rejects(
    appendWarningEvent(detected({ subjectKey: 'account:205-0159-6019' }), { rootDir }),
    /식별자 형식 오류/,
  );
  assert.deepEqual(readWarningEvents({ rootDir }), { events: [], invalidRows: [] });
});

test('사건 UUID는 허용하되 대상 식별자에 긴 숫자열은 기록하지 않는다', async (t) => {
  const rootDir = tempRoot(t);
  const incidentId = '0f6a8c2b-3344-4555-8666-9d7e8f9a0b1c';
  await appendWarningEvent(detected({ incidentId, subjectKey: 'stock:005930' }), { rootDir });
  assert.equal(readWarningEvents({ rootDir }).events[0].incidentId, incidentId);
});

test('전달 이벤트는 시도 ID와 검증된 Telegram 메시지 ID만 기록한다', async (t) => {
  const rootDir = tempRoot(t);
  const deliveryAttemptId = randomUUID();
  const base = detected({
    eventType: 'delivery', deliveryStatus: 'sent', deliveryAttemptId,
    telegramMessageId: 12345, legacyFingerprint: 'a'.repeat(40),
  });
  await appendWarningEvent(base, { rootDir });
  assert.equal(readWarningEvents({ rootDir }).events[0].telegramMessageId, 12345);
  await assert.rejects(
    appendWarningEvent(detected({ eventType: 'delivery', deliveryStatus: 'sent', deliveryAttemptId }), { rootDir }),
    /Telegram 메시지 ID/,
  );
  await assert.rejects(
    appendWarningEvent(detected({ eventType: 'delivery', deliveryStatus: 'reserved' }), { rootDir }),
    /전달 시도 ID/,
  );
});

test('동일 이벤트를 재시도해도 한 번만 기록하고 ID 충돌의 다른 내용은 거부한다', async (t) => {
  const rootDir = tempRoot(t);
  const event = detected({ occurredAt: '2026-09-30T10:00:00.000Z' });
  await appendWarningEvent(event, { rootDir });
  await appendWarningEvent(event, { rootDir });
  await assert.rejects(
    appendWarningEvent({ ...event, severity: 'high' }, { rootDir }),
    /같은 이벤트 ID의 내용 불일치/,
  );
  assert.equal(readWarningEvents({ rootDir }).events.length, 1);
  assert.equal(rebuildWarningIncidents({ rootDir }).incidents[0].detectedCount, 1);
});

test('같은 ID가 다른 월에 다시 나타나도 재생성에서 중복 집계하지 않고 충돌을 표시한다', async (t) => {
  const rootDir = tempRoot(t);
  const event = detected({ occurredAt: '2026-09-30T14:59:00.000Z' });
  await appendWarningEvent(event, { rootDir });
  await appendWarningEvent({ ...event, occurredAt: '2026-09-30T15:01:00.000Z' }, { rootDir });
  const result = rebuildWarningIncidents({ rootDir });
  assert.equal(result.incidents[0].detectedCount, 1);
  assert.deepEqual(result.invalidRows, [{ file: null, line: null, reason: '이벤트 ID 내용 충돌' }]);
});

test('늦게 기록된 과거 상태는 최신 사건·전달 상태를 되돌리지 않는다', async (t) => {
  const rootDir = tempRoot(t);
  await appendWarningEvent(detected({ severity: 'critical', occurredAt: '2026-09-30T10:00:00.000Z' }), { rootDir });
  await appendWarningEvent(detected({ eventType: 'status', incidentStatus: 'reopened', severity: 'medium', occurredAt: '2026-09-30T10:04:00.000Z' }), { rootDir });
  await appendWarningEvent(detected({ eventType: 'delivery', deliveryStatus: 'unknown', deliveryAttemptId: randomUUID(), occurredAt: '2026-09-30T10:04:00.000Z' }), { rootDir });
  await appendWarningEvent(detected({ eventType: 'status', incidentStatus: 'resolved', occurredAt: '2026-09-30T10:02:00.000Z' }), { rootDir });
  await appendWarningEvent(detected({ eventType: 'delivery', deliveryStatus: 'sent', deliveryAttemptId: randomUUID(), telegramMessageId: 456, occurredAt: '2026-09-30T10:02:00.000Z' }), { rootDir });
  const incident = rebuildWarningIncidents({ rootDir }).incidents[0];
  assert.equal(incident.status, 'reopened');
  assert.equal(incident.lastDeliveryStatus, 'unknown');
  assert.equal(incident.severity, 'critical');
  assert.equal(incident.lastSeen, '2026-09-30T10:04:00.000Z');
});

test('원장 경로에 쓸 수 없으면 성공으로 가장하지 않고 호출자에게 실패를 돌려준다', async (t) => {
  const parent = tempRoot(t);
  const rootDir = join(parent, 'not-a-directory');
  writeFileSync(rootDir, '기존 파일');
  await assert.rejects(appendWarningEvent(detected(), { rootDir }), /EEXIST|ENOTDIR/);
  assert.equal(readFileSync(rootDir, 'utf8'), '기존 파일');
});

test('야간 Vault Git 스냅샷과 같은 add/commit 기록에서 원장을 복구할 수 있다', async (t) => {
  const vaultRoot = tempRoot(t);
  const rootDir = join(vaultRoot, 'Log', 'WarningEvents');
  await appendWarningEvent(detected({ occurredAt: '2026-09-30T00:00:00.000Z' }), { rootDir });
  execFileSync('git', ['init', '-q'], { cwd: vaultRoot });
  execFileSync('git', ['add', '-A'], { cwd: vaultRoot });
  execFileSync('git', ['-c', 'user.name=journal-test', '-c', 'user.email=journal@test.invalid', 'commit', '-q', '-m', 'snapshot'], { cwd: vaultRoot });

  const file = join(rootDir, '2026-09.jsonl');
  rmSync(file);
  const archived = execFileSync('git', ['show', 'HEAD:Log/WarningEvents/2026-09.jsonl'], { cwd: vaultRoot });
  writeFileSync(file, archived, { mode: 0o600 });
  const result = rebuildWarningIncidents({ rootDir });
  assert.equal(result.incidents[0].detectedCount, 1);
  assert.deepEqual(result.invalidRows, []);
});
