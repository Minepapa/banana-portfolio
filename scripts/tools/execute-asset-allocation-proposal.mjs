#!/usr/bin/env node
// execute-asset-allocation-proposal.mjs — 승인된 자산분배 트랙 제안을 검문소에 통과시켜
// NH PLUG로 실제 체결(섀도우모드면 로그, 실전모드면 실제 매수/매도). execute-quant-
// proposal.mjs(퀀트 트랙, KIS)와 같은 아키텍처를 그대로 재사용한다 — order-gate.mjs·
// shadow-mode.mjs·execute-proposal.mjs는 브로커 무관 순수 파이프라인이라 전혀 안
// 바뀐다(order-gate.mjs의 checkMarketOpen만 US 시장 분기가 추가됐다 — 아래 H5 참고,
// KR 분기 동작은 그대로라 퀀트에 영향 없음). 이 파일이 새로 하는 일은 ①NH PLUG
// 계좌·잔고·시세 조회 ②assetKey→NH 주문가능 자산군 분류(asset-allocation-
// instrument-router.mjs, proposal.account 필드는 신뢰 불가능이라 안 씀 — 그 파일
// 헤더 주석 참고) ③분류 결과에 따라 krstock/gbstock/krgold 중 알맞은 주문 함수
// 선택뿐이다.
//
// 오너 지시(2026-09-05, "지금 배선하는거야"):
//   - 폴링 10분(퀀트의 5분보다 느슨 — 오너 명시 지정)
//   - 검문소 기준은 퀀트와 동일(order-gate.mjs 그대로 재사용, 가격이탈 ±1% 등)
//   - 킬스위치·체결모드(섀도우/실전)는 퀀트와 전역 공유(State/KillSwitch,
//     State/ExecutionMode — 이 잡만의 별도 상태 파일 없음)
//   - 연금저축은 계속 리마인더 전용(자동체결 대상 아님) — 이 잡은 위탁·금현물만
//   - 실물금·해외주식 포함 전체 스코프로 1차 구현(연금저축만 제외)
//
// ⚠️ 알려진 한계(1차 구현 범위 밖, 실측 빈도 낮거나 대안이 이미 있어 의도적으로 미룸):
//   - 직접채권(예: 삼척블루파워12 — KRX 마스터파일 미등재라 krStockCode가 null 반환)
//     은 라우터가 UNSUPPORTED로 분류해 자동체결 대상에서 빠진다(수동 처리 유지).
//   - 외화 RP는 NH가 USD 예수금 발생 시 자동 스윕하는 브로커 기능이라 별도 주문
//     자체가 없음(오너 확인 2026-09-05) — 라우터가 UNSUPPORTED로 분류. ⚠️ 게다가
//     잔고 조회조차 NH PLUG 공개 API로 불가능하다(2026-09-06 확인 — nhplug.com
//     API가이드 전체 6개 대분류에 RP 도메인 자체가 없음, MTS 앱 전용 상품으로
//     추정) — 그래서 해외주식 가용현금 계산이 fc_dca(API로 확인되는 미투자
//     외화현금) + State/Holdings/위탁-외화-RP.md의 qty(오너가 "외화 상품매도·
//     환전 직후 수동 갱신"하기로 확정)를 합산한다(아래 gbCash 계산부 주석 참고).
//   - ISA는 NH PLUG API(/n2/acctinfo)가 애초에 노출하지 않아(2026-09-03 라이브
//     확인, nh-accounts.mjs 참고) 이 잡이 배선할 방법 자체가 없다 — ISA 자산분배
//     제안은 계속 수동 처리(자동 만료 알림은 그대로 발송돼 오너에게 도달함).
//   - watch-order-fill.mjs(체결 확인 백그라운드 감시)는 KIS 전용 구현이라 NH 주문에는
//     아직 대응하는 게 없다 — 실주문 접수(brokerOrderId)까지만 확인하고, 실제 체결
//     여부는 카카오 알림 파싱 경로(parse-notifications-to-vault.mjs)에 의존한다.
//
// 사용법:
//   node scripts/tools/execute-asset-allocation-proposal.mjs
//   node scripts/tools/execute-asset-allocation-proposal.mjs --proposal-id=<id>
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseProposal, proposalMatchKey, updateProposalRecord } from '../lib/proposal-vault.mjs';
import { executeProposal } from '../lib/execute-proposal.mjs';
import { isApprovalStale } from '../lib/order-gate.mjs';
import { buildGateInput } from '../lib/proposal-execution-input.mjs';
import { getExecutionMode, MODE_LIVE } from '../lib/shadow-mode.mjs';
import { writeStateFile } from '../lib/state-writer.mjs';
import { loadExecutedOrderIds, recordExecutedOrder, unrecordExecutedOrder } from '../lib/executed-orders.mjs';
import { VAULT_PATHS } from '../lib/vault-paths.mjs';
import { sendTelegram } from '../lib/telegram.mjs';
import { formatDepartmentMessage } from '../lib/telegram-messages.mjs';
import { getCodeRegistry } from '../lib/stock-registry.mjs';
import {
  INSTRUMENT_TYPE, buildHoldingsIndex, classifyAssetAllocationInstrument,
} from '../lib/asset-allocation-instrument-router.mjs';
import { normalizeKrHoldings, normalizeGbHoldings, normalizeGoldHoldings } from '../lib/nh-holdings-normalize.mjs';
import { extractNhPrice, extractNhCashDeposit } from '../lib/nh-response-parse.mjs';
import { canonName } from '../../src/lib/stockIdentity.js';
import { hasNhplugCredentials, loadNhplugCredentials, getNhToken, listNhAccounts } from '../lib/nhplug.mjs';
import { resolveNhAccountsByLabel } from '../lib/nh-accounts.mjs';
import { getKrBalance, getKrCurrentPrice, placeKrCashBuyOrder, placeKrCashSellOrder } from '../lib/nhplug-krstock.mjs';
import { getGbBalance, getGbCurrentPrice, placeGbBuyOrder, placeGbSellOrder } from '../lib/nhplug-gbstock.mjs';
import { getGoldBalance, getGoldCurrentPrice, placeGoldBuyOrder, placeGoldSellOrder } from '../lib/nhplug-krgold.mjs';

// execute-quant-proposal.mjs와 동일 원칙 — 이 잡의 알림 3종(만료·정합성 경고·검문소
// 차단)은 전부 결정론적 Node 판정이지 부서(LLM) 판단이 아니라 무(無)부서 인프라
// 알림으로 운영실 Hermes 라벨을 공유한다.
const DEPARTMENT_LABEL = '운영실 Hermes';
// 위탁·금현물만 — 연금저축은 오너 지시로 리마인더 전용 유지(자동체결 대상 아님).
// ISA도 결과적으로 빠지지만 이유가 다르다 — NH PLUG API(/n2/acctinfo)가 ISA 계좌
// 자체를 노출하지 않아(2026-09-03 라이브 확인, nh-accounts.mjs 헤더 주석 참고)
// 배선할 방법이 없다(2026-09-06 코드리뷰 지적으로 이유 명시).
const ALLOWED_NH_ACCOUNTS = new Set(['위탁', '금현물']);

function parseArgs(argv) {
  const out = {};
  for (const a of argv) {
    const m = a.match(/^--([a-z-]+)=(.*)$/s);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

function loadProposals(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => {
      const content = readFileSync(join(dir, f), 'utf8');
      return { filename: f, content, ...parseProposal(content) };
    });
}

function readStateFileOrNull(filepath) {
  try { return readFileSync(filepath, 'utf8'); } catch { return null; }
}

// 콤마 포함 문자열도 안전하게 숫자로(구글시트 숫자 파싱 함정과 동일 클래스 —
// extractNhCashDeposit과 같은 방어를 fc_dca(KRW 계좌잔고 필드가 아니라 외화 필드라
// 그 함수를 그대로 못 씀)에도 적용). null/NaN이면 null(0으로 추정 안 함).
function parseNhNumber(raw) {
  if (raw == null) return null;
  const n = Number(String(raw).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

// 순수함수(테스트 가능) — 해외주식 매수 가용현금 = fc_dca(API로 확인되는 미투자
// 외화현금) + State/Holdings/위탁-외화-RP.md의 qty(오너가 수동 갱신하는 RP 잔고).
// ⚠️ 2026-09-06 정정 — 원래 fc_abk_amt(외화보관금액)를 RP 포함 가용현금으로
// 잘못 썼다가, 오너가 준 실제 NH 앱 스크린샷 대조 + nhplug.com 공식 API 문서
// 확인 결과 fc_abk_amt는 "외화장부금액"(보유 해외주식 매입원가)이지 예수금이
// 아님을 확인했다(앱의 "매입금액 18,416.20"과 정확히 일치). 외화RP는 이 API가
// 다루는 6개 대분류(국내/해외 주식·파생, 장내채권, 금현물) 전체에 도메인 자체가
// 없어 API로 조회가 불가능 — 오너가 "외화 상품매도·환전 직후 RP를 수동으로
// 업데이트"하기로 확정(2026-09-06)했으므로 그 Vault 값을 신뢰한다. gbBalanceBody가
// 없으면(조회 실패) null(0으로 추정 안 함) — fc_dca가 있으면 RP qty는 없어도(null)
// 0으로 더한다(RP를 아직 한 번도 수동 기록 안 한 신규 계좌 등 정상 상태 포함).
export function computeOverseasCash({ gbBalanceBody, holdingsIndex }) {
  if (!gbBalanceBody) return null;
  const fcDca = parseNhNumber(gbBalanceBody.Output_0?.fc_dca);
  if (fcDca == null) return null;
  const manualRpQty = holdingsIndex.get(canonName('외화 RP'))?.qty;
  return fcDca + (Number.isFinite(manualRpQty) ? manualRpQty : 0);
}

// 순수함수(테스트 가능) — 수량/가격 미정 제안(정성적 갭 신호 — 아직 구체적 수량·
// 가격이 확정되지 않은 자산분배 초기 제안, 실측: TIGER-KRX금현물 20260823 건 등)을
// 걸러낸다. buildGateInput의 orderCost=quantity*proposedPrice가 NaN이 되면
// checkHoldingsConsistency의 매수 분기(orderCost > availableCash)가 항상 false(NaN
// 비교)로 나와 검문소를 잘못 통과시킬 위험이 있어 이 필터가 그 이전에 반드시 걸린다.
export function filterExecutableProposals(proposals, { log = () => {} } = {}) {
  return proposals.filter((p) => {
    if (p.quantity == null || p.proposedPrice == null) {
      log(`  ℹ️ ${p.id} — 수량/가격 미정(정성적 제안) — 자동체결 대상 아님, 건너뜀`);
      return false;
    }
    return true;
  });
}

// 순수함수(테스트 가능) — 분류된 자산군별로 알맞은 예수금 풀을 고른다. 세 풀은
// 서로 다른 계좌·통화라(2026-09-05/06 실측 확인) 잘못 고르면 엉뚱한 풀 잔고로
// 매수 가능 여부를 판정하게 된다(2026-09-06 코드리뷰 M3 지적 — 알 수 없는 자산군은
// 조용히 아무 풀에나 매칭하지 않고 명시적으로 throw).
export function selectCashPool(instrumentType, { krCash, gbCash, goldCash }) {
  if (instrumentType === INSTRUMENT_TYPE.KR_STOCK) return krCash;
  if (instrumentType === INSTRUMENT_TYPE.OVERSEAS_STOCK) return gbCash;
  if (instrumentType === INSTRUMENT_TYPE.GOLD) return goldCash;
  throw new Error(`알 수 없는 자산군: ${instrumentType}`);
}

// classification.type별 현재가·잔고·주문함수를 한데 묶는다(if/else 반복을 호출부
// 여러 곳에 복붙하지 않기 위함) — token/actNo/prefetched 잔고는 배치 단위 상수라
// 클로저로 캡처. ⚠️ 현재가는 반드시 extractNhPrice로 검증한다(2026-09-06 코드리뷰
// HIGH 지적 — NH 시세 필드는 문자열로 온다, 검증 없이 그대로 넘기면 checkPriceDeviation
// 의 Number.isFinite 검사에서 항상 false가 돼 모든 제안이 "현재가 조회 실패"로
// 오판됐었다). 알 수 없는 type은 명시적으로 throw(2026-09-06 코드리뷰 M3 지적 —
// 예전엔 KR/해외 둘 다 아니면 조용히 GOLD로 폴스루해, 나중에 자산군이 추가되면
// 엉뚱하게 금현물 API로 주문이 나갈 위험이 있었다).
function resolveInstrumentContext(classification, { token, actNoByLabel, krHoldings, gbHoldings, goldHoldings }) {
  const actNo = actNoByLabel.get(classification.nhAccountLabel);
  if (classification.type === INSTRUMENT_TYPE.KR_STOCK) {
    return {
      actNo, holdings: krHoldings,
      getCurrentPrice: async () => extractNhPrice((await getKrCurrentPrice({ token, iemCd: classification.iemCd })).Output_0, 'stck_prpr'),
      placeBuy: placeKrCashBuyOrder, placeSell: placeKrCashSellOrder,
    };
  }
  if (classification.type === INSTRUMENT_TYPE.OVERSEAS_STOCK) {
    return {
      actNo, holdings: gbHoldings,
      getCurrentPrice: async () => extractNhPrice((await getGbCurrentPrice({ token, iemCd: classification.iemCd })).Output_0, 'trdprc'),
      placeBuy: placeGbBuyOrder, placeSell: placeGbSellOrder,
    };
  }
  if (classification.type === INSTRUMENT_TYPE.GOLD) {
    return {
      actNo, holdings: goldHoldings,
      getCurrentPrice: async () => extractNhPrice((await getGoldCurrentPrice({ token, iemCd: classification.iemCd })).Output_0, 'stck_prpr'),
      placeBuy: placeGoldBuyOrder, placeSell: placeGoldSellOrder,
    };
  }
  throw new Error(`알 수 없는 자산군: ${classification.type}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!hasNhplugCredentials()) {
    console.log('ℹ️ NH PLUG 크리덴셜 미설정 — 스킵');
    return;
  }

  const proposalsDir = VAULT_PATHS.decisions.proposals;
  const all = loadProposals(proposalsDir);
  let targets = all.filter((p) => p.track === '자산분배' && p.status === '승인');

  // 당일 유효기간(오너 확정, execute-quant-proposal.mjs와 동일 정책 — 2026-08-29
  // 자산분배 트랙 감사 당시 이미 자산분배에도 적용 확정된 원칙). 만료 처리는
  // NH 호출 전(네트워크 호출 0)에 걸러낸다.
  const stillFresh = [];
  for (const p of targets) {
    if (!isApprovalStale({ decidedAt: p.decidedAt })) { stillFresh.push(p); continue; }
    const updated = updateProposalRecord(p.content, {
      status: '만료',
      rejectReason: `당일 미체결로 자동 만료 — 승인일(${p.decidedAt}) 안에 체결되지 않음. 여전히 필요하면 새로 제안·승인해 주세요.`,
    });
    await writeStateFile(join(proposalsDir, p.filename), updated);
    console.log(`  ⏳ ${p.id} — 당일 미체결로 자동 만료 처리(재승인 필요)`);
    try {
      await sendTelegram(formatDepartmentMessage({
        departmentLabel: DEPARTMENT_LABEL, tag: '만료',
        body: `<b>승인 만료(자산분배)</b>\n${p.side} ${p.assetKey} ${p.quantity ?? '(수량미정)'}주 (제안 ${p.id})\n` +
          `승인 당일 안에 체결되지 않아 자동 만료되었습니다.\n계속 진행하려면 다시 제안해 주세요.`,
      }));
    } catch (e) { console.error('텔레그램 알림 실패(무시):', e.message); }
  }
  targets = stillFresh;

  if (args['proposal-id']) {
    targets = targets.filter((p) => p.id === args['proposal-id']);
    if (!targets.length) { console.log(`ℹ️ 승인 상태의 자산분배 제안 중 id=${args['proposal-id']} 없음`); return; }
  } else {
    // 단일 활성 제안 원칙 위반 방어 — execute-quant-proposal.mjs와 동일 로직(같은
    // 안건에 "승인"이 2건 이상이면 추정하지 않고 전부 건너뜀).
    const byKey = new Map();
    for (const p of targets) {
      const key = proposalMatchKey(p);
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push(p);
    }
    const duplicates = [...byKey.entries()].filter(([, ps]) => ps.length > 1);
    if (duplicates.length) {
      const lines = duplicates.map(([key, ps]) => `· ${key}: ${ps.map((p) => p.id).join(', ')}`);
      for (const line of lines) console.error(`  ⛔ 같은 안건에 "승인"이 2건 이상 — 추정하지 않고 전부 건너뜀: ${line}`);
      try {
        await sendTelegram(formatDepartmentMessage({
          departmentLabel: DEPARTMENT_LABEL, tag: '경고',
          body: `<b>제안 정합성 이상(자산분배)</b>\n같은 안건에 "승인" 상태가 2건 이상 동시에 있어 자동체결을 보류했습니다.\n` +
            `수동으로 확인 후 하나만 남기고 나머지는 거부/대체 처리해 주세요.\n${lines.join('\n')}`,
        }));
      } catch (e) { console.error('텔레그램 알림 실패(무시):', e.message); }
      const duplicateIds = new Set(duplicates.flatMap(([, ps]) => ps.map((p) => p.id)));
      targets = targets.filter((p) => !duplicateIds.has(p.id));
    }
  }

  targets = filterExecutableProposals(targets, { log: console.log });
  if (!targets.length) { console.log('ℹ️ 체결 대기 중인 승인된 자산분배 제안 없음'); return; }

  const mode = getExecutionMode(readStateFileOrNull(VAULT_PATHS.state.executionMode));

  const { appkey, appsecret } = loadNhplugCredentials();
  const token = await getNhToken({ appkey, appsecret });
  const accounts = await listNhAccounts({ token });
  const actNoByLabel = resolveNhAccountsByLabel(accounts, ALLOWED_NH_ACCOUNTS);

  const holdingsIndex = buildHoldingsIndex();
  const registry = getCodeRegistry();

  // 자산군별 잔고·예수금은 배치 시작 시 1회만 조회(제안마다 반복 조회하지 않음 —
  // execute-quant-proposal.mjs와 동일 절약 원칙). 계좌가 실제로 조회됐을 때만.
  // 셋을 각각 try/catch로 감싸 한 계좌 조회 실패가 배치 전체를 죽이지 않게 한다
  // (2026-09-06 코드리뷰 LOW 지적 — 예전엔 무방비 await라 위탁 조회 1회 실패가
  // 금현물만 관련된 제안까지 전부 막았다).
  const krActNo = actNoByLabel.get('위탁');
  const goldActNo = actNoByLabel.get('금현물');
  let krBalanceBody = null;
  let gbBalanceBody = null;
  let goldBalanceBody = null;
  try { krBalanceBody = krActNo ? await getKrBalance({ token, actNo: krActNo }) : null; } catch (e) { console.error(`  ⚠️ 위탁 국내잔고 조회 실패(무시, 이 배치의 KR_STOCK 제안은 건너뜀): ${e.message}`); }
  // curCd:'USD' 명시(2026-09-06 코드리뷰 H3 지적 — 기본값 'KRW'는 "전체 통화 합산"
  // 의미라 다른 통화 포지션이 생기면 fc_abk_amt가 섞일 위험이 있었다). 라이브 확인
  // (2026-09-06) 결과 이 계좌는 USD 단일 보유라 curCd 값과 무관하게 fc_abk_amt 값
  // 자체는 동일했지만, 의도를 명시해 향후 다통화 보유 시에도 안전하게 한다.
  try { gbBalanceBody = krActNo ? await getGbBalance({ token, actNo: krActNo, curCd: 'USD' }) : null; } catch (e) { console.error(`  ⚠️ 위탁 해외잔고 조회 실패(무시, 이 배치의 OVERSEAS_STOCK 제안은 건너뜀): ${e.message}`); }
  try { goldBalanceBody = goldActNo ? await getGoldBalance({ token, actNo: goldActNo }) : null; } catch (e) { console.error(`  ⚠️ 금현물 잔고 조회 실패(무시, 이 배치의 GOLD 제안은 건너뜀): ${e.message}`); }

  const krHoldings = normalizeKrHoldings(krBalanceBody?.Output_1);
  const gbHoldings = normalizeGbHoldings(gbBalanceBody?.Output_1);
  const goldHoldings = normalizeGoldHoldings(goldBalanceBody?.Output_1);

  // 매수 가용예수금 — 자산군마다 다른 계좌·통화 풀(2026-09-05/06 실측 확인):
  //   - KR_STOCK: 위탁 KRW 예수금 — dca(당일예수금)가 아니라 drn_pbl_amt(출금가능
  //     금액) 우선(reconcile-nh-cash.mjs 2026-09-03 결정과 동일 이유: dca는 결제
  //     T+2 반영 전 값이라 매수 직후 며칠간 부풀려질 수 있음 — extractNhCashDeposit
  //     이 이 우선순위를 담당, 2026-09-06 코드리뷰 H4 지적으로 정정).
  //   - OVERSEAS_STOCK: computeOverseasCash 참고(fc_dca + 오너가 수동 갱신하는
  //     외화 RP Vault 값 — 2026-09-06 정정, 아래 함수 주석에 상세 근거).
  //   - GOLD: 금현물 계좌 자체 KRW 예수금(위와 동일 이유로 drn_pbl_amt 우선, 위탁과
  //     별개 풀).
  const safeExtractCash = (output0) => {
    if (!output0) return null;
    try { return extractNhCashDeposit(output0); } catch (e) { console.error(`  ⚠️ 예수금 파싱 실패(무시): ${e.message}`); return null; }
  };
  let krCash = safeExtractCash(krBalanceBody?.Output_0);
  let gbCash = computeOverseasCash({ gbBalanceBody, holdingsIndex });
  let goldCash = safeExtractCash(goldBalanceBody?.Output_0);

  console.log(`[체결] 모드=${mode} · 대상 ${targets.length}건`);

  for (const proposal of targets) {
    const classification = classifyAssetAllocationInstrument({
      assetKey: proposal.assetKey, holdingsIndex, registry, dartApiKey: process.env.DART_API_KEY,
    });
    if (classification.type === INSTRUMENT_TYPE.UNSUPPORTED) {
      console.log(`  ℹ️ ${proposal.id} — 자동체결 대상 아님(${classification.reason}), 건너뜀(기존 수동 리마인더 흐름 유지)`);
      continue;
    }
    if (!ALLOWED_NH_ACCOUNTS.has(classification.nhAccountLabel)) {
      console.log(`  ℹ️ ${proposal.id} — 분류된 계좌(${classification.nhAccountLabel})가 이 잡의 대상 계좌(위탁·금현물) 밖 — 건너뜀`);
      continue;
    }

    const ctx = resolveInstrumentContext(classification, { token, actNoByLabel, krHoldings, gbHoldings, goldHoldings });
    if (!ctx.actNo) {
      console.log(`  ⚠️ ${proposal.id} — NH 계좌(${classification.nhAccountLabel}) 조회 실패(미등록 가능성), 건너뜀(다음 실행에서 재시도)`);
      continue;
    }

    let currentPrice;
    try {
      currentPrice = await ctx.getCurrentPrice();
    } catch (e) {
      console.log(`  ⚠️ ${proposal.id} — 현재가 조회 실패(${e.message}), 이 제안은 건너뜀(다음 실행에서 재시도)`);
      continue;
    }

    const cash = selectCashPool(classification.type, { krCash, gbCash, goldCash });
    // 예수금 파싱 실패(null)를 0으로 추정해 매수를 기계적으로 막지 않는다 —
    // execute-quant-proposal.mjs와 동일 원칙(ADR 0003 폴백 금지). 매도는 예수금을
    // 안 쓰므로 이 가드 대상이 아니다.
    if (proposal.side === '매수' && cash == null) {
      console.log(`  ⚠️ ${proposal.id} — 예수금 조회 실패(0으로 추정하지 않음), 이 제안은 건너뜀(다음 실행에서 재시도)`);
      continue;
    }

    const killSwitchContent = readStateFileOrNull(VAULT_PATHS.state.killSwitch);
    const alreadyExecutedIds = loadExecutedOrderIds(VAULT_PATHS.state.executedOrders);

    // buildGateInput은 holdings.find(h => h.code === proposal.assetKey)로 보유수량을
    // 찾는다(proposal-execution-input.mjs) — 이 제안의 assetKey는 원본 표기(이름
    // 또는 코드 혼재)라 정규화된 holdings(code=NH iemCd)와 안 맞을 수 있다. assetKey
    // 만 iemCd로 덮은 얕은 복사본을 넘겨 그 룩업만 정확히 맞춘다(다른 필드·원본
    // proposal 객체는 그대로 executeProposal에 넘겨 게이트 판정·기록에 영향 없음).
    // market도 여기서 자산군에 맞게 넘긴다(2026-09-06 코드리뷰 H5 지적 — 기본값
    // 'KR'을 그대로 두면 해외주식이 KR 장중(미국장은 오히려 닫혀있는 시간대)에만
    // 통과하는 거꾸로 된 게이트였다. order-gate.mjs checkMarketOpen이 'US' 분기를
    // 이번에 새로 지원한다).
    const gateInput = buildGateInput({
      proposal: { ...proposal, assetKey: classification.iemCd },
      currentPrice, holdings: ctx.holdings, cash, killSwitchContent, alreadyExecutedIds,
      market: classification.type === INSTRUMENT_TYPE.OVERSEAS_STOCK ? 'US' : 'KR',
    });

    // 실전 모드에서만 실제 NH 주문 — 섀도우 모드는 settleExecution이 애초에 이
    // 함수를 안 부른다(shadow-mode.mjs 분기, execute-quant-proposal.mjs와 동일).
    const liveExecutor = mode === MODE_LIVE
      ? async (p) => {
        const claimed = await recordExecutedOrder(VAULT_PATHS.state.executedOrders, p.id);
        if (!claimed) {
          throw new Error(`이미 다른 실행(동시 실행 또는 직전 처리)이 이 제안을 선점함 — 중복 실주문 방지로 중단: ${p.id}`);
        }
        try {
          const placeFn = p.side === '매수' ? ctx.placeBuy : ctx.placeSell;
          const order = await placeFn({
            token, actNo: ctx.actNo, iemCd: classification.iemCd, quantity: p.quantity, price: p.proposedPrice,
          });
          return {
            brokerOrderId: order.orderNo,
            log: `NH PLUG 실주문 접수 — 주문번호 ${order.orderNo}(${p.side} ${p.assetKey} ${p.quantity}주 @${p.proposedPrice}, ${classification.type})`,
          };
        } catch (e) {
          // confirmedNotSent=true(사전검증 실패·NH 명시적 업무거부)일 때만 롤백+재시도
          // 안전 — 그 외(네트워크 예외·429 등)는 실제로 접수됐을 수 있어 선점 유지
          // (execute-quant-proposal.mjs와 동일 원칙, nhplug-order-safety.mjs 계약).
          if (e.confirmedNotSent) {
            try {
              await unrecordExecutedOrder(VAULT_PATHS.state.executedOrders, p.id);
            } catch (rollbackErr) {
              console.error(`  ⚠️ ${p.id} — 선점 롤백 자체가 실패(수동 확인 필요): ${rollbackErr.message}`);
            }
          } else {
            console.error(`  ⚠️ ${p.id} — 주문 결과 불명(NH 응답을 못 받음, 실제로 접수됐을 수 있음) — 선점 유지, NH 체결내역과 수동 대조 필요`);
          }
          throw e;
        }
      }
      : undefined;

    let result;
    try {
      result = await executeProposal({
        proposal, proposalContent: proposal.content, gateInput, mode, liveExecutor,
      });
    } catch (e) {
      console.log(`  ❌ ${proposal.id} — 실주문 실패(${e.message}), 이 제안은 건너뜀(다음 실행에서 재시도)`);
      continue;
    }

    await writeStateFile(join(proposalsDir, proposal.filename), result.updatedContent);

    if (!result.executed) {
      // 저장된 값을 다시 파싱해서 비교(execute-quant-proposal.mjs와 동일 이유 —
      // 형식이 두 곳에서 갈라지는 걸 원천 차단, 5분/10분마다 도는 무인 재시도라
      // 사유가 안 바뀌면 알림 스팸이 된다).
      const newReason = parseProposal(result.updatedContent).gateBlockedReason ?? '';
      console.log(`  ⛔ ${proposal.id} — 검문소 차단: ${newReason}`);
      if (newReason !== (proposal.gateBlockedReason || '')) {
        try {
          await sendTelegram(formatDepartmentMessage({
            departmentLabel: DEPARTMENT_LABEL, tag: '차단',
            body: `<b>검문소 차단(자산분배)</b>\n${proposal.side} ${proposal.assetKey} ${proposal.quantity}주 (제안 ${proposal.id})\n${newReason}`,
          }));
        } catch (e) { console.error('텔레그램 알림 실패(무시):', e.message); }
      }
    } else {
      console.log(`  ✅ ${proposal.id} — ${result.settlement.status} (${result.settlement.log})`);
      // ⚠️ watch-order-fill.mjs는 KIS 전용이라 여기서 못 띄운다(파일 헤더 주석
      // "알려진 한계" 참고) — 실제 체결 확인은 카카오 알림 파싱 경로에 의존.

      // 배치 내 다음 제안이 같은 풀을 다시 쓸 때를 대비해 이번 체결분을 로컬
      // 스냅샷에 반영(2026-09-06 코드리뷰 M2 지적 — 예전엔 잔고를 배치 시작 시
      // 1회만 읽어, 분기 리밸런싱처럼 같은 배치에 여러 매수가 동시에 승인돼 있으면
      // 예수금 100만원에 60만원짜리 매수 2건이 둘 다 검문소를 통과할 수 있었다).
      // 다음 실행에서는 어차피 NH 실측으로 다시 조회하므로 이 스냅샷은 "같은 배치
      // 안에서만" 유효한 근사치면 충분하다.
      const orderAmount = proposal.quantity * proposal.proposedPrice;
      if (proposal.side === '매수') {
        if (classification.type === INSTRUMENT_TYPE.KR_STOCK && krCash != null) krCash -= orderAmount;
        else if (classification.type === INSTRUMENT_TYPE.OVERSEAS_STOCK && gbCash != null) gbCash -= orderAmount;
        else if (classification.type === INSTRUMENT_TYPE.GOLD && goldCash != null) goldCash -= orderAmount;
      }
      const holdingEntry = ctx.holdings.find((h) => h.code === classification.iemCd);
      const qtyDelta = proposal.side === '매수' ? proposal.quantity : -proposal.quantity;
      if (holdingEntry) holdingEntry.qty += qtyDelta;
      else if (proposal.side === '매수') ctx.holdings.push({ code: classification.iemCd, qty: proposal.quantity });
    }
  }
}

// import.meta.url 가드(execute-quant-proposal.mjs와 동일 이유 — 실제 NH 주문을 내는
// 파일이라, 나중에 순수함수를 뽑아 테스트하려고 import만 해도 main()이 실행돼 실주문이
// 나가는 사고를 원천 차단).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error('\n❌ 오류:', e.message); process.exit(1); });
}
