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
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
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
import {
  hasKisCredentials, loadKisCredentials, loadQuantAccount,
  getKisToken, getKrQuote, getAccountBalance, placeKrOrder,
} from '../lib/kis.mjs';

// 이 잡의 운영 알림(승인만료·검문소차단·정합성이상) 3종은 전부 이 파일 안의 순수 Node
// 판정(날짜비교·중복탐지·order-gate.mjs 결정론적 게이트)이 낸 결과다 — 부서(LLM) 판단이
// 개입한 적이 없다. 처음엔(2026-08-17) 퀀트 트랙 소관이라는 이유로 Kairos로 묶었지만,
// 2026-08-23 오너 지적으로 재검토 — order-gate.mjs 자체 헌장이 "어떤 부서도 이 검문소를
// 우회 못한다"고 명시한 무(無)부서 인프라이고, 나머지 두 알림도 같은 성격이라 세 곳
// 전부 job-alerts.mjs·health-watcher.mjs와 같은 카테고리(운영실 Hermes)로 재배정.
// 어느 트랙 주문인지는 본문(track/assetKey)에 그대로 남아 추적성은 안 잃는다.
const DEPARTMENT_LABEL = '운영실 Hermes';

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

  // 당일 유효기간(오너 확정, 2026-08-13) — 승인한 그날(KST) 안에 체결되지 못한 건은
  // 여기서 먼저 걸러 "만료"시킨다. --proposal-id로 특정 제안을 지목했어도 예외
  // 없이 적용(수동 재시도라고 해서 당일유효 원칙을 비켜가면 정책이 두 갈래로 갈라진다).
  // KIS 조회 전(네트워크 호출 0)에 걸러내 만료 건이 섞여 있어도 API 낭비가 없다.
  //
  // ⚠️ 버그 수정(2026-08-13, 독립 코드리뷰 MEDIUM 지적) — 처음엔 status를 "거부"로
  // 썼는데, findRecentRejection(proposal-vault.mjs)이 "거부" 상태를 24시간 재상정
  // 쿨다운 판정에 그대로 쓴다 — decidedAt(승인 시각)을 안 바꾸고 재사용했으므로, 자동
  // 만료 직후 "다시 제안해 주세요" 안내를 그대로 따라 재제안해도 최대 24시간 동안
  // "거부 재상정 쿨다운"에 걸려 차단됐다(오너가 실제 거부한 적이 없는데도). "만료"라는
  // 별개 상태로 분리해 이 쿨다운 로직과 아예 안 엮이게 한다.
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
        departmentLabel: DEPARTMENT_LABEL,
        tag: '만료',
        body: `<b>승인 만료</b>\n${p.side} ${p.assetKey} ${p.quantity}주 (제안 ${p.id})\n` +
          `승인 당일 안에 체결되지 않아 자동 만료되었습니다.\n계속 진행하려면 다시 제안해 주세요.`,
      }));
    } catch (e) { console.error('텔레그램 알림 실패(무시):', e.message); }
  }
  targets = stillFresh;

  if (args['proposal-id']) {
    targets = targets.filter((p) => p.id === args['proposal-id']);
    if (!targets.length) { console.log(`ℹ️ 승인 상태의 퀀트 제안 중 id=${args['proposal-id']} 없음`); return; }
  } else {
    // 단일 활성 제안 원칙(2026-08-13) — findActiveProposal이 이제 '승인'도 활성으로 쳐서
    // 새 제안이 자동으로 대체(supersede)하지만, 이 방어가 배포되기 전 데이터·수동 파일
    // 편집 등으로 그 불변조건이 이미 깨져 같은 안건(track+assetKey+side)에 "승인"이
    // 2건 이상 남아있을 수 있다. --proposal-id 없이 일괄 실행할 때 이런 상태를 만나면
    // 어느 쪽이 맞는 제안인지 추정하지 않고 둘 다 건너뛴다 — 잘못 하나 골라 집행하면
    // 중복 실거래가 되므로, 아무것도 안 하는 쪽이 훨씬 안전하다(ADR 0003 폴백 금지 원칙).
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
          departmentLabel: DEPARTMENT_LABEL,
          tag: '경고',
          body: `<b>제안 정합성 이상</b>\n같은 안건에 "승인" 상태가 2건 이상 동시에 있어 자동체결을 보류했습니다.\n` +
            `수동으로 확인 후 하나만 남기고 나머지는 거부/대체 처리해 주세요.\n${lines.join('\n')}`,
        }));
      } catch (e) { console.error('텔레그램 알림 실패(무시):', e.message); }
      const duplicateIds = new Set(duplicates.flatMap(([, ps]) => ps.map((p) => p.id)));
      targets = targets.filter((p) => !duplicateIds.has(p.id));
    }
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
      // ⚠️ 버그 수정(2026-08-13, 독립 코드리뷰 MEDIUM 지적) — 여기서 별도로 문자열을
      // 다시 조립하면(`${f.check}(${f.reason})`) execute-proposal.mjs가 실제 파일에 쓰는
      // 형식(`${f.check}: ${f.reason}`)과 어긋나 dedup 비교가 매번 "다름"으로 나와
      // 5분마다 알림이 스팸으로 나갔다. 방금 write한 result.updatedContent를 그대로
      // 파싱해 "실제 저장된 값"을 쓴다 — 형식이 두 곳에서 따로 관리되며 갈라지는 걸
      // 원천 차단(단일 진실 소스).
      const newReason = parseProposal(result.updatedContent).gateBlockedReason ?? '';
      console.log(`  ⛔ ${proposal.id} — 검문소 차단: ${newReason}`);
      // 5분마다 도는 무인 재시도(com.banana2.execute-quant, 2026-08-13)라 같은 사유로
      // 계속 막히면 실행마다 알림을 보내면 스팸이 된다 — 차단 사유가 "바뀔 때만" 알린다
      // (최초 차단 포함 — 이전 gateBlockedReason은 이 실행 전 파일 내용이라 바뀌지 않는
      // 한 자연히 dedup됨). 장외시간→장중 전환처럼 사유가 바뀌면 다시 알림이 나간다.
      if (newReason !== (proposal.gateBlockedReason || '')) {
        try {
          await sendTelegram(formatDepartmentMessage({
            departmentLabel: DEPARTMENT_LABEL,
            tag: '차단',
            body: `<b>검문소 차단</b>\n${proposal.side} ${proposal.assetKey} ${proposal.quantity}주 (제안 ${proposal.id})\n${newReason}`,
          }));
        } catch (e) { console.error('텔레그램 알림 실패(무시):', e.message); }
      }
    } else {
      console.log(`  ✅ ${proposal.id} — ${result.settlement.status} (${result.settlement.log})`);
      // 실주문이 실제로 KIS에 접수되면(brokerOrderId 있음) 체결 여부를 아무도 확인 안 하는
      // 갭이 있었다(2026-08-12 발견 — 카카오 알림 파싱이 v2/퀀트 트랙에 배선 안 돼 있어
      // 체결을 시스템이 전혀 모름). watch-order-fill.mjs를 분리된 백그라운드 프로세스로
      // 띄워 KIS 체결내역조회 API로 직접 확인 후 텔레그램으로 알린다 — detached+unref로
      // 이 스크립트(execute-quant-proposal.mjs)가 끝나도 감시가 계속되게 한다.
      if (result.settlement.brokerOrderId) {
        const here = dirname(fileURLToPath(import.meta.url));
        const child = spawn('node', [
          join(here, 'watch-order-fill.mjs'),
          `--order-no=${result.settlement.brokerOrderId}`,
          `--code=${proposal.assetKey}`,
          `--side=${proposal.side}`,
        ], { detached: true, stdio: 'ignore' }); // name 생략 시 watch-order-fill.mjs가 code로 대체(proposal에 별도 종목명 필드 없음)
        // spawn()은 실행 자체가 실패해도(예: node 못 찾음) 동기 throw가 아니라 비동기
        // 'error' 이벤트로만 알려준다 — 리스너가 없으면 unhandled 'error'가 이 프로세스를
        // 죽여 같은 배치의 나머지 제안 처리까지 중단시킨다(코드리뷰 지적, 2026-08-12).
        // 이미 주문 자체는 writeStateFile로 기록 완료된 뒤라 감시 기동 실패는 로그만
        // 남기고 배치는 계속 진행되게 한다.
        child.on('error', (e) => console.error(`  ⚠️ 체결감시 기동 실패(주문 자체는 이미 기록됨): ${e.message}`));
        child.unref();
        console.log(`  👁️ 체결감시 시작(백그라운드) — 주문번호 ${result.settlement.brokerOrderId}`);
      }
    }
  }
}

// import.meta.url 가드(2026-08-23, 독립 코드리뷰 지적 — 실제 KIS 주문을 내는 파일이라
// morning-briefing.mjs 사고의 재발 방지 차원에서 선제 적용) — 지금은 이 파일이 아무것도
// export하지 않아 당장 import될 일은 없지만, 나중에 순수함수를 뽑아 테스트하려고 import만
// 해도 main()이 실행돼 실주문이 나가는 사고를 원천 차단한다.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error('\n❌ 오류:', e.message); process.exit(1); });
}
