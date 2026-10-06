import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createDependencies, inspectLaunchd, planInstall, rewritePlist, run } from './relocate-launchd.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const oldRoot = '/a/repo';
const newRoot = '/b/repo';

function plist(label, root = oldRoot) {
  return `<?xml version="1.0"?>\n<plist><dict>\n` +
    `<key>Label</key><string>${label}</string>\n` +
    `<!-- ${root}/comment -->\n` +
    `<key>ProgramArguments</key><array><string>/bin/bash</string><string>${root}/scripts/launchd/run.sh</string></array>\n` +
    `<key>WorkingDirectory</key><string>${root}</string>\n` +
    `<key>StandardOutPath</key><string>/Users/me/Library/Logs/${root.slice(1)}/log</string>\n` +
    `<key>OtherPath</key><string>${root}2/data</string>\n` +
    `</dict></plist>\n`;
}

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'relocate-launchd-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const plistDirectory = path.join(directory, 'repo', 'scripts', 'launchd');
  const agentsDirectory = path.join(directory, 'LaunchAgents');
  fs.mkdirSync(plistDirectory, { recursive: true });
  fs.mkdirSync(agentsDirectory);
  for (const label of ['com.banana2.link', 'com.banana2.copy', 'com.banana2.absent']) {
    fs.writeFileSync(path.join(plistDirectory, `${label}.plist`), plist(label));
  }
  fs.symlinkSync(path.join(plistDirectory, 'com.banana2.link.plist'), path.join(agentsDirectory, 'com.banana2.link.plist'));
  fs.writeFileSync(path.join(agentsDirectory, 'com.banana2.copy.plist'),
    plist('com.banana2.copy').replace('<!-- /a/repo/comment -->', '<!-- changed comment -->'));
  fs.writeFileSync(path.join(agentsDirectory, 'com.banana2.test-only.plist'), plist('com.banana2.test-only'));
  return { plistDirectory, agentsDirectory };
}

test('rewrite는 string 경로만 바꾸고 주석·로그·경계 밖 문자열을 보존한다', () => {
  const original = plist('com.banana2.test');
  const rewritten = rewritePlist(original, oldRoot, newRoot);
  assert.match(rewritten, /<string>\/b\/repo\/scripts\/launchd\/run.sh<\/string>/);
  assert.match(rewritten, /<key>WorkingDirectory<\/key><string>\/b\/repo<\/string>/);
  assert.match(rewritten, /<!-- \/a\/repo\/comment -->/);
  assert.match(rewritten, /Library\/Logs\/a\/repo\/log/);
  assert.match(rewritten, /<string>\/a\/repo2\/data<\/string>/);
  assert.equal(rewritePlist(original, oldRoot, oldRoot), original);
});

test('검사는 링크·주석만 다른 복사본·미설치·저장소 밖 설치본을 구분한다', (t) => {
  const dirs = fixture(t);
  const report = inspectLaunchd(dirs);
  assert.equal(report.root, oldRoot);
  assert.deepEqual(report.installations.map((item) => item.status), ['미설치', '복사본', '링크']);
  assert.equal(report.installations.find((item) => item.status === '복사본').same, true);
  assert.deepEqual(report.outside.map((item) => item.label), ['com.banana2.test-only']);
  assert.equal(report.files.every((file) => file.uses.length === 2), true);
});

test('install 계획과 only 필터는 실제 시스템 호출 없이 동작한다', (t) => {
  const dirs = fixture(t);
  let writes = 0;
  let launchCalls = 0;
  const guardedFs = new Proxy(fs, { get(target, key) {
    if (['mkdirSync', 'writeFileSync', 'unlinkSync', 'symlinkSync'].includes(key)) {
      return () => { writes += 1; throw new Error('dry-run이 파일을 썼습니다'); };
    }
    return target[key];
  } });
  const deps = createDependencies({ fs: guardedFs, launchctl: () => { launchCalls += 1; } });
  const output = [];
  const plan = run(['--install'], { ...dirs, deps, output: (line) => output.push(line) });
  assert.deepEqual(plan.map((item) => item.previous.status), ['미설치', '복사본', '링크']);
  assert.equal(plan.length, 3);
  assert.match(output.at(-1), /test-only.*유지/);
  assert.equal(writes, 0);
  assert.equal(launchCalls, 0);
  const only = run(['--install', '--only', 'com.banana2.copy'], { ...dirs, deps, output: () => {} });
  assert.deepEqual(only.map((item) => item.label), ['com.banana2.copy']);
  assert.equal(writes, 0);
  assert.equal(launchCalls, 0);
  assert.equal(planInstall(inspectLaunchd(dirs), { ...dirs }).length, 3);
  assert.equal(plan.find((item) => item.label === 'com.banana2.link').action, '변경 없음');
  assert.equal(planInstall(inspectLaunchd(dirs), { ...dirs, reload: true })
    .find((item) => item.label === 'com.banana2.link').action, '재시작');
});

test('rewrite 기본 실행은 변경 줄만 보여주고 파일을 쓰지 않는다', (t) => {
  const dirs = fixture(t);
  const original = fs.readFileSync(path.join(dirs.plistDirectory, 'com.banana2.copy.plist'));
  let writes = 0;
  const guardedFs = new Proxy(fs, { get(target, key) {
    if (['mkdirSync', 'writeFileSync'].includes(key)) return () => { writes += 1; throw new Error('dry-run 쓰기'); };
    return target[key];
  } });
  const output = [];
  run(['--rewrite', '--to', newRoot], { ...dirs, deps: createDependencies({ fs: guardedFs }),
    output: (line) => output.push(line) });
  assert.equal(writes, 0);
  assert.match(output.join('\n'), /\+.*\/b\/repo\/scripts\/launchd\/run.sh/);
  assert.equal(fs.readFileSync(path.join(dirs.plistDirectory, 'com.banana2.copy.plist')).equals(original), true);
  assert.throws(() => run(['--rewrite', '--from', '/wrong', '--to', newRoot], { ...dirs, output: () => {} }),
    /감지된 루트와 다릅니다/);
  const outDirectory = path.join(path.dirname(dirs.plistDirectory), 'rewritten');
  const outLines = [];
  run(['--rewrite', '--to', newRoot, '--out', outDirectory], { ...dirs, output: (line) => outLines.push(line) });
  assert.match(outLines.join('\n'), /\+.*\/b\/repo\/scripts\/launchd\/run.sh/);
  assert.equal(fs.existsSync(outDirectory), false);
  assert.throws(() => run(['--rewrite', '--to', newRoot, '--out', dirs.plistDirectory, '--apply'],
    { ...dirs, output: () => {} }), /원본 plist 디렉토리/);
  const outLink = path.join(path.dirname(dirs.plistDirectory), 'original-link');
  fs.symlinkSync(dirs.plistDirectory, outLink);
  assert.throws(() => run(['--rewrite', '--to', newRoot, '--out', outLink, '--apply'],
    { ...dirs, output: () => {} }), /원본 plist 디렉토리/);
  run(['--rewrite', '--to', newRoot, '--out', outDirectory, '--apply'], { ...dirs, output: () => {} });
  assert.match(fs.readFileSync(path.join(outDirectory, 'com.banana2.copy.plist'), 'utf8'), /\/b\/repo\/scripts\/launchd\/run.sh/);
  assert.equal(fs.readFileSync(path.join(dirs.plistDirectory, 'com.banana2.copy.plist')).equals(original), true);
  assert.throws(() => run(['--rewrite', '--to', '/a&b'], { ...dirs, output: () => {} }), /XML 특수문자/);
  assert.equal(rewritePlist(plist('test'), '/a/repo/', newRoot), plist('test'));
});

test('apply는 선택한 설치본만 링크로 교체하고 bootout 뒤 bootstrap한다', (t) => {
  const dirs = fixture(t);
  const calls = [];
  const deps = createDependencies({ uid: 123, launchctl: (args) => {
    calls.push(args);
    if (args[0] === 'print') throw new Error('not loaded');
  }, sleep: () => { throw new Error('unexpected sleep'); } });
  run(['--install', '--only', 'com.banana2.copy', '--apply'], { ...dirs, deps, output: () => {} });
  const installed = path.join(dirs.agentsDirectory, 'com.banana2.copy.plist');
  assert.equal(fs.lstatSync(installed).isSymbolicLink(), true);
  assert.equal(fs.readlinkSync(installed), path.join(dirs.plistDirectory, 'com.banana2.copy.plist'));
  assert.deepEqual(calls.map((args) => args[0]), ['print', 'bootout', 'print', 'bootstrap']);
  assert.equal(fs.lstatSync(path.join(dirs.agentsDirectory, 'com.banana2.test-only.plist')).isSymbolicLink(), false);
});

test('다른 복사본은 거부하고 --force에서만 설치 계획에 넣는다', (t) => {
  const dirs = fixture(t);
  const copyPath = path.join(dirs.agentsDirectory, 'com.banana2.copy.plist');
  fs.writeFileSync(copyPath, plist('com.banana2.copy').replace(`<string>${oldRoot}</string>`, '<string>/different/repo</string>'));
  const report = inspectLaunchd(dirs);
  const blocked = planInstall(report, dirs).find((item) => item.label === 'com.banana2.copy');
  assert.equal(blocked.action, '거부');
  assert.match(blocked.warning, /--force/);
  assert.equal(planInstall(report, { ...dirs, force: true })
    .find((item) => item.label === 'com.banana2.copy').action, '설치');
  assert.throws(() => run(['--install', '--only', 'com.banana2.copy', '--apply'],
    { ...dirs, output: () => {} }), /--force 없이 적용할 수 없습니다/);
  assert.equal(fs.lstatSync(copyPath).isSymbolicLink(), false);
});

test('bootout 완료를 기다리고 bootstrap을 재시도한다', (t) => {
  const dirs = fixture(t);
  const calls = [];
  let printed = 0;
  let bootstraps = 0;
  const deps = createDependencies({ uid: 123, sleep: (duration) => calls.push(`sleep ${duration}`),
    launchctl: (args) => {
      calls.push(args[0]);
      if (args[0] === 'print' && ++printed === 3) throw new Error('stopped');
      if (args[0] === 'bootstrap' && ++bootstraps < 3) throw new Error('busy');
    } });
  run(['--install', '--only', 'com.banana2.copy', '--apply'], { ...dirs, deps, output: () => {} });
  assert.deepEqual(calls, ['print', 'bootout', 'print', 'sleep 1000', 'print', 'bootstrap',
    'sleep 2000', 'bootstrap', 'sleep 2000', 'bootstrap']);
});

test('실패 항목의 복사본을 되돌리고 다음 항목은 처리하지 않는다', (t) => {
  const dirs = fixture(t);
  const copyPath = path.join(dirs.agentsDirectory, 'com.banana2.copy.plist');
  const original = fs.readFileSync(copyPath);
  const calls = [];
  let prints = 0;
  const deps = createDependencies({ uid: 123, sleep: () => {}, launchctl: (args) => {
    calls.push(args[0]);
    if (args[0] === 'print' && ++prints > 1) throw new Error('stopped');
    if (args[0] === 'bootstrap' && fs.lstatSync(copyPath).isSymbolicLink()) throw new Error('bad link');
  } });
  assert.throws(() => run(['--install', '--only', 'com.banana2.copy,com.banana2.link', '--reload', '--apply'],
    { ...dirs, deps, output: () => {} }), /실패: com\.banana2\.copy.*미처리: com\.banana2\.link/);
  assert.equal(fs.lstatSync(copyPath).isSymbolicLink(), false);
  assert.equal(fs.readFileSync(copyPath).equals(original), true);
  assert.deepEqual(calls, ['print', 'bootout', 'print', 'bootstrap', 'bootstrap', 'bootstrap', 'print', 'bootstrap']);
});

test('원래 미로드였던 복사본은 실패 원복 후에도 미로드로 둔다', (t) => {
  const dirs = fixture(t);
  const copyPath = path.join(dirs.agentsDirectory, 'com.banana2.copy.plist');
  let bootstrapCalls = 0;
  const deps = createDependencies({ sleep: () => {}, launchctl: (args) => {
    if (args[0] === 'print') throw new Error('not loaded');
    if (args[0] === 'bootstrap') { bootstrapCalls += 1; throw new Error('busy'); }
  } });
  assert.throws(() => run(['--install', '--only', 'com.banana2.copy', '--apply'],
    { ...dirs, deps, output: () => {} }), /bootstrap 3회 실패/);
  assert.equal(bootstrapCalls, 3);
  assert.equal(fs.lstatSync(copyPath).isSymbolicLink(), false);
});

test('중간 실패 뒤 같은 명령을 재실행하면 완료 항목을 건너뛰고 이어서 적용한다', (t) => {
  const dirs = fixture(t);
  const labels = ['com.banana2.01', 'com.banana2.02', 'com.banana2.03'];
  for (const label of labels) {
    fs.writeFileSync(path.join(dirs.plistDirectory, `${label}.plist`), plist(label));
    fs.writeFileSync(path.join(dirs.agentsDirectory, `${label}.plist`), plist(label));
  }
  const secondPath = path.join(dirs.agentsDirectory, `${labels[1]}.plist`);
  const originalSecond = fs.readFileSync(secondPath);
  let failSecond = true;
  const bootstrapped = [];
  const deps = createDependencies({ sleep: () => {}, launchctl: (args) => {
    if (args[0] === 'print') throw new Error('not loaded');
    if (args[0] === 'bootstrap') {
      const label = path.basename(args[2], '.plist');
      bootstrapped.push(label);
      if (failSecond && label === labels[1]) throw new Error('busy');
    }
  } });
  const command = ['--install', '--only', labels.join(','), '--apply'];
  assert.throws(() => run(command, { ...dirs, deps, output: () => {} }), (error) => {
    assert.match(error.message, /처리 완료: com\.banana2\.01; 실패: com\.banana2\.02 \(bootstrap 3회 실패\); 미처리: com\.banana2\.03/);
    assert.match(error.message, /원인을 해결한 뒤 같은 명령을 다시 실행하면 완료 항목은 건너뛰고 이어서 처리합니다\./);
    return true;
  });
  assert.equal(fs.readlinkSync(path.join(dirs.agentsDirectory, `${labels[0]}.plist`)),
    path.join(dirs.plistDirectory, `${labels[0]}.plist`));
  assert.equal(fs.lstatSync(secondPath).isSymbolicLink(), false);
  assert.equal(fs.readFileSync(secondPath).equals(originalSecond), true);
  assert.equal(fs.lstatSync(path.join(dirs.agentsDirectory, `${labels[2]}.plist`)).isSymbolicLink(), false);
  assert.deepEqual(bootstrapped, [labels[0], labels[1], labels[1], labels[1]]);

  const plan = run(['--install', '--only', labels.join(',')], { ...dirs, deps, output: () => {} });
  assert.deepEqual(plan.map((item) => item.action), ['변경 없음', '설치', '설치']);
  failSecond = false;
  bootstrapped.length = 0;
  run(command, { ...dirs, deps, output: () => {} });
  assert.deepEqual(bootstrapped, [labels[1], labels[2]]);
  assert.deepEqual(run(['--install', '--only', labels.join(',')],
    { ...dirs, deps, output: () => {} }).map((item) => item.action),
  ['변경 없음', '변경 없음', '변경 없음']);
});

test('옛 경로를 거치는 링크는 대상만 갱신하고 재로드하지 않는다', (t) => {
  const dirs = fixture(t);
  const oldDirectory = path.join(path.dirname(dirs.plistDirectory), 'old-launchd');
  fs.symlinkSync(dirs.plistDirectory, oldDirectory);
  const link = path.join(dirs.agentsDirectory, 'com.banana2.link.plist');
  const oldTarget = path.join(oldDirectory, 'com.banana2.link.plist');
  fs.unlinkSync(link);
  fs.symlinkSync(oldTarget, link);
  const calls = [];
  const deps = createDependencies({ launchctl: (args) => calls.push(args) });
  const plan = run(['--install', '--only', 'com.banana2.link'], { ...dirs, deps, output: () => {} });
  assert.equal(plan[0].action, '링크 대상 갱신 필요');
  run(['--install', '--only', 'com.banana2.link', '--apply'], { ...dirs, deps, output: () => {} });
  assert.deepEqual(calls, []);
  assert.equal(fs.readlinkSync(link), path.join(dirs.plistDirectory, 'com.banana2.link.plist'));
  assert.equal(run(['--install', '--only', 'com.banana2.link'],
    { ...dirs, deps, output: () => {} })[0].action, '변경 없음');

  fs.unlinkSync(link);
  fs.symlinkSync(oldTarget, link);
  const reloadCalls = [];
  const reloadDeps = createDependencies({ launchctl: (args) => {
    reloadCalls.push(args[0]);
    if (args[0] === 'print') throw new Error('not loaded');
  } });
  run(['--install', '--only', 'com.banana2.link', '--reload', '--apply'],
    { ...dirs, deps: reloadDeps, output: () => {} });
  assert.deepEqual(reloadCalls, ['print', 'bootout', 'print', 'bootstrap']);
  assert.equal(fs.readlinkSync(link), path.join(dirs.plistDirectory, 'com.banana2.link.plist'));
});

test('순환 링크도 계획 단계에서 중단하지 않고 설치 대상으로 분류한다', (t) => {
  const dirs = fixture(t);
  const link = path.join(dirs.agentsDirectory, 'com.banana2.link.plist');
  fs.unlinkSync(link);
  fs.symlinkSync(link, link);
  const plan = run(['--install', '--only', 'com.banana2.link'], { ...dirs, output: () => {} });
  assert.equal(plan[0].action, '설치');
});

test('bootout 제한시간 실패는 링크를 바꾸지 않고 멈춘다', (t) => {
  const dirs = fixture(t);
  const copyPath = path.join(dirs.agentsDirectory, 'com.banana2.copy.plist');
  const original = fs.readFileSync(copyPath);
  const sleeps = [];
  const deps = createDependencies({ bootoutTimeoutSeconds: 2, sleep: (duration) => sleeps.push(duration),
    launchctl: () => {} });
  assert.throws(() => run(['--install', '--only', 'com.banana2.copy', '--apply'],
    { ...dirs, deps, output: () => {} }), /2초 내 종료되지 않았습니다/);
  assert.deepEqual(sleeps, [1000, 1000]);
  assert.equal(fs.readFileSync(copyPath).equals(original), true);
});

test('임시 심볼릭 링크 경유 CLI도 --check를 실행한다', (t) => {
  const dirs = fixture(t);
  const link = path.join(dirs.agentsDirectory, 'relocate-link.mjs');
  fs.symlinkSync(fileURLToPath(new URL('./relocate-launchd.mjs', import.meta.url)), link);
  const output = execFileSync(process.execPath, [link, '--check'], { encoding: 'utf8' });
  assert.match(output, /저장소 루트:/);
});

test('실제 저장소 plist 45개는 현재 루트로 rewrite할 때 바이트가 같다', () => {
  const directory = path.join(repositoryRoot, 'scripts', 'launchd');
  const names = fs.readdirSync(directory).filter((name) => name.endsWith('.plist'));
  assert.equal(names.length, 45);
  for (const name of names) {
    const source = fs.readFileSync(path.join(directory, name));
    assert.equal(Buffer.from(rewritePlist(source.toString('utf8'), repositoryRoot, repositoryRoot)).equals(source), true, name);
  }
});
