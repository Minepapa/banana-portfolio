#!/usr/bin/env node
// 기존 원문 JSONL의 날짜별 파생 요약을 다시 만든다. 기본은 읽기 전용 미리보기다.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VAULT_PATHS } from '../lib/vault-paths.mjs';
import { withLock, writeAtomic } from '../lib/state-writer.mjs';
import { readDailySpending, spendingRawPath, spendingSummaryPath } from '../lib/spending-daily.mjs';

export async function rebuildSpendingSummaries({ spendingDir = VAULT_PATHS.spending,
  apply = false, logger = console } = {}) {
  const dates = [];
  for (const year of readdirSync(spendingDir, { withFileTypes: true })) {
    if (!year.isDirectory() || !/^\d{4}$/.test(year.name)) continue;
    for (const name of readdirSync(join(spendingDir, year.name))) {
      if (/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)) dates.push(name.slice(0, 10));
    }
  }
  let changed = 0;
  for (const date of dates.sort()) {
    const path = spendingSummaryPath(date, spendingDir);
    if (apply) {
      // 수집 잡과 같은 원문 → 요약 락 순서를 지켜 원문 쓰기 중 스냅샷을 피한다.
      await withLock(spendingRawPath(date, spendingDir), () => withLock(path, () => {
        const content = `${JSON.stringify(readDailySpending(date, { spendingDir }), null, 2)}\n`;
        if (!existsSync(path) || readFileSync(path, 'utf8') !== content) {
          writeAtomic(path, content);
          changed += 1;
        }
      }));
    } else changed += 1;
  }
  logger.log(`[spending-summary] dates=${dates.length} ${apply ? 'written' : 'planned'}=${changed} dryRun=${!apply}`);
  return { dates: dates.length, changed, dryRun: !apply };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  rebuildSpendingSummaries({ apply: process.argv.includes('--apply') })
    .catch(() => { console.error('[spending-summary] failed=1'); process.exitCode = 1; });
}
