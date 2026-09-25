import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, basename } from 'node:path';

export const STATUS_RULES = [
  { path: 'Log/Implementation', allowed: ['예정', '진행중', '차단됨', '완료', '보류', '폐기'] },
  { path: 'Log/DevRequests', allowed: ['예정', '진행중', '차단됨', '완료', '보류', '폐기'] },
  { path: 'Knowledge', allowed: ['활성', '비활성', '진행중', '탐색지도', '대체됨'] },
  { path: 'Decisions/Proposals', allowed: ['대기', '승인', '거부', '대체됨', '체결', '섀도우체결'] },
  { path: 'Decisions/Profile', allowed: ['관찰', '승격후보', '확정', '기각'] },
  { path: 'Log/Strategy', allowed: ['결정됨', '실행대기', '보류', '대체됨'] },
];
export const ID_RULE_PATHS = ['State/BreakoutPositions', 'State/BreakoutPendingEntries'];

export function parseFlatFrontmatter(text) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return null;
  const fields = {};
  for (const line of match[1].split(/\r?\n/)) {
    const m = line.match(/^([\w-]+):\s*(.*?)\s*$/);
    if (m) fields[m[1]] = m[2].replace(/^(["'])(.*)\1$/, '$2');
  }
  return fields;
}

export function validateStatus(value, allowed) {
  if (typeof value !== 'string' || !value || value.length > 40 || /[\r\n]/.test(value)) return false;
  return allowed.includes(value);
}

export function stripCode(text) {
  return text.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, (block) => '\n'.repeat((block.match(/\n/g) || []).length))
    .replace(/`+[^`\n]*`+/g, (inline) => ' '.repeat(inline.length));
}

export function extractWikiLinks(text) {
  const clean = stripCode(text);
  const links = [];
  const malformed = [];
  let cursor = 0;
  while (cursor < clean.length) {
    const open = clean.indexOf('[[', cursor);
    if (open < 0) break;
    const close = clean.indexOf(']]', open + 2);
    const nextOpen = clean.indexOf('[[', open + 2);
    if (close < 0 || (nextOpen >= 0 && nextOpen < close)) {
      malformed.push(clean.slice(open, nextOpen >= 0 ? nextOpen : Math.min(clean.length, open + 120)).trim());
      cursor = nextOpen >= 0 ? nextOpen : clean.length;
      continue;
    }
    const raw = clean.slice(open + 2, close).replace(/\\\|/g, '|').replace(/\s*\/\s*/g, '/').replace(/\s+/g, ' ').trim();
    links.push(raw.split('|')[0].split('#')[0].trim());
    cursor = close + 2;
  }
  return { links, malformed };
}

export function resolveWikiTarget(target, files) {
  const normalized = target.replace(/\\/g, '/').replace(/^\//, '').replace(/\.md$/i, '');
  return files.some((entry) => {
    const f = typeof entry === 'string' ? entry : entry.path;
    const rel = f.replace(/\\/g, '/').replace(/\.md$/i, '');
    const aliases = typeof entry === 'string' ? [] : entry.aliases ?? [];
    return rel === normalized || basename(rel) === normalized || basename(rel) === normalized.split('/').at(-1)
      || aliases.some((alias) => alias === normalized || alias === normalized.split('/').at(-1));
  });
}

export function findIdMismatches(records) {
  return records.filter(({ filename, id }) => id && basename(filename, '.md') !== id);
}

export function findExecutionDuplicates(records) {
  const groups = new Map();
  for (const record of records) {
    const fields = parseFlatFrontmatter(record.text) ?? {};
    const values = ['tradeDate', 'tradeType', 'stockName', 'quantity'].map((key) => fields[key]);
    if (values.some((v) => v == null || v === '')) continue;
    values[0] = values[0].slice(0, 10); // tradeDate 시각은 제외하고 날짜 단위 비교
    const key = JSON.stringify(values);
    groups.set(key, [...(groups.get(key) ?? []), record.path]);
  }
  return [...groups.values()].filter((paths) => paths.length > 1);
}

function walk(dir) {
  if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? walk(path) : entry.isFile() && entry.name.endsWith('.md') ? [path] : [];
  });
}

export function auditVault(root, repoRoot) {
  const errors = [];
  const allFiles = walk(root);
  const relFiles = allFiles.map((file) => {
    const text = readFileSync(file, 'utf8');
    const fm = parseFlatFrontmatter(text);
    const aliasesMatch = text.match(/^aliases:\s*\[([^\]]*)\]\s*$/m);
    const aliases = aliasesMatch ? [...aliasesMatch[1].matchAll(/(?:^|,)\s*["']?([^,"']+)["']?\s*(?=,|$)/g)].map((m) => m[1].trim()) : [];
    return { path: relative(root, file), aliases: [...aliases, ...(fm?.aliases ? [fm.aliases] : [])] };
  });
  for (const { path, allowed } of STATUS_RULES) {
    for (const file of walk(join(root, path))) {
      const fm = parseFlatFrontmatter(readFileSync(file, 'utf8'));
      if (fm?.status != null && !validateStatus(fm.status, allowed)) errors.push(`${relative(root, file)}: invalid status ${JSON.stringify(fm.status)}`);
    }
  }
  for (const folder of ID_RULE_PATHS) {
    for (const file of walk(join(root, folder))) {
      const fm = parseFlatFrontmatter(readFileSync(file, 'utf8'));
      if (fm?.id && basename(file, '.md') !== fm.id) errors.push(`${relative(root, file)}: filename does not match id ${fm.id}`);
    }
  }
  for (const file of allFiles) {
    const text = readFileSync(file, 'utf8');
    const { links, malformed } = extractWikiLinks(text);
    for (const link of malformed) errors.push(`${relative(root, file)}: malformed wiki link ${link}`);
    for (const link of links) if (!resolveWikiTarget(link, relFiles)) errors.push(`${relative(root, file)}: unresolved wiki link [[${link}]]`);
  }
  const failed = walk(join(root, 'State/BreakoutPositions')).filter((file) => /protectionStatus:\s*["']?failed["']?/i.test(readFileSync(file, 'utf8')));
  const executions = walk(join(root, 'Facts/Ledger/Executions')).map((path) => ({ path: relative(root, path), text: readFileSync(path, 'utf8') }));
  const duplicates = findExecutionDuplicates(executions);
  const policyFiles = ['scripts/lib/order-candidates.mjs', 'scripts/lib/behavior-signals.mjs'];
  for (const file of policyFiles) {
    const text = readFileSync(join(repoRoot, file), 'utf8');
    if (/RULE500_WON/.test(text)) errors.push(`${file}: RULE500_WON regression`);
  }
  return { errors, failedPositions: failed.map((f) => relative(root, f)), executionDuplicates: duplicates };
}
