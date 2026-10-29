import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OLYMPUS_SERVER_MODULE, recordOlympusHealth } from './olympus-server.mjs';
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
