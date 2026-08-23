import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeJob, JOB_LABELS, JOB_REMEDIATION } from './job-labels.mjs';

test('describeJob: 등록된 잡은 "이름(한글설명)" 형태로 반환', () => {
  assert.equal(describeJob('backup-vault'), 'backup-vault(매일 밤 Vault 전체 스냅샷 git 백업)');
});

test('[막아야 함] describeJob: 등록 안 된 잡 이름도 조용히 사라지지 않고 이름 그대로 반환', () => {
  assert.equal(describeJob('아직-등록-안-된-새-잡'), '아직-등록-안-된-새-잡');
});

test('JOB_LABELS: 현재 활성 launchd 잡 15개(telegram-session 포함) 전부 등록돼 있음', () => {
  // 2026-08-23 — 오너 지시로 launchd 잡 16개 전수 재점검, sync-firestore-mirror·
  // update-allocation-from-holdings·update-holdings-prices 라벨 누락 추가 발견·등록
  // (telegram-session-restart는 하트비트 자체를 안 남겨 JobHealth 추적 대상이 아님 —
  // 의도적으로 이 목록 밖).
  const active = [
    'backup-vault', 'health-watcher', 'execute-quant', 'daily-asset-allocation-check',
    'parse-notifications-to-vault', 'update-holdings-from-executions', 'telegram-session',
    'reconcile-irp', 'update-cash-from-ledger', 'new-cash-allocation',
    'update-monthly-balance-snapshot', 'weekly-report',
    'sync-firestore-mirror', 'update-allocation-from-holdings', 'update-holdings-prices',
  ];
  for (const job of active) assert.ok(JOB_LABELS[job], `${job} 라벨 누락`);
});

// ── JOB_REMEDIATION(2026-08-23, 오너 지시 — "조치사항이 필요하면 등록") ──────
test('JOB_REMEDIATION: 알려진 크리덴셜·경로 의존이 있는 잡만 등록돼 있다(근거 없는 일반론 안 채움)', () => {
  const withRemediation = ['execute-quant', 'reconcile-irp', 'sync-firestore-mirror', 'parse-notifications-to-vault', 'backup-vault'];
  for (const job of withRemediation) assert.ok(JOB_REMEDIATION[job], `${job} 조치사항 누락`);
  // 대조군 — 크리덴셜 의존이 없는 순수 Vault 읽기 잡은 등록 안 돼 있어야 정상
  // (등록하면 "근거 없는 일반론"이 된다는 헤더 주석 원칙 위반).
  assert.equal(JOB_REMEDIATION['weekly-report'], undefined);
  assert.equal(JOB_REMEDIATION['update-monthly-balance-snapshot'], undefined);
});
