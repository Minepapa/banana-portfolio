// 구조적 가드(2026-10-10 오너 지시: 텔레그램 입력 규칙이 흩어져 누락되지 않게) —
// 텔레그램 세션이 표준입력 JSON(--json=-)으로 부르는 도구는 전부 볼트 "텔레그램 입력 규칙" 표에 있어야 한다.
// 새 입력 도구를 만들고 표에 행을 더하지 않으면 실패한다. 이 Mac·볼트가 있을 때만 돈다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { VAULT_REL, vaultAbs } from '../lib/vault-paths.mjs';

const RULES = vaultAbs(VAULT_REL.telegramInputRulesFile);
const TOOLS = new URL('.', import.meta.url).pathname;

test('telegram-input-rules-audit: --json=- 도구는 전부 텔레그램 입력 규칙 표에 있다', { skip: !existsSync(RULES) }, () => {
  const rules = readFileSync(RULES, 'utf8');
  const tools = readdirSync(TOOLS).filter((name) => name.endsWith('.mjs') && !name.endsWith('.test.mjs'))
    .filter((name) => readFileSync(join(TOOLS, name), 'utf8').includes("'--json=-'"));
  assert.ok(tools.length >= 4, `--json=- 도구 탐지가 깨졌을 수 있음: ${tools.join(', ')}`);
  const missing = tools.filter((name) => !rules.includes(`\`${name}\``));
  assert.deepEqual(missing, [], `입력 규칙 표에 없는 텔레그램 입력 도구: ${missing.join(', ')} — 90_Delphi/Channels/텔레그램 입력 규칙에 행을 추가할 것`);
});
