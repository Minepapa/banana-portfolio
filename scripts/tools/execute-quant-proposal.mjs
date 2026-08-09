#!/usr/bin/env node
// execute-quant-proposal.mjs — 승인된 퀀트 트랙 제안을 검문소에 통과시켜 체결(섀도우모드면
// 로그, 실전모드면 Phase 11 브로커 API로 실제 매수/매도). docs/ARCHITECTURE-V2.md
// "실행 흐름(주문)" 4단계의 구현.
//
// telegram-reply-handler.mjs가 의도적으로 여기까지 안 온다("승인" 상태 전이까지만 책임) —
// 이 스크립트가 nextStep이 요구하는 "현재가·보유수량·예수금 등 실행 시점 데이터"를
// 실제로 모아 execute-proposal.mjs(runExecutionGateChecks)를 호출하는 지점이다.
//
// ✅ 영속 idempotency 저장소(Phase 11, 2026-08-09) — executed-orders.mjs(State/
// ExecutedOrders.md)로 "크래시 후 재실행 시 중복체결" 문제를 해소했다.
//
// ⚠️ 보안리뷰 지적(2026-08-09) 반영 — 두 가지 추가 수정:
// 1) **선점(claim) 시점** — 처음엔 "주문 성공 후 기록"이었는데, 이러면 이 스크립트가 겹쳐
//    실행될 때(수동 중복 실행 등) 두 프로세스가 똑같이 "아직 기록 안 됨" 스냅샷을 보고
//    둘 다 실제 주문을 내버리는 TOCTOU 레이스가 있었다. 지금은 liveExecutor 안에서
//    "선점(recordExecutedOrder) → 성공해야만 실제 주문" 순서로 바꿔, 락으로 직렬화되는
//    선점 자체가 compare-and-set 역할을 한다 — 두 프로세스 중 하나만 선점에 성공하고
//    나머지는 즉시 에러로 중단(placeKrOrder를 아예 호출 안 함). 주문 자체가 실패하면
//    선점을 롤백(unrecordExecutedOrder)해 다음 실행에서 재시도 가능하게 유지.
// 2) **킬스위치·멱등목록 스냅샷 시점** — 배치 시작 시 한 번만 읽으면, 처리 도중 오너가
//    킬스위치를 눌러도 이번 배치의 남은 제안들은 옛 스냅샷으로 계속 통과된다. 이제
//    제안마다 루프 안에서 다시 읽어 "직전 상태"를 반영한다.
// 3) **주문 결과가 "불명"이면(네트워크 예외·응답파싱 실패 등, kis.mjs placeKrOrder의
//    confirmedNotSent 미설정 케이스) 선점을 절대 롤백하지 않는다** — 확실히 미체결임을
//    확인할 수 있을 때(사전검증 실패·KIS 명시적 업무거부)만 롤백+재시도가 안전하다.
//    불명 케이스는 실제로 KIS에 이미 접수됐을 수 있어, 롤백 후 재시도하면 진짜 이중
//    실주문이 될 위험이 있다 — 그 대신 선점을 유지한 채 로그로 "수동 확인 필요"를
//    남기고, Proposal 상태는 그대로 "승인"에 머문다(오너가 KIS 체결내역과 직접 대조).
//
// ⚠️ 알려진 한계(낮은 우선순위, 실전전환 전 참고): 주문이 실제로는 성공하고 선점
// (recordExecutedOrder)까지 기록됐는데 그 직후 Proposal 파일 쓰기(writeStateFile) 전에
// 크래시하면, 재실행 시 멱등체크가 이 제안을 정확히 막아주지만(이중주문 없음 — 안전)
// Proposal 파일 자체는 영원히 "승인" 상태로 남는다(체결 사실이 파일에 안 남음). 자금
// 안전에는 무해하지만(Ledger는 카카오 파싱 경로가 별도로 채움) 제안 장부가 실제 상태와
// 어긋날 수 있다는 뜻 — 발생하면 KIS 체결내역과 State/ExecutedOrders.md를 대조해 수동
// 정합화 필요.
//
// 사용법:
//   node scripts/tools/execute-quant-proposal.mjs                    # 승인 대기 중인 퀀트 제안 전부
//   node scripts/tools/execute-quant-proposal.mjs --proposal-id=<id>  # 특정 제안 하나만
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseProposal } from '../lib/proposal-vault.mjs';
import { executeProposal } from '../lib/execute-proposal.mjs';
import { buildGateInput } from '../lib/proposal-execution-input.mjs';
import { getExecutionMode, MODE_LIVE } from '../lib/shadow-mode.mjs';
import { writeStateFile } from '../lib/state-writer.mjs';
import { loadExecutedOrderIds, recordExecutedOrder, unrecordExecutedOrder } from '../lib/executed-orders.mjs';
import { VAULT_PATHS } from '../lib/vault-paths.mjs';
import {
  hasKisCredentials, loadKisCredentials, loadQuantAccount,
  getKisToken, getKrQuote, getAccountBalance, placeKrOrder,
} from '../lib/kis.mjs';

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

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!hasKisCredentials()) {
    console.log('ℹ️ KIS 크리덴셜 미설정 — 스킵');
    return;
  }
  const quantAccount = loadQuantAccount();
  if (!quantAccount) {
    console.log('ℹ️ 퀀트 계좌정보(quantAccount) 미설정 — 스킵');
    return;
  }

  const proposalsDir = VAULT_PATHS.decisions.proposals;
  const all = loadProposals(proposalsDir);
  let targets = all.filter((p) => p.track === '퀀트' && p.status === '승인');
  if (args['proposal-id']) {
    targets = targets.filter((p) => p.id === args['proposal-id']);
    if (!targets.length) { console.log(`ℹ️ 승인 상태의 퀀트 제안 중 id=${args['proposal-id']} 없음`); return; }
  }
  if (!targets.length) { console.log('ℹ️ 체결 대기 중인 승인된 퀀트 제안 없음'); return; }

  const mode = getExecutionMode(readStateFileOrNull(VAULT_PATHS.state.executionMode));

  const { appkey: quoteAppkey, appsecret: quoteAppsecret } = loadKisCredentials();
  const quoteToken = await getKisToken({ appkey: quoteAppkey, appsecret: quoteAppsecret });

  const { appkey, appsecret, cano, acntPrdtCd } = quantAccount;
  const balanceToken = await getKisToken({ appkey, appsecret });
  const { holdings, cash } = await getAccountBalance({ token: balanceToken, appkey, appsecret, cano, acntPrdtCd });

  // 실전 모드에서만 실제 KIS 주문 API를 호출하는 liveExecutor를 만든다 — 섀도우 모드는
  // settleExecution이 애초에 이 함수를 안 부른다(shadow-mode.mjs 분기). 퀀트 계좌 전용
  // 앱키·토큰(quoteToken이 아니라 balanceToken)으로 주문 — 시세조회 앱과 계좌 앱은
  // 다른 KIS 앱이라 섞어 쓰면 인증 실패(kis.mjs 헤더 주석 참고).
  //
  // 선점(claim)을 실제 주문 직전에 여기서 한다(파일 상단 주석 #1) — 검문소 통과 후
  // settleExecution이 이 함수를 부르는 시점이 "실제로 브로커에 나가기 직전"이라, 여기서
  // recordExecutedOrder가 실패(이미 선점됨)하면 placeKrOrder 자체를 호출하지 않는다.
  const liveExecutor = mode === MODE_LIVE
    ? async (p) => {
      const claimed = await recordExecutedOrder(VAULT_PATHS.state.executedOrders, p.id);
      if (!claimed) {
        throw new Error(`이미 다른 실행(동시 실행 또는 직전 처리)이 이 제안을 선점함 — 중복 실주문 방지로 중단: ${p.id}`);
      }
      try {
        const order = await placeKrOrder({
          token: balanceToken, appkey, appsecret, cano, acntPrdtCd,
          code: p.assetKey, side: p.side, quantity: p.quantity, price: p.proposedPrice,
        });
        return {
          brokerOrderId: order.orderNo,
          log: `KIS 실주문 접수 — 주문번호 ${order.orderNo}(${p.side} ${p.assetKey} ${p.quantity}주 @${p.proposedPrice})`,
        };
      } catch (e) {
        // 코드리뷰 지적(2026-08-09, HIGH) — "주문 실패면 무조건 선점 롤백"은 위험하다.
        // confirmedNotSent=true(kis.mjs가 붙임)일 때만 "확실히 KIS에 안 나갔다"고 믿을 수
        // 있어 롤백+재시도가 안전하다. 그 외(네트워크 예외·응답파싱 실패 등)는 실제로는
        // KIS에 이미 접수됐을 수 있어 롤백하면 다음 실행이 진짜 이중 실주문을 낼 위험이
        // 있다 — 선점을 그대로 둬 재시도를 막고 사람이 KIS 체결내역과 직접 대조하게 한다.
        if (e.confirmedNotSent) {
          try {
            await unrecordExecutedOrder(VAULT_PATHS.state.executedOrders, p.id);
          } catch (rollbackErr) {
            // 롤백 자체가 실패해도 원본 KIS 에러(e)를 덮지 않는다(코드리뷰 MEDIUM 지적 —
            // 이중실패 시 원본 에러가 소실되던 문제) — 여기서 별도로 로그만 남기고 e는
            // 아래에서 그대로 던진다.
            console.error(`  ⚠️ ${p.id} — 선점 롤백 자체가 실패(수동 확인 필요): ${rollbackErr.message}`);
          }
        } else {
          console.error(`  ⚠️ ${p.id} — 주문 결과 불명(KIS 응답을 못 받음, 실제로 접수됐을 수 있음) — 선점 유지, KIS 체결내역과 수동 대조 필요`);
        }
        throw e;
      }
    }
    : undefined;

  console.log(`[체결] 모드=${mode} · 대상 ${targets.length}건`);

  for (const proposal of targets) {
    let currentPrice;
    try {
      ({ price: currentPrice } = await getKrQuote({ token: quoteToken, appkey: quoteAppkey, appsecret: quoteAppsecret, code: proposal.assetKey }));
    } catch (e) {
      console.log(`  ⚠️ ${proposal.id} — 현재가 조회 실패(${e.message}), 이 제안은 건너뜀(다음 실행에서 재시도)`);
      continue;
    }

    // 예수금 파싱 실패(null)를 0으로 추정해 매수를 기계적으로 막지 않는다 — "예수금 없음"과
    // "조회 실패"는 다른 상황이다(ADR 0003 폴백 금지 원칙, kis.mjs parseBalanceResponse의
    // null-vs-0 구분과 동일 정신). 매도는 예수금을 안 쓰므로 이 가드 대상이 아니다.
    if (proposal.side === '매수' && cash == null) {
      console.log(`  ⚠️ ${proposal.id} — 예수금 조회 실패(0으로 추정하지 않음), 이 제안은 건너뜀(다음 실행에서 재시도)`);
      continue;
    }

    // 킬스위치·멱등목록은 제안마다 다시 읽는다(배치 시작 시 1회 스냅샷이면 처리 도중
    // 킬스위치를 눌러도 이번 배치의 남은 제안들에 반영이 안 됨 — 파일 상단 주석 #2).
    const killSwitchContent = readStateFileOrNull(VAULT_PATHS.state.killSwitch);
    const alreadyExecutedIds = loadExecutedOrderIds(VAULT_PATHS.state.executedOrders);

    let result;
    try {
      result = await executeProposal({
        proposal,
        proposalContent: proposal.content,
        gateInput: buildGateInput({ proposal, currentPrice, holdings, cash, killSwitchContent, alreadyExecutedIds }),
        mode,
        liveExecutor,
      });
    } catch (e) {
      // liveExecutor(실제 KIS 주문)가 실패하면 여기서 throw가 전파된다(settleExecution·
      // executeProposal이 이 경우 updatedContent를 안 만든다 — Phase 11 회귀방지, 체결로
      // 위장하지 않음. liveExecutor 자체가 실패 시 선점도 롤백함). Proposal 상태는 그대로
      // "승인"에 남아 다음 실행에서 재시도된다.
      console.log(`  ❌ ${proposal.id} — 실주문 실패(${e.message}), 이 제안은 건너뜀(다음 실행에서 재시도)`);
      continue;
    }

    await writeStateFile(join(proposalsDir, proposal.filename), result.updatedContent);

    if (!result.executed) {
      console.log(`  ⛔ ${proposal.id} — 검문소 차단: ${result.gate.failures.map((f) => `${f.check}(${f.reason})`).join('; ')}`);
    } else {
      console.log(`  ✅ ${proposal.id} — ${result.settlement.status} (${result.settlement.log})`);
    }
  }
}

main().catch((e) => { console.error('\n❌ 오류:', e.message); process.exit(1); });
