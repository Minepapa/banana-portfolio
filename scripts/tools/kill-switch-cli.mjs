#!/usr/bin/env node
/**
 * 킬스위치 토글 — Zeus(상시 세션)가 Frank의 "긴급정지"/"STOP"/"정지해제" 텍스트를 받으면
 * 이 CLI를 호출한다. State/KillSwitch/KillSwitch.md를 갱신한다. ("정지"/"해제" 단일단어는 일상
 * 대화에 흔해 오작동 위험 있다고 판단, 2026-08-12 오너 확정으로 복합어 교체.)
 *
 * 사용법: node scripts/tools/kill-switch-cli.mjs --text="긴급정지"
 */
import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseKillSwitchCommand } from '../lib/telegram-messages.mjs';
import { buildKillSwitchState, isKillSwitchActive } from '../lib/kill-switch.mjs';
import { writeStateFile } from '../lib/state-writer.mjs';
import { VAULT_PATHS } from '../lib/vault-paths.mjs';

// ⚠️ 2026-08-23 코드리뷰 지적으로 수정 — 이 파일이 VAULT_PATHS.state.killSwitch를 안 쓰고
// 여기서만 별도로 경로를 조립해왔다(execute-quant-proposal.mjs는 반대로 공용 상수를
// 읽음). 지금까지는 두 값이 우연히 같은 문자열이라 무해했지만, State/ 구조 개편(단일
// 상태 파일도 자기 폴더를 갖도록 통일)으로 공용 상수 쪽 값이 바뀌면서 이 로컬 상수를
// 안 고치면 "쓰기는 옛 경로, 읽기는 새 경로"로 갈라져 킬스위치가 조용히 무력화되는
// 사고가 날 뻔했다 — 아예 공용 상수 하나로 합쳐 이 클래스의 드리프트를 원천 차단한다.
const KILL_SWITCH_PATH = VAULT_PATHS.state.killSwitch;

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
    mkdirSync(dirname(KILL_SWITCH_PATH), { recursive: true });
    const content = buildKillSwitchState({ active: true, reason: `Frank 명령: "${text}"` });
    await writeStateFile(KILL_SWITCH_PATH, content);
    console.log('🛑 킬스위치 활성화 — 모든 자동 체결이 중단됩니다(새 제안 생성은 계속됨). 해제는 "정지해제" 명령으로만.');
    return;
  }

  // deactivate
  if (!wasActive) { console.log('ℹ️ 킬스위치는 이미 꺼져 있습니다.'); return; }
  mkdirSync(dirname(KILL_SWITCH_PATH), { recursive: true });
  const content = buildKillSwitchState({ active: false, reason: `Frank 명령: "${text}"` });
  await writeStateFile(KILL_SWITCH_PATH, content);
  console.log('✅ 킬스위치 해제 — 자동 실행이 재개됩니다. 자동 재개는 없습니다(항상 명시적 명령 필요).');
}

main().catch((e) => { console.error('❌ 오류:', e.message); process.exit(1); });
