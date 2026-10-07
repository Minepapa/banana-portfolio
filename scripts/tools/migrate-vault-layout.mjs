#!/usr/bin/env node
// 볼트 2단계 이관을 계획하고, 명시적인 --apply에서만 git 작업 트리를 바꾼다.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, normalize, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LEGACY_TO_MOUSEION_RULES, mapLegacyPath, MOUSEION_TOP_FOLDERS } from '../lib/vault-layout.mjs';
import { VAULT_PATHS, VAULT_ROOT } from '../lib/vault-paths.mjs';

const EXCLUDED = new Set(['.git', '.obsidian', '.omc', '.trash']);

export function listVaultFiles(root) {
  const files = [];
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (EXCLUDED.has(entry.name)) continue;
      const absolutePath = join(directory, entry.name);
      if (entry.isDirectory()) visit(absolutePath);
      else if (entry.isFile()) files.push(relative(root, absolutePath).split('\\').join('/'));
      else throw new Error(`지원하지 않는 볼트 항목: ${absolutePath}`);
    }
  }
  visit(root);
  return files.sort();
}

function determineYearEvidence(relPath, content = '') {
  const nameYear = /^(\d{4})-\d{2}-\d{2}(?:\D|$)/.exec(relPath.split('/').at(-1));
  if (nameYear) return { year: nameYear[1], source: 'filename' };
  if (extname(relPath) !== '.md') return null;
  const frontmatter = /^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
  const dateYear = frontmatter?.[1].match(/^date:\s*["']?(\d{4})-\d{2}-\d{2}/m);
  return dateYear ? { year: dateYear[1], source: 'frontmatter' } : null;
}

export function determineYear(relPath, content = '') {
  return determineYearEvidence(relPath, content)?.year ?? null;
}

function isNewPath(relPath) {
  return MOUSEION_TOP_FOLDERS.includes(relPath.split('/')[0]);
}

export function planMigration(files, gitFirstCommitYear = () => null) {
  const moves = [];
  const deletes = [];
  const unresolvedYears = [];
  const unmapped = [];
  const yearSources = { filename: 0, frontmatter: 0, gitFirstCommit: 0 };
  const gitFirstCommitFiles = [];
  const destinations = new Map();
  const sourcePaths = new Set(files.map((file) => file.path));

  for (const file of files) {
    const from = file.path;
    if (isNewPath(from)) continue;
    const mapping = mapLegacyPath(from);
    if (!mapping) {
      unmapped.push(from);
      continue;
    }
    if (mapping.action === 'delete') {
      deletes.push(from);
      continue;
    }
    let to = mapping.to;
    if (mapping.yearFolder) {
      let evidence = determineYearEvidence(from, file.content);
      if (!evidence) {
        const year = gitFirstCommitYear(from);
        if (year) evidence = { year, source: 'gitFirstCommit' };
      }
      if (!evidence) {
        unresolvedYears.push(from);
        continue;
      }
      const { year, source } = evidence;
      yearSources[source] += 1;
      if (source === 'gitFirstCommit') gitFirstCommitFiles.push({ path: from, year });
      if (from === mapping.rule.from && extname(mapping.rule.from)) {
        to = `${dirname(to)}/${year}/${basename(to)}`;
      } else {
        const base = mapping.rule.to;
        to = `${base}/${year}${to.slice(base.length)}`;
      }
    }
    if (from !== to) moves.push({ from, to });
  }

  for (const path of sourcePaths) {
    if (deletes.includes(path) || moves.some((move) => move.from === path)) continue;
    const key = path.toLocaleLowerCase('en-US');
    const group = destinations.get(key) ?? { to: path, sources: [] };
    group.sources.push(path);
    destinations.set(key, group);
  }
  for (const { from, to } of moves) {
    const key = to.toLocaleLowerCase('en-US');
    const group = destinations.get(key) ?? { to, sources: [] };
    group.sources.push(from);
    destinations.set(key, group);
  }
  const collisions = [...destinations.values()].filter((group) => group.sources.length > 1);
  const byDestination = {};
  for (const { to } of moves) {
    const folder = dirname(to);
    byDestination[folder] = (byDestination[folder] ?? 0) + 1;
  }
  return { moves, deletes, byDestination, yearSources, gitFirstCommitFiles, unresolvedYears, unmapped, collisions };
}

function linkParts(inner) {
  const separator = inner.search(/[|#^]/);
  return separator < 0 ? [inner, ''] : [inner.slice(0, separator), inner.slice(separator)];
}

function inlineSegments(line) {
  const segments = [];
  const delimiters = [...line.matchAll(/`+/g)];
  let start = 0;
  for (let index = 0; index < delimiters.length; index += 1) {
    const opening = delimiters[index];
    const closingIndex = delimiters.findIndex((candidate, candidateIndex) =>
      candidateIndex > index && candidate[0].length === opening[0].length);
    if (closingIndex < 0) continue;
    const closing = delimiters[closingIndex];
    segments.push({ text: line.slice(start, opening.index), code: false });
    segments.push({ text: line.slice(opening.index, closing.index + closing[0].length), code: true });
    start = closing.index + closing[0].length;
    index = closingIndex;
  }
  segments.push({ text: line.slice(start), code: false });
  return segments;
}

export function rewriteLinks(content, moves, deletes = [], paths = moves.map(({ from }) => from), sourcePath = '') {
  const moved = new Map(moves.map(({ from, to }) => [from, to]));
  const deleted = new Set(deletes);
  const deletedLinks = [];
  let changedLinks = 0;
  let basenameLinks = 0;
  let basenameChangedLinks = 0;
  const deferredBasenameLinks = [];
  const legacyByBasename = new Map();
  const destinationByBasename = new Map();
  for (const path of paths.filter((path) => path.endsWith('.md'))) {
    const name = basename(path, '.md');
    legacyByBasename.set(name, [...(legacyByBasename.get(name) ?? []), path]);
    if (deleted.has(path)) continue;
    const destination = moved.get(path) ?? path;
    const nextName = basename(destination, '.md');
    destinationByBasename.set(nextName, [...(destinationByBasename.get(nextName) ?? []), destination]);
  }
  const renames = new Map(moves.filter(({ from, to }) => from.endsWith('.md') &&
    basename(from, '.md') !== basename(to, '.md'))
    .map(({ from, to }) => [basename(from, '.md'), { from, to }]));
  let fence = null;
  const rewritten = content.split(/(\r?\n)/).map((line) => {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker && (!fence || (marker[0] === fence[0] && marker.length >= fence.length))) {
      fence = fence ? null : marker;
      return line;
    }
    if (fence || /^\r?\n$/.test(line)) return line;
    // 인라인 코드 조각을 그대로 통과시킨 뒤 나머지 부분의 위키링크만 찾는다.
    return inlineSegments(line).map(({ text: part, code }) => {
      if (code) return part;
      return part.replace(/(!?\[\[)([^\]\r\n]+)(\]\])/g, (full, open, inner, close) => {
        const [rawTarget, suffix] = linkParts(inner);
        const target = rawTarget.replace(/\\+$/, '');
        const separator = rawTarget.slice(target.length) + suffix;
        if (!target.includes('/')) {
          basenameLinks += 1;
          const hasMd = target.endsWith('.md');
          const name = hasMd ? target.slice(0, -3) : target;
          const rename = renames.get(name);
          if (!rename) return full;
          const candidates = legacyByBasename.get(name) ?? [];
          if (candidates.length !== 1) {
            deferredBasenameLinks.push({ file: sourcePath, target, candidates });
            return full;
          }
          const nextName = basename(rename.to, '.md');
          const nextTarget = (destinationByBasename.get(nextName)?.length ?? 0) === 1
            ? nextName : rename.to.slice(0, -3);
          changedLinks += 1;
          basenameChangedLinks += 1;
          return `${open}${nextTarget}${hasMd ? '.md' : ''}${separator}${close}`;
        }
        const hasMd = target.endsWith('.md');
        const isRelative = target.startsWith('../') || target.startsWith('./');
        const oldTarget = isRelative ? normalize(join(dirname(sourcePath), target)).split('\\').join('/') : target;
        const lookup = hasMd ? oldTarget : `${oldTarget}.md`;
        if (isRelative && !paths.includes(lookup) && !paths.includes(oldTarget)) return full;
        if (deleted.has(lookup) || deleted.has(oldTarget)) {
          deletedLinks.push(target);
          return full;
        }
        const resolvedTarget = paths.includes(lookup) ? lookup : oldTarget;
        const destination = moved.get(resolvedTarget) ?? resolvedTarget;
        const newSource = moved.get(sourcePath) ?? sourcePath;
        const newTarget = isRelative
          ? relative(dirname(newSource), destination).split('\\').join('/') : destination;
        if (!isRelative && !moved.has(lookup) && !moved.has(oldTarget)) return full;
        const next = hasMd || !newTarget.endsWith('.md') ? newTarget : newTarget.slice(0, -3);
        const relativeNext = isRelative && !next.startsWith('.') ? `./${next}` : next;
        if (isRelative && relativeNext === target) return full;
        changedLinks += 1;
        return `${open}${relativeNext}${separator}${close}`;
      });
    }).join('');
  }).join('');
  return { content: rewritten, changedLinks, basenameLinks, basenameChangedLinks,
    deferredBasenameLinks, deletedLinks };
}

export function brokenFullPathLinks(content, existingPaths, sourcePath = '') {
  const existing = new Set(existingPaths);
  const existingBasenames = new Set(existingPaths.filter((path) => path.endsWith('.md'))
    .map((path) => basename(path, '.md')));
  const missing = new Set();
  const visible = rewriteLinks(content, [], []);
  // 같은 코드 제외 규칙을 쓰기 위해 대상 추출을 치환 함수에 추가하지 않고 구간을 순회한다.
  let fence = null;
  for (const line of visible.content.split(/\r?\n/)) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker && (!fence || (marker[0] === fence[0] && marker.length >= fence.length))) {
      fence = fence ? null : marker;
      continue;
    }
    if (fence) continue;
    for (const { text: part, code } of inlineSegments(line)) {
      if (code) continue;
      for (const match of part.matchAll(/!?\[\[([^\]\r\n]+)\]\]/g)) {
        const [rawTarget] = linkParts(match[1]);
        const target = rawTarget.replace(/\\+$/, '');
        if (!target) continue;
        if (!target.includes('/')) {
          const name = target.endsWith('.md') ? target.slice(0, -3) : target;
          if (!existingBasenames.has(name)) missing.add(target);
          continue;
        }
        const resolved = target.startsWith('../') || target.startsWith('./')
          ? normalize(join(dirname(sourcePath), target)).split('\\').join('/') : target;
        if (existing.has(resolved) || existing.has(`${resolved}.md`)) continue;
        if (!target.startsWith('../') && !target.startsWith('./')
          && [...existing].some((path) => path.endsWith(`/${target}`) || path.endsWith(`/${target}.md`))) continue;
        missing.add(target);
      }
    }
  }
  return [...missing];
}

function git(vault, ...args) {
  return execFileSync('git', ['-C', vault, ...args], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
}

function gitFirstCommitYear(vault, path) {
  try {
    // 과거에 추적되다 삭제된 경로에 미추적 파일이 다시 생겨도 옛 커밋 연도를 쓰지 않는다.
    if (!git(vault, 'ls-files', '-z', '--', path).split('\0').includes(path)) return null;
    const dates = git(vault, 'log', '--diff-filter=A', '--follow', '--format=%ad', '--date=format:%Y', '--', path)
      .trim().split('\n');
    const firstYear = dates.at(-1);
    return /^\d{4}$/.test(firstYear) ? firstYear : null;
  } catch {
    return null;
  }
}

function collectBrokenLinks(root, paths) {
  const brokenLinks = [];
  for (const path of paths.filter((item) => item.endsWith('.md'))) {
    for (const target of brokenFullPathLinks(readFileSync(join(root, path), 'utf8'), paths, path)) {
      brokenLinks.push({ file: path, target });
    }
  }
  return brokenLinks;
}

function cleanLegacyFolders(root) {
  const legacyRoots = [...new Set(LEGACY_TO_MOUSEION_RULES
    .filter((rule) => rule.from !== '.gitignore')
    .map((rule) => rule.from.split('/')[0]))];
  function removeEmptyFolders(directory) {
    if (!existsSync(directory)) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) removeEmptyFolders(join(directory, entry.name));
    }
    if (readdirSync(directory).length === 0) rmdirSync(directory);
  }
  for (const folder of legacyRoots) removeEmptyFolders(join(root, folder));
  return listVaultFiles(root).filter((path) => legacyRoots.includes(path.split('/')[0]));
}

export function migrateVault(vault, { apply = false, reportPath, afterMove } = {}) {
  const root = resolve(vault);
  if (!existsSync(root) || !statSync(root).isDirectory()) throw new Error(`볼트 디렉토리가 없습니다: ${root}`);
  const paths = listVaultFiles(root);
  const files = paths.map((path) => ({ path, content: path.endsWith('.md') ? readFileSync(join(root, path), 'utf8') : '' }));
  const plan = planMigration(files, (path) => gitFirstCommitYear(root, path));
  const rewrites = files.filter(({ path }) => path.endsWith('.md') && !plan.deletes.includes(path))
    .map((file) => ({ from: file.path, ...rewriteLinks(file.content, plan.moves, plan.deletes, paths, file.path) }));
  const linkFiles = rewrites.filter((entry) => entry.changedLinks > 0).length;
  const linkCount = rewrites.reduce((count, entry) => count + entry.changedLinks, 0);
  const moved = new Map(plan.moves.map(({ from, to }) => [from, to]));
  const remainingPlanned = paths.filter((path) => !plan.deletes.includes(path))
    .map((path) => moved.get(path) ?? path);
  const plannedBrokenLinks = rewrites.flatMap((entry) => {
    const destination = moved.get(entry.from) ?? entry.from;
    return brokenFullPathLinks(entry.content, remainingPlanned, destination)
      .map((target) => ({ file: destination, target }));
  });
  const safetyPaths = [VAULT_PATHS.state.killSwitch, VAULT_PATHS.state.executionMode,
    VAULT_PATHS.state.proposalMode].map((absolute) => relative(VAULT_ROOT, absolute).split('\\').join('/'));
  const safetyFiles = safetyPaths.flatMap((to) => paths
    .filter((from) => from === to || mapLegacyPath(from)?.to === to)
    .map((from) => ({ from, to, tracked: null, byteIdentical: null })));
  const safetyContents = new Map(safetyFiles.map(({ from }) => [from, readFileSync(join(root, from))]));
  const result = {
    moveCount: plan.moves.length, deleteCount: plan.deletes.length,
    byDestination: plan.byDestination, yearSources: plan.yearSources,
    gitFirstCommitFiles: plan.gitFirstCommitFiles, unresolvedYears: plan.unresolvedYears,
    unmapped: plan.unmapped, collisions: plan.collisions,
    linkFiles, linkCount,
    basenameLinks: rewrites.reduce((count, entry) => count + entry.basenameLinks, 0),
    basenameChangedLinks: rewrites.reduce((count, entry) => count + entry.basenameChangedLinks, 0),
    deferredBasenameLinks: rewrites.flatMap((entry) => entry.deferredBasenameLinks),
    deletedLinks: rewrites.flatMap((entry) => entry.deletedLinks.map((target) => ({ file: entry.from, target }))),
    moves: plan.moves, deletes: plan.deletes,
    plannedBrokenLinks, safetyFiles,
  };
  if (!apply) return result;
  if (realpathSync(git(root, 'rev-parse', '--show-toplevel').trim()) !== realpathSync(root)) {
    throw new Error(`--vault는 git 작업 트리 루트여야 합니다: ${root}`);
  }
  if (plan.unmapped.length || plan.collisions.length || plan.unresolvedYears.length || plannedBrokenLinks.length) {
    throw new Error(`이관 사전 검사 실패: 매핑 없음 ${plan.unmapped.length}, 충돌 ${plan.collisions.length}, 연도 미결정 ${plan.unresolvedYears.length}, 적용 후 깨진 링크 ${plannedBrokenLinks.length}`);
  }
  // 작업이 끝난 볼트는 첫 실행의 미커밋 이동이 남아 있어도 재실행이 무작업이어야 한다.
  if (!plan.moves.length && !plan.deletes.length && !linkCount) {
    const tracked = new Set(git(root, 'ls-files', '-z').split('\0').filter(Boolean));
    for (const file of safetyFiles) {
      file.tracked = tracked.has(file.from);
      file.byteIdentical = existsSync(join(root, file.to))
        && safetyContents.get(file.from).equals(readFileSync(join(root, file.to)));
    }
    if (safetyFiles.some((file) => !file.tracked || !file.byteIdentical)) {
      throw new Error('안전 상태 파일 대조 실패');
    }
    const remainingLegacyFiles = cleanLegacyFolders(root);
    const completed = { ...result, brokenLinks: collectBrokenLinks(root, paths), remainingLegacyFiles };
    if (reportPath) writeFileSync(resolve(reportPath), `${JSON.stringify(completed, null, 2)}\n`);
    return completed;
  }
  if (git(root, 'status', '--porcelain').trim()) throw new Error('볼트 git 작업 트리가 깨끗하지 않습니다');
  const tracked = new Set(git(root, 'ls-files', '-z').split('\0').filter(Boolean));
  const untrackedSources = [...plan.moves.map((move) => move.from), ...plan.deletes,
    ...safetyFiles.map((file) => file.from)]
    .filter((path) => !tracked.has(path));
  for (const file of safetyFiles) file.tracked = tracked.has(file.from);
  if (untrackedSources.length) {
    throw new Error(`git에 추적되지 않는 이관 대상: ${untrackedSources.join(', ')}`);
  }
  for (const { to } of plan.moves) {
    let parent = dirname(to);
    while (parent !== '.') {
      if (existsSync(join(root, parent)) && !statSync(join(root, parent)).isDirectory()) {
        throw new Error(`목적지 부모 경로가 파일입니다: ${parent}`);
      }
      parent = dirname(parent);
    }
    if (existsSync(join(root, to))) {
      throw new Error(`목적지 경로가 이미 점유돼 있습니다: ${to}`);
    }
  }
  const startHead = git(root, 'rev-parse', 'HEAD').trim();
  try {
    for (const { from, to } of plan.moves) {
      mkdirSync(dirname(join(root, to)), { recursive: true });
      git(root, 'mv', '--', from, to);
      afterMove?.({ from, to });
    }
    for (const path of plan.deletes) git(root, 'rm', '-r', '-q', '--', path);
    for (const rewrite of rewrites) {
      if (!rewrite.changedLinks) continue;
      const destination = moved.get(rewrite.from) ?? rewrite.from;
      writeFileSync(join(root, destination), rewrite.content);
    }
    const remainingLegacyFiles = cleanLegacyFolders(root);
    for (const file of safetyFiles) {
      file.byteIdentical = existsSync(join(root, file.to))
        && safetyContents.get(file.from).equals(readFileSync(join(root, file.to)));
    }
    // 원본 바이트는 이동 전 저장한 값으로 비교한다.
    if (safetyFiles.some((file) => !file.byteIdentical)) throw new Error('안전 상태 파일 대조 실패');
    const remaining = listVaultFiles(root);
    const brokenLinks = collectBrokenLinks(root, remaining);
    const applied = { ...result, brokenLinks, remainingLegacyFiles };
    if (reportPath) writeFileSync(resolve(reportPath), `${JSON.stringify(applied, null, 2)}\n`);
    return applied;
  } catch (error) {
    let recovery = 'success';
    try {
      git(root, 'reset', '-q', '--hard', startHead);
      git(root, 'clean', '-fdq', '--', ...MOUSEION_TOP_FOLDERS);
    } catch (recoveryError) { recovery = `failed: ${recoveryError.message}`; }
    const failed = { ...result, recovery, error: error.message };
    if (reportPath) writeFileSync(resolve(reportPath), `${JSON.stringify(failed, null, 2)}\n`);
    throw new Error(`${error.message}; 복구: ${recovery}`);
  }
}

function parseArgs(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--apply') options.apply = true;
    else if (arg === '--vault' && args[index + 1]) options.vault = args[++index];
    else if (arg === '--report' && args[index + 1]) options.reportPath = args[++index];
    else throw new Error(`알 수 없거나 값이 없는 인자: ${arg}`);
  }
  if (!options.vault) throw new Error('--vault 경로가 필요합니다');
  return options;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { vault, ...options } = parseArgs(process.argv.slice(2));
    console.log(JSON.stringify(migrateVault(vault, options), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
