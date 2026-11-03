#!/usr/bin/env node
/**
 * 보유(Holdings) ↔ 체결 원장 재생 대조 — 하루 1회 읽기 전용 감시(데이터 체계 개선 ⑥, 2026-11-03).
 *
 * 판정은 lib/holdings-ledger-recon.mjs(순수 함수, 헤더에 기준점 설계·불변식). 이 잡은 볼트를 읽고,
 * 기준점 상태 파일(볼트 밖)을 갱신하고, 이상이 있으면 플루토스 명의 경고를 하루 1회 보낸다.
 *
 * ⚠️ 읽기 전용: Holdings·Ledger를 절대 고치지 않는다. 볼트에 아무것도 쓰지 않는다.
 *   - 결과 파일을 볼트에 남기는 기능은 없다. 새 볼트 경로는 오너 승인 사항이라 후보만 제안했다
 *     (95_Etna/Jobs 아래, 상세는 구현 보고). 실행 기록은 launchd 로그에만 남는다.
 *   - 기준점 상태: ~/.cache/banana-portfolio-v2/holdings-ledger-anchors.json(볼트 밖).
 *     첫 실행에서 종목마다 "보유 − Σ체결"(암묵 기초)을 저장하고, 이후 그 값과 비교한다.
 *     상태 파일이 사라지면 다음 실행이 다시 기준점을 잡는다(그날은 과거 어긋남을 못 본다).
 *   - 하루 1회 억제 상태: ~/.cache/banana-portfolio-v2/holdings-ledger-alerts.json(볼트 밖).
 *
 * 사용법:
 *   node scripts/jobs/reconcile-holdings-ledger.mjs                 # 대조 + 기준점 저장 + 이상 시 경고
 *   node scripts/jobs/reconcile-holdings-ledger.mjs --dry-run       # 계산·로그만(상태 파일 쓰기·발송 없음)
 *   node scripts/jobs/reconcile-holdings-ledger.mjs --anchors=<json> # 기초 잔고를 파일로 지정(읽기만, 기준점 저장 안 함)
 *   node scripts/jobs/reconcile-holdings-ledger.mjs --rebaseline    # 원장·보유를 바로잡은 뒤 기준점을 지금 값으로 다시 잡음
 */
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { VAULT_PATHS } from '../lib/vault-paths.mjs';
import { parseFrontmatter } from '../lib/vault-frontmatter.mjs';
import { writeAtomic, withLock } from '../lib/state-writer.mjs';
import { decideRevertAlert, recordRevertAlert } from '../lib/holdings-revert-check.mjs';
import { sendAgentMessage, renderAgentMessage } from '../lib/pantheon-send.mjs';
import { createDirectWarningSender, warningSubjectKey } from '../lib/direct-warning-delivery.mjs';
import {
  replayHoldings, diffHoldings, findExecutionDuplicates, classifyExecutionFilename, FILENAME_RULES,
  selectAlertIssues, hasAlertIssues, alertSignature, buildReconMessage, formatQty, fundPurchaseAsExecution, nextAnchors,
} from '../lib/holdings-ledger-recon.mjs';

const JOB_NAME = 'reconcile-holdings-ledger';
const STATE_DIR = join(homedir(), '.cache', 'banana-portfolio-v2');
export const ANCHORS_FILE = join(STATE_DIR, 'holdings-ledger-anchors.json');
const ALERT_STATE_FILE = join(STATE_DIR, 'holdings-ledger-alerts.json');

function readRecords(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => name.endsWith('.md')).map((filename) => ({
    ...parseFrontmatter(readFileSync(join(dir, filename), 'utf8')), filename,
  }));
}

export function readAnchorState(file) {
  if (!existsSync(file)) return null;
  const parsed = JSON.parse(readFileSync(file, 'utf8'));
  if (!parsed || typeof parsed.anchors !== 'object') throw new Error(`기준점 파일 형식 오류: ${file}`);
  return parsed;
}

function parseArgs(argv) {
  const args = { dryRun: false, rebaseline: false, anchorsFile: null };
  for (const arg of argv) {
    if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--rebaseline') args.rebaseline = true;
    else if (arg.startsWith('--anchors=')) args.anchorsFile = arg.slice('--anchors='.length);
    // 모르는 인자로 실제 실행이 돌지 않게 막는다(데몬을 --help로 떠보다 실행된 2026-10-31 사고).
    else throw new Error(`알 수 없는 인자: ${arg} — 사용법은 파일 헤더 참고`);
  }
  if (args.anchorsFile && args.rebaseline) throw new Error('--anchors와 --rebaseline은 함께 쓸 수 없음');
  return args;
}

function logReport({ rows, replay, duplicates, filenameCounts, unknownFilenames, anchorsLabel }) {
  console.log(`🔎 보유↔원장 재생 대조 — 기준점: ${anchorsLabel}`);
  console.log(`   대조 ${rows.length}종목 · 반영 체결 ${[...replay.rows.values()].reduce((sum, row) => sum + row.ledgerCount, 0)}건 · 미반영 ${replay.pending.length}건 · 계좌 미확정 ${replay.unassigned.length}건 · 보유 미기록 계좌(퀀트) ${replay.notInHoldings}건`);
  const counts = rows.reduce((acc, row) => ({ ...acc, [row.status]: (acc[row.status] ?? 0) + 1 }), {});
  console.log(`   상태: ${Object.entries(counts).map(([status, n]) => `${status} ${n}`).join(' · ')}`);
  for (const row of rows.filter((item) => item.status !== 'ok')) {
    console.log(`   - [${row.status}] ${row.key} 기대 ${formatQty(row.expected)} 실제 ${formatQty(row.actual)} 차이 ${formatQty(row.diff)} (원장 ${row.ledgerCount}건 합 ${formatQty(row.ledgerNet)}, 암묵 기초 ${formatQty(row.impliedOpening)}, 기준점 ${row.anchor == null ? '없음' : formatQty(row.anchor)}, 이력 최저 ${formatQty(row.minRunning)})`);
  }
  for (const record of replay.pending) {
    console.log(`   - [미반영${record.stale ? '·하루 넘음' : ''}] ${record.filename}`);
  }
  for (const dup of duplicates.confirmed) console.log(`   - [중복:${dup.reason}] ${dup.records.map((r) => r.filename).join(' / ')}`);
  for (const dup of duplicates.suspected) console.log(`   - [중복 의심:${dup.reason}] ${dup.records.map((r) => r.filename).join(' / ')}`);
  console.log(`   파일명 규칙: ${Object.entries(filenameCounts).map(([rule, n]) => `${FILENAME_RULES[rule]} ${n}`).join(' · ')}`);
  for (const filename of unknownFilenames) console.log(`   - [파일명 규칙 밖] ${filename}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const executions = readRecords(VAULT_PATHS.facts.ledger.executions);
  const fundPurchases = readRecords(VAULT_PATHS.facts.ledger.fundPurchases).map(fundPurchaseAsExecution);
  const holdings = readRecords(VAULT_PATHS.state.holdings);

  const previous = args.anchorsFile ? null : readAnchorState(ANCHORS_FILE);
  const anchors = args.anchorsFile
    ? JSON.parse(readFileSync(args.anchorsFile, 'utf8'))
    : (args.rebaseline ? {} : (previous?.anchors ?? {}));
  const anchorsLabel = args.anchorsFile ? `지정 파일 ${args.anchorsFile}`
    : args.rebaseline ? '다시 잡기(--rebaseline)'
      : previous ? `상태 파일(${Object.keys(previous.anchors).length}종목, ${previous.updatedAt})` : '없음(첫 실행 — 지금 값으로 잡음)';

  const replay = replayHoldings([...executions, ...fundPurchases], anchors, { holdings });
  const rows = diffHoldings(replay);
  const duplicates = findExecutionDuplicates(executions);
  const filenameCounts = {};
  const unknownFilenames = [];
  for (const record of executions) {
    const rule = classifyExecutionFilename(record.filename, record);
    filenameCounts[rule] = (filenameCounts[rule] ?? 0) + 1;
    if (rule === 'unknown') unknownFilenames.push(record.filename);
  }
  logReport({ rows, replay, duplicates, filenameCounts, unknownFilenames, anchorsLabel });

  // 지정 파일 기준점은 사람이 주는 일회성 값이라 상태로 저장하지 않는다.
  const anchorsExisted = Boolean(args.anchorsFile) || (!args.rebaseline && previous != null);
  if (!args.anchorsFile) {
    const { state, seeded } = nextAnchors(rows, previous, { rebaseline: args.rebaseline });
    if (seeded) console.log(`   기준점 새로 잡음 ${seeded}종목${args.dryRun ? ' (드라이런 — 저장 안 함)' : ''}`);
    if (!args.dryRun && (seeded || args.rebaseline)) {
      mkdirSync(STATE_DIR, { recursive: true });
      writeAtomic(ANCHORS_FILE, `${JSON.stringify(state, null, 2)}\n`);
    }
  }

  const issues = selectAlertIssues({ rows, duplicates, pending: replay.pending, anchorsExisted });
  if (!hasAlertIssues(issues)) {
    console.log('✅ 알릴 이상 없음');
    return;
  }
  const message = buildReconMessage(issues);
  if (args.dryRun) {
    console.log('\n(드라이런 — 경고 발송 생략, 미리보기)\n');
    console.log(renderAgentMessage(message));
    return;
  }
  const subjectKey = warningSubjectKey('holdings-ledger', alertSignature(issues));
  const sendWarning = createDirectWarningSender(sendAgentMessage, {
    jobName: JOB_NAME, warningCode: 'HOLDINGS_LEDGER_MISMATCH', kind: 'data-quality', severity: 'high',
  });
  mkdirSync(dirname(ALERT_STATE_FILE), { recursive: true });
  // 같은 이상 묶음은 KST 하루 1회. 기록은 발송(또는 아침 보류 큐 등록) 성공 뒤에만 한다.
  await withLock(ALERT_STATE_FILE, async () => {
    let state = null;
    try { state = JSON.parse(readFileSync(ALERT_STATE_FILE, 'utf8')); } catch { state = null; }
    const { send, today } = decideRevertAlert(state, subjectKey);
    if (!send) {
      console.log('   (같은 이상은 오늘 이미 알림 — 발송 생략)');
      return;
    }
    await sendWarning(message, { subjectKey });
    try {
      writeAtomic(ALERT_STATE_FILE, `${JSON.stringify(recordRevertAlert(state, subjectKey, today))}\n`);
    } catch (error) {
      console.error(`   ⚠️  경고는 보냈으나 하루 1회 억제 기록 실패 — 다음 실행에서 다시 보낼 수 있음: ${error.message}`);
    }
  }, { retries: 300, retryDelayMs: 100 });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error('\n❌ 오류:', error.message); process.exit(1); });
}
