// 보유↔원장 재생 대조 잡의 실행 흐름(인자 해석·기준점 저장·하루 1회 억제·발송) — 주입 가능한 형태.
//
// 잡 진입점(scripts/jobs/reconcile-holdings-ledger.mjs)은 볼트를 읽어 이 함수에 넘기고, 상태 디렉터리와
// 발송 함수를 주입한다. 진입점은 vault-paths를 import 시점에 읽어 테스트가 정적 import할 수 없으므로
// 흐름 전체를 여기 두고 테스트는 이 모듈만 부른다. 볼트 경로는 vaultFile 하나만 주입받는다(테스트는 임시 폴더).
//
// 불변식:
//   - Holdings·Ledger에 쓰지 않는다. 쓰는 곳은 stateDir(볼트 밖) 아래 기준점·억제 파일과 vaultFile(볼트 사본)뿐이다.
//   - 정본 기준점은 stateDir 파일이다. vaultFile(95_Etna/Jobs/HoldingsLedgerRecon.json, 2026-11-04 오너 승인)은
//     기준점과 마지막 대조 요약의 백업·열람용 사본이다. 정본이 없고 사본에 기준점이 있을 때만 사본에서 복원한다 —
//     상태 파일이 사라졌다고 기준점을 조용히 지금 값으로 다시 잡으면 그동안 쌓인 차이가 묻히기 때문이다.
//   - vaultFile은 generatedAt 말고 바뀐 것이 있을 때만 쓴다(write-if-changed.mjs, LiveSync 복제 줄이기).
//   - 미리보기 모드(--dry-run 또는 --anchors)는 어떤 파일도 쓰지 않고 어떤 발송도 하지 않는다(볼트 사본도 안 쓴다).
//   - 테스트(NODE_TEST_CONTEXT) 중 vaultFile이 실볼트 아래면 아무것도 하기 전에 거부한다.
//   - 기준점 파일을 덮어쓰기 전에는 항상 타임스탬프 백업을 남기고, 바뀐 종목마다 "이전 → 새"를 로그에 남긴다.
//   - 종목 단위 재설정 키가 하나라도 거부되면 아무것도 쓰지 않고 실패한다(부분 적용 금지).
//   - 같은 이상 묶음 경고는 KST 하루 1회. 억제 기록은 발송(또는 아침 보류 큐 등록) 성공 뒤에만 남긴다.
//   - 위탁 해외주식 외부 대사(보유 ↔ NH 해외주식 잔고, holdings-gb-balance-recon.mjs, 2026-11-04 제우스)는 원장 대조·
//     기준점 저장·원장 경고가 다 끝난 뒤의 덧붙임 단계다. 조회 실패·빈 응답·구조 이상·내부 오류는 '외부 대사 건너뜀'
//     (사유 포함)으로 기록만 하고 던지지 않는다 — 원장 대조 결과·기준점·원장 경고에 영향 0. NH 조회는 주입받은
//     fetchGbBalance 한 번뿐이고, 미리보기(--dry-run·--anchors)·기준점 재설정에서는 부르지 않는다.
//     --external-dry-run만 조회하되 쓰기·발송은 미리보기와 같이 하지 않는다.
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { withLock, writeAtomic } from './state-writer.mjs';
import { assertNotRealVaultInTest, writeIfChanged } from './write-if-changed.mjs';
import { renderAgentMessage } from './pantheon-send.mjs';
import {
  replayHoldings, diffHoldings, findExecutionDuplicates, classifyExecutionFilename, FILENAME_RULES,
  selectAlertIssues, hasAlertIssues, alertSignature, buildReconMessage, buildAnchorSummaryMessage,
  formatQty, fundPurchaseAsExecution, planAnchors,
} from './holdings-ledger-recon.mjs';
import {
  reconcileGbBalance, buildGbSummary, hasGbAlertIssues, gbAlertSignature, buildGbReconMessage, kstDay as gbKstDay,
} from './holdings-gb-balance-recon.mjs';

export const ANCHORS_FILENAME = 'holdings-ledger-anchors.json';
export const ALERTS_FILENAME = 'holdings-ledger-alerts.json';
// 위탁 해외주식 게시 대기 시작일(볼트 밖 상태 — 2영업일 판정 재료).
export const GB_PENDING_FILENAME = 'holdings-gb-balance-pending.json';
// NH 잔고 조회 전체 제한 시간. 원장 사본·원장 경고가 외부 대사 뒤에 이어지므로 NH가 응답을 붙잡아도 이만큼만 늦어진다
// (잡은 각 HTTP 요청에도 따로 제한을 건다 — 여기는 재시도까지 포함한 마지막 안전망).
export const GB_FETCH_TIMEOUT_MS = 90_000;
export const VAULT_COPY_SCHEMA_VERSION = 1;

export function parseReconArgs(argv) {
  const args = { dryRun: false, externalDryRun: false, anchorsFile: null, rebaselineKeys: [], rebaselineAll: false };
  for (const arg of argv) {
    if (arg === '--dry-run') args.dryRun = true;
    // 미리보기 + NH 해외주식 잔고 실조회(쓰기·발송 없음).
    else if (arg === '--external-dry-run') { args.dryRun = true; args.externalDryRun = true; }
    else if (arg === '--rebaseline-all') args.rebaselineAll = true;
    else if (arg.startsWith('--anchors=')) {
      const file = arg.slice('--anchors='.length).trim();
      if (!file) throw new Error('--anchors= 뒤에 파일 경로가 없음');
      args.anchorsFile = file;
    } else if (arg.startsWith('--rebaseline=')) {
      const key = arg.slice('--rebaseline='.length).trim();
      if (!key.includes('|') || key.startsWith('|') || key.endsWith('|')) throw new Error(`--rebaseline=계좌|종목 형식이 아님: ${arg}`);
      args.rebaselineKeys.push(key);
    } else if (arg === '--rebaseline') {
      throw new Error('전 종목 재설정은 --rebaseline-all, 종목 단위는 --rebaseline=계좌|종목');
    } else {
      // 모르는 인자로 실제 실행이 돌지 않게 막는다(데몬을 --help로 떠보다 실행된 2026-10-31 사고).
      throw new Error(`알 수 없는 인자: ${arg} — 사용법은 잡 파일 헤더 참고`);
    }
  }
  if (args.anchorsFile && (args.rebaselineAll || args.rebaselineKeys.length)) {
    throw new Error('--anchors와 기준점 재설정은 함께 쓸 수 없음');
  }
  if (args.rebaselineAll && args.rebaselineKeys.length) throw new Error('--rebaseline-all과 --rebaseline=은 함께 쓸 수 없음');
  if (args.externalDryRun && (args.anchorsFile || args.rebaselineAll || args.rebaselineKeys.length)) {
    throw new Error('--external-dry-run은 --anchors·기준점 재설정과 함께 쓸 수 없음');
  }
  return args;
}

// holdings-revert-check decideRevertAlert·recordRevertAlert와 같은 규칙(그 모듈은 vault-paths를 끌어와 여기서 import하지 않는다).
function kstDay(now) {
  return new Date(now.getTime() + 9 * 3_600_000).toISOString().slice(0, 10);
}
export function decideDailyAlert(state, subjectKey, now = new Date()) {
  const today = kstDay(now);
  return { send: state?.sent?.[subjectKey] !== today, today };
}
export function recordDailyAlert(state, subjectKey, today) {
  const kept = Object.fromEntries(Object.entries(state?.sent ?? {}).filter(([, day]) => day === today));
  return { sent: { ...kept, [subjectKey]: today } };
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

// 볼트 사본에서 기준점을 읽는다. 없거나 기준점이 비어 있으면 null.
// 사본이 있는데 깨졌거나 형식이 틀리면 던진다 — 상태 파일도 없는 날 조용히 지금 값으로 다시 잡으면 그동안 쌓인 차이가
// 묻히고 깨진 사본까지 덮어써 단서가 사라진다(조용한 폴백 금지). 오너가 확인한 뒤 --rebaseline-all로만 다시 잡는다.
function readVaultAnchors(vaultFile, { allowBroken = false, logError }) {
  if (!vaultFile || !existsSync(vaultFile)) return null;
  const refuse = (reason) => {
    const message = `상태 파일이 없고 볼트 사본(${vaultFile})을 복원할 수 없음 — ${reason}. 확인 뒤 --rebaseline-all로 다시 잡을 것`;
    if (!allowBroken) throw new Error(message);
    logError(`   ⚠️  ${message} (--rebaseline-all이라 계속)`);
    return null;
  };
  let copy;
  try { copy = readJson(vaultFile); } catch (error) { return refuse(`읽기 실패: ${error.message}`); }
  const anchors = copy?.anchors;
  const valid = anchors && typeof anchors === 'object' && !Array.isArray(anchors)
    && Object.values(anchors).every((value) => typeof value === 'number' && Number.isFinite(value));
  if (!valid) return refuse('기준점 형식이 맞지 않음');
  if (Object.keys(anchors).length === 0) return null;
  return { version: 1, updatedAt: copy.anchorsUpdatedAt ?? copy.generatedAt ?? null, anchors };
}

// 볼트 사본 내용. generatedAt만 매번 바뀌고 나머지는 대조 결과가 같으면 같다(비교 키에서 generatedAt을 뺀다).
export function buildVaultCopy({ anchorsState, anchorsUpdatedAt, rows, issues, held, heldReasons, nowIso, externalRecon = null }) {
  const statusCounts = {};
  for (const row of rows) statusCounts[row.status] = (statusCounts[row.status] ?? 0) + 1;
  const sortedCounts = Object.fromEntries(Object.keys(statusCounts).sort().map((status) => [status, statusCounts[status]]));
  return {
    schemaVersion: VAULT_COPY_SCHEMA_VERSION,
    generatedAt: nowIso,
    anchorsUpdatedAt,
    anchors: anchorsState.anchors,
    lastRecon: {
      rowCount: rows.length,
      statusCounts: sortedCounts,
      issues: [
        ...issues.quantityIssues.map((row) => ({
          type: 'quantity', key: row.key, status: row.status, cause: row.cause ?? null,
          expected: row.expected ?? null, actual: row.actual ?? null, diff: row.diff ?? null,
        })),
        ...issues.confirmedDuplicates.map((dup) => ({ type: 'duplicate', reason: dup.reason, files: dup.records.map((r) => r.filename ?? r.dedupKey) })),
        ...issues.stalePending.map((record) => ({ type: 'stale-pending', file: record.filename ?? record.dedupKey })),
      ],
      held: held.map((key) => ({ key, reason: heldReasons[key] ?? null })),
    },
    // 위탁 해외주식 보유 ↔ NH 잔고 외부 대사 요약(buildGbSummary). 원장 대조와 별개 칸.
    externalRecon,
  };
}

// 비교 키는 실행 시각(generatedAt·외부 대사 checkedAt)만 뺀다 — 결과가 같으면 쓰지 않게.
export function vaultCopyCompareKey(text) {
  const { generatedAt, externalRecon, ...rest } = JSON.parse(text);
  if (externalRecon && typeof externalRecon === 'object') {
    const { checkedAt, ...externalRest } = externalRecon;
    return JSON.stringify({ ...rest, externalRecon: externalRest });
  }
  return JSON.stringify({ ...rest, externalRecon: externalRecon ?? null });
}

// 위탁 해외주식 보유 ↔ NH 잔고 외부 대사 단계. 무엇이 실패해도 던지지 않고 { summary, result }로 돌려준다.
// 실운영에서 판정이 된 날만 게시 대기 상태 파일을 쓴다(건너뛴 날·미리보기는 쓰지 않는다).
async function runGbBalanceStage({ args, fetchGbBalance, gbFetchTimeoutMs, holdings, executions, stateDir, now, preview, log, logError }) {
  const checkedAt = now.toISOString();
  const skip = (reason) => {
    log(`   외부 대사(위탁 해외주식 ↔ NH 잔고) 건너뜀: ${reason}`);
    return { summary: { checkedAt, status: 'skipped', reason }, result: { status: 'skipped', reason } };
  };
  const rebaseline = args.rebaselineAll || args.rebaselineKeys.length > 0;
  if (!args.externalDryRun && preview) return skip('미리보기 실행(NH 조회 안 함)');
  if (rebaseline) return skip('기준점 재설정 실행(NH 조회 안 함)');
  if (typeof fetchGbBalance !== 'function') return skip('NH 잔고 조회 함수 없음');
  try {
    let body;
    try {
      let timer;
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error(`${gbFetchTimeoutMs}ms 안에 응답 없음`), { code: 'TIMEOUT' })), gbFetchTimeoutMs);
      });
      try { body = await Promise.race([fetchGbBalance(), timeout]); } finally { clearTimeout(timer); }
    } catch (error) {
      logError(`   ⚠️  NH 해외주식 잔고 조회 실패(원장 대조와 무관): ${error.message}`);
      // 볼트 사본에는 단계와 코드만 남긴다(응답 원문은 로그에만).
      const detail = error.code ?? error.status ?? null;
      return skip(`NH 조회 실패${error.stage ? `(${error.stage})` : ''}${detail != null ? ` — ${detail}` : ''}`);
    }
    const pendingFile = join(stateDir, GB_PENDING_FILENAME);
    let pendingState = null;
    let pendingStateReset = false;
    if (existsSync(pendingFile)) {
      try {
        pendingState = readJson(pendingFile);
        if (!pendingState || typeof pendingState.pending !== 'object' || pendingState.pending == null || Array.isArray(pendingState.pending)) throw new Error('형식이 맞지 않음');
      } catch (error) {
        // 시작일을 잃으면 경고가 늦어질 뿐 거짓 경고는 나지 않는다 — 오늘부터 다시 세고 사본에 표시한다.
        logError(`   ⚠️  게시 대기 상태 파일을 읽지 못함 — 시작일을 오늘부터 다시 셈: ${error.message}`);
        pendingState = null;
        pendingStateReset = true;
      }
    }
    const today = gbKstDay(now);
    const result = reconcileGbBalance({ holdings, executions, body, pendingState, today });
    if (result.status !== 'ok') return skip(result.reason);
    log(`   외부 대사(위탁 해외주식 ↔ NH 잔고): 비교 ${result.compared}종목 · 일치 ${result.matched.length} · 게시 대기 ${result.pending.length} · 차이 ${result.mismatches.length}`);
    for (const item of result.pending) {
      log(`   - [게시 대기] ${item.key} 보유 ${formatQty(item.holdingsQty ?? 0)} NH ${formatQty(item.nhQty)} (매수 대기 ${formatQty(item.buyPending)} · 매도 대기 ${formatQty(item.sellPending)}, ${item.since}부터 평일 ${item.businessDays}일)`);
    }
    for (const item of result.mismatches) {
      log(`   - [수량 차이${item.side ? `:${item.side}` : ''}] ${item.key} 보유 ${item.holdingsQty == null ? '없음' : formatQty(item.holdingsQty)} NH ${item.nhQty == null ? '없음' : formatQty(item.nhQty)}`);
    }
    const summary = { ...buildGbSummary(result, checkedAt), ...(pendingStateReset ? { pendingStateReset: true } : {}) };
    if (!preview) {
      try {
        const next = `${JSON.stringify({ ...result.nextPendingState, updatedAt: checkedAt }, null, 2)}\n`;
        const prevPending = pendingState ? JSON.stringify(pendingState.pending) : null;
        if (prevPending !== JSON.stringify(result.nextPendingState.pending)) {
          mkdirSync(stateDir, { recursive: true });
          writeAtomic(pendingFile, next);
        }
      } catch (error) {
        logError(`   ⚠️  게시 대기 상태 파일 쓰기 실패(대조·경고는 계속): ${error.message}`);
      }
    }
    return { summary, result };
  } catch (error) {
    logError(`   ⚠️  외부 대사 내부 오류(원장 대조와 무관): ${error.message}`);
    return skip(`외부 대사 내부 오류: ${error.message}`);
  }
}

function logReport(log, { rows, replay, duplicates, filenameCounts, unknownFilenames, anchorsLabel }) {
  log(`🔎 보유↔원장 재생 대조 — 기준점: ${anchorsLabel}`);
  log(`   대조 ${rows.length}종목 · 반영 체결 ${[...replay.rows.values()].reduce((sum, row) => sum + row.ledgerCount, 0)}건 · 미반영 ${replay.pending.length}건 · 계좌 미확정 ${replay.unassigned.length}건 · 보유 미기록 계좌(퀀트) ${replay.notInHoldings}건 · 현금성 키 제외 ${replay.cashLikeSkipped}건`);
  const counts = rows.reduce((acc, row) => ({ ...acc, [row.status]: (acc[row.status] ?? 0) + 1 }), {});
  log(`   상태: ${Object.entries(counts).map(([status, n]) => `${status} ${n}`).join(' · ')}`);
  for (const row of rows.filter((item) => item.status !== 'ok')) {
    log(`   - [${row.status}${row.cause ? `:${row.cause}` : ''}] ${row.key} 기대 ${formatQty(row.expected)} 실제 ${formatQty(row.actual)} 차이 ${formatQty(row.diff)} (원장 ${row.ledgerCount}건 합 ${formatQty(row.ledgerNet)}, 암묵 기초 ${formatQty(row.impliedOpening)}, 기준점 ${row.anchor == null ? '없음' : formatQty(row.anchor)}, 이력 최저 ${formatQty(row.minRunning)})`);
  }
  for (const record of replay.pending) log(`   - [미반영${record.stale ? '·하루 넘음' : ''}] ${record.filename}`);
  for (const dup of duplicates.confirmed) log(`   - [중복:${dup.reason}] ${dup.records.map((r) => r.filename).join(' / ')}`);
  for (const dup of duplicates.suspected) log(`   - [중복 의심:${dup.reason}] ${dup.records.map((r) => r.filename).join(' / ')}`);
  log(`   파일명 규칙: ${Object.entries(filenameCounts).map(([rule, n]) => `${FILENAME_RULES[rule]} ${n}`).join(' · ')}`);
  for (const filename of unknownFilenames) log(`   - [파일명 규칙 밖] ${filename}`);
}

// sendWarning(message, signature): 경고 발송(호출부가 경고 원장·보류 큐를 거치게 감싼다).
// sendInfo(message): 기준점 첫 설정 정보성 요약 발송.
// vaultFile: 볼트 사본 경로(없으면 볼트 사본을 읽지도 쓰지도 않는다).
// fetchGbBalance(): NH 해외주식 잔고 응답(getGbBalance 본문)을 돌려주는 함수. 없으면 외부 대사를 건너뛴다.
export async function runHoldingsLedgerRecon({
  args, executions, fundPurchases = [], holdings, stateDir, vaultFile = null, sendWarning, sendInfo, fetchGbBalance = null,
  gbFetchTimeoutMs = GB_FETCH_TIMEOUT_MS,
  log = console.log, logError = console.error, now = new Date(),
}) {
  if (vaultFile) assertNotRealVaultInTest(vaultFile);
  const preview = args.dryRun || Boolean(args.anchorsFile);
  const anchorsFile = join(stateDir, ANCHORS_FILENAME);
  const alertsFile = join(stateDir, ALERTS_FILENAME);
  const result = { wroteAnchors: false, backupFile: null, sentWarning: false, sentInfo: false, suppressed: false,
    restoredFromVault: false, wroteVaultCopy: false, vaultCopyError: null,
    externalRecon: null, sentGbWarning: false, gbSuppressed: false, gbAlertError: null };

  let previous = args.anchorsFile ? null : (existsSync(anchorsFile) ? readJson(anchorsFile) : null);
  if (previous && (typeof previous.anchors !== 'object' || previous.anchors == null)) throw new Error(`기준점 파일 형식 오류: ${anchorsFile}`);
  if (!args.anchorsFile && previous == null) {
    previous = readVaultAnchors(vaultFile, { allowBroken: args.rebaselineAll, logError });
    result.restoredFromVault = previous != null;
  }
  const anchors = args.anchorsFile ? readJson(args.anchorsFile) : (args.rebaselineAll ? {} : (previous?.anchors ?? {}));
  const anchorsLabel = args.anchorsFile ? `지정 파일 ${args.anchorsFile}(미리보기 — 쓰기·발송 없음)`
    : args.rebaselineAll ? '전 종목 다시 잡기(--rebaseline-all)'
      : result.restoredFromVault ? `볼트 사본에서 복원(상태 파일 없음, ${Object.keys(previous.anchors).length}종목, ${previous.updatedAt})`
        : previous ? `상태 파일(${Object.keys(previous.anchors).length}종목, ${previous.updatedAt})` : '없음(첫 실행 — 지금 값으로 잡음)';

  const ledger = [...executions, ...fundPurchases.map(fundPurchaseAsExecution)];
  const replay = replayHoldings(ledger, anchors, { holdings, now: now.getTime() });
  let rows = diffHoldings(replay);
  const duplicates = findExecutionDuplicates(executions);
  const filenameCounts = {};
  const unknownFilenames = [];
  for (const record of executions) {
    const rule = classifyExecutionFilename(record.filename, record);
    filenameCounts[rule] = (filenameCounts[rule] ?? 0) + 1;
    if (rule === 'unknown') unknownFilenames.push(record.filename);
  }
  logReport(log, { rows, replay, duplicates, filenameCounts, unknownFilenames, anchorsLabel });

  // 중복 의심이 걸린 종목은 기준점을 잡지 않는다(의심이 진짜면 틀린 값이 굳는다).
  const heldReasons = {};
  for (const dup of duplicates.suspected) for (const record of dup.records) heldReasons[replay.keyOf(record)] = `중복 의심(${dup.reason})`;
  const heldKeys = new Set(Object.keys(heldReasons));

  let plan = null;
  if (!args.anchorsFile) {
    plan = planAnchors({ rows, previous, heldKeys, rebaselineKeys: args.rebaselineKeys, rebaselineAll: args.rebaselineAll, nowIso: now.toISOString() });
    if (plan.rejected.length) {
      for (const item of plan.rejected) logError(`   ❌ 재설정 거부: ${item.key} — ${item.reason}`);
      throw new Error(`기준점 재설정 거부 ${plan.rejected.length}건 — 아무것도 저장하지 않음`);
    }
    for (const change of plan.changes) {
      log(`   기준점 ${change.key}: ${change.before == null ? '없음' : formatQty(change.before)} → ${change.after == null ? '없음' : formatQty(change.after)}`);
    }
    for (const key of plan.held) log(`   기준점 보류 ${key}: ${heldReasons[key]}`);
    if (plan.seeded.length) log(`   기준점 새로 잡음 ${plan.seeded.length}종목${preview ? ' (미리보기 — 저장 안 함)' : ''}`);
    // 볼트 사본에서 복원한 날은 바뀐 것이 없어도 상태 파일(정본)을 되살린다.
    if (!preview && (plan.changes.length || result.restoredFromVault)) {
      if (result.restoredFromVault) log(`   기준점 복원: 볼트 사본 → ${anchorsFile}`);
      mkdirSync(stateDir, { recursive: true });
      if (existsSync(anchorsFile)) {
        result.backupFile = join(stateDir, `${ANCHORS_FILENAME.replace(/\.json$/, '')}.${now.toISOString().replace(/[:.]/g, '-')}.json`);
        copyFileSync(anchorsFile, result.backupFile);
        log(`   기준점 백업: ${result.backupFile}`);
      }
      // 복원만 한 날(바뀐 기준점 없음)은 원래 기준점 시각을 지킨다 — 언제 잡은 기준점인지 추적이 끊기지 않게.
      const restoredOnly = result.restoredFromVault && plan.changes.length === 0 && previous.updatedAt;
      const stateToWrite = restoredOnly ? { ...plan.state, updatedAt: previous.updatedAt } : plan.state;
      writeAtomic(anchorsFile, `${JSON.stringify(stateToWrite, null, 2)}\n`);
      result.wroteAnchors = true;
      result.anchorsUpdatedAt = stateToWrite.updatedAt;
    }
    // 기준점을 처음 잡거나 상태 파일이 사라져 다시 잡은 날 한 번 — 실운영에서만.
    if (!preview && previous == null && plan.seeded.length) {
      try {
        await sendInfo(buildAnchorSummaryMessage({ seeded: plan.seeded, held: plan.held, heldReasons }));
        result.sentInfo = true;
      } catch (error) {
        logError(`   ⚠️  기준점 요약 발송 실패(대조 결과와 무관): ${error.message}`);
      }
    }
  }

  // 재설정한 날은 새 기준점으로 다시 판정한다(방금 인정한 차이를 경고로 내보내지 않게).
  if (plan && (args.rebaselineAll || args.rebaselineKeys.length)) {
    rows = diffHoldings(replayHoldings(ledger, plan.state.anchors, { holdings, now: now.getTime() }));
  }
  const anchorsExisted = Boolean(args.anchorsFile) || (!args.rebaselineAll && previous != null);
  const issues = selectAlertIssues({ rows, duplicates, pending: replay.pending, anchorsExisted });
  result.issues = issues;
  result.rows = rows;
  result.plan = plan;
  // 외부 대사는 원장 대조·기준점이 다 정해진 뒤에 돈다(그 결과를 읽지도 바꾸지도 않는다).
  const gbStage = await runGbBalanceStage({ args, fetchGbBalance, gbFetchTimeoutMs, holdings, executions, stateDir, now, preview, log, logError });
  result.externalRecon = gbStage.summary;
  // 볼트 사본은 경고 발송보다 먼저 쓴다(발송이 실패해도 사본은 남게). 실패해도 대조·경고는 계속하고 호출부가 종료 코드로 알린다.
  if (!preview && vaultFile && plan) {
    try {
      const copy = buildVaultCopy({
        anchorsState: plan.state, anchorsUpdatedAt: result.wroteAnchors ? result.anchorsUpdatedAt : (previous?.updatedAt ?? null),
        rows, issues, held: plan.held, heldReasons, nowIso: now.toISOString(), externalRecon: gbStage.summary,
      });
      mkdirSync(dirname(vaultFile), { recursive: true });
      result.wroteVaultCopy = writeIfChanged(vaultFile, `${JSON.stringify(copy, null, 2)}\n`, { compareKey: vaultCopyCompareKey });
      log(`   볼트 사본: ${result.wroteVaultCopy ? '갱신' : '바뀐 것 없음(쓰지 않음)'}`);
    } catch (error) {
      result.vaultCopyError = error.message;
      logError(`   ⚠️  볼트 사본 쓰기 실패(대조·경고는 계속): ${error.message}`);
    }
  }
  if (!hasAlertIssues(issues)) {
    log('✅ 알릴 이상 없음');
  } else if (preview) {
    log('\n(미리보기 — 경고 발송·억제 기록 없음)\n');
    log(renderAgentMessage(buildReconMessage(issues)));
  } else {
    await sendLedgerAlert({ issues, stateDir, alertsFile, now, sendWarning, log, logError, result });
  }
  await sendGbAlert({ gbResult: gbStage.result, preview, stateDir, alertsFile, now, sendWarning, log, logError, result });
  return result;
}

// 원장 대조 경고(기존 흐름 그대로 — 발송 실패는 던진다).
async function sendLedgerAlert({ issues, stateDir, alertsFile, now, sendWarning, log, logError, result }) {
  const message = buildReconMessage(issues);
  const signature = alertSignature(issues);
  const subjectKey = `holdings-ledger:${createHash('sha256').update(signature).digest('hex').slice(0, 20)}`;
  mkdirSync(stateDir, { recursive: true });
  await withLock(alertsFile, async () => {
    let state = null;
    try { state = readJson(alertsFile); } catch { state = null; }
    const { send, today } = decideDailyAlert(state, subjectKey, now);
    if (!send) {
      log('   (같은 이상은 오늘 이미 알림 — 발송 생략)');
      result.suppressed = true;
      return;
    }
    await sendWarning(message, signature);
    result.sentWarning = true;
    try {
      writeAtomic(alertsFile, `${JSON.stringify(recordDailyAlert(state, subjectKey, today))}\n`);
    } catch (error) {
      logError(`   ⚠️  경고는 보냈으나 하루 1회 억제 기록 실패 — 다음 실행에서 다시 보낼 수 있음: ${error.message}`);
    }
  }, { retries: 300, retryDelayMs: 100 });
}

// 외부 대사 경고 — 같은 억제 파일·같은 하루 1회 규칙, 원장 경고와 다른 억제 키. 실패해도 던지지 않고 gbAlertError로 남긴다
// (원장 대조 경고·결과에 영향 0, 호출부가 종료 코드로 알린다).
async function sendGbAlert({ gbResult, preview, stateDir, alertsFile, now, sendWarning, log, logError, result }) {
  if (!hasGbAlertIssues(gbResult)) return;
  const message = buildGbReconMessage(gbResult);
  if (preview) {
    log('\n(미리보기 — 외부 대사 경고 발송·억제 기록 없음)\n');
    log(renderAgentMessage(message));
    return;
  }
  const signature = gbAlertSignature(gbResult);
  const subjectKey = `holdings-gb-balance:${createHash('sha256').update(signature).digest('hex').slice(0, 20)}`;
  try {
    mkdirSync(stateDir, { recursive: true });
    await withLock(alertsFile, async () => {
      let state = null;
      try { state = readJson(alertsFile); } catch { state = null; }
      const { send, today } = decideDailyAlert(state, subjectKey, now);
      if (!send) {
        log('   (같은 외부 대사 이상은 오늘 이미 알림 — 발송 생략)');
        result.gbSuppressed = true;
        return;
      }
      await sendWarning(message, signature);
      result.sentGbWarning = true;
      try {
        writeAtomic(alertsFile, `${JSON.stringify(recordDailyAlert(state, subjectKey, today))}\n`);
      } catch (error) {
        logError(`   ⚠️  외부 대사 경고는 보냈으나 하루 1회 억제 기록 실패 — 다음 실행에서 다시 보낼 수 있음: ${error.message}`);
      }
    }, { retries: 300, retryDelayMs: 100 });
  } catch (error) {
    result.gbAlertError = error.message;
    logError(`   ⚠️  외부 대사 경고 발송 실패(원장 대조와 무관): ${error.message}`);
  }
}
