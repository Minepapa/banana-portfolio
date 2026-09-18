import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describeJob, JOB_LABELS, JOB_REMEDIATION } from './job-labels.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// run.sh의 case문에서 실제로 디스패치되는 잡 이름만 뽑는다 — health-watcher.test.js
// listDispatchedJobs와 동일 패턴(2026-09-19, DevRequest 잡실패알림-잡한글설명추가).
function listDispatchedJobs() {
  const runSh = readFileSync(join(__dirname, '..', 'launchd', 'run.sh'), 'utf8');
  return [...runSh.matchAll(/^\s*([a-z][a-z0-9-]*)\)\s+CMD=/gm)].map((m) => m[1]);
}

test('describeJob: 등록된 잡은 "이름(한글설명)" 형태로 반환', () => {
  assert.equal(describeJob('backup-vault'), 'backup-vault(매일 밤 Vault 전체 스냅샷 git 백업)');
});

test('[막아야 함] describeJob: 등록 안 된 잡 이름도 조용히 사라지지 않고 이름 그대로 반환', () => {
  assert.equal(describeJob('아직-등록-안-된-새-잡'), '아직-등록-안-된-새-잡');
});

// [구조적 가드] 2026-09-19 — 오너 지적("잡이 너무 많아서 다 기억하지 못한다") 대응.
// 잡 실패 알림에 이름+한글설명을 병기하는 record-heartbeat-vault.mjs·health-
// watcher.mjs는 이미 describeJob을 쓰고 있었지만, 그 기반인 JOB_LABELS는 2026-08-23
// 시점 스냅샷을 손으로 나열한 목록으로만 검증되고 있었다 — 그 뒤 신설된 잡(daily-
// breakout-signal-scan 등 여러 건)은 이 테스트가 통과한다는 사실 자체가 등록 여부를
// 보장해주지 못했다(실제로 한동안 라벨 없이 돌았던 전례, job-labels.mjs 상단 주석
// 참고). health-watcher.test.js의 EXPECTED_INTERVALS_MS 구조적 가드와 정확히 같은
// 원칙("기억해서 채워넣기는 구조적으로 안 지켜진다")을 여기도 적용 — run.sh가 실제로
// 디스패치하는 잡 목록을 동적으로 읽어 전부 JOB_LABELS에 있는지 강제한다.
test('JOB_LABELS: run.sh가 디스패치하는 잡은 전부 등록돼 있어야 함(신규 잡 라벨누락 재발 방지)', () => {
  const dispatched = listDispatchedJobs();
  assert.ok(dispatched.length > 10, 'run.sh case문 파싱이 깨졌을 가능성 — 잡 이름이 거의 안 뽑힘');
  const missing = dispatched.filter((job) => !JOB_LABELS[job]);
  assert.deepEqual(missing, [], `JOB_LABELS에 없는 잡: ${missing.join(', ')} — job-labels.mjs JOB_LABELS에 한 줄 추가할 것`);
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
