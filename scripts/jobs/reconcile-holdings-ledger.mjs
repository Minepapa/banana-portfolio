#!/usr/bin/env node
/**
 * 보유(Holdings) ↔ 체결 원장 재생 대조 — 하루 1회 읽기 전용 감시(데이터 체계 개선 ⑥, 2026-11-03).
 *
 * 판정은 lib/holdings-ledger-recon.mjs(순수 함수, 헤더에 기준점 설계·불변식), 실행 흐름(인자·기준점 저장·
 * 하루 1회 억제·발송)은 lib/holdings-ledger-recon-run.mjs. 이 파일은 볼트를 읽고 상태 디렉터리·발송 함수를 넘긴다.
 *
 * 쓰는 곳(사실대로):
 *   - Holdings·Ledger에는 절대 쓰지 않는다.
 *   - 볼트에 쓰는 것: 기준점·마지막 대조 요약 사본 95_Etna/Jobs/HoldingsLedgerRecon.json(2026-11-04 오너 승인, 바뀐 것이
 *     있을 때만 — 미리보기에서는 안 씀), 그리고 경고를 보낼 때 createDirectWarningSender가 남기는 경고 원장
 *     (95_Etna/Jobs/WarningEvents)과 아침 보류 큐(DeferredWarnings.json).
 *   - 볼트 밖 상태: ~/.cache/banana-portfolio-v2/holdings-ledger-anchors.json(기준점, 덮어쓰기 전 타임스탬프 백업)과
 *     holdings-ledger-alerts.json(같은 이상 하루 1회 억제). 기준점 파일이 없으면 볼트 사본의 기준점으로 되살린다.
 *
 * 사용법:
 *   node scripts/jobs/reconcile-holdings-ledger.mjs                       # 대조 + 기준점 저장 + 이상 시 경고
 *   node scripts/jobs/reconcile-holdings-ledger.mjs --dry-run             # 계산·로그만(파일 쓰기·발송 없음)
 *   node scripts/jobs/reconcile-holdings-ledger.mjs --anchors=<json>      # 기초 잔고를 파일로 지정해 미리보기(쓰기·발송 없음)
 *   node scripts/jobs/reconcile-holdings-ledger.mjs --rebaseline='ISA|종목' # 오너 확인 뒤 그 종목 기준점만 지금 값으로(여러 번 가능)
 *   node scripts/jobs/reconcile-holdings-ledger.mjs --rebaseline-all      # 전 종목 기준점을 다시 잡음(보류·음수 종목은 제외)
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { VAULT_PATHS, VAULT_REL, vaultAbs } from '../lib/vault-paths.mjs';
import { parseFrontmatter } from '../lib/vault-frontmatter.mjs';
import { sendAgentMessage } from '../lib/pantheon-send.mjs';
import { createDirectWarningSender, warningSubjectKey } from '../lib/direct-warning-delivery.mjs';
import { parseReconArgs, runHoldingsLedgerRecon } from '../lib/holdings-ledger-recon-run.mjs';

const STATE_DIR = join(homedir(), '.cache', 'banana-portfolio-v2');

function readRecords(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => name.endsWith('.md')).map((filename) => ({
    ...parseFrontmatter(readFileSync(join(dir, filename), 'utf8')), filename,
  }));
}

async function main() {
  const args = parseReconArgs(process.argv.slice(2));
  const warningSender = createDirectWarningSender(sendAgentMessage, {
    jobName: 'reconcile-holdings-ledger', warningCode: 'HOLDINGS_LEDGER_MISMATCH', kind: 'data-quality', severity: 'high',
  });
  const result = await runHoldingsLedgerRecon({
    args,
    executions: readRecords(VAULT_PATHS.facts.ledger.executions),
    fundPurchases: readRecords(VAULT_PATHS.facts.ledger.fundPurchases),
    holdings: readRecords(VAULT_PATHS.state.holdings),
    stateDir: STATE_DIR,
    vaultFile: vaultAbs(VAULT_REL.holdingsLedgerRecon),
    sendWarning: (message, signature) => warningSender(message, { subjectKey: warningSubjectKey('holdings-ledger', signature) }),
    sendInfo: (message) => sendAgentMessage(message),
  });
  // 볼트 사본 쓰기 실패는 대조·경고를 막지 않지만, 잡은 실패로 끝나 하트비트·로그에 남긴다.
  if (result.vaultCopyError) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error('\n❌ 오류:', error.message); process.exit(1); });
}
