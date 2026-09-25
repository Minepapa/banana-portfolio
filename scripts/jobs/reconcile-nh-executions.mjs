#!/usr/bin/env node
/**
 * 위탁·금현물 체결 — NH PLUG API(당일 체결조회)로 직접 폴링 → Facts/Ledger/Executions 기록.
 *
 * 왜: `Log/Strategy/2026-09-02-NH-API-우선-KIS-카카오파싱-역할축소-결정.md`
 * 마이그레이션 4단계. 지금까지 위탁·금현물 체결은 카카오 알림(NH투자증권 브로커
 * 패턴, notification-parsers.mjs parseExecution)에만 의존했다 — `reconcile-irp-
 * executions.mjs`(IRP, KIS 전용 API)·`watch-order-fill.mjs`(퀀트, KIS)와 동일
 * 철학으로, 카카오 알림 파싱 없이 API로 직접 원장을 채운다. CMA는 스코프 밖
 * (Strategy 문서: "CMA는 체결 자체가 없는 계좌라 제외").
 *
 * 2026-09-25부터 API가 실제로 덮는 위탁 국내주식·금현물 카카오 체결은 수신 단계에서
 * 원장 기록을 중단했다. 아래 크로스소스 처리는 전환 전에 생긴 과거 이중 기록을 위한
 * 호환 경로다. 두 경로가 같은 체결을 각자 별도 파일로 기록했던 시기에는
 * (`buildExecutionRecord`의 dedupKey·파일명이 `tradeDate|tradeType|stockName|
 * quantity`(+이 잡만 쓰는 orderNo)로 결정되는데, 두 소스의 tradeDate 계산 방식이
 * 달라 — 카카오는 실제 체결시각, 이 잡은 시각 정보가 없어 00:00:00 — 같은 체결이
 * 서로 다른 파일명으로 남는다).
 *
 * ⚠️ **정정(2026-09-03, code-reviewer 지적으로 발견)** — "파일이 2개라도 이중계상은
 * 아니다"라고 처음 적었던 건 틀렸다. `update-holdings-from-executions.mjs`가 미처리
 * 체결마다 State/Holdings에 applyBuy/applySell을 적용하는데, 원래 이 잡이 잡는 중복은
 * legacy(v1 마이그레이션 스냅샷)뿐이었다 — 카카오·NH API가 각각 만든 두 "살아있는"
 * 체결 파일은 서로를 모르고 **둘 다 적용**돼 수량이 실제로 두 배(매수) 또는 실현손익이
 * 중복 기록(매도)될 뻔했다(라이브 Vault의 실제 체결 1건으로 재현 확인). 이제
 * `update-holdings-from-executions.mjs`의 `findMatchingKnownExecution`이 legacy뿐
 * 아니라 "이미 holdingsApplied된 다른 소스의 체결"까지 대조해 이중 적용을 막는다
 * (2026-09-03 동시 수정 — 그 파일의 헤더 주석 참고). 이 잡을 배선하기 전에 그 수정이
 * 먼저 들어가 있어야 한다.
 *
 * ⚠️ 응답 필드 구조(2026-09-03, 라이브 조회로 실측 확인 — 위탁 실제 체결 1건
 * "메리츠금융지주 매도 30주 @132,000원"으로 검증) — getKrDailyOrderExecution/
 * getGoldExecution 둘 다 완전히 동일한 Output_0 필드 구조를 반환한다:
 * itg_orr_no(통합주문번호)·iem_cd(종목코드)·iem_nm(종목명)·sby_dit_cd_nm(매매구분명,
 * "현금매도"/"현금매수")·orr_qty(주문수량)·tot_cns_qty(총체결수량)·
 * cns_avg_uit_pr(체결평균단가). 실제 사례에서 orr_qty===tot_cns_qty===30,
 * cns_avg_uit_pr===132000으로 Vault에 이미 기록된 카카오 파싱 결과와 정확히
 * 일치함을 확인 — 이 잡은 필드명이 검증된 상태로 시작한다(IRP Phase 2와 달리
 * 미실측 경고 불필요).
 *
 * ⚠️ 체결 시각 필드가 없음 — 이 응답엔 체결/주문 시각을 담은 필드가 아예 없다
 * (IRP의 ord_tmd 같은 필드조차 없음). 그래서 tradeDate의 시각 부분은 항상
 * "00:00:00"으로 채운다(추정하지 않음, 이 코드베이스 원칙 — 있지도 않은 시각을
 * 지어내지 않는다). 같은 날 같은 종목·수량·방향의 체결이 2건 이상 있으면 시각까지
 * 겹쳐 파일명이 충돌할 수 있어, `itg_orr_no`(통합주문번호)를 `buildExecutionRecord`
 * 의 새 선택 필드 `orderNo`로 넘겨 그 경우에도 항상 서로 다른 레코드로 구분되게
 * 한다(ledger-vault-writer.mjs 2026-09-03 확장, 이 잡이 첫 소비처).
 *
 * ⚠️ 부분체결 폴링 멱등성 — tot_cns_qty는 주문의 누적 체결수량이다. 활성 부분체결은
 * 미체결수량(ny_cns_qty)이 남아있는 동안 장부 반영을 보류하고, 전량체결 또는 잔량
 * 0으로 종료된 부분체결만 공용 nh-execution-ledger.mjs를 통해 기록한다. 기록기는
 * 주문별 락으로 watcher/정기대사 경합을 막고, 카카오 알림이 이미 남긴 체결수량을
 * 차감한 증분만 단일 이벤트로 기록한다. cns_amt와 누적 평균단가가 모순되면 보류한다.
 *
 * 안전: 조회 전용(매매 API 미사용). 계좌 하나가 실패해도 나머지는 계속 진행.
 * 범위: 날짜 범위 파라미터가 없는 API라(orrDt 단일 날짜) 당일 조회만 된다 —
 * 매일 폴링해야 그날 체결을 놓치지 않는다(reconcile-irp-executions.mjs와 동일).
 *
 * ⚠️ "체결 없음" 응답 패턴이 IRP(KIS)와 반대(2026-09-03 라이브 확인) — KIS는
 * 당일 체결이 없으면 rt_cd:'0'(성공)+output:[](빈 배열)로 응답하지만, NH는
 * 업무거부(rsp_cd '11512', "데이터가 존재하지 않습니다")로 응답한다(위탁·금현물
 * 둘 다 동일 코드로 확인). `e.businessRejection===true && e.code==='11512'`일
 * 때만 정상적인 "오늘 체결 0건"으로 취급하고 collectWarning을 안 올린다 —
 * businessRejection 조건까지 함께 확인하는 이유(code-reviewer 지적, 2026-09-03):
 * `err.code`에 `rsp_cd`가 실리는 분기는 nhplug.mjs의 업무거부(businessRejection)
 * 분기 하나뿐이지만, 그 계약이 앞으로도 유지된다고 이 파일만으로는 보장 못 하므로
 * 명시적으로 좁혀서 인증실패·네트워크 오류 등이 우연히 같은 코드값을 갖더라도
 * 절대 조용히 삼켜지지 않게 한다. 그 외 실패는 그대로 경고.
 *
 * 사용법:
 *   node scripts/jobs/reconcile-nh-executions.mjs            # 실제로 Vault에 씀
 *   node scripts/jobs/reconcile-nh-executions.mjs --dry-run  # 조회만, 쓰기 없음
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { hasNhplugCredentials, loadNhplugCredentials, getNhToken, listNhAccounts } from '../lib/nhplug.mjs';
import { getKrDailyOrderExecution } from '../lib/nhplug-krstock.mjs';
import { getGoldExecution } from '../lib/nhplug-krgold.mjs';
import { getGbDailyTransaction } from '../lib/nhplug-gbstock.mjs';
import { resolveNhAccountsByLabel, maskNhActNo } from '../lib/nh-accounts.mjs';
import { recordNhDailyTransactionExecution, recordNhTerminalExecution } from '../lib/nh-execution-ledger.mjs';
import { buildGbExecutionLedgerInput, isSupportedGbUsTradeRow, parseGbDailyTransactionRows } from '../lib/nh-gbstock-execution.mjs';
import { GB_EXECUTION_API_CUTOVER_KST_DATE, kstDateOrNull } from '../lib/gb-execution-cutover.mjs';
import { collectWarning, flushWarnings } from '../lib/job-alerts.mjs';
import { VAULT_PATHS } from '../lib/vault-paths.mjs';
import { findProposalByBrokerOrderId, parseProposal } from '../lib/proposal-vault.mjs';
import { recordProposalExecutionStatus } from '../lib/proposal-execution-status.mjs';

const DRY_RUN = process.argv.includes('--dry-run');
const BROKER = 'NH투자증권';

// CMA 제외 — 위 헤더 주석 참고(체결 자체가 없는 계좌).
const NH_EXECUTION_ACCOUNTS = new Set(['위탁', '금현물']);

function loadProposalsForOrderTracking() {
  const dir = VAULT_PATHS.decisions.proposals;
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((file) => file.endsWith('.md')).map((filename) => {
    const content = readFileSync(join(dir, filename), 'utf8');
    return { filename, ...parseProposal(content) };
  });
}

// KIS 응답의 output/output1 패턴과 달리 NH krstock·krgold 체결조회는 둘 다
// Output_0(대문자, 배열)에 담아 준다 — nhplug.mjs callNh의 공용 응답 형태.
// 순수함수 — 테스트 가능. tot_cns_qty(총체결수량)가 0(또는 결측)인 행은 미체결이라
// 제외 — 추정 대신 확인(이 코드베이스 원칙, parseIrpPensionExecutions와 동일 관례).
//
// [핵심 안전장치] sby_dit_cd_nm(매매구분명) 화이트리스트(2026-09-03, code-reviewer
// 지적) — "매도"·"매수" 둘 다 아닌 값(결측·신용/대주 등 이 잡이 실측한 적 없는 표기)
// 이 오면 tradeType을 매수로 단정하지 않고 null로 남긴다. 매매구분은 보유수량의
// 부호를 결정하는 값이라 오판이 applyBuy/applySell을 통째로 뒤집을 수 있어, 여기서만은
// "매도가 아니면 매수"라는 단순 폴백을 안 쓴다(추정 대신 확인 원칙).
export function parseNhExecutionRows(rows) {
  const num = (v) => {
    if (v == null || String(v).trim() === '') return null;
    const n = Number(String(v).replace(/,/g, ''));
    return Number.isFinite(n) ? n : null;
  };
  return (Array.isArray(rows) ? rows : [])
    .map((row) => {
      const quantity = num(row.tot_cns_qty);
      const orderQty = num(row.orr_qty);
      const price = num(row.cns_avg_uit_pr);
      const unfilledQty = num(row.ny_cns_qty);
      const canceledQty = num(row.can_qty);
      const dirRaw = String(row.sby_dit_cd_nm ?? '');
      const tradeType = dirRaw.includes('매도') ? '매도' : dirRaw.includes('매수') ? '매수' : null;
      return {
        orderNo: String(row.itg_orr_no ?? '').trim(),
        stockCode: String(row.iem_cd ?? '').trim(),
        stockName: String(row.iem_nm ?? '').trim(),
        tradeType,
        quantity,
        orderQty,
        fullyFilled: quantity != null && orderQty != null && quantity === orderQty,
        price,
        unfilledQty,
        canceledQty,
        executionAmount: num(row.cns_amt),
      };
    })
    // tradeType!=null: 위 화이트리스트에서 탈락한 행 제외. orderNo!=='': 이 잡의
    // 유일한 파일명 충돌 방지 수단(시각이 전부 00:00:00이라 orderNo로만 구분됨,
    // 위 헤더 주석 참고)이라 결측이면 안전하게 기록을 건너뛴다(2026-09-03 code-
    // reviewer 지적 — 실측상 항상 존재하는 필드지만 이 잡에서는 선택이 아니라
    // 필수이므로 결측을 구조 이상 신호로 취급, 아래 rawRows.length>0&&executions.
    // length===0 경고가 이 경우도 함께 잡아준다).
    .filter((e) => e.tradeType != null && e.orderNo !== '' && e.quantity != null && e.quantity > 0 && e.price != null && e.price > 0);
}

export function isTerminalNhExecution(row) {
  if (row?.fullyFilled) return true;
  return row?.quantity > 0 && row?.orderQty > row.quantity && row?.unfilledQty === 0;
}

// 호환용 순수 변환기(테스트·기존 외부 소비자용). 실제 정기대사와 즉시감시는 이제
// 누적 부분체결·카카오 상호대조까지 처리하는 nh-execution-ledger.mjs를 공용 사용한다.
export function buildNhFillLedgerInput(row, { today, account, actNo }) {
  return {
    tradeDate: `${today} 00:00:00`,
    tradeType: row.tradeType,
    stockCode: row.stockCode,
    stockName: row.stockName,
    quantity: row.quantity,
    price: row.price,
    currency: 'KRW',
    broker: BROKER,
    account,
    acctNo: maskNhActNo(actNo) || '',
    orderNo: row.orderNo,
  };
}

// 부분·전량 체결 모두 Proposal 상태 대사 대상이다. 원장에는 전량체결만 기록해
// 누적수량을 중복 기록하지 않지만, 현재 누적 체결상태는 매 폴링마다 갱신한다.
export function buildNhProposalStatusInput(proposal, execution, proposalsDir) {
  if (!Number.isFinite(execution.orderQty) || execution.orderQty <= 0) return null;
  return {
    proposalsDir,
    proposalId: proposal.id,
    brokerOrderId: execution.orderNo,
    status: execution.fullyFilled ? '체결' : execution.unfilledQty === 0 ? '취소' : '부분체결',
    filledQty: execution.quantity,
    avgFillPrice: execution.price,
  };
}

function kstTodayParts() {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).formatToParts(new Date());
  const get = (type) => parts.find((p) => p.type === type).value;
  return { dashed: `${get('year')}-${get('month')}-${get('day')}`, compact: `${get('year')}${get('month')}${get('day')}` };
}

// 미국 거래일(trd_dt)이 KST 날짜와 다를 수 있어, 평일 15:55 안전망은 당일만
// 조회하지 않는다. 최근 7개 이전 달력일까지 재조회해 주말·시차로 늦게 보이는
// 미기록 거래를 회수하며, Ledger 파일 키가 중복 기록을 막는다.
export { GB_EXECUTION_API_CUTOVER_KST_DATE } from '../lib/gb-execution-cutover.mjs';

export function gbReconcileStartDate(compactToday) {
  const compact = String(compactToday ?? '');
  if (!/^\d{8}$/.test(compact)) throw new Error(`gbstock 대조 기준일 형식 오류: ${compact}`);
  const date = new Date(Date.UTC(Number(compact.slice(0, 4)), Number(compact.slice(4, 6)) - 1, Number(compact.slice(6, 8))));
  date.setUTCDate(date.getUTCDate() - 7);
  const rollingStart = date.toISOString().slice(0, 10).replaceAll('-', '');
  const cutover = GB_EXECUTION_API_CUTOVER_KST_DATE.replaceAll('-', '');
  // 과거 카카오 체결은 이미 holdingsApplied 완료 상태다. 7일 안전망이 그보다
  // 앞을 가리켜도 이 API 경로에서는 절대 조회·기록하지 않는다.
  return rollingStart < cutover ? cutover : rollingStart;
}

export function gbReconcileWindow(compactToday) {
  const compact = String(compactToday ?? '');
  if (!/^\d{8}$/.test(compact)) throw new Error(`gbstock 대조 기준일 형식 오류: ${compact}`);
  const cutover = GB_EXECUTION_API_CUTOVER_KST_DATE.replaceAll('-', '');
  // 배선일 이전에 이 코드를 실행해도 역방향 기간을 NH에 보내지 않으며, 과거분을
  // 소급 대사하지 않는다.
  if (compact < cutover) return null;
  return { startDate: gbReconcileStartDate(compact), endDate: compact };
}

export function shouldRecordGbExecutionAtCutover(event) {
  // gbstock trd_dt는 KST 체결시각이 아니고, 현재 표시일자 보정은 전일을 쓴다.
  // 따라서 API 조회창만 컷오버로 제한하면 경계일 행이 전환 전 Ledger에 기록될 수
  // 있다. 표시일자가 확정적으로 컷오버 전이면 보수적으로 보류한다.
  const ledgerDate = kstDateOrNull(event?.tradeDate);
  return ledgerDate != null && ledgerDate >= GB_EXECUTION_API_CUTOVER_KST_DATE;
}

async function main() {
  if (!hasNhplugCredentials()) {
    console.log('ℹ️ NH PLUG 크리덴셜 미설정 — 스킵');
    return;
  }

  const { appkey, appsecret } = loadNhplugCredentials();
  const token = await getNhToken({ appkey, appsecret });
  const accounts = await listNhAccounts({ token });

  const byLabel = resolveNhAccountsByLabel(accounts, NH_EXECUTION_ACCOUNTS);
  for (const label of NH_EXECUTION_ACCOUNTS) {
    if (!byLabel.has(label)) {
      collectWarning(`NH 체결조회: ${label} 계좌를 /n2/acctinfo 응답에서 못 찾음(계좌번호 매핑 확인 필요)`);
    }
  }

  const { dashed: today, compact: orrDt } = kstTodayParts();
  const trackedProposals = DRY_RUN ? [] : loadProposalsForOrderTracking();
  let recorded = 0, skipped = 0, partial = 0;

  for (const [label, actNo] of byLabel) {
    let rawRows;
    try {
      // ostCnsDit: '1'(체결)로 명시 — 기본값 '0'(전체)이면 미체결 주문 행까지 같이
      // 와서, 그날 지정가 주문이 하나도 체결 안 된 평범한 날에도 rawRows.length>0인데
      // 전부 quantity=0으로 필터 탈락해 아래 "구조 이상" 경고가 오탐 발사된다(2026-09-03
      // code-reviewer 지적 — 이 경고의 전제는 "성공 응답에 담긴 행은 전부 체결"인데
      // 기본값 '0'은 그 전제를 깬다).
      // ⚠️ 버그 수정(2026-09-03, 오너가 공식 API 가이드 페이지를 직접 대조해 발견) —
      // 처음엔 '2'를 "체결"로 잘못 알고 넣었다(nhplug-krstock.mjs의 옛 주석이 1·2를
      // 뒤바꿔 적어놨던 게 원인). 실제로는 '2'=미체결이라 이 잡이 신설된 이래 계속
      // "체결 없음"만 반환하고 있었다 — 진짜 체결 데이터를 못 본 게 아니라 애초에
      // 미체결 행만 조회하고 있었던 것. '1'로 정정.
      const body = label === '금현물'
        ? await getGoldExecution({ token, actNo, orrDt, ostCnsDit: '1' })
        : await getKrDailyOrderExecution({ token, actNo, orrDt, ostCnsDit: '1' });
      rawRows = body?.Output_0;
    } catch (e) {
      // ⚠️ NH는 "당일 체결 없음"을 성공+빈배열이 아니라 업무거부(rsp_cd 11512,
      // "데이터가 존재하지 않습니다")로 응답한다(2026-09-03 라이브 확인 — IRP의
      // KIS API와 반대 패턴, KIS는 output:[]로 성공 응답). businessRejection===true
      // 까지 함께 확인해야 하는 이유는 위 헤더 주석 참고 — 그 외 실패는 그대로 경고.
      if (e.businessRejection === true && e.code === '11512') {
        console.log(`  · ${label}: 오늘 체결 없음(NH 11512)`);
        continue;
      }
      console.error(`NH 체결조회 실패(${label}) —`, e.message);
      collectWarning(`NH 체결조회 실패(${label})`);
      continue;
    }

    // [핵심 안전장치] 성공 응답인데 Output_0이 배열이 아니면(봉투 구조 변경 등)
    // 조용히 "0건"으로 넘어가지 않고 경고 — 이 잡의 전제상(11512 아니면 성공 응답은
    // 항상 배열을 가져야 함) 여기 도달했는데 배열이 아니면 그 자체가 이상 신호다.
    if (!Array.isArray(rawRows)) {
      collectWarning(`NH 체결조회(${label}): 성공 응답인데 Output_0 배열이 없음 — 응답 봉투 구조 확인 필요`);
      continue;
    }

    const executions = parseNhExecutionRows(rawRows);
    // [핵심 안전장치] 원본 행이 있는데 파싱 결과가 비면(필드명 불일치 등 구조 이상
    // 신호) "오늘 체결 0건"과 구분해 노출 — reconcile-irp-executions.mjs와 동일 안전장치.
    if (rawRows.length > 0 && executions.length === 0) {
      collectWarning(`NH 체결조회(${label}): 응답 ${rawRows.length}행이 있는데 전부 필터 탈락 — 필드명/구조 확인 필요`);
    }

    for (const e of executions) {
      const proposal = findProposalByBrokerOrderId(trackedProposals, { brokerOrderId: e.orderNo, account: label });
      if (proposal) {
        const statusInput = buildNhProposalStatusInput(proposal, e, VAULT_PATHS.decisions.proposals);
        if (!statusInput) {
          collectWarning(`NH 체결 대사: ${proposal.id} — 주문수량 확인 불가, Proposal 상태 갱신 보류`);
        } else {
          try {
            const updated = await recordProposalExecutionStatus(statusInput);
            if (updated) {
              const labelText = e.fullyFilled ? '전량체결' : `부분체결 ${e.quantity}/${e.orderQty}주`;
              console.log(`  ✓ [Proposal] ${proposal.id} — 일일 NH 대사로 ${labelText} 확인`);
            }
          } catch (error) {
            console.error(`Proposal 체결상태 기록 실패(${proposal.id}) —`, error.message);
            collectWarning('NH 체결 대사: 주문접수 제안의 체결상태를 갱신하지 못함 — 상태 파일 확인 필요');
          }
        }
      }
      if (!isTerminalNhExecution(e)) { partial++; continue; }
      const result = await recordNhTerminalExecution({
        row: e, tradeDate: `${today} 00:00:00`, account: label,
        acctNo: maskNhActNo(actNo) || '', dir: VAULT_PATHS.facts.ledger.executions, dryRun: DRY_RUN,
      });
      if (!result.ok) {
        collectWarning(`NH 체결기록: ${label} ${e.stockName} 주문번호 ${e.orderNo} — ${result.reason}`);
        skipped++;
      } else if (!result.event) {
        console.log(`  · 이미 기존 체결기록으로 반영됨 — ${label} ${e.stockName} ${e.quantity}주`);
        skipped++;
      } else {
        console.log(`  + [체결기록${DRY_RUN ? '(예정)' : ''}] ${label} ${e.tradeType} ${e.stockName} ${result.event.quantity}주 @${result.event.price}원${result.event.quantity < e.quantity ? ` (누적 ${e.quantity}주 중 기존 기록 제외)` : ''} — ${result.filepath}`);
        recorded++;
      }
    }
  }

  // gbstock 일별거래내역은 itg_orr_no 같은 주문번호가 없다. 따라서 위탁 계좌의
  // 실측 행(trd_dt·act_trd_tp_nm·iem_nm·trd_qty) 자체를 주문번호 없는 체결로
  // 기록한다. ISA는 NH PLUG 계좌목록에 노출되지 않아 여기서 조회할 수 없다.
  const gbActNo = byLabel.get('위탁');
  const gbWindow = gbReconcileWindow(orrDt);
  if (gbActNo && gbWindow) {
    let rawRows;
    let gbPaginationTruncated = false;
    let gbPaginationInvalidOutput0 = false;
    try {
      const body = await getGbDailyTransaction({
        token, actNo: gbActNo, iqrStaDt: gbWindow.startDate, iqrEndDt: gbWindow.endDate,
      });
      rawRows = body?.Output_0;
      gbPaginationTruncated = body?.paginationTruncated === true;
      gbPaginationInvalidOutput0 = body?.paginationInvalidOutput0 === true;
    } catch (e) {
      // 11512="체결 없음"은 krstock·krgold에서만 실측한 업무거부 코드다. gbstock
      // 에서 같은 의미인지는 아직 직접 검증하지 못했으므로, 이 분기는 경보를 줄이는
      // 편의 처리일 뿐 해외주식 무체결의 확정 근거로 쓰지 않는다.
      if (e.businessRejection === true && e.code === '11512') {
        console.log('  · 위탁 해외주식: NH 11512 응답(체결 없음 의미는 gbstock 미검증)');
      } else {
        console.error('NH 해외주식 체결조회 실패(위탁) —', e.message);
        collectWarning('NH 해외주식 체결조회 실패(위탁)');
      }
      rawRows = null;
    }

    if (rawRows != null) {
      if (!Array.isArray(rawRows)) {
        collectWarning(`NH 해외주식 체결조회(위탁): ${gbPaginationInvalidOutput0 ? '페이지 응답의 Output_0이 배열이 아님' : '성공 응답인데 Output_0 배열이 없음'} — 체결 반영 보류, 응답 봉투 구조 확인 필요`);
      } else {
        const executions = parseGbDailyTransactionRows(rawRows);
        if (gbPaginationTruncated) {
          collectWarning('NH 해외주식 체결조회(위탁): 연속조회가 끝까지 완료되지 않아 일부 행만 반영했을 수 있음 — 다음 실행에서 재확인 필요');
        }
        // 배당·세금 등 비매매 행만 있는 정상 응답을 "전부 필터 탈락"으로 경고하지
        // 않는다. 매수/매도 행이 있었는데도 하나도 정규화하지 못한 경우만 스키마
        // 변화·필수필드 결측 가능성으로 경고한다.
        const tradeRows = rawRows.filter((row) => ['매수', '매도'].includes(String(row?.act_trd_tp_nm ?? '').trim()));
        if (tradeRows.length > 0 && executions.length === 0) {
          collectWarning(`NH 해외주식 체결조회(위탁): 매수/매도 ${tradeRows.length}행이 있는데 전부 필터 탈락 — 필드명/구조 확인 필요`);
        }
        // 이번 원장 배선은 실측한 USD·미국시장만 대상이다. 통화·종목코드 형식이
        // 지원 범위 밖인 행도 같은 파서 기준으로 집계해 조용히 드롭되지 않게 한다.
        const unsupportedMarketRows = rawRows.filter((row) => !isSupportedGbUsTradeRow(row)).length;
        if (unsupportedMarketRows > 0) {
          console.log(`  ℹ️ 위탁 해외주식: 미국 USD 지원 범위 밖 ${unsupportedMarketRows}행은 미검증이라 Ledger 기록 제외`);
        }
        for (const execution of executions) {
          const event = buildGbExecutionLedgerInput(execution, { account: '위탁', actNo: gbActNo });
          if (!shouldRecordGbExecutionAtCutover(event)) {
            console.log(`  ℹ️ 위탁 해외주식: ${execution.stockName} API 거래일 ${execution.tradeDate}의 KST Ledger 표시일이 컷오버 전이라 기록 보류`);
            skipped++;
            continue;
          }
          const result = await recordNhDailyTransactionExecution({
            event,
            dir: VAULT_PATHS.facts.ledger.executions, dryRun: DRY_RUN,
          });
          if (!result.ok) {
            collectWarning(`NH 해외주식 체결기록: 위탁 ${execution.stockName} ${execution.tradeDate} — ${result.reason}`);
            skipped++;
          } else if (!result.event) {
            console.log(`  · 이미 기존 체결기록으로 반영됨 — 위탁 해외주식 ${execution.stockName} ${execution.quantity}주`);
            skipped++;
          } else {
            console.log(`  + [체결기록${DRY_RUN ? '(예정)' : ''}] 위탁 ${execution.tradeType} ${execution.stockName} ${execution.quantity}주 @${execution.price}USD — ${result.filepath}`);
            recorded++;
          }
        }
      }
    }
  }

  // 활성 부분체결은 잔량이 끝날 때까지 보류한다. 종료된 부분체결은 위에서 NH
  // 누적수량을 기존 카카오/API 기록과 대조해 증분만 남긴다. 잔량상태를 확인할 수
  // 없는 부분체결은 종결을 추정하지 않고 경보한다.
  if (partial > 0) {
    collectWarning(`NH 체결조회: ${partial}건 부분체결이 남아있거나 잔량상태를 확인할 수 없어 장부 반영 보류 — 다음 조회에서 재확인`);
  }

  console.log(`\n✅ NH 체결 ${recorded}건 신규 기록 · ${skipped}건 이미 존재 · ${partial}건 부분체결 대기` + (DRY_RUN ? ' (드라이런 — 쓰기 없음)' : ''));
  await flushWarnings('reconcile-nh-executions');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(async (e) => {
    console.error('\n❌ 오류:', e.message);
    await flushWarnings('reconcile-nh-executions').catch(() => {});
    process.exit(1);
  });
}
