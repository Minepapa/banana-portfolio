#!/usr/bin/env node
// PreToolUse: 금고 경로와 해제 장치에 대한 에이전트 도구 접근을 막는다.
import { existsSync, realpathSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { VAULT_ROOT, VAULT_REL } from '../lib/vault-paths.mjs';
import { isTelegramChannel } from '../lib/telegram-channel-env.mjs';

const VAULT_DIR = resolve(VAULT_ROOT, VAULT_REL.adytonRoot);
const UNLOCK_FILE = process.env.ADYTON_UNLOCK_FILE ||
  join(homedir(), '.config', 'banana-portfolio-v2', 'adyton-unlock.json');
const OWNER_HINT = '오너가 본 세션에서 `! node scripts/tools/adyton-unlock.mjs 15m`으로 열 수 있음';
const VAULT_NAME = /99_adyton/i;
const UNLOCK_NAME = /adyton-unlock(?:\.json|\.mjs)?/i;
// 정적 검사이므로 셸 변수로 만든 경로와 간접 실행은 해석하지 못한다.
const RECURSIVE_BASH_COMMANDS = [
  /(?:^|[;&|\s])(?:grep|egrep)\s+(?:[^;&|]*?\s)?(?:-[A-Za-z]*[rR][A-Za-z]*|--recursive)(?=\s|$)/,
  /(?:^|[;&|\s])rg\s+[^;&|]*(?:--no-ignore(?:-[\w-]+)?|--hidden|(?<!\S)-u{1,3}(?=\s|$))/,
  /(?:^|[;&|\s])find\s+[^;&|]*(?:-exec\b|-print0\s*\|\s*xargs\b[^;&|]*(?:cat|head|tail|less|grep|egrep|rg)\b)/,
  /(?:^|[;&|\s])(?:cat|head|tail|less)\s+[^;&|]*(?:\*\*|\*\/\*)/,
  /(?:^|[;&|\s])cp\s+(?:[^;&|]*?\s)?(?:-[A-Za-z]*[rRa][A-Za-z]*|--recursive)(?=\s|$)/,
  /(?:^|[;&|\s])(?:rsync|tar|zip|ditto)(?=\s|$)/,
  /(?:^|[;&|\s])ls\s+(?:[^;&|]*?\s)?(?:-[A-Za-z]*R[A-Za-z]*|--recursive)(?=\s|$)/,
];

// 존재하지 않는 파일도 기존 상위 폴더의 심볼릭 링크를 풀어 판정한다.
function realPath(filePath) {
  let current = resolve(filePath);
  const missing = [];
  while (!existsSync(current)) {
    missing.unshift(basename(current));
    const parent = dirname(current);
    if (parent === current) return current;
    current = parent;
  }
  return join(realpathSync.native(current), ...missing);
}

function realPathOrResolved(filePath) {
  try { return realPath(filePath); } catch { return resolve(filePath); }
}

const REAL_VAULT_DIR = realPathOrResolved(VAULT_DIR);
const UNLOCK_SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'tools', 'adyton-unlock.mjs');
const REAL_UNLOCK_FILE = realPathOrResolved(UNLOCK_FILE);
const REAL_UNLOCK_SCRIPT = realPathOrResolved(UNLOCK_SCRIPT);

function inside(candidate, root) {
  const rel = relative(root, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function pathForCheck(value, cwd) {
  const expanded = value.startsWith('~/') ? join(homedir(), value.slice(2)) : value;
  return isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
}

function isVaultPath(value, cwd) {
  if (VAULT_NAME.test(value)) return true;
  try {
    const candidate = pathForCheck(value, cwd);
    return inside(candidate, VAULT_DIR) || inside(realPath(candidate), REAL_VAULT_DIR);
  } catch {
    // 경로 확인 중 실패했다면 금고 문자열에 대한 위 판정은 이미 적용됐다.
    return false;
  }
}

function searchCanReachVault(value, cwd) {
  try {
    // 글롭 이후는 실제 경로가 아니므로 그 앞의 디렉터리를 검사한다.
    const globAt = value.search(/[?*\[]/);
    const literal = globAt < 0 ? value : value.slice(0, globAt);
    const path = globAt < 0 || literal.endsWith('/') ? literal : dirname(literal);
    const candidate = pathForCheck(path, cwd);
    return inside(VAULT_DIR, candidate) || inside(REAL_VAULT_DIR, realPath(candidate));
  } catch {
    return false;
  }
}

function isUnlockTarget(value, cwd) {
  try {
    const candidate = realPath(pathForCheck(value, cwd));
    return candidate === REAL_UNLOCK_FILE || candidate === REAL_UNLOCK_SCRIPT;
  } catch {
    return false;
  }
}

function stringsForTool(toolName, input) {
  if (toolName === 'Read' || toolName === 'Write' || toolName === 'Edit' || toolName === 'NotebookEdit') {
    return [input?.file_path, input?.notebook_path].filter((v) => typeof v === 'string');
  }
  if (toolName === 'Grep') return [input?.path, input?.glob, input?.pattern].filter((v) => typeof v === 'string');
  if (toolName === 'Glob') return [input?.path, input?.pattern].filter((v) => typeof v === 'string');
  if (toolName === 'Bash') return [input?.command].filter((v) => typeof v === 'string');
  return [JSON.stringify(input), ...nestedStrings(input)];
}

function nestedStrings(value) {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(nestedStrings);
  if (value && typeof value === 'object') return Object.values(value).flatMap(nestedStrings);
  return [];
}

function commandPaths(command) {
  // 쉘 인용부호 안의 공백은 경로 일부이고, 붙어 있는 인용 구간은 한 인자다.
  // 완전한 쉘 해석기는 아니지만 실제 인자 모양을 보존해 링크 별칭을 판정한다.
  const words = [];
  let word = '';
  let quote = null;
  let escaped = false;
  for (const char of command) {
    if (escaped) { word += char; escaped = false; continue; }
    if (char === '\\' && quote !== "'") { escaped = true; continue; }
    if (quote) {
      if (char === quote) quote = null;
      else word += char;
    } else if (char === "'" || char === '"') {
      quote = char;
    } else if (/[\s;|&<>()]/.test(char)) {
      if (word) words.push(word);
      word = '';
    } else {
      word += char;
    }
  }
  if (word) words.push(word);
  return words;
}

function commandOperands(words, valueOptions = []) {
  const operands = [];
  let patternOption = false;
  for (let index = 1; index < words.length; index++) {
    const word = words[index];
    if (valueOptions.includes(word)) {
      if (word === '-e' || word === '--regexp' || word === '-f' || word === '--file') patternOption = true;
      index++;
    } else if (!word.startsWith('-') || word === '-') {
      operands.push(word);
    }
  }
  return { operands, patternOption };
}

function recursiveTargets(words) {
  const command = words[0];
  if (command === 'rg' || command === 'grep' || command === 'egrep') {
    const { operands, patternOption } = commandOperands(words,
      ['-e', '--regexp', '-f', '--file', '-g', '--glob', '--iglob', '-t', '--type']);
    return patternOption ? operands : operands.slice(1);
  }
  if (command === 'cp') return commandOperands(words).operands.slice(0, -1);
  if (command === 'find') return words.slice(1).filter((word) => !word.startsWith('-')).slice(0, 1);
  if (command === 'head' || command === 'tail') {
    return commandOperands(words, ['-n', '--lines', '-c', '--bytes']).operands;
  }
  return commandOperands(words).operands;
}

function inspectBashCommand(command, cwd) {
  let commandCwd = cwd;
  let readsParent = false;
  let explicitVault = false;
  for (const segment of command.split(/\s*(?:&&|\|\||;)\s*/)) {
    const words = commandPaths(segment);
    if (words.some((word) => isVaultPath(word, commandCwd))) explicitVault = true;
    if (words[0] === 'cd' && words[1]) {
      commandCwd = pathForCheck(words[1], commandCwd);
      continue;
    }
    if (!RECURSIVE_BASH_COMMANDS.some((pattern) => pattern.test(segment))) continue;
    const targets = recursiveTargets(words);
    if (targets.length ? targets.some((target) => searchCanReachVault(target, commandCwd)) :
      searchCanReachVault(commandCwd, commandCwd)) readsParent = true;
  }
  return { readsParent, explicitVault };
}

function unlocked() {
  try {
    const state = JSON.parse(readFileSync(UNLOCK_FILE, 'utf8'));
    return typeof state.expiresAt === 'string' && Date.parse(state.expiresAt) > Date.now();
  } catch {
    return false;
  }
}

export function decide({ toolName, toolInput, cwd = process.cwd(), telegram = false, isUnlocked = unlocked() }) {
  const values = stringsForTool(toolName, toolInput);
  const raw = values.join(' ');
  const candidates = toolName === 'Bash' ? values.flatMap(commandPaths) : values;
  if (UNLOCK_NAME.test(raw) || candidates.some((value) => UNLOCK_NAME.test(value) || isUnlockTarget(value, cwd))) {
    return { block: true, reason: '금고 해제 명령·상태 파일은 에이전트 도구로 실행하거나 변경할 수 없습니다.' };
  }
  const bash = toolName === 'Bash' ? inspectBashCommand(raw, cwd) : null;
  if (!bash?.readsParent && !bash?.explicitVault &&
      !(toolName !== 'Bash' && candidates.some((value) => isVaultPath(value, cwd)))) {
    return { block: false };
  }
  if (!telegram && isUnlocked) return { block: false };
  const reason = telegram ? '텔레그램 세션은 금고 해제 중에도 접근할 수 없습니다.' : '금고 접근이 잠겨 있습니다.';
  return { block: true, reason: `${reason} ${OWNER_HINT}` };
}

let rawInput = '';
async function main() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
    rawInput += chunk.toString('utf8');
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    if (VAULT_NAME.test(raw) || UNLOCK_NAME.test(raw)) {
      process.stderr.write(`금고 관련 도구 입력을 해석할 수 없어 차단했습니다. ${OWNER_HINT}\n`);
      process.exitCode = 2;
    }
    return;
  }
  const decision = decide({
    toolName: data.tool_name || data.toolName || '',
    toolInput: data.tool_input || data.toolInput || {},
    cwd: data.cwd || process.cwd(),
    // 상시 세션과 관문 헤드리스 실행 모두 해제 중에도 막는다(telegram-channel-env.mjs).
    telegram: isTelegramChannel(),
  });
  if (decision.block) {
    process.stderr.write(`${decision.reason}\n`);
    process.exitCode = 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    if (VAULT_NAME.test(rawInput) || UNLOCK_NAME.test(rawInput)) {
      process.stderr.write(`금고 접근 훅 오류로 차단했습니다: ${error.message}\n`);
      process.exitCode = 2;
    }
  });
}
