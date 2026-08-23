#!/usr/bin/env node
/**
 * 체결모드(섀도우|실전) 전환 — Phase 12. Zeus(상시 세션)가 Frank의 "실전전환"/"섀도우전환"
 * 텍스트를 받으면 이 CLI를 호출한다. State/ExecutionMode/ExecutionMode.md를 갱신한다 — 킬스위치
 * 전환(kill-switch-cli.mjs)과 동일한 패턴.
 *
 * ⚠️ 자동전환 없음(구현계획서 Phase 12 원칙) — 오너의 명시적 텍스트 명령으로만 전환된다.
 * 섀도우→실전 전환 자체는 이 스크립트가 판단하지 않는다("준비됐는지"는 오너 판단 —
 * IMPLEMENTATION-PLAN.md Phase 12 완료기준: "오너가 준비됐다고 판단한 시점, 최소 기간
 * 강제 없음"). 실전 전환 시점에 KIS 퀀트 계좌 크리덴셜이 아직 미등록이어도 안전하다 —
 * execute-quant-proposal.mjs가 크리덴셜 없으면 그 자체로 조용히 skip하므로(hasKisCredentials
 * 가드) 이 전환 자체가 즉시 실주문을 유발하지 않는다.
 *
 * 사용법: node scripts/tools/execution-mode-cli.mjs --text="실전전환"
 */
import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseExecutionModeCommand } from '../lib/telegram-messages.mjs';
import { buildExecutionModeState, getExecutionMode, MODE_LIVE, MODE_SHADOW } from '../lib/shadow-mode.mjs';
import { writeStateFile } from '../lib/state-writer.mjs';
import { VAULT_PATHS } from '../lib/vault-paths.mjs';

function parseArgs(argv) {
  const out = {};
  for (const a of argv) {
    const m = a.match(/^--([a-z-]+)=(.*)$/s);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const text = args.text ?? '';
  const cmd = parseExecutionModeCommand(text);

  if (!cmd) {
    console.log(`ℹ️ "${text}"는 체결모드 전환 명령이 아닙니다(정확히 "실전전환"/"섀도우전환"만 인정) — 무시`);
    return;
  }

  const existing = existsSync(VAULT_PATHS.state.executionMode) ? readFileSync(VAULT_PATHS.state.executionMode, 'utf8') : null;
  const currentMode = getExecutionMode(existing);
  const targetMode = cmd === 'live' ? MODE_LIVE : MODE_SHADOW;

  if (currentMode === targetMode) {
    console.log(`ℹ️ 이미 ${targetMode} 모드입니다.`);
    return;
  }

  mkdirSync(dirname(VAULT_PATHS.state.executionMode), { recursive: true });
  const content = buildExecutionModeState({ mode: targetMode, reason: `Frank 명령: "${text}"` });
  await writeStateFile(VAULT_PATHS.state.executionMode, content);

  if (targetMode === MODE_LIVE) {
    console.log('🔴 실전 전환 — 검문소를 통과한 승인된 제안은 이제 실제 KIS 계좌에 매수/매도 주문이 나갑니다. 되돌리려면 "섀도우전환" 명령.');
  } else {
    console.log('🟢 섀도우 전환 — 이후 체결은 실제 주문 없이 로그로만 기록됩니다.');
  }
}

main().catch((e) => { console.error('❌ 오류:', e.message); process.exit(1); });
