#!/usr/bin/env node
// 테미스 판정 원장 CLI — 원장(95_Etna/Themis/verdicts.jsonl)에 쓰는 유일한 길.
// 제우스가 테미스 하위 에이전트의 판정을 받으면 기록한다. 판정 자체는 테미스가 내리고, 이 도구는 형식 검사 후 남기기만 한다.
//   append: stdin으로 판정 JSON 한 건 → 저장한 줄을 출력
//     {"subject":"…","requestedBy":"zeus","verdict":"통과|보류|거부","kind":"주문 제안|미디어 삭제|결정 문서|돌파 사후|기타",
//      "reasons":"…","refs":["40_Projects/…/노트","banana-portfolio-v2@abc1234"]}
//   list [--limit=N]: 최근 판정(읽기만)
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { appendVerdict, readVerdicts } from '../lib/themis-verdict-ledger.mjs';

// 명령마다 허용한 --키만 받는다(오타 --limt=5가 조용히 무시되지 않게).
const ALLOWED_ARGS = { append: new Set(), list: new Set(['limit']) };
// 기록 중 죽은 락은 state-writer가 10초 뒤 회수한다 — 그보다 길게 기다린다(50ms × 300 = 15초).
const CLI_LOCK_OPTIONS = { retries: 300, retryDelayMs: 50 };

export function parseArgs(argv, allowed = new Set()) {
  const result = {};
  for (const arg of argv) {
    const match = arg.match(/^--([a-z-]+)=(.*)$/s);
    if (!match || !allowed.has(match[1])) throw new Error(`알 수 없는 인자: ${arg}`);
    result[match[1]] = match[2];
  }
  return result;
}

export async function run(command, argv, { stdin = () => readFileSync(0, 'utf8'), path } = {}) {
  if (!Object.hasOwn(ALLOWED_ARGS, command ?? '')) throw new Error('사용법: themis-verdict-cli.mjs append < 판정.json | list [--limit=N]');
  const args = parseArgs(argv, ALLOWED_ARGS[command]);
  const options = { lockOptions: CLI_LOCK_OPTIONS, ...(path ? { path } : {}) };
  if (command === 'append') {
    const input = stdin();
    if (!input.trim()) throw new Error('stdin으로 판정 JSON을 전달하세요.');
    let parsed;
    try { parsed = JSON.parse(input); } catch { throw new Error('판정 JSON을 읽을 수 없다'); }
    return appendVerdict(parsed, options);
  }
  if (command === 'list') {
    const limit = args.limit === undefined ? 20 : Number(args.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error('--limit은 1~500');
    return readVerdicts(path).slice(-limit);
  }
  throw new Error('사용법: themis-verdict-cli.mjs append < 판정.json | list [--limit=N]');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [command, ...argv] = process.argv.slice(2);
  run(command, argv)
    .then((value) => process.stdout.write(`${JSON.stringify(value)}\n`))
    .catch((error) => { process.stderr.write(`[themis-verdict] ${error.message}\n`); process.exitCode = 1; });
}
