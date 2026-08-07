#!/usr/bin/env node
// execute-quant-proposal.mjs — 승인된 퀀트 트랙 제안을 검문소에 통과시켜 체결(섀도우모드면
// 로그, 실전모드면 Phase 11 브로커 API — 아직 없으므로 실전 전환 전까지는 섀도우만 실제로
// 동작). docs/ARCHITECTURE-V2.md "실행 흐름(주문)" 4단계의 구현.
//
// telegram-reply-handler.mjs가 의도적으로 여기까지 안 온다("승인" 상태 전이까지만 책임) —
// 이 스크립트가 nextStep이 요구하는 "현재가·보유수량·예수금 등 실행 시점 데이터"를
// 실제로 모아 execute-proposal.mjs(runExecutionGateChecks)를 호출하는 지점이다.
//
// ⚠️ 알려진 한계(섀도우모드에서는 무해, 실전 전환 전 반드시 재검토): settleExecution 성공과
// 그 결과를 Proposal 파일에 쓰는 것 사이에 크래시가 나면, 재실행 시 상태가 여전히 "승인"
// 이라 같은 제안이 다시 처리될 수 있다(order-gate의 idempotency 체크는 별도의 영속
// "이미체결 ID 목록"이 없으면 이 경우를 못 잡는다 — 지금은 그 목록 자체가 없음). 섀도우
// 모드에서는 중복돼도 로그 한 줄 더 남는 것뿐이라 무해하지만, Phase 11(실주문)+실전전환
// 전에는 영속 idempotency 저장소를 반드시 추가해야 한다.
//
// 사용법:
//   node scripts/tools/execute-quant-proposal.mjs                    # 승인 대기 중인 퀀트 제안 전부
//   node scripts/tools/execute-quant-proposal.mjs --proposal-id=<id>  # 특정 제안 하나만
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseProposal } from '../lib/proposal-vault.mjs';
import { executeProposal } from '../lib/execute-proposal.mjs';
import { buildGateInput } from '../lib/proposal-execution-input.mjs';
import { getExecutionMode } from '../lib/shadow-mode.mjs';
import { writeStateFile } from '../lib/state-writer.mjs';
import { VAULT_PATHS } from '../lib/vault-paths.mjs';
import {
  hasKisCredentials, loadKisCredentials, loadQuantAccount,
  getKisToken, getKrQuote, getAccountBalance,
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
  const killSwitchContent = readStateFileOrNull(VAULT_PATHS.state.killSwitch);

  const { appkey: quoteAppkey, appsecret: quoteAppsecret } = loadKisCredentials();
  const quoteToken = await getKisToken({ appkey: quoteAppkey, appsecret: quoteAppsecret });

  const { appkey, appsecret, cano, acntPrdtCd } = quantAccount;
  const balanceToken = await getKisToken({ appkey, appsecret });
  const { holdings, cash } = await getAccountBalance({ token: balanceToken, appkey, appsecret, cano, acntPrdtCd });

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

    const result = executeProposal({
      proposal,
      proposalContent: proposal.content,
      gateInput: buildGateInput({ proposal, currentPrice, holdings, cash, killSwitchContent }),
      mode,
    });

    await writeStateFile(join(proposalsDir, proposal.filename), result.updatedContent);

    if (!result.executed) {
      console.log(`  ⛔ ${proposal.id} — 검문소 차단: ${result.gate.failures.map((f) => `${f.check}(${f.reason})`).join('; ')}`);
    } else {
      console.log(`  ✅ ${proposal.id} — ${result.settlement.status} (${result.settlement.log})`);
    }
  }
}

main().catch((e) => { console.error('\n❌ 오류:', e.message); process.exit(1); });
