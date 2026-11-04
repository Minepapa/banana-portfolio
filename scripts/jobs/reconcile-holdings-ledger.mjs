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
 *     holdings-gb-balance-pending.json(위탁 해외주식 게시 대기 시작일 — 2영업일 판정 재료).
 *
 * 위탁 해외주식 외부 대사(2026-11-04 제우스, 판정은 lib/holdings-gb-balance-recon.mjs): 원장 대조 뒤 보유 ↔ NH 해외주식
 * 잔고를 맞춰 본다. 감지만 한다. NH 호출은 실행 1회에 토큰(getNhToken 캐시 — 유효하면 HTTP 0회) + 계좌목록 1회
 * (/n2/acctinfo, 위탁 계좌번호를 캐시할 기존 수단이 없다) + 해외주식 잔고 1회(/gbstock/inquiry/v1/balance)뿐이다
 * (callNh 공용 재시도 — 429·5xx 1회, 무효 토큰이면 재발급 뒤 1회 — 는 별도). 요청마다 30초 제한을 건다.
 * 일별거래내역·미체결 등 다른 엔드포인트는 부르지 않는다. 조회 실패는 '외부 대사 건너뜀'으로 볼트 사본에만 남고
 * 원장 대조·기준점·원장 경고에는 영향이 없다.
 *
 * 사용법:
 *   node scripts/jobs/reconcile-holdings-ledger.mjs                       # 대조 + 기준점 저장 + 이상 시 경고
 *   node scripts/jobs/reconcile-holdings-ledger.mjs --dry-run             # 계산·로그만(파일 쓰기·발송 없음, NH 조회 없음)
 *   node scripts/jobs/reconcile-holdings-ledger.mjs --external-dry-run    # --dry-run + NH 해외주식 잔고 실조회(쓰기·발송 없음)
 *   node scripts/jobs/reconcile-holdings-ledger.mjs --anchors=<json>      # 기초 잔고를 파일로 지정해 미리보기(쓰기·발송 없음, NH 조회 없음)
 *   node scripts/jobs/reconcile-holdings-ledger.mjs --rebaseline='ISA|종목' # 오너 확인 뒤 그 종목 기준점만 지금 값으로(여러 번 가능, NH 조회 없음)
 *   node scripts/jobs/reconcile-holdings-ledger.mjs --rebaseline-all      # 전 종목 기준점을 다시 잡음(보류·음수 종목은 제외, NH 조회 없음)
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
import { hasNhplugCredentials, loadNhplugCredentials, getNhToken, listNhAccounts } from '../lib/nhplug.mjs';
import { getGbBalance } from '../lib/nhplug-gbstock.mjs';
import { resolveNhAccountsByLabel } from '../lib/nh-accounts.mjs';

const STATE_DIR = join(homedir(), '.cache', 'banana-portfolio-v2');

// NH 해외주식 잔고 1회 조회(reconcile-nh-fx-rp.mjs와 같은 토큰·계좌 해석). 실패 단계를 error.stage에 붙여 던진다 —
// 실행 흐름이 '외부 대사 건너뜀'으로 바꾼다. curCd 'USD'는 execute-asset-allocation-proposal과 같은 이유(통화 합산 방지).
async function fetchGbBalance() {
  // callNhOnce fetch에는 제한 시간이 없다 — NH가 붙잡으면 원장 사본·경고까지 늦어지므로 이 잡에서만 건다.
  const fetchImpl = (url, options = {}) => fetch(url, { ...options, signal: AbortSignal.timeout(30_000) });
  const step = async (stage, fn) => {
    try { return await fn(); } catch (error) { error.stage = stage; throw error; }
  };
  if (!hasNhplugCredentials()) throw Object.assign(new Error('NH PLUG 자격증명 없음'), { stage: '자격증명' });
  const { appkey, appsecret } = await step('자격증명', () => loadNhplugCredentials());
  const token = await step('토큰', () => getNhToken({ appkey, appsecret }));
  const accounts = await step('계좌목록', () => listNhAccounts({ token, fetchImpl }));
  const actNo = await step('계좌목록', () => resolveNhAccountsByLabel(accounts, new Set(['위탁'])).get('위탁'));
  if (!actNo) throw Object.assign(new Error('NH 계좌목록에 위탁 계좌 없음'), { stage: '계좌목록' });
  return step('잔고', () => getGbBalance({ token, actNo, curCd: 'USD', fetchImpl }));
}

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
    // 외부 대사 경고(서명 'gb-' 접두)는 경고 원장에서 출처가 갈리게 다른 주제 키를 쓴다.
    sendWarning: (message, signature) => warningSender(message, {
      subjectKey: warningSubjectKey(signature.startsWith('gb-') ? 'holdings-gb-balance' : 'holdings-ledger', signature),
    }),
    sendInfo: (message) => sendAgentMessage(message),
    fetchGbBalance,
  });
  // 볼트 사본 쓰기·외부 대사 경고 발송 실패는 대조·경고를 막지 않지만, 잡은 실패로 끝나 하트비트·로그에 남긴다.
  if (result.vaultCopyError || result.gbAlertError) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error('\n❌ 오류:', error.message); process.exit(1); });
}
