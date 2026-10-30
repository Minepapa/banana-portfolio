import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatOlympusStats, OLYMPUS_SERVER_MODULE, recordOlympusHealth } from './olympus-server.mjs';
import { VAULT_REL } from '../lib/vault-paths.mjs';
import { JOB_LABELS, JOB_REMEDIATION } from '../lib/job-labels.mjs';

test('올림푸스 서버 모듈은 형제 저장소 Repos/olympus를 가리킨다', () => {
  assert.match(OLYMPUS_SERVER_MODULE, /[\\/]Repos[\\/]olympus[\\/]server[\\/]olympus-server\.mjs$/);
});

test('상태 기록: 잡 상태 폴더에 olympus-server OK', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'olympus-health-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  await recordOlympusHealth({ root, now: new Date('2040-02-03T00:00:00Z') });
  const text = readFileSync(join(root, VAULT_REL.jobHealth, 'olympus-server.md'), 'utf8');
  assert.match(text, /olympus-server/);
  assert.match(text, /OK/);
});

test('잡 이름표와 조치 안내가 제자리에 있다', () => {
  assert.equal(JOB_LABELS['olympus-server'], '올림푸스 대시보드 서버(상시 프로세스)');
  assert.match(JOB_REMEDIATION['olympus-server'], /tailscale serve 8443/);
});

test('formatOlympusStats: 거절 횟수를 한 줄로, 읽을 수 없는 칸은 뺀다', () => {
  assert.equal(formatOlympusStats({ hostRejected: 2, keyRejected: 3, cookieRejected: 0, lastKeyRejectedAt: '2040-02-03T00:00:00.000Z' }),
    '서버 시작 뒤 누적: 401 틀린 키 3(마지막 2040-02-03T00:00:00.000Z) · 401 쿠키 0 · Host 거절 2');
  assert.equal(formatOlympusStats({ keyRejected: 0, lastKeyRejectedAt: null }), '서버 시작 뒤 누적: 401 틀린 키 0');
  assert.equal(formatOlympusStats({ keyRejected: 2, lastKeyRejectedAt: '1' }), '서버 시작 뒤 누적: 401 틀린 키 2', 'ISO가 아닌 시각은 뺀다');
  assert.equal(formatOlympusStats({ keyRejected: -1, cookieRejected: 'x', hostRejected: 1.5 }), '');
  for (const bad of [null, undefined, 3, 'x']) assert.equal(formatOlympusStats(bad), '');
});

test('상태 기록: 거절 횟수를 detail에 적고, 함수가 없거나 던지거나 이상한 값을 줘도 OK 기록은 그대로', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'olympus-health-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, VAULT_REL.jobHealth, 'olympus-server.md');
  const now = new Date('2040-02-03T00:00:00Z');
  await recordOlympusHealth({ root, now, readStats: () => ({ hostRejected: 0, keyRejected: 1, cookieRejected: 4, lastKeyRejectedAt: null }) });
  assert.match(readFileSync(file, 'utf8'), /401 틀린 키 1 · 401 쿠키 4 · Host 거절 0/);
  for (const readStats of [null, () => { throw new Error('boom'); }, () => undefined, () => 'garbage']) {
    await recordOlympusHealth({ root, now, readStats });
    const text = readFileSync(file, 'utf8');
    assert.match(text, /status: "?OK"?/);
    assert.doesNotMatch(text, /boom|401/);
  }
});
