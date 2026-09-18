#!/usr/bin/env node
/**
 * 제안모드(허용|금지) 전환 — 2026-08-29. Zeus(상시 세션)가 Frank의 "제안모드 온"/
 * "제안모드 오프" 텍스트를 받으면 이 CLI를 호출한다. State/ProposalMode/ProposalMode.md를
 * 갱신한다 — 킬스위치 전환(kill-switch-cli.mjs)·체결모드 전환(execution-mode-cli.mjs)과
 * 동일 패턴. (구 "제안금지"/"제안요청" — 2026-09-18 세 스위치 명령어를 "OO 온"/
 * "OO 오프" 공통 패턴으로 재통일, 오너 지시. "온"=제안 생성 허용(기본값), "오프"=금지.)
 *
 * ⚠️ 카이로스(돌파매매)는 이 스위치의 영향을 받지 않는다 — 제안 단계 자체가 없는
 * 구조(신호판정 즉시 자동발주)라 "제안 생성"을 막는 이 스위치가 적용될 지점이 없다.
 *
 * 사용법: node scripts/tools/proposal-mode-cli.mjs --text="제안모드 오프"
 */
import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseProposalModeCommand } from '../lib/telegram-messages.mjs';
import { buildProposalModeState, getProposalMode, MODE_ALLOWED, MODE_BLOCKED } from '../lib/proposal-mode.mjs';
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
  const cmd = parseProposalModeCommand(text);

  if (!cmd) {
    console.log(`ℹ️ "${text}"는 제안모드 전환 명령이 아닙니다(정확히 "제안모드 온"/"제안모드 오프"만 인정) — 무시`);
    return;
  }

  const existing = existsSync(VAULT_PATHS.state.proposalMode) ? readFileSync(VAULT_PATHS.state.proposalMode, 'utf8') : null;
  const currentMode = getProposalMode(existing);
  const targetMode = cmd === 'blocked' ? MODE_BLOCKED : MODE_ALLOWED;

  if (currentMode === targetMode) {
    console.log(`ℹ️ 이미 제안 ${targetMode} 상태입니다.`);
    return;
  }

  mkdirSync(dirname(VAULT_PATHS.state.proposalMode), { recursive: true });
  const content = buildProposalModeState({ mode: targetMode, reason: `Frank 명령: "${text}"` });
  await writeStateFile(VAULT_PATHS.state.proposalMode, content);

  if (targetMode === MODE_BLOCKED) {
    console.log('🚫 제안모드 오프 — 이후 new-cash-allocation·rebalance-proposal·퀀트 제안 전부 생성되지 않습니다(기존 대기/승인 제안 처리는 그대로 가능, 카이로스는 영향 없음). 되돌리려면 "제안모드 온" 명령.');
  } else {
    console.log('✅ 제안모드 온 — 자동 제안 생성이 다시 정상적으로 이루어집니다.');
  }
}

main().catch((e) => { console.error('❌ 오류:', e.message); process.exit(1); });
