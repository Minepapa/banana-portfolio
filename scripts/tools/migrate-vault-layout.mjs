#!/usr/bin/env node
// 볼트 2단계 이관을 계획하고, 명시적인 --apply에서만 git 작업 트리를 바꾼다.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, rmdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, normalize, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LEGACY_TO_MOUSEION_RULES, mapLegacyPath, MOUSEION_TOP_FOLDERS } from '../lib/vault-layout.mjs';
import { VAULT_PATHS, VAULT_REL, VAULT_ROOT } from '../lib/vault-paths.mjs';
import { parseFrontmatter } from '../lib/vault-frontmatter.mjs';

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

export function planExplicitMap(paths, entries) {
  if (!Array.isArray(entries)) throw new Error('--map은 JSON 배열이어야 합니다');
  const available = new Set(paths);
  const sources = new Set();
  const moves = [];
  const redirects = [];
  for (const entry of entries) {
    const { from, to, mode } = entry ?? {};
    for (const path of [from, to]) {
      if (typeof path !== 'string' || !path.endsWith('.md') || isAbsolute(path) || path.includes('\\')
        || normalize(path) !== path || path.split('/').some((part) => !part || part === '..' || part === '.')) {
        throw new Error(`--map 경로는 볼트 상대 .md 파일이어야 합니다: ${path}`);
      }
    }
    if (from === to || sources.has(from) || !['move', 'redirect'].includes(mode)) {
      throw new Error(`--map 항목이 중복되거나 잘못됐습니다: ${from}`);
    }
    sources.add(from);
    if (mode === 'move') {
      if (available.has(from)) moves.push({ from, to });
      else if (!available.has(to)) throw new Error(`이동 원본이 없습니다: ${from}`);
    } else {
      if (available.has(from)) throw new Error(`redirect 원본이 아직 존재합니다: ${from}`);
      redirects.push({ from, to });
    }
  }
  const destinations = new Set([...available].filter((path) => !moves.some((move) => move.from === path)));
  const collisions = [];
  for (const { from, to } of moves) {
    const existing = [...destinations].find((path) => path.toLocaleLowerCase('en-US') === to.toLocaleLowerCase('en-US'));
    if (existing) collisions.push({ to, sources: [from, existing] });
    destinations.add(to);
  }
  for (const { from, to } of redirects) {
    if (!destinations.has(to)) throw new Error(`redirect 목적지가 없습니다: ${from} → ${to}`);
  }
  const byDestination = {};
  for (const { to } of moves) byDestination[dirname(to)] = (byDestination[dirname(to)] ?? 0) + 1;
  return { moves, redirects, deletes: [], byDestination, collisions, unresolvedYears: [], unmapped: [],
    yearSources: { filename: 0, frontmatter: 0, gitFirstCommit: 0 }, gitFirstCommitFiles: [] };
}

// 날짜 접두사는 보존하고, 제목의 하이픈은 양옆이 ASCII 영숫자인 경우에만 남긴다.
export function normalizeDatedTitle(filename, dateOnlyTopic = '') {
  const match = /^(\d{4}-\d{2}-\d{2})(.*)\.md$/.exec(filename);
  if (!match) return filename;
  const suffix = match[2];
  if (!suffix && !dateOnlyTopic) return filename;
  if (suffix && !/^[-\s]/.test(suffix)) return filename;
  const title = (suffix || ` ${dateOnlyTopic}`).replace(/-/g, (hyphen, index, value) =>
    /[A-Za-z0-9]/.test(value[index - 1] ?? '') && /[A-Za-z0-9]/.test(value[index + 1] ?? '')
      ? hyphen : ' ').replace(/\s+/g, ' ').trim();
  if (!title) throw new Error(`정규화 후 제목이 비어 있습니다: ${filename}`);
  return `${match[1]} ${title}.md`;
}

function titleScope(path) {
  const parts = path.split('/');
  if ([VAULT_REL.decisionsProfile, VAULT_REL.logSessions].some((folder) =>
    parts[0] === folder.split('/')[0])) return true;
  if ([VAULT_REL.logStrategy, relative(VAULT_ROOT, VAULT_PATHS.log.reports)].some((folder) =>
    path.startsWith(`${folder}/`))) return true;
  return parts[0] === VAULT_REL.logImplementation.split('/')[0] && parts.length >= 4
    && ['Implementation', 'Requests'].includes(parts[2]);
}

export function planTitles(files) {
  const moves = [];
  const telegramFolder = relative(VAULT_ROOT, VAULT_PATHS.log.telegramSession).split('\\').join('/');
  const reportsFolder = relative(VAULT_ROOT, VAULT_PATHS.log.reports).split('\\').join('/');
  for (const { path, content = '' } of files) {
    if (!titleScope(path) || !path.endsWith('.md')) continue;
    const name = basename(path);
    const dateOnly = /^\d{4}-\d{2}-\d{2}\.md$/.test(name);
    let topic = '';
    if (dateOnly && path.startsWith(`${telegramFolder}/`)) {
      topic = '텔레그램 세션 인수인계';
      if (parseFrontmatter(content).type !== 'telegram-session-handoff') {
        throw new Error(`날짜 전용 노트의 type이 인수인계가 아닙니다: ${path}`);
      }
    } else if (dateOnly && path.startsWith(`${reportsFolder}/`)) {
      topic = '주간 리포트';
      if (parseFrontmatter(content).type !== 'weekly-report') {
        throw new Error(`날짜 전용 노트의 type이 주간 리포트가 아닙니다: ${path}`);
      }
    }
    const nextName = normalizeDatedTitle(name, topic);
    if (nextName === name) continue;
    if (/[\x00-\x1f<>:"/\\|?*]/.test(nextName)) {
      throw new Error(`금지 문자가 있는 제목: ${path} → ${nextName}`);
    }
    moves.push({ from: path, to: join(dirname(path), nextName).split('\\').join('/'), mode: 'move' });
  }
  const plan = planExplicitMap(files.map(({ path }) => path), moves);
  if (plan.collisions.length) throw new Error(`제목 경로 충돌 ${JSON.stringify(plan.collisions)}`);
  return { entries: moves, byDestination: plan.byDestination };
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

function visitWikiLinks(content, visit) {
  let fence = null;
  let visible = '';
  let nonFence = '';
  let output = '';
  function flush() {
    let cursor = 0;
    let search = 0;
    for (let start = visible.indexOf('[[', search); start >= 0; start = visible.indexOf('[[', search)) {
      let targetEnd = start + 2;
      while (targetEnd < visible.length && !/[|#^\]\r\n]/.test(visible[targetEnd])) targetEnd += 1;
      const target = visible.slice(start + 2, targetEnd);
      let close = -1;
      if (target && visible.startsWith(']]', targetEnd)) close = targetEnd;
      else if (target && /[|#^]/.test(visible[targetEnd] ?? '')) {
        const candidate = visible.indexOf(']]', targetEnd);
        const suffix = candidate < 0 ? '' : visible.slice(targetEnd, candidate);
        if (candidate >= 0 && !suffix.includes('[[') && !/\r?\n[ \t]*\r?\n/.test(suffix)
          && (!/\r?\n/.test(suffix) || suffix.includes('|'))) close = candidate;
      } else if (target.includes('/') && /\r?\n/.test(visible[targetEnd] ?? '')) {
        const candidate = visible.indexOf(']]', targetEnd);
        const continuation = candidate < 0 ? '' : visible.slice(targetEnd, candidate);
        if (candidate >= 0 && !continuation.includes('[[') && !/\r?\n[ \t]*\r?\n/.test(continuation)) {
          close = candidate;
        }
      }
      if (close < 0) { search = start + 2; continue; }
      const open = start > 0 && visible[start - 1] === '!' ? start - 1 : start;
      const full = visible.slice(open, close + 2);
      output += visible.slice(cursor, open) + visit(full, visible.slice(start + 2, close));
      cursor = close + 2;
      search = cursor;
    }
    output += visible.slice(cursor);
    visible = '';
  }
  function flushText() {
    for (const segment of inlineSegments(nonFence)) {
      if (segment.code) { flush(); output += segment.text; }
      else visible += segment.text;
    }
    nonFence = '';
  }
  for (const line of content.split(/(?<=\n)/)) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker && (!fence || (marker[0] === fence[0] && marker.length >= fence.length))) {
      flushText(); flush(); fence = fence ? null : marker; output += line; continue;
    }
    if (fence) { output += line; continue; }
    nonFence += line;
  }
  flushText();
  flush();
  return output;
}

function replaceMarkdownLinks(text, visit) {
  let output = '';
  let search = 0;
  const openingPattern = /\[[^\]\n]+\]\(/g;
  for (let match = openingPattern.exec(text); match; match = openingPattern.exec(text)) {
    const targetStart = openingPattern.lastIndex;
    const enclosed = text[targetStart] === '<';
    let cursor = targetStart + Number(enclosed);
    let depth = 0;
    while (cursor < text.length) {
      const char = text[cursor];
      if (char === '\n') break;
      if (char === '\\' && /[()]/.test(text[cursor + 1] ?? '')) {
        cursor += 2;
        continue;
      }
      if (enclosed && char === '>') break;
      if (!enclosed && char === '(') depth += 1;
      if (!enclosed && char === ')') {
        if (depth === 0) break;
        depth -= 1;
      }
      cursor += 1;
    }
    const target = text.slice(targetStart + Number(enclosed), cursor).replace(/\\([()])/g, '$1');
    const closingIndex = enclosed ? cursor + 1 : cursor;
    if (text[closingIndex] !== ')' || !/^\.\.?\/[^\n<>]+\.md$/.test(target)) continue;
    const end = closingIndex + 1;
    output += text.slice(search, match.index) + visit(text.slice(match.index, end), match[0], target, ')');
    search = end;
    openingPattern.lastIndex = end;
  }
  return output + text.slice(search);
}

function visitMarkdownLinks(content, visit) {
  let fence = null;
  return content.split(/(?<=\n)/).map((line) => {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker && (!fence || (marker[0] === fence[0] && marker.length >= fence.length))) {
      fence = fence ? null : marker;
      return line;
    }
    if (fence) return line;
    return inlineSegments(line).map((segment) => segment.code ? segment.text
      : replaceMarkdownLinks(segment.text, visit)).join('');
  }).join('');
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
    destinationByBasename.set(nextName, [...new Set([...(destinationByBasename.get(nextName) ?? []), destination])]);
  }
  const renames = new Map(moves.filter(({ from, to }) => from.endsWith('.md') &&
    basename(from, '.md') !== basename(to, '.md'))
    .map(({ from, to }) => [basename(from, '.md'), { from, to }]));
  const wikiRewritten = visitWikiLinks(content, (full, inner) => {
        const open = full.startsWith('!') ? '![[' : '[[';
        const close = ']]';
        const [rawTarget, suffix] = linkParts(inner);
        const trailing = /\\+$/.exec(rawTarget)?.[0] ?? '';
        const target = rawTarget.slice(0, rawTarget.length - trailing.length)
          .replace(/\r?\n\s*/g, '').replace(/\s*\/\s*/g, '/')
          .replace(/\s+/g, ' ');
        const separator = trailing + suffix;
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
        const legacyTarget = !isRelative && !paths.includes(lookup) ? mapLegacyPath(lookup)?.to : null;
        const resolvedTarget = paths.includes(lookup) ? lookup : legacyTarget ?? oldTarget;
        const destination = moved.get(resolvedTarget) ?? resolvedTarget;
        const newSource = moved.get(sourcePath) ?? sourcePath;
        const newTarget = isRelative
          ? relative(dirname(newSource), destination).split('\\').join('/') : destination;
        if (!isRelative && !moved.has(lookup) && !moved.has(oldTarget) && !moved.has(resolvedTarget)) return full;
        const next = hasMd || !newTarget.endsWith('.md') ? newTarget : newTarget.slice(0, -3);
        const relativeNext = isRelative && !next.startsWith('.') ? `./${next}` : next;
        if (isRelative && relativeNext === target) return full;
        changedLinks += 1;
        return `${open}${relativeNext}${separator}${close}`;
  });
  const rewritten = visitMarkdownLinks(wikiRewritten,
    (full, opening, rawTarget, closing) => {
      const oldTarget = normalize(join(dirname(sourcePath), rawTarget)).split('\\').join('/');
      let destination = moved.get(oldTarget);
      if (!destination && !paths.includes(oldTarget)) {
        // 이전 구조를 가리키는 상대 링크도 basename이 유일하면 실제 이동 원본에 연결한다.
        const candidates = moves.filter(({ from }) => basename(from) === basename(oldTarget));
        if (candidates.length === 1) destination = candidates[0].to;
      }
      if (!destination) return full;
      const newSource = moved.get(sourcePath) ?? sourcePath;
      const next = relative(dirname(newSource), destination).split('\\').join('/');
      changedLinks += 1;
      return `${opening}<${next}>${closing}`;
    });
  return { content: rewritten, changedLinks, basenameLinks, basenameChangedLinks,
    deferredBasenameLinks, deletedLinks };
}

export function brokenFullPathLinks(content, existingPaths, sourcePath = '') {
  const existing = new Set(existingPaths);
  const existingBasenames = new Set(existingPaths.filter((path) => path.endsWith('.md'))
    .map((path) => basename(path, '.md')));
  const missing = new Set();
  const legacyRoots = new Set(LEGACY_TO_MOUSEION_RULES.map((rule) => rule.from.split('/')[0]));
  visitWikiLinks(content, (_full, inner) => {
        const [rawTarget] = linkParts(inner);
        const target = rawTarget.replace(/\r?\n\s*/g, '').replace(/\s*\/\s*/g, '/')
          .replace(/\s+/g, ' ').replace(/\\+$/, '');
        if (!target) return _full;
        if (legacyRoots.has(target.split('/')[0])) { missing.add(target); return _full; }
        if (!target.includes('/')) {
          const name = target.endsWith('.md') ? target.slice(0, -3) : target;
          if (!existingBasenames.has(name)) missing.add(target);
          return _full;
        }
        const resolved = target.startsWith('../') || target.startsWith('./')
          ? normalize(join(dirname(sourcePath), target)).split('\\').join('/') : target;
        if (existing.has(resolved) || existing.has(`${resolved}.md`)) return _full;
        if (!target.startsWith('../') && !target.startsWith('./')
          && [...existing].some((path) => path.endsWith(`/${target}`) || path.endsWith(`/${target}.md`))) return _full;
        missing.add(target);
        return _full;
  });
  visitMarkdownLinks(content, (full, _opening, target) => {
    const resolved = normalize(join(dirname(sourcePath), target)).split('\\').join('/');
    if (!existing.has(resolved)) missing.add(target);
    return full;
  });
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

function planLegacyLinkFix(files, paths) {
  const legacyRoots = new Set(LEGACY_TO_MOUSEION_RULES.map((rule) => rule.from.split('/')[0]));
  const mappings = new Map();
  const unresolvedLegacyLinks = [];
  for (const file of files.filter(({ path }) => path.endsWith('.md'))) {
    visitWikiLinks(file.content, (_full, inner) => {
      const [rawTarget] = linkParts(inner);
      const target = rawTarget.replace(/\\+$/, '');
      if (!legacyRoots.has(target.split('/')[0])) return _full;
      const from = target.endsWith('.md') ? target : `${target}.md`;
      const mapping = mapLegacyPath(from);
      let candidates = [];
      if (mapping?.to && mapping.yearFolder) {
        const exactFile = from === mapping.rule.from && extname(mapping.rule.from);
        const base = exactFile ? dirname(mapping.to) : mapping.rule.to;
        const suffix = exactFile ? `/${basename(mapping.to)}` : mapping.to.slice(base.length);
        candidates = paths.filter((path) => {
          const prefix = `${base}/`;
          if (!path.startsWith(prefix)) return false;
          const year = path.slice(prefix.length, prefix.length + 4);
          return /^\d{4}$/.test(year) && path === `${prefix}${year}${suffix}`;
        });
      } else if (mapping?.to && paths.includes(mapping.to)) candidates = [mapping.to];
      if (candidates.length === 1) mappings.set(from, candidates[0]);
      else unresolvedLegacyLinks.push({ file: file.path, target, candidates });
      return _full;
    });
  }
  return { mappings: [...mappings].map(([from, to]) => ({ from, to })), unresolvedLegacyLinks };
}

function expectedLegacyFixedContent(root, path, paths) {
  const original = git(root, 'show', `HEAD:${path}`);
  const { mappings } = planLegacyLinkFix([{ path, content: original }], paths);
  return rewriteLinks(original, mappings, [], [...paths, ...mappings.map(({ from }) => from)], path).content;
}

function allowedMapChanges(root, redirects, paths) {
  const deleted = new Set(redirects.map(({ from }) => from));
  const modified = new Set(redirects.map(({ to }) => to));
  const preserved = new Map();
  const status = git(root, 'status', '--porcelain=v1', '-z', '--untracked-files=all').split('\0').filter(Boolean);
  for (let index = 0; index < status.length; index += 1) {
    const entry = status[index];
    const code = entry.slice(0, 2);
    const path = entry.slice(3);
    if (code.includes('R') || code.includes('C')) index += 1;
    if (code === ' D' && deleted.has(path)) {
      preserved.set(path, null);
    } else if (code === ' M' && modified.has(path)) {
      preserved.set(path, readFileSync(join(root, path)));
    } else if (code === ' M' && path.endsWith('.md')
      && readFileSync(join(root, path), 'utf8') === expectedLegacyFixedContent(root, path, paths)) {
      preserved.set(path, readFileSync(join(root, path)));
    } else {
      throw new Error(`볼트 git 작업 트리가 깨끗하지 않습니다: ${path}`);
    }
  }
  return preserved;
}

function verifyCompletedMapChanges(root, mapEntries) {
  const moves = new Map(mapEntries.filter(({ mode }) => mode === 'move').map(({ from, to }) => [from, to]));
  const movedFromByTo = new Map([...moves].map(([from, to]) => [to, from]));
  const redirectFrom = new Set(mapEntries.filter(({ mode }) => mode === 'redirect').map(({ from }) => from));
  const redirectTo = new Set(mapEntries.filter(({ mode }) => mode === 'redirect').map(({ to }) => to));
  const headPaths = git(root, 'ls-tree', '-r', '--name-only', '-z', 'HEAD').split('\0').filter(Boolean);
  const rewrites = mapEntries.map(({ from, to }) => ({ from, to }));
  const linkSourcePaths = [...new Set([...headPaths, ...redirectFrom])];
  const status = git(root, 'status', '--porcelain=v1', '-z', '--untracked-files=all').split('\0').filter(Boolean);
  for (let index = 0; index < status.length; index += 1) {
    const entry = status[index];
    const code = entry.slice(0, 2);
    const path = entry.slice(3);
    const renamedFrom = code.includes('R') || code.includes('C') ? status[++index] : null;
    const original = movedFromByTo.get(path) ?? path;
    const validMove = movedFromByTo.has(path);
    const validDeletion = moves.has(path) || redirectFrom.has(path);
    const validRename = validMove && renamedFrom === original && code[0] === 'R';
    const validAddition = validMove && code === 'A ';
    const validModification = (code === ' M' || code === 'RM') && path.endsWith('.md');
    if (code === ' D' && validDeletion) continue;
    if (code === ' M' && redirectTo.has(path)) continue;
    if (!validRename && !validAddition && !validModification) {
      throw new Error(`볼트 git 작업 트리가 깨끗하지 않습니다: ${path}`);
    }
    if (!headPaths.includes(original)) throw new Error(`HEAD에 없는 이관 변경: ${path}`);
    const prior = expectedLegacyFixedContent(root, original, headPaths);
    const expected = rewriteLinks(prior, rewrites, [], linkSourcePaths, original).content;
    if (readFileSync(join(root, path), 'utf8') !== expected) {
      throw new Error(`예상한 이관 내용과 다릅니다: ${path}`);
    }
  }
  // 원본만 수동 삭제하고 우연히 있던 목적지를 완료로 오인하지 않도록 이동마다 대조한다.
  // 이미 이관을 커밋했다면 HEAD에 원본이 없으므로 이 검사는 건너뛴다.
  for (const [from, to] of moves) {
    if (!headPaths.includes(from)) continue;
    const prior = expectedLegacyFixedContent(root, from, headPaths);
    const expected = rewriteLinks(prior, rewrites, [], linkSourcePaths, from).content;
    if (!existsSync(join(root, to)) || readFileSync(join(root, to), 'utf8') !== expected) {
      throw new Error(`이동 목적지가 원본과 다릅니다: ${from} → ${to}`);
    }
  }
}

export function migrateVault(vault, { apply = false, reportPath, afterMove, mapPath, planTitlesPath, fixLegacyLinks = false } = {}) {
  const root = resolve(vault);
  if (planTitlesPath && (apply || mapPath || fixLegacyLinks)) {
    throw new Error('--plan-titles는 --apply, --map, --fix-legacy-links와 함께 쓸 수 없습니다');
  }
  if (fixLegacyLinks && mapPath) throw new Error('--fix-legacy-links와 --map은 함께 쓸 수 없습니다');
  if (!existsSync(root) || !statSync(root).isDirectory()) throw new Error(`볼트 디렉토리가 없습니다: ${root}`);
  const paths = listVaultFiles(root);
  const files = paths.map((path) => ({ path, content: path.endsWith('.md') ? readFileSync(join(root, path), 'utf8') : '' }));
  if (planTitlesPath) {
    const titles = planTitles(files);
    writeFileSync(resolve(planTitlesPath), `${JSON.stringify(titles.entries, null, 2)}\n`);
    return { moveCount: titles.entries.length, byDestination: titles.byDestination, collisions: [] };
  }
  const mapEntries = mapPath ? JSON.parse(readFileSync(resolve(mapPath), 'utf8')) : null;
  const plan = mapPath
    ? planExplicitMap(paths, mapEntries)
    : fixLegacyLinks ? { moves: [], deletes: [], byDestination: {}, yearSources: {}, gitFirstCommitFiles: [],
      unresolvedYears: [], unmapped: [], collisions: [] }
      : planMigration(files, (path) => gitFirstCommitYear(root, path));
  const legacyFix = fixLegacyLinks ? planLegacyLinkFix(files, paths) : { mappings: [], unresolvedLegacyLinks: [] };
  const rewritesFor = [...plan.moves, ...(plan.redirects ?? []), ...legacyFix.mappings];
  const linkSourcePaths = [...paths, ...(plan.redirects ?? []).map(({ from }) => from),
    ...legacyFix.mappings.map(({ from }) => from)];
  const rewrites = files.filter(({ path }) => path.endsWith('.md') && !plan.deletes.includes(path))
    .map((file) => ({ from: file.path, ...rewriteLinks(file.content, rewritesFor, plan.deletes, linkSourcePaths, file.path) }));
  const linkFiles = rewrites.filter((entry) => entry.changedLinks > 0).length;
  const linkCount = rewrites.reduce((count, entry) => count + entry.changedLinks, 0);
  const moved = new Map([...plan.moves, ...(plan.redirects ?? [])].map(({ from, to }) => [from, to]));
  const remainingPlanned = paths.filter((path) => !plan.deletes.includes(path))
    .map((path) => moved.get(path) ?? path);
  const plannedBrokenLinks = rewrites.flatMap((entry) => {
    const destination = moved.get(entry.from) ?? entry.from;
    return brokenFullPathLinks(entry.content, remainingPlanned, destination)
      .map((target) => ({ file: destination, target }));
  });
  const unresolvedKeys = new Set(legacyFix.unresolvedLegacyLinks
    .map(({ file, target }) => `${file}\0${target}`));
  const unexpectedBroken = (links) => links.filter(({ file, target }) => !unresolvedKeys.has(`${file}\0${target}`));
  const safetyPaths = [VAULT_PATHS.state.killSwitch, VAULT_PATHS.state.executionMode,
    VAULT_PATHS.state.proposalMode].map((absolute) => relative(VAULT_ROOT, absolute).split('\\').join('/'));
  const safetyFiles = safetyPaths.flatMap((to) => paths
    .filter((from) => from === to || (!mapPath && mapLegacyPath(from)?.to === to))
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
    moves: plan.moves, redirects: plan.redirects ?? [], deletes: plan.deletes,
    plannedBrokenLinks, unresolvedLegacyLinks: legacyFix.unresolvedLegacyLinks, safetyFiles,
  };
  if (!apply) return result;
  if (realpathSync(git(root, 'rev-parse', '--show-toplevel').trim()) !== realpathSync(root)) {
    throw new Error(`--vault는 git 작업 트리 루트여야 합니다: ${root}`);
  }
  if (plan.unmapped.length || plan.collisions.length || plan.unresolvedYears.length
    || (mapPath && result.deferredBasenameLinks.length)
    || unexpectedBroken(plannedBrokenLinks).length) {
    throw new Error(`이관 사전 검사 실패: 매핑 없음 ${plan.unmapped.length}, 충돌 ${plan.collisions.length}, 연도 미결정 ${plan.unresolvedYears.length}, 모호한 basename 링크 ${result.deferredBasenameLinks.length}, 적용 후 깨진 링크 ${plannedBrokenLinks.length}`);
  }
  if (fixLegacyLinks && git(root, 'status', '--porcelain').trim()) {
    throw new Error('볼트 git 작업 트리가 깨끗하지 않습니다');
  }
  // 작업이 끝난 볼트는 첫 실행의 미커밋 이동이 남아 있어도 재실행이 무작업이어야 한다.
  if (!plan.moves.length && !plan.deletes.length && !linkCount) {
    if (mapPath) verifyCompletedMapChanges(root, mapEntries);
    const tracked = new Set(git(root, 'ls-files', '-z').split('\0').filter(Boolean));
    for (const file of safetyFiles) {
      file.tracked = tracked.has(file.from);
      file.byteIdentical = existsSync(join(root, file.to))
        && safetyContents.get(file.from).equals(readFileSync(join(root, file.to)));
    }
    if (safetyFiles.some((file) => !file.tracked || !file.byteIdentical)) {
      throw new Error('안전 상태 파일 대조 실패');
    }
    const remainingLegacyFiles = mapPath || fixLegacyLinks ? [] : cleanLegacyFolders(root);
    const brokenLinks = collectBrokenLinks(root, paths);
    if (unexpectedBroken(brokenLinks).length) throw new Error(`적용 후 깨진 링크 ${brokenLinks.length}`);
    const completed = { ...result, brokenLinks, remainingLegacyFiles };
    if (reportPath) writeFileSync(resolve(reportPath), `${JSON.stringify(completed, null, 2)}\n`);
    return completed;
  }
  const preserved = mapPath ? allowedMapChanges(root, plan.redirects, paths) : new Map();
  if (!mapPath && git(root, 'status', '--porcelain').trim()) throw new Error('볼트 git 작업 트리가 깨끗하지 않습니다');
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
    const remainingLegacyFiles = mapPath || fixLegacyLinks ? [] : cleanLegacyFolders(root);
    for (const file of safetyFiles) {
      file.byteIdentical = existsSync(join(root, file.to))
        && safetyContents.get(file.from).equals(readFileSync(join(root, file.to)));
    }
    // 원본 바이트는 이동 전 저장한 값으로 비교한다.
    if (safetyFiles.some((file) => !file.byteIdentical)) throw new Error('안전 상태 파일 대조 실패');
    const remaining = listVaultFiles(root);
    const brokenLinks = collectBrokenLinks(root, remaining);
    if (unexpectedBroken(brokenLinks).length) throw new Error(`적용 후 깨진 링크 ${brokenLinks.length}`);
    const applied = { ...result, brokenLinks, remainingLegacyFiles };
    if (reportPath) writeFileSync(resolve(reportPath), `${JSON.stringify(applied, null, 2)}\n`);
    return applied;
  } catch (error) {
    let recovery = 'success';
    try {
      git(root, 'reset', '-q', '--hard', startHead);
      if (mapPath || fixLegacyLinks) {
        for (const [path, content] of preserved) {
          if (content === null) rmSync(join(root, path), { force: true });
          else writeFileSync(join(root, path), content);
        }
        for (const { to } of plan.moves) {
          let folder = dirname(to);
          while (folder !== '.' && existsSync(join(root, folder)) && readdirSync(join(root, folder)).length === 0) {
            rmdirSync(join(root, folder));
            folder = dirname(folder);
          }
        }
      } else git(root, 'clean', '-fdq', '--', ...MOUSEION_TOP_FOLDERS);
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
    else if (arg === '--map' && args[index + 1]) options.mapPath = args[++index];
    else if (arg === '--plan-titles' && args[index + 1]) options.planTitlesPath = args[++index];
    else if (arg === '--fix-legacy-links') options.fixLegacyLinks = true;
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
