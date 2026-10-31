#!/usr/bin/env node
// 소비 설정 파일에 오너가 확정한 표(카드 표·결제수단 별칭·고정비·가맹점 항목)를 넣는다.
// 기본은 미리보기(바뀔 칸만 출력). --apply일 때만 볼트에 쓴다. patch는 칸 단위로 통째로 바꾼다.
//   node scripts/tools/spending-settings.mjs --patch=<patch.json> [--apply]
import { readFileSync } from 'node:fs';
import { VAULT_PATHS } from '../lib/vault-paths.mjs';
import { applySettingsPatch, mergeSettings, readSettingsFile } from '../lib/spending-settings.mjs';

export function runSettingsTool(argv, { spendingDir = VAULT_PATHS.spending, log = console.log } = {}) {
  const args = Object.fromEntries(argv.map((arg) => arg.replace(/^--/, '').split(/=(.*)/s)).map(([key, value]) => [key, value ?? true]));
  const unknown = Object.keys(args).filter((key) => !['patch', 'apply'].includes(key));
  if (unknown.length) throw new Error(`모르는 옵션: ${unknown.join(', ')}`);
  if (typeof args.patch !== 'string') throw new Error('--patch=<patch.json> 필요');
  const patch = JSON.parse(readFileSync(args.patch, 'utf8'));
  if (args.apply !== true) {
    const current = readSettingsFile(spendingDir);
    const next = mergeSettings(current, patch);
    const keys = Object.keys(patch).filter((key) => JSON.stringify(current[key]) !== JSON.stringify(next[key]));
    log(`[spending-settings] 미리보기 — 바뀔 칸: ${keys.length ? keys.join(', ') : '없음'}`);
    for (const key of keys) log(`  ${key}: ${(current[key] ?? []).length}개 → ${next[key].length}개`);
    return { changed: false, keys, preview: true };
  }
  const result = applySettingsPatch(spendingDir, patch);
  log(`[spending-settings] 적용 — ${result.changed ? `바뀐 칸: ${result.keys.join(', ')}` : '바뀐 것 없음'}`);
  return result;
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  try { runSettingsTool(process.argv.slice(2)); }
  catch (error) { console.error('[spending-settings] 실패:', error.message); process.exitCode = 1; }
}
