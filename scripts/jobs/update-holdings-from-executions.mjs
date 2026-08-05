#!/usr/bin/env node
/**
 * 신규 체결(카카오 파싱, 라이브) → State/Holdings 반영 (구현계획서 Phase 8)
 *
 * Phase 2가 "계좌 귀속·보유종목갱신은 Phase 8·9 몫"이라며 의도적으로 비워둔 부분을
 * 마저 연결한다. docs/ARCHITECTURE-V2.md "체결 기록 권위 소스" 절의 원칙(State는 항상
 * 실제 체결량 그대로)을 수행하는 잡.
 *
 * 범위: Facts/Ledger/Executions 중 legacy(Phase 7 마이그레이션 스냅샷)가 아니고 아직
 * holdingsApplied 안 된 것만 대상 — legacy는 이미 그 시점 스냅샷이 State/Holdings로
 * 직접 옮겨졌으므로 체결을 다시 재생하면 이중 반영된다(제외 이유).
 *
 * ⚠️ 실행 시작 시 항상 먼저 로트 통합(consolidateLots)부터 한다 — 독립 코드리뷰
 * (oh-my-claudecode:code-reviewer) 지적, 2026-08-05: Phase 7 마이그레이션이 계좌당
 * 종목 하나에 여러 파일(예: 위탁 삼성전자 40주@50,450원 + 30주@54,700원 로트 2개)을
 * 만들어둔 경우가 있는데, 원래는 (계좌,종목)키로 Map을 만들 때 나중 로트가 앞 로트를
 * 조용히 덮어써 새 체결이 들어오면 한쪽 로트가 통째로 유실되는 심각한 버그가 있었다
 * (Phase 7 로트유실 사고와 같은 클래스가 다른 자리에서 재발). 통합 후엔 계좌당 종목
 * 하나 = 파일 하나 불변식이 항상 성립한다.
 *
 * 계좌 귀속: account-resolver.mjs — 삼성증권→연금저축·한국투자증권→IRP는 확정, NH는
 * 기존 State/Holdings 보유현황(+stockCode/ticker 일치)으로 좁힌다. 그래도 못 풀리면
 * (신규 종목 첫 매수 등) **추정하지 않고 건너뛴다** — holdingsApplied를 안 찍어서 다음
 * 실행에서 다시 시도되고(그 사이 수동으로 보유 파일을 만들어두면 풀릴 수 있음), warning
 * 으로 로그에 남는다.
 *
 * 매수: 가중평균 합침(holdings-updater.mjs applyBuy). 매도: 평단가 유지+수량비례축소,
 * 실현손익을 Facts/Ledger/Profits에 별도 기록(applySell). 매도수량이 보유수량을
 * 초과하면(데이터 불일치) 마찬가지로 추정하지 않고 건너뛴다.
 *
 * 멱등: 체결 파일의 holdingsApplied 플래그가 1차 방어, 보유 파일의 appliedDedupKeys
 * (체결 dedupKey 목록)가 2차 방어다(코드리뷰 지적, 2026-08-05) — 보유 파일 쓰기는
 * 성공했는데 그 직후 플래그 쓰기가 실패/중단되면, 다음 실행에서 같은 체결이 다시
 * 선택되지만 보유 쪽 appliedDedupKeys가 이미 그 dedupKey를 갖고 있으면 재적용 없이
 * 플래그만 (재)기록한다 — 수량이 두 번 반영되는 사고를 막는다.
 *
 * 사용법:
 *   node scripts/jobs/update-holdings-from-executions.mjs            # 실제로 반영
 *   node scripts/jobs/update-holdings-from-executions.mjs --dry-run  # 계산만, 쓰기 없음
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { VAULT_PATHS } from '../lib/vault-paths.mjs';
import { parseFrontmatter, updateFrontmatter } from '../lib/vault-frontmatter.mjs';
import { writeAtomic } from '../lib/state-writer.mjs';
import { resolveExecutionAccount } from '../lib/account-resolver.mjs';
import { applyBuy, applySell, consolidateLots } from '../lib/holdings-updater.mjs';
import { buildLiveHoldingRecord, holdingFilename, parseAppliedDedupKeys } from '../lib/holdings-vault-writer.mjs';
import { buildProfitRecord } from '../lib/ledger-vault-writer.mjs';

const DRY_RUN = process.argv.includes('--dry-run');

function readVaultFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => {
    const filepath = join(dir, f);
    const content = readFileSync(filepath, 'utf8');
    return { filepath, content, parsed: parseFrontmatter(content) };
  });
}

export function pickUnprocessedExecutions(executionFiles) {
  return executionFiles
    .filter(({ parsed }) => !parsed.legacy && !parsed.holdingsApplied)
    .sort((a, b) => String(a.parsed.tradeDate).localeCompare(String(b.parsed.tradeDate))
      || String(a.parsed.recordedAt).localeCompare(String(b.parsed.recordedAt)));
}

function writeHolding(holding) {
  const { filename, content, dir } = buildLiveHoldingRecord(holding);
  if (!DRY_RUN) { mkdirSync(dir, { recursive: true }); writeAtomic(join(dir, filename), content); }
}

// 계좌당 종목 하나 = 파일 하나로 수렴시킨다. 여러 로트가 있던 항목은 통합 결과를 쓰고
// 남는 로트 파일을 지운다(전부 --dry-run이면 계산만, 쓰기 없음). 반환: account|name →
// holding(+appliedDedupKeys 배열) Map.
function loadConsolidatedHoldings() {
  const files = readVaultFiles(VAULT_PATHS.state.holdings);
  const groups = new Map();
  for (const f of files) {
    const key = `${f.parsed.account}|${f.parsed.name}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(f);
  }
  const holdingsMap = new Map();
  for (const [key, group] of groups) {
    const merged = consolidateLots(group.map((f) => f.parsed));
    if (group.length > 1) {
      console.log(`  🔀 로트 통합: ${key} (${group.length}개 파일 → 1개, 합산 ${merged.qty}주)`);
      writeHolding(merged);
      for (const f of group) {
        const survivingFilename = join(VAULT_PATHS.state.holdings, holdingFilename(merged.account, merged.name));
        if (f.filepath !== survivingFilename && !DRY_RUN) rmSync(f.filepath, { force: true });
      }
    }
    holdingsMap.set(key, { ...merged, appliedDedupKeys: parseAppliedDedupKeys(merged) });
  }
  return holdingsMap;
}

async function main() {
  const executionFiles = readVaultFiles(VAULT_PATHS.facts.ledger.executions);
  const targets = pickUnprocessedExecutions(executionFiles);
  console.log(`🔎 미처리 체결 ${targets.length}건 (전체 ${executionFiles.length}건 중)`);

  const holdingsMap = loadConsolidatedHoldings();
  if (targets.length === 0) { console.log('처리할 게 없습니다.'); return; }

  let buys = 0, sells = 0, closed = 0, unresolvedAccount = 0, warnings = 0, alreadyApplied = 0, totalRealizedProfit = 0;

  for (const { filepath, content, parsed: exec } of targets) {
    const currentHoldings = [...holdingsMap.values()];
    const account = exec.account || resolveExecutionAccount({ broker: exec.broker, stockName: exec.stockName, stockCode: exec.stockCode }, currentHoldings);
    if (!account) {
      console.log(`  ⚠️  계좌 귀속 불가 — 건너뜀: ${exec.tradeDate} ${exec.tradeType} ${exec.stockName} (${exec.broker})`);
      unresolvedAccount++;
      continue;
    }

    const key = `${account}|${exec.stockName}`;
    const existing = holdingsMap.get(key) ?? null;
    const execWithAccount = { ...exec, account };

    // 2차 방어: 이 체결이 이미 이 보유에 반영된 적 있으면(플래그 기록이 중간에 실패했던
    // 경우) 재적용하지 않고 플래그만 다시 찍는다.
    if (existing?.appliedDedupKeys?.includes(exec.dedupKey)) {
      console.log(`  ↩️  이미 반영된 체결(재시도) — 재적용 없이 플래그만 기록: ${exec.stockName}`);
      alreadyApplied++;
      if (!DRY_RUN) writeAtomic(filepath, updateFrontmatter(content, { holdingsApplied: true, holdingsAppliedAt: new Date().toISOString() }));
      continue;
    }

    if (exec.tradeType === '매수') {
      const updated = { ...applyBuy(existing, execWithAccount), appliedDedupKeys: [...(existing?.appliedDedupKeys ?? []), exec.dedupKey] };
      console.log(`  + [매수] ${account} ${exec.stockName} ${exec.quantity}주 @${exec.price} → 보유 ${updated.qty}주(평단 ${Math.round(updated.avgPrice)})`);
      writeHolding(updated);
      holdingsMap.set(key, updated);
      buys++;
    } else if (exec.tradeType === '매도') {
      const result = applySell(existing, execWithAccount);
      if (result.warning) {
        console.log(`  ⚠️  ${result.warning} — 건너뜀`);
        warnings++;
        continue;
      }
      console.log(`  - [매도] ${account} ${exec.stockName} ${exec.quantity}주 @${exec.price} → 실현손익 ${Math.round(result.realizedProfit).toLocaleString()}원${result.closed ? ' (전량청산)' : ''}`);
      totalRealizedProfit += result.realizedProfit;
      if (!DRY_RUN) {
        const { filename: pFilename, content: pContent, dir: pDir } = buildProfitRecord(execWithAccount, existing.avgPrice, result.realizedProfit);
        mkdirSync(pDir, { recursive: true });
        writeAtomic(join(pDir, pFilename), pContent);
      }
      if (result.closed) {
        if (!DRY_RUN) rmSync(join(VAULT_PATHS.state.holdings, holdingFilename(account, exec.stockName)), { force: true });
        holdingsMap.delete(key);
        closed++;
      } else {
        const updated = { ...result.updatedHolding, appliedDedupKeys: [...(existing?.appliedDedupKeys ?? []), exec.dedupKey] };
        writeHolding(updated);
        holdingsMap.set(key, updated);
      }
      sells++;
    } else {
      console.log(`  ⚠️  알 수 없는 tradeType(${exec.tradeType}) — 건너뜀`);
      continue;
    }

    if (!DRY_RUN) writeAtomic(filepath, updateFrontmatter(content, { holdingsApplied: true, holdingsAppliedAt: new Date().toISOString() }));
  }

  console.log(
    `\n📊 매수 ${buys}건 · 매도 ${sells}건(전량청산 ${closed}건, 실현손익 합계 ${Math.round(totalRealizedProfit).toLocaleString()}원) · ` +
    `계좌귀속불가 ${unresolvedAccount}건 · 경고스킵 ${warnings}건 · 재시도(이미반영) ${alreadyApplied}건` + (DRY_RUN ? ' (드라이런 — 쓰기 없음)' : ''),
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error('\n❌ 오류:', e.message); process.exit(1); });
}
