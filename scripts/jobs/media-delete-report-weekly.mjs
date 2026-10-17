#!/usr/bin/env node
// 결정 미디어-삭제-판정 §4: 4주 관찰용 보고. 미디어 원본은 읽기만 한다.
// launchctl kickstart 검증은 실제 발송을 막도록 --no-send로 실행한다.
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { main as measureQuality } from '../tools/media-quality-measure.mjs';
import { main as buildDeleteReport } from '../tools/media-delete-report.mjs';
import { MEDIA_RECORDINGS_PATHS, VAULT_PATHS, VAULT_REL, categoryLink } from '../lib/vault-paths.mjs';
import { buildFrontmatter } from '../lib/vault-frontmatter.mjs';
import { checkNote, parseRegistry } from '../lib/vault-registry.mjs';
import { writeAtomic } from '../lib/state-writer.mjs';
import { sendAgentMessage } from '../lib/pantheon-send.mjs';

const SENDER_AGENT = 'themis';
const MEASURE_LIMIT = 100;

export function parseArgs(args) {
  const options = { dryRun: false, noSend: false };
  for (const arg of args) {
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--no-send') options.noSend = true;
    else throw new Error(`지원 옵션: --dry-run, --no-send (${arg})`);
  }
  return options;
}

export function reportMessage(summary, path) {
  return { agent: SENDER_AGENT, topic: '미디어 삭제 후보 주간 관찰', kind: '정보',
    body: `후보 ${summary.candidateItems}건 · ${summary.candidateBytes}바이트\n리포트: ${path}\n원본 처리 없음` };
}

export function writeWeeklyReport({ day, markdown, summary }, {
  root = VAULT_PATHS.root, registryPath = join(VAULT_PATHS.root, VAULT_REL.registryFile),
  write = writeAtomic } = {}) {
  const path = join(root, VAULT_REL.logReports, day.slice(0, 4), `${day} 미디어 삭제 후보 주간 관찰.md`);
  if (existsSync(path)) return { path, created: false, day };
  const content = buildFrontmatter({ type: 'report', reportKind: 'media-delete-weekly',
    category: [categoryLink('500 기술')], description: '미디어 삭제 후보 관찰 리포트',
    sensitivity: '일반', created: day, modified: day, author: SENDER_AGENT, model: 'node' })
    + markdown.replace(/개별 행과 연사 대표\/나머지는 같은 날짜 JSONL에 기록했다\.\n/,
      '원본은 옮기거나 지우지 않았다.\n');
  const errors = checkNote(relative(root, path), content,
    parseRegistry(readFileSync(registryPath, 'utf8')));
  if (errors.length) throw new Error(`리포트 등록부 위반: ${errors.join('; ')}`);
  mkdirSync(resolve(path, '..'), { recursive: true });
  write(path, content);
  return { path, created: true, day, summary };
}

export async function runWeekly(args = [], { measure = measureQuality,
  report = buildDeleteReport, save = writeWeeklyReport, send = sendAgentMessage,
  output = console, stateRoot = join(MEDIA_RECORDINGS_PATHS.mediaRoot, 'DeleteReport') } = {}) {
  const options = parseArgs(args);
  const measureArgs = [`--limit=${MEASURE_LIMIT}`, ...(options.dryRun ? ['--dry-run'] : [])];
  measure(measureArgs);
  if (options.dryRun) {
    const summary = report(['--dry-run']);
    output.log(JSON.stringify({ dryRun: true, ...summary }));
    return summary;
  }
  let saved;
  let reportDay;
  const summary = report([], { writer: (result) => { reportDay = result.day; saved = save(result); } });
  if (!saved) throw new Error('리포트 저장 결과 없음');
  output.log(JSON.stringify({ report: saved.path, created: saved.created, ...summary }));
  const sentPath = join(stateRoot, `${reportDay}.sent.json`);
  if (!options.noSend && !existsSync(sentPath)) {
    await send(reportMessage(summary, saved.path));
    mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
    writeAtomic(sentPath, `${JSON.stringify({ report: saved.path, sentAt: new Date().toISOString() })}\n`);
  }
  return summary;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runWeekly(process.argv.slice(2)).catch((error) => { console.error(error); process.exitCode = 1; });
}
