// launchd plist의 저장소 경로와 설치 상태를 점검하고 이관 작업을 준비한다.
// 사용: node scripts/tools/relocate-launchd.mjs --check [--json]
//       node scripts/tools/relocate-launchd.mjs --rewrite --to /new/repo [--from /old/repo] [--out /tmp/plists] [--apply]
//       node scripts/tools/relocate-launchd.mjs --install [--only label1,label2] [--reload] [--force] [--apply]
// 1단계: --check → --rewrite --to <새 루트> 계획 확인 → --rewrite --to <새 루트> --apply
//       → --install 계획 확인 → --install --apply. 실패하면 원인 해결 후 같은 명령을 재실행한다.
// --rewrite --apply는 LaunchAgents 링크를 통해 운영 plist를 바꾸는 행위다.
// --out과 원본 모두 --apply가 있을 때만 쓴다.
import * as nodeFs from 'node:fs';
import * as nodePath from 'node:path';
import * as nodeOs from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repositoryRoot = nodePath.resolve(nodePath.dirname(fileURLToPath(import.meta.url)), '../..');
const tokenPattern = /<!--[\s\S]*?-->|<key>([\s\S]*?)<\/key>|<string>([\s\S]*?)<\/string>/g;

function plistTokens(source) {
  const tokens = [];
  let currentKey = null;
  for (const match of source.matchAll(tokenPattern)) {
    if (match[0].startsWith('<!--')) continue;
    if (match[1] !== undefined) {
      currentKey = match[1];
      continue;
    }
    const valueOffset = match[0].indexOf('>') + 1;
    tokens.push({ key: currentKey, value: match[2], start: match.index + valueOffset,
      end: match.index + valueOffset + match[2].length });
  }
  return tokens;
}

function pathHasRoot(value, root) {
  return value === root || value.startsWith(`${root}/`);
}

function rootFromToken(token) {
  if (token.key === 'WorkingDirectory' && token.value.startsWith('/')) return token.value;
  if (token.key === 'ProgramArguments' && token.value.endsWith('/scripts/launchd/run.sh')) {
    return token.value.slice(0, -'/scripts/launchd/run.sh'.length);
  }
  return null;
}

function withoutComments(source) {
  return source.replace(/<!--[\s\S]*?-->/g, '');
}

export function rewritePlist(source, fromRoot, toRoot) {
  if (!nodePath.isAbsolute(fromRoot) || !nodePath.isAbsolute(toRoot)) {
    throw new Error('저장소 루트는 절대경로여야 합니다');
  }
  let result = '';
  let cursor = 0;
  for (const token of plistTokens(source)) {
    if (!pathHasRoot(token.value, fromRoot)) continue;
    result += source.slice(cursor, token.start) + toRoot + token.value.slice(fromRoot.length);
    cursor = token.end;
  }
  return result + source.slice(cursor);
}

export function createDependencies(overrides = {}) {
  return {
    fs: nodeFs,
    path: nodePath,
    launchctl: (args) => execFileSync('launchctl', args, { stdio: 'pipe' }),
    sleep: (milliseconds) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds),
    bootoutTimeoutSeconds: 10,
    uid: process.getuid(),
    ...overrides,
  };
}

export function inspectLaunchd({ plistDirectory, agentsDirectory, deps = createDependencies() }) {
  const { fs, path } = deps;
  const plistNames = fs.readdirSync(plistDirectory).filter((name) => name.endsWith('.plist')).sort();
  const files = plistNames.map((name) => {
    const source = fs.readFileSync(path.join(plistDirectory, name), 'utf8');
    const tokens = plistTokens(source);
    const label = tokens.find((token) => token.key === 'Label')?.value;
    if (!label) throw new Error(`${name}: Label이 없습니다`);
    const roots = [...new Set(tokens.map(rootFromToken).filter(Boolean))];
    if (roots.length !== 1) throw new Error(`${name}: 저장소 루트가 일치하지 않습니다: ${roots.join(', ')}`);
    const root = roots[0];
    const uses = tokens.filter((token) => pathHasRoot(token.value, root))
      .map((token) => ({ key: token.key, value: token.value }));
    return { name, label, root, uses, source, realpath: fs.realpathSync(path.join(plistDirectory, name)) };
  });
  const roots = [...new Set(files.map((file) => file.root))];
  if (roots.length !== 1) throw new Error(`plist 간 저장소 루트가 일치하지 않습니다: ${roots.join(', ')}`);
  const installedNames = fs.existsSync(agentsDirectory)
    ? fs.readdirSync(agentsDirectory).filter((name) => name.endsWith('.plist')) : [];
  const sourceNames = new Set(plistNames);
  const installations = files.map((file) => {
    const installedPath = path.join(agentsDirectory, file.name);
    // existsSync는 끊어진 심볼릭 링크를 놓치므로 lstat으로 설치 여부를 판별한다.
    let stat;
    try { stat = fs.lstatSync(installedPath); } catch (error) {
      if (error.code === 'ENOENT') return { label: file.label, status: '미설치' };
      throw error;
    }
    if (stat.isSymbolicLink()) {
      const target = fs.readlinkSync(installedPath);
      let realpath = null;
      try { realpath = fs.realpathSync(installedPath); } catch (error) {
        if (!['ENOENT', 'ELOOP', 'ENOTDIR'].includes(error.code)) throw error;
      }
      return { label: file.label, status: '링크', target: path.resolve(agentsDirectory, target), realpath };
    }
    return { label: file.label, status: '복사본', same: withoutComments(fs.readFileSync(installedPath, 'utf8'))
      === withoutComments(file.source) };
  });
  // 이 저장소의 launchd 네임스페이스만 비교한다. 다른 앱의 LaunchAgent는 이관 대상이 아니다.
  const outside = installedNames.filter((name) => name.startsWith('com.banana2.') && !sourceNames.has(name))
    .map((name) => ({ label: name.slice(0, -'.plist'.length), status: '저장소 밖' }));
  return { root: roots[0], files, installations, outside };
}

export function planInstall(report, { plistDirectory, agentsDirectory, only, reload = false, force = false } = {}) {
  const selected = only ? new Set(only.split(',').filter(Boolean)) : null;
  if (selected) {
    const unknown = [...selected].filter((label) => !report.files.some((file) => file.label === label));
    if (unknown.length) throw new Error(`저장소에 없는 label: ${unknown.join(', ')}`);
  }
  return report.files.filter((file) => !selected || selected.has(file.label)).map((file) => {
    const source = nodePath.join(plistDirectory, file.name);
    const previous = report.installations.find((item) => item.label === file.label);
    const action = previous.status === '링크' && previous.target === source
      ? (reload ? '재시작' : '변경 없음')
      : previous.status === '링크' && previous.realpath === file.realpath
        ? '링크 대상 갱신 필요'
        : previous.status === '복사본' && !previous.same && !force ? '거부' : '설치';
    const warnings = [];
    if (action === '거부') warnings.push('복사본 내용 다름: --force 필요');
    if (/^com\.banana2\.(telegram-session|execute-)/.test(file.label)) {
      warnings.push('상시·장중 잡: 적용 시 중단 가능');
    }
    return { label: file.label, source, link: nodePath.join(agentsDirectory, file.name), previous,
      action, reload, warning: warnings.join('; ') || null };
  });
}

export function applyInstall(plan, deps = createDependencies()) {
  const { fs, path, launchctl, uid, sleep, bootoutTimeoutSeconds } = deps;
  const completed = [];
  const actionable = plan.filter((item) => ['설치', '재시작', '링크 대상 갱신 필요'].includes(item.action));
  for (const [index, item] of actionable.entries()) {
    const previous = item.previous.status === '링크'
      ? { type: 'link', value: fs.readlinkSync(item.link) }
      : item.previous.status === '복사본'
        ? { type: 'copy', value: fs.readFileSync(item.link), mode: fs.statSync(item.link).mode } : { type: 'none' };
    let installationChanged = false;
    let wasLoaded = false;
    try {
      if (item.action === '링크 대상 갱신 필요' && !item.reload) {
        installationChanged = true;
        fs.unlinkSync(item.link);
        fs.symlinkSync(item.source, item.link);
        completed.push(item.label);
        continue;
      }
      try { launchctl(['print', `gui/${uid}/${item.label}`]); wasLoaded = true; } catch { /* 원래 미로드 */ }
      try { launchctl(['bootout', `gui/${uid}/${item.label}`]); } catch { /* 미로드 상태는 정상이다. */ }
      let stopped = false;
      for (let second = 0; second <= bootoutTimeoutSeconds; second += 1) {
        try { launchctl(['print', `gui/${uid}/${item.label}`]); } catch { stopped = true; break; }
        if (second < bootoutTimeoutSeconds) sleep(1000);
      }
      if (!stopped) throw new Error(`bootout 후 ${bootoutTimeoutSeconds}초 내 종료되지 않았습니다`);
      if (item.action === '설치' || item.action === '링크 대상 갱신 필요') {
        fs.mkdirSync(path.dirname(item.link), { recursive: true });
        installationChanged = true;
        if (previous.type !== 'none') fs.unlinkSync(item.link);
        fs.symlinkSync(item.source, item.link);
      }
      let bootstrapped = false;
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try { launchctl(['bootstrap', `gui/${uid}`, item.link]); bootstrapped = true; break; }
        catch { if (attempt < 3) sleep(2000); }
      }
      if (!bootstrapped) throw new Error('bootstrap 3회 실패');
      completed.push(item.label);
    } catch (error) {
      // 실패한 항목만 원래 설치 형태로 돌려 운영 설정을 더 악화시키지 않는다.
      try {
        if (installationChanged) {
          try { fs.unlinkSync(item.link); } catch (unlinkError) { if (unlinkError.code !== 'ENOENT') throw unlinkError; }
          if (previous.type === 'link') fs.symlinkSync(previous.value, item.link);
          if (previous.type === 'copy') {
            fs.writeFileSync(item.link, previous.value);
            fs.chmodSync(item.link, previous.mode);
          }
        }
        if (previous.type !== 'none' && wasLoaded) {
          let alreadyLoaded = false;
          try { launchctl(['print', `gui/${uid}/${item.label}`]); alreadyLoaded = true; } catch { /* 내려간 상태 */ }
          if (!alreadyLoaded) launchctl(['bootstrap', `gui/${uid}`, item.link]);
        }
      } catch (restoreError) { error.message += `; 원상복구 실패: ${restoreError.message}`; }
      const pending = actionable.slice(index + 1).map((entry) => entry.label);
      throw new Error(`처리 완료: ${completed.join(', ') || '없음'}; 실패: ${item.label} (${error.message}); 미처리: ${pending.join(', ') || '없음'}\n원인을 해결한 뒤 같은 명령을 다시 실행하면 완료 항목은 건너뛰고 이어서 처리합니다.`);
    }
  }
  return completed;
}

function parseOptions(args) {
  const options = { mode: '--check', apply: false, json: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (['--check', '--rewrite', '--install'].includes(arg)) options.mode = arg;
    else if (arg === '--apply') options.apply = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--reload') options.reload = true;
    else if (arg === '--force') options.force = true;
    else if (['--to', '--from', '--out', '--only'].includes(arg)) {
      if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`${arg} 값이 필요합니다`);
      options[arg.slice(2)] = args[++index];
    } else throw new Error(`알 수 없는 옵션: ${arg}`);
  }
  return options;
}

function printCheck(report, output) {
  output(`저장소 루트: ${report.root} | plist ${report.files.length}개`);
  output('LABEL | 경로 사용처 | 설치 상태');
  for (const file of report.files) {
    const installed = report.installations.find((item) => item.label === file.label);
    const status = installed.status === '링크' ? `링크 → ${installed.target}`
      : installed.status === '복사본' ? `복사본 (주석 제외 ${installed.same ? '동일' : '다름'})` : '미설치';
    output(`${file.label} | ${file.uses.map((use) => use.key).join(', ')} | ${status}`);
  }
  for (const item of report.outside) output(`${item.label} | — | 저장소 밖 (유지)`);
  const counts = Object.fromEntries(['링크', '복사본', '미설치'].map((status) =>
    [status, report.installations.filter((item) => item.status === status).length]));
  output(`합계: 링크 ${counts['링크']}, 복사본 ${counts['복사본']}, 미설치 ${counts['미설치']}, 저장소 밖 ${report.outside.length}`);
}

export function run(args, { deps = createDependencies(),
  plistDirectory = nodePath.join(repositoryRoot, 'scripts/launchd'),
  agentsDirectory = nodePath.join(nodeOs.homedir(), 'Library/LaunchAgents'),
  output = console.log } = {}) {
  const options = parseOptions(args);
  const report = inspectLaunchd({ plistDirectory, agentsDirectory, deps });
  if (options.mode === '--check') {
    if (options.json) output(JSON.stringify(report, (key, value) => key === 'source' ? undefined : value, 2));
    else printCheck(report, output);
    return report;
  }
  if (options.mode === '--rewrite') {
    if (!options.to) throw new Error('--rewrite에는 --to가 필요합니다');
    for (const key of ['to', 'from']) {
      if (options[key] && /[&<>]/.test(options[key])) throw new Error(`${key} 경로에 XML 특수문자를 쓸 수 없습니다`);
      if (options[key]) options[key] = deps.path.resolve(options[key]);
    }
    const resolvedOut = options.out && deps.fs.existsSync(options.out)
      ? deps.fs.realpathSync(options.out) : options.out && deps.path.resolve(options.out);
    if (resolvedOut && resolvedOut === deps.fs.realpathSync(plistDirectory)) {
      throw new Error('--out은 원본 plist 디렉토리를 가리킬 수 없습니다');
    }
    if (options.from && options.from !== deps.path.resolve(report.root)) {
      throw new Error(`--from이 감지된 루트와 다릅니다: ${report.root}`);
    }
    const fromRoot = options.from ?? report.root;
    for (const file of report.files) {
      const rewritten = rewritePlist(file.source, fromRoot, options.to);
      if (options.out && options.apply) {
        deps.fs.mkdirSync(options.out, { recursive: true });
        deps.fs.writeFileSync(deps.path.join(options.out, file.name), rewritten);
      } else if (options.apply && rewritten !== file.source) {
        deps.fs.writeFileSync(deps.path.join(plistDirectory, file.name), rewritten);
      }
      if (!options.apply && rewritten !== file.source) {
        output(`--- ${file.name}\n+++ ${file.name} (${options.to})`);
        const before = file.source.split('\n');
        const after = rewritten.split('\n');
        before.forEach((line, index) => { if (line !== after[index]) output(`-${line}\n+${after[index]}`); });
      }
    }
    return;
  }
  const plan = planInstall(report, { plistDirectory, agentsDirectory, only: options.only,
    reload: options.reload, force: options.force });
  if (options.apply) {
    const rejected = plan.filter((item) => item.action === '거부');
    if (rejected.length) throw new Error(`내용이 다른 복사본은 --force 없이 적용할 수 없습니다: ${rejected.map((item) => item.label).join(', ')}`);
    applyInstall(plan, deps);
  }
  else {
    for (const item of plan) {
      const steps = item.action === '링크 대상 갱신 필요' && !item.reload
        ? ` (${item.previous.target} → 링크 ${item.source})`
        : ['설치', '재시작', '링크 대상 갱신 필요'].includes(item.action)
          ? ` (${item.previous.status} → 링크 ${item.source} → bootout → bootstrap)` : '';
      output(`${item.label}: ${item.action}${steps}`);
      if (item.warning) output(`  ⚠ ${item.label}: ${item.warning}`);
    }
    for (const item of report.outside) output(`${item.label}: 저장소 밖 설치본 유지`);
  }
  return plan;
}

if (process.argv[1] && nodeFs.realpathSync(process.argv[1]) === nodeFs.realpathSync(fileURLToPath(import.meta.url))) {
  try { run(process.argv.slice(2)); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
