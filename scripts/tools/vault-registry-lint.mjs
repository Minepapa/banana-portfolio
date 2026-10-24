#!/usr/bin/env node
// 경로 등록부 lint(읽기 전용) — 볼트 전체 노트를 등록부 규칙으로 검사해 위반을 요약한다(D48 ③ 매일 lint).
// 사용법: node scripts/tools/vault-registry-lint.mjs [--list] [--fix]
//   위반마다 추천안(→)을 함께 보인다. --fix는 정보 손실 없는 안전 수정만 적용한다(야간 backup-vault와 같은 함수,
//   30분 안에 고친 파일 제외). --fix 없이는 아무것도 쓰지 않고 "자동 수정 가능" 목록만 보인다.
// 범위 밖: 95_Etna(코드가 쓰는 기계 데이터, 별도 감사)·99_Adyton(내용을 읽지 않음)·숨김 폴더.
import { fileURLToPath } from 'node:url';
import { VAULT_PATHS } from '../lib/vault-paths.mjs';
import { autoFixVault, lintVaultWithSuggestions, recordFixesInClioLog } from '../lib/vault-lint-fix.mjs';

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const apply = process.argv.includes('--fix');
  const fixed = autoFixVault(VAULT_PATHS.root, { dryRun: !apply });
  if (apply && fixed.length) recordFixesInClioLog(VAULT_PATHS.root, fixed);
  if (fixed.length) {
    console.log(`${apply ? '자동 수정함' : '자동 수정 가능(--fix로 적용)'} ${fixed.length}개`);
    for (const { rel, changes } of fixed) console.log(`  ${rel} — ${changes.join(' / ')}`);
    console.log('');
  }
  for (const { rel, error } of fixed.skipped ?? []) console.log(`자동 수정 실패: ${rel} — ${error}`);
  const { checked, results } = lintVaultWithSuggestions(VAULT_PATHS.root);
  const byKind = new Map();
  for (const { rel, problems, suggestions } of results) for (const p of problems) {
    const kind = p.replace(/\(.*\)$/, '').replace(/: .*$/, '').replace(/"[^"]*"/, '"…"');
    if (!byKind.has(kind)) byKind.set(kind, []);
    byKind.get(kind).push(`${rel} — ${p}${suggestions.length ? `\n    → 추천: ${suggestions.join(' / ')}` : ''}`);
  }
  console.log(`검사 ${checked}개 · 위반 노트 ${results.length}개`);
  for (const [kind, items] of [...byKind].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`\n■ ${kind} (${items.length})`);
    for (const line of items.slice(0, process.argv.includes('--list') ? Infinity : 5)) console.log(`  ${line}`);
  }
}
