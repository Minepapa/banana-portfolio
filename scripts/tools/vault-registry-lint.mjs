#!/usr/bin/env node
// 경로 등록부 lint(읽기 전용) — 볼트 전체 노트를 등록부 규칙으로 검사해 위반을 요약한다(D48 ③ 매일 lint).
// 사용법: node scripts/tools/vault-registry-lint.mjs [--list]
// 범위 밖: 95_Etna(코드가 쓰는 기계 데이터, 별도 감사)·99_Adyton(내용을 읽지 않음)·숨김 폴더.
import { fileURLToPath } from 'node:url';
import { VAULT_PATHS } from '../lib/vault-paths.mjs';
import { lintVault } from '../lib/vault-registry.mjs';

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { checked, results } = lintVault(VAULT_PATHS.root);
  const byKind = new Map();
  for (const { rel, problems } of results) for (const p of problems) {
    const kind = p.replace(/\(.*\)$/, '').replace(/: .*$/, '').replace(/"[^"]*"/, '"…"');
    if (!byKind.has(kind)) byKind.set(kind, []);
    byKind.get(kind).push(`${rel} — ${p}`);
  }
  console.log(`검사 ${checked}개 · 위반 노트 ${results.length}개`);
  for (const [kind, items] of [...byKind].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`\n■ ${kind} (${items.length})`);
    for (const line of items.slice(0, process.argv.includes('--list') ? Infinity : 5)) console.log(`  ${line}`);
  }
}
