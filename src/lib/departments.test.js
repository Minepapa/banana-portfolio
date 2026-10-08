import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEPARTMENTS } from './colors.js';
import { JOB_DEPARTMENT } from './constants.js';

test('앱 부서 배지는 6인 조직만 쓰고 잡 담당 키가 모두 유효하다', () => {
  assert.deepEqual(Object.keys(DEPARTMENTS).sort(), ['athena', 'clio', 'hermes', 'plutus', 'themis', 'zeus']);
  for (const [job, department] of Object.entries(JOB_DEPARTMENT)) {
    assert.ok(DEPARTMENTS[department], `${job}: ${department}`);
  }
  assert.equal(JOB_DEPARTMENT['weekly-report'], 'plutus');
});
