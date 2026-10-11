import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lintVault } from './vault-registry.mjs';
import { evaluateDoneWhen, parseDoneWhen } from './work-doc-freshness.mjs';
import { buildJobHealthRecord } from './job-health.mjs';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'work-doc-freshness-'));
  const registry = `| type | 경로 | 제목 | 필수 | 쓰는 주체 |\n|---|---|---|---|---|\n`
    + `| \`implementation\` | \`40_Projects/{project}/Implementation/\` | 자유 | S | 클리오 |\n`
    + `| \`request\` | \`40_Projects/{project}/Requests/\` | 자유 | S | 클리오 |\n`
    + `| \`session-log\` | \`60_Logs/{agent}/\` | 자유 | S | 클리오 |\n`
    + Array.from({ length: 20 }, (_, i) => `| \`dummy${i}\` | \`Dummy${i}/\` | 자유 | S | 클리오 |`).join('\n')
    + '\n\n## 3. 검사\n';
  function put(rel, text) { const path = join(root, rel); mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, text); }
  put('90_Delphi/Schema/경로 등록부.md', registry);
  // Registry is itself a note but not covered by the tiny fixture table.
  function lint() { return lintVault(root).results.filter((r) => !r.rel.startsWith('90_Delphi/')); }
  return { root, put, lint, close: () => rmSync(root, { recursive: true, force: true }) };
}
const note = (type, fields = '', body = '') => `---\ntype: "${type}"\ndescription: "설명"\ncreated: "2026-10-11"\nmodified: "2026-10-11"\n${fields}---\n${body}`;

test('lintVault: 작업 문서 필수값·날짜·Implementation 예정·supersedes·doneWhen', () => {
  const f = fixture();
  try {
    const path = '40_Projects/alpha/Requests/work.md';
    f.put(path, note('request', 'status: "진행중"\nwaitingOn: "외부"\nnextCheck: "2026-01-01"\n'));
    assert.deepEqual(f.lint(), [], '지난 nextCheck는 lint 위반이 아님');
    for (const status of ['예정', '진행중', '차단됨', '보류']) {
      for (const waitingOn of ['오너 판단', '시장 이벤트', '데이터 축적', '착수 대기', '외부']) {
        f.put(path, note('request', `status: "${status}"\nwaitingOn: "${waitingOn}"\nnextCheck: "2026-11-01"\n`));
        assert.deepEqual(f.lint(), [], `${status}/${waitingOn} 허용`);
      }
    }
    f.put(path, note('request', 'status: "진행중"\nwaitingOn: "잘못됨"\nnextCheck: "2026-02-30"\n'));
    assert.match(f.lint()[0].problems.join(), /waitingOn.*nextCheck/);
    f.put(path, note('request', 'status: "진행중"\nwaitingOn: "외부"\nnextCheck: "2026-11-01"\ndoneWhen: ["job-ok:job since:2026-10-11", "commit:abcdef1", "file:40_Projects/alpha/Requests/work.md", "launchd:local.test"]\n'));
    assert.deepEqual(f.lint(), []);
    f.put(path, note('request', 'status: "진행중"\nwaitingOn: "외부"\nnextCheck: "2026-11-01"\ndoneWhen: ["job-ok:job since:2026-10-11T15:00+09:00", "job-ok:job since:2026-10-11T06:00Z"]\n'));
    assert.deepEqual(f.lint(), [], 'ISO 시각의 두 허용 오프셋');
    for (const since of ['2026-10-11T24:00Z', '2026-10-11T12:60+09:00', '2026-10-11T12:00+08:00']) {
      f.put(path, note('request', `status: "진행중"\nwaitingOn: "외부"\nnextCheck: "2026-11-01"\ndoneWhen: ["job-ok:job since:${since}"]\n`));
      assert.match(f.lint()[0].problems.join(), /doneWhen/, since);
    }
    f.put(path, note('request', 'status: "완료"\ndoneWhen: []\nsupersedes: []\n'));
    assert.deepEqual(f.lint(), [], '선택 배열의 빈 값은 유효');
    f.put(path, note('request', 'status: "진행중"\nwaitingOn: "외부"\nnextCheck: "2026-11-01"\ndoneWhen: ["nonsense"]\n'));
    assert.match(f.lint()[0].problems.join(), /doneWhen/);
    f.put(path, note('request', 'status: "완료"\n'));
    f.put('40_Projects/alpha/Implementation/new.md', note('implementation', 'status: "예정"\nwaitingOn: "착수 대기"\nnextCheck: "2026-11-01"\nsupersedes: ["[[40_Projects/alpha/Requests/work]]"]\n'));
    assert.match(f.lint()[0].problems.join(), /계획은 Requests에/);
    f.put('40_Projects/alpha/Implementation/new.md', note('implementation', 'status: "진행중"\nwaitingOn: "착수 대기"\nnextCheck: "2026-11-01"\nsupersedes: ["[[40_Projects/alpha/Requests/work]]"]\n'));
    assert.deepEqual(f.lint(), []);
    f.put(path, note('request', 'status: "진행중"\nwaitingOn: "외부"\nnextCheck: "2026-11-01"\n'));
    assert.match(f.lint().find((r) => r.rel.includes('new.md')).problems.join(), /supersedes 대상 미종결/);
    f.put('40_Projects/alpha/Implementation/new.md', note('implementation', 'status: "완료"\nsupersedes: ["[[40_Projects/alpha/Requests/missing]]"]\n'));
    assert.match(f.lint().find((r) => r.rel.includes('new.md')).problems.join(), /대상 없음/);
  } finally { f.close(); }
});

test('lintVault: 시행일 이후 로그의 남은 것 목록은 각 항목에 링크가 필요하다', () => {
  const f = fixture();
  try {
    f.put('60_Logs/Zeus/2026-10-10 old.md', note('session-log', 'created: "2026-10-10"\n', '## 남은 것\n- 링크 없음'));
    assert.deepEqual(f.lint(), []);
    f.put('60_Logs/Zeus/2026-10-11 new.md', note('session-log', '', '## 남은 것\n- [[40_Projects/alpha/Requests/work]] 확인\n- 링크 없음'));
    assert.match(f.lint()[0].problems.join(), /남은 것 목록/);
    f.put('60_Logs/Zeus/2026-10-11 new.md', note('session-log', '', '### 남은 것\n- [[40_Projects/alpha/Requests/work]] 확인'));
    assert.deepEqual(f.lint(), []);
    f.put('60_Logs/Zeus/2026-10-11 new.md', note('session-log', 'created: "2026-10-10"\n', '## 남은 것\n- 링크 없음'));
    assert.match(f.lint()[0].problems.join(), /남은 것 목록/, '파일명 날짜가 기준일 이후이면 created가 이전이어도 검사');
  } finally { f.close(); }
});

test('doneWhen: job-ok·commit·file·launchd 조건을 주입하여 모두 판정한다', () => {
  const f = fixture();
  try {
    f.put('95_Etna/Jobs/JobHealth/job.md', buildJobHealthRecord({ job: 'job', status: 'OK', now: new Date('2026-10-12T00:00:00Z') }).content);
    f.put('40_Projects/alpha/Requests/work.md', 'file');
    const conditions = parseDoneWhen(['job-ok:job since:2026-10-11', 'commit:abcdef1', 'file:40_Projects/alpha/Requests/work.md', 'launchd:local.test']);
    const options = { vaultRoot: f.root, repoPath: '/tmp/repo', git: (_command, args) => { assert.deepEqual(args, ['merge-base', '--is-ancestor', 'abcdef1', 'main']); }, launchctlList: () => 'PID\tStatus\tLabel\n-\t0\tlocal.test' };
    assert.equal(evaluateDoneWhen(conditions, options).satisfied, true);
    assert.match(evaluateDoneWhen(conditions, options).evidence[0].detail, /마지막 실행 2026-10-12T00:00:00.000Z/);
    assert.equal(evaluateDoneWhen(conditions, { ...options, launchctlList: () => '' }).satisfied, false);
    assert.equal(evaluateDoneWhen(conditions, { ...options, git: () => { throw new Error('nonancestor'); } }).satisfied, false);
    assert.equal(evaluateDoneWhen(parseDoneWhen(['file:40_Projects/alpha/Requests/missing.md']), options).satisfied, false);
    assert.equal(evaluateDoneWhen(parseDoneWhen(['job-ok:job since:2026-10-12']), options).satisfied, false, '날짜만 있으면 다음 날 00:00 KST 기준');
    f.put('95_Etna/Jobs/JobHealth/job.md', buildJobHealthRecord({ job: 'job', status: 'OK', now: new Date('2026-10-10T16:00:00Z') }).content);
    assert.equal(evaluateDoneWhen(parseDoneWhen(['job-ok:job since:2026-10-11']), options).satisfied, false, '한국시간 since 당일 실행은 제외');
    assert.equal(evaluateDoneWhen(parseDoneWhen(['job-ok:job since:2026-10-11T00:00+09:00']), options).satisfied, true, 'ISO는 해당 시각으로 비교');
    assert.equal(evaluateDoneWhen(parseDoneWhen(['job-ok:job since:2026-10-10T16:01Z']), options).satisfied, false, 'ISO는 분 단위 경계를 지킨다');
    assert.equal(evaluateDoneWhen(parseDoneWhen(['job-ok:job since:2026-10-12']), options).satisfied, false, '한국시간 기준 전날 성공은 제외');
    f.put('95_Etna/Jobs/JobHealth/job.md', buildJobHealthRecord({ job: 'job', status: 'OK', now: new Date('2026-10-11T15:00:00Z') }).content);
    const boundary = evaluateDoneWhen(parseDoneWhen(['job-ok:job since:2026-10-11']), options);
    assert.equal(boundary.satisfied, true, '다음 날 00:00 KST 정각부터 인정');
    assert.match(boundary.evidence[0].detail, /비교 기준 2026-10-11 다음 날 00:00 KST 이후/);
    f.put('95_Etna/Jobs/JobHealth/job.md', buildJobHealthRecord({ job: 'job', status: 'OK', now: new Date('2026-10-12T00:00:00Z') }).content);
    assert.equal(evaluateDoneWhen(parseDoneWhen(['job-ok:job since:2026-10-13']), options).satisfied, false, 'since 이전 성공 제외');
    f.put('95_Etna/Jobs/JobHealth/job.md', buildJobHealthRecord({ job: 'job', status: 'FAIL', now: new Date('2026-10-13T00:00:00Z') }).content);
    assert.equal(evaluateDoneWhen(parseDoneWhen(['job-ok:job since:2026-10-11']), options).satisfied, false, '마지막 기록이 실패이면 제외');
    assert.equal(parseDoneWhen(['job-ok:job since:2026-02-30']), null);
  } finally { f.close(); }
});
