#!/usr/bin/env node
/**
 * 킬스위치 토글 — Zeus(상시 세션)가 Frank의 "긴급정지"/"STOP"/"정지해제" 텍스트를 받으면
 * 이 CLI를 호출한다. State/KillSwitch.md를 갱신한다. ("정지"/"해제" 단일단어는 일상
 * 대화에 흔해 오작동 위험 있다고 판단, 2026-08-12 오너 확정으로 복합어 교체.)
 *
 * 사용법: node scripts/tools/kill-switch-cli.mjs --text="긴급정지"
 */
import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseKillSwitchCommand } from '../lib/telegram-messages.mjs';
import { buildKillSwitchState, isKillSwitchActive } from '../lib/kill-switch.mjs';
import { writeStateFile } from '../lib/state-writer.mjs';
import { VAULT_PATHS } from '../lib/vault-paths.mjs';

const KILL_SWITCH_PATH = join(VAULT_PATHS.root, 'State', 'KillSwitch.md');

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
  const cmd = parseKillSwitchCommand(text);

  if (!cmd) {
    console.log(`ℹ️ "${text}"는 킬스위치 명령이 아닙니다(정확히 "긴급정지"/"STOP"/"정지해제"만 인정) — 무시`);
    return;
  }

  const existing = existsSync(KILL_SWITCH_PATH) ? readFileSync(KILL_SWITCH_PATH, 'utf8') : null;
  const wasActive = isKillSwitchActive(existing);

  if (cmd === 'activate') {
    if (wasActive) { console.log('⚠️ 킬스위치는 이미 켜져 있습니다.'); return; }
    mkdirSync(VAULT_PATHS.root + '/State', { recursive: true });
    const content = buildKillSwitchState({ active: true, reason: `Frank 명령: "${text}"` });
    await writeStateFile(KILL_SWITCH_PATH, content);
    console.log('🛑 킬스위치 활성화 — 모든 자동 체결이 중단됩니다(새 제안 생성은 계속됨). 해제는 "정지해제" 명령으로만.');
    return;
  }

  // deactivate
  if (!wasActive) { console.log('ℹ️ 킬스위치는 이미 꺼져 있습니다.'); return; }
  mkdirSync(VAULT_PATHS.root + '/State', { recursive: true });
  const content = buildKillSwitchState({ active: false, reason: `Frank 명령: "${text}"` });
  await writeStateFile(KILL_SWITCH_PATH, content);
  console.log('✅ 킬스위치 해제 — 자동 실행이 재개됩니다. 자동 재개는 없습니다(항상 명시적 명령 필요).');
}

main().catch((e) => { console.error('❌ 오류:', e.message); process.exit(1); });
