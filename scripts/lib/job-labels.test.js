import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeJob, JOB_LABELS } from './job-labels.mjs';

test('describeJob: 등록된 잡은 "이름(한글설명)" 형태로 반환', () => {
  assert.equal(describeJob('backup-vault'), 'backup-vault(매일 밤 Vault 전체 스냅샷 git 백업)');
});

test('[막아야 함] describeJob: 등록 안 된 잡 이름도 조용히 사라지지 않고 이름 그대로 반환', () => {
  assert.equal(describeJob('아직-등록-안-된-새-잡'), '아직-등록-안-된-새-잡');
});

test('JOB_LABELS: 현재 활성 launchd 잡 12개(telegram-session 포함) 전부 등록돼 있음', () => {
  // 2026-08-23 — update-monthly-balance-snapshot·weekly-report 추가(오너 신고로
  // 발견된 오알람 수정과 동시에, 이 목록 자체가 새 잡 추가 시 안 갱신되는 같은
  // 실수를 겪지 않도록 여기도 갱신).
  const active = [
    'backup-vault', 'health-watcher', 'execute-quant', 'daily-asset-allocation-check',
    'parse-notifications-to-vault', 'update-holdings-from-executions', 'telegram-session',
    'reconcile-irp', 'update-cash-from-ledger', 'new-cash-allocation',
    'update-monthly-balance-snapshot', 'weekly-report',
  ];
  for (const job of active) assert.ok(JOB_LABELS[job], `${job} 라벨 누락`);
});
