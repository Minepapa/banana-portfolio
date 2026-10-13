#!/usr/bin/env node
// 원장 원문은 보존하고 나중 기록의 연결 머리말만 추가하는 일회성 도구.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { findEquivalentExecutions } from '../lib/execution-identity.mjs';
import { writeAtomic } from '../lib/state-writer.mjs';
import { parseFrontmatter } from '../lib/vault-frontmatter.mjs';
import { VAULT_PATHS } from '../lib/vault-paths.mjs';

function readExecutions(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => name.endsWith('.md')).map((name) => {
    const filepath = join(dir, name);
    const content = readFileSync(filepath, 'utf8');
    return { ...parseFrontmatter(content), filepath, content, name };
  });
}

// These six unsourced legacy pairs were verified in the 2026-10-13 request.
// Unknown unsourced rows have no defensible provenance and stay untouched.
const VERIFIED_LEGACY_PAIRS = [
  ['2026-08-06-092837-매수-TIGER-리츠부동산인프라.md', '2026-08-06-9_28_37-매수-TIGER-리츠부동산인프라-r81.md'],
  ['2026-09-03-000000-매도-TIGER-리츠부동산인프라TOP10액티브-1-769683.md', '2026-09-03-130050-매도-TIGER-리츠부동산인프라TOP10액티브-1.md'],
  ['2026-09-04-000000-매수-금-99.99K-1-2344110.md', '2026-09-04-113357-매수-금-99.99K-1.md'],
  ['2026-09-10-000000-매수-금-99.99K-1-3765906.md', '2026-09-10-125536-매수-금-99.99K-1.md'],
  ['2026-09-21-000000-매도-TIGER-리츠부동산인프라TOP10액티브-49-847026.md', '2026-09-21-141047-매도-TIGER-리츠부동산인프라TOP10액티브-49.md'],
  ['2026-09-23-000000-매도-TIGER-리츠부동산인프라TOP10액티브-100-296789.md', '2026-09-23-091342-매도-TIGER-리츠부동산인프라TOP10액티브-100.md'],
];
const VERIFIED_LEGACY_SOURCE = new Map(VERIFIED_LEGACY_PAIRS.flatMap(([nh, kakao]) =>
  [[nh, 'NH_API'], [kakao, 'KAKAO']]));

export function insertDuplicateOf(content, stem) {
  const closing = content.indexOf('\n---\n', 4);
  if (!content.startsWith('---\n') || closing < 0) throw new Error('머리말 경계를 찾을 수 없음');
  if (/^duplicateOf:/m.test(content.slice(4, closing))) throw new Error('이미 duplicateOf 있음');
  return `${content.slice(0, closing)}\nduplicateOf: ${JSON.stringify(stem)}${content.slice(closing)}`;
}

export function planDuplicateMarks(records) {
  const actions = [];
  const skipped = [];
  const pathSource = (record) => record.source || VERIFIED_LEGACY_SOURCE.get(record.name) || null;
  const neighbors = new Map(records.map((record) => [record.filepath, findEquivalentExecutions(record,
    records.filter((other) => other.filepath !== record.filepath && pathSource(record)
      && pathSource(other) && pathSource(other) !== pathSource(record)))]));
  const visited = new Set();
  for (const record of records) {
    if (visited.has(record.filepath)) continue;
    const matches = neighbors.get(record.filepath);
    if (!matches.length) continue;
    const group = [];
    const queue = [record];
    while (queue.length) {
      const current = queue.shift();
      if (group.some((item) => item.filepath === current.filepath)) continue;
      group.push(current);
      queue.push(...neighbors.get(current.filepath));
    }
    group.forEach((item) => visited.add(item.filepath));
    if (group.length !== 2 || group.some((item) => neighbors.get(item.filepath).length !== 1)) {
      skipped.push({ names: group.map((item) => item.name), reason: '후보가 둘 이상' });
      continue;
    }
    const [first, second] = group;
    const firstTime = Date.parse(first.recordedAt ?? '');
    const secondTime = Date.parse(second.recordedAt ?? '');
    if (!Number.isFinite(firstTime) || !Number.isFinite(secondTime) || firstTime === secondTime) {
      skipped.push({ names: group.map((item) => item.name), reason: 'recordedAt 없음 또는 시각 동률' });
      continue;
    }
    const earlier = firstTime < secondTime ? first : second;
    const later = firstTime < secondTime ? second : first;
    const earlierStem = basename(earlier.name, '.md');
    if (group.some((item) => item.duplicateOf)) {
      skipped.push({ names: group.map((item) => item.name), reason: '이미 duplicateOf 표시됨' });
      continue;
    }
    actions.push({ earlier, later, earlierStem });
  }
  return { actions, skipped };
}

export function markDuplicateExecutions(dir, { apply = false, log = console.log } = {}) {
  const { actions, skipped } = planDuplicateMarks(readExecutions(dir));
  for (const { earlier, later, earlierStem } of actions) {
    log(`${earlier.name} -> ${later.name}: duplicateOf=${earlierStem}${apply ? ' [적용]' : ' [dry-run]'}`);
    if (apply) {
      writeAtomic(later.filepath, insertDuplicateOf(later.content, earlierStem));
    }
  }
  for (const item of skipped) log(`건너뜀 (${item.reason}): ${item.names.join(' / ')}`);
  log(`쌍 ${actions.length}개, 건너뜀 ${skipped.length}개`);
  return { actions, skipped };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args.some((arg) => !['--apply', '--dry-run'].includes(arg)) || (args.includes('--apply') && args.includes('--dry-run'))) {
    throw new Error('사용법: node scripts/tools/mark-duplicate-executions.mjs [--dry-run|--apply]');
  }
  markDuplicateExecutions(VAULT_PATHS.facts.ledger.executions, { apply: args.includes('--apply') });
}
