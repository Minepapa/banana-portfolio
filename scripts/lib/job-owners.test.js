import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { AGENT_IDS } from './agent-registry.mjs';
import { EXPECTED_INTERVALS_MS } from './job-schedule.mjs';
import { JOB_OWNERS } from './job-owners.mjs';
import { listDispatchedJobs, listPlistJobs } from './launchd-jobs.mjs';

// 등록된 잡을 손 목록이 아니라 실제 등록 위치(run.sh case문·launchd plist·기대 주기 표)에서 읽는다.
function registeredJobs() {
  const dispatched = listDispatchedJobs();
  const plists = listPlistJobs();
  return { dispatched, plists, all: [...new Set([...dispatched, ...plists, ...Object.keys(EXPECTED_INTERVALS_MS)])] };
}

test('잡 담당 모듈은 import가 없다(대시보드 서버가 그대로 읽음)', () => {
  const IMPORT_RE = /^\s*import[\s{]|^\s*export\s[^;]*\sfrom\s|\bimport\s*\(/m;
  for (const name of ['job-owners.mjs', 'job-schedule.mjs', 'wiki-question-status.mjs']) {
    assert.equal(IMPORT_RE.test(readFileSync(new URL(`./${name}`, import.meta.url), 'utf8')), false, name);
  }
});

test('JOB_OWNERS: 등록된 모든 잡(run.sh·plist·기대 주기 표)에 담당이 있다', () => {
  const { dispatched, plists, all } = registeredJobs();
  assert.ok(dispatched.length > 10 && plists.length > 10, '등록 목록 파싱이 깨졌을 가능성');
  const missing = all.filter((job) => !(job in JOB_OWNERS));
  assert.deepEqual(missing, [], `담당 선언이 없는 잡: ${missing.join(', ')} — scripts/lib/job-owners.mjs에 헌장 책임 기준으로 한 줄 추가할 것`);
});

test('JOB_OWNERS: 값은 판테온 6인 중 하나, 등록되지 않은 잡 이름은 남기지 않는다', () => {
  const { all } = registeredJobs();
  for (const [job, owner] of Object.entries(JOB_OWNERS)) {
    assert.ok(AGENT_IDS.includes(owner), `${job}: 6인 밖 담당 ${owner}`);
    assert.ok(all.includes(job), `${job}: 등록되지 않은(폐지된) 잡의 담당 선언`);
  }
});
