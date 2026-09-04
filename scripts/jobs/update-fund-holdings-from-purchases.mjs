#!/usr/bin/env node
/**
 * 정기적립식 펀드(VIP펀드, 연금저축) 매수 알림 → State/Holdings 누적 반영.
 *
 * ⚠️ 왜 이 잡이 필요했나(2026-09-04, 오너 발견) — `Facts/Ledger/FundPurchases`(펀드적립
 * 카카오 "매수 완료 안내" 알림, 2026-08-21부터 배선돼 매달 1일경 200,000원 정기적립을
 * 정확히 파싱·기록 중이었음, 실측 확인)를 **읽어서 State/Holdings의 qty·invest를 실제로
 * 갱신하는 잡이 어디에도 없었다.** `update-holdings-prices.mjs`(30분마다)는 시세
 * (curPrice)만 갱신하고 qty·invest는 그대로 두는 설계라(recomputeValuation 참고) 이
 * 둘이 만나는 지점이 애초에 빠져있던 것 — 카카오는 정확히 기록하고 있었는데 그 기록을
 * 아무도 State에 옮기지 않고 있었다. 그 결과 카카오 펀드평가 알림의 원금(13,000,000원)
 * 과 State의 invest(12,800,000원)가 200,000원(=한 번의 미반영 적립) 차이났다.
 *
 * 정본/검증 역할 분리(2026-09-04 오너 확정) — 오너가 "펀드평가 알림의 이전달·이번달
 * 원금 차이로 매수액을 역산하면 되지 않나"고 제안했으나, FundPurchases가 이미 파싱
 * 시점에 정확한 금액·NAV·좌수를 확보하고 있어(카카오 "매수 완료 안내"는 좌수까지
 * 원문에 있음) 델타로 근사할 이유가 없다는 데 동의 — **FundPurchases가 State/Holdings
 * qty·invest의 정본**, FundValuations(월간 정기평가 스냅샷)는 그 결과를 검증하는
 * 안전망으로만 쓴다(원금 불일치 감지 시 경고, checkFundValuationDrift 참고). 이걸로
 * `Log/Strategy/2026-09-02-NH-API-우선-KIS-카카오파싱-역할축소-결정.md`가 구현 시점
 * 판단으로 미뤄뒀던 설계 질문("검증용 vs 정본")이 확정된다.
 *
 * 멱등: `Facts/Ledger/FundPurchases` 파일의 `holdingsApplied` 플래그(update-holdings-
 * from-executions.mjs와 동일 관례) — 같은 매수를 두 번 누적 반영하지 않는다.
 *
 * 순서: 매수는 여러 건이 동시에 밀려있을 수 있으므로(잡이 며칠 못 돌았거나 첫 배선
 * 시점) 반드시 date 오름차순으로 하나씩 순서대로 누적한다 — 순서가 바뀌어도 최종
 * 합계(qty·invest)는 같지만, 중간에 실패해 일부만 반영된 경우 감사 추적이 뒤틀리지
 * 않게 하기 위함.
 *
 * 사용법:
 *   node scripts/jobs/update-fund-holdings-from-purchases.mjs            # 실제 반영
 *   node scripts/jobs/update-fund-holdings-from-purchases.mjs --dry-run  # 반영 대상만 출력
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { VAULT_PATHS } from '../lib/vault-paths.mjs';
import { parseFrontmatter, updateFrontmatter } from '../lib/vault-frontmatter.mjs';
import { writeAtomic } from '../lib/state-writer.mjs';
import { applyFundPurchase, checkFundValuationDrift, isValuationStale } from '../lib/fund-holdings-updater.mjs';
import { writeHoldingSafely, holdingFilename } from '../lib/holdings-vault-writer.mjs';
import { collectWarning, flushWarnings } from '../lib/job-alerts.mjs';
import { FUND_PURCHASE_ACCOUNT } from '../lib/account-resolver.mjs';

const DRY_RUN = process.argv.includes('--dry-run');
// update-holdings-prices.mjs의 VIP_FUND_NAME과 동일 상수(이 계좌엔 이 펀드 하나뿐 —
// fund-holdings-updater.mjs checkFundValuationDrift 헤더 주석 참고, 이름매칭 안 함).
const VIP_FUND_NAME = 'VIP한국형가치투자증권자투자신탁(주식)-C-Pe';

// 순수함수(테스트 가능) — 아직 holdings 반영 안 된 펀드 매수 기록, date 오름차순.
export function readUnappliedFundPurchases(dir = VAULT_PATHS.facts.ledger.fundPurchases) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.md'))
    .map((f) => {
      const content = readFileSync(join(dir, f), 'utf8');
      return { filepath: join(dir, f), content, parsed: parseFrontmatter(content) };
    })
    .filter(({ parsed }) => !parsed.holdingsApplied)
    .sort((a, b) => (a.parsed.date < b.parsed.date ? -1 : a.parsed.date > b.parsed.date ? 1 : 0));
}

function readFundHolding() {
  const filepath = join(VAULT_PATHS.state.holdings, holdingFilename(FUND_PURCHASE_ACCOUNT, VIP_FUND_NAME));
  if (!existsSync(filepath)) return null;
  return parseFrontmatter(readFileSync(filepath, 'utf8'));
}

function readLatestFundValuation() {
  const dir = VAULT_PATHS.facts.ledger.fundValuations;
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter((f) => f.endsWith('.md'));
  if (!files.length) return null;
  const parsed = files.map((f) => parseFrontmatter(readFileSync(join(dir, f), 'utf8')));
  return parsed.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))[0];
}

// 이미 holdingsApplied:true인 매수들(과거 실행분 포함) 중 가장 최근 date — isValuationStale
// 판단의 시작점. 이번 실행에서 새로 반영하는 매수 날짜는 main()의 루프가 이 값 위에
// 계속 이어서 갱신한다(과거+이번 실행분 합쳐 항상 "지금까지 반영된 매수 중 최신"을 유지).
export function latestPreviouslyAppliedDate(dir = VAULT_PATHS.facts.ledger.fundPurchases) {
  if (!existsSync(dir)) return null;
  const applied = readdirSync(dir).filter((f) => f.endsWith('.md'))
    .map((f) => parseFrontmatter(readFileSync(join(dir, f), 'utf8')))
    .filter((p) => p.holdingsApplied);
  if (!applied.length) return null;
  return applied.reduce((max, p) => (p.date > max ? p.date : max), applied[0].date);
}

async function main() {
  const targets = readUnappliedFundPurchases();
  if (!targets.length) {
    console.log('반영할 펀드 매수 없음');
  }

  let holding = readFundHolding();
  let applied = 0, skipped = 0;
  // 과거(이전 실행분) 적용 이력에서 시작 — 오늘 새로 반영되는 게 없어도 이 값이
  // 과거 사실을 그대로 유지해야 isValuationStale이 매 실행마다 올바르게 판단한다.
  let latestAppliedPurchaseDate = latestPreviouslyAppliedDate();
  for (const { filepath, content, parsed: purchase } of targets) {
    // fundName 검증(코드리뷰 CRITICAL 지적, 2026-09-04) — 삼성증권 알림 템플릿이
    // "매수 완료 안내"와 "펀드평가 안내"에서 서로 다른 fundName 표기를 쓰는 걸 실측
    // 확인했다(checkFundValuationDrift 헤더 주석 참고). readFundHolding()은
    // VIP_FUND_NAME 하드코딩으로 기존 파일을 찾는데, 만약 매수 알림 쪽 fundName이
    // 그 상수와 다르게 오면(다른 표기·오탐지·새 펀드 추가 등) applyFundPurchase가
    // 다른 이름으로 새 보유 파일을 만들어버려 기존 보유와 분리된 채 이중계상된다 —
    // 이걸 막기 위해 여기서 정확히 일치할 때만 진행, 아니면 건너뛰고 경고.
    if (purchase.fundName !== VIP_FUND_NAME) {
      collectWarning(`펀드 매수 알림의 fundName("${purchase.fundName}")이 기존 보유 펀드명("${VIP_FUND_NAME}")과 다름 — 이중계상 위험으로 반영 건너뜀, 수동 확인 필요`);
      skipped++;
      continue;
    }
    // appliedDedupKeys 2차 방어(코드리뷰 HIGH 지적) — holdingsApplied 플래그 쓰기가
    // 중간에 실패했던 재시도라면 재적용 없이 플래그만 다시 찍는다(update-holdings-
    // from-executions.mjs와 동일 패턴).
    if (holding?.appliedDedupKeys?.includes(purchase.dedupKey)) {
      console.log(`  ↩️  이미 반영된 매수(재시도) — 재적용 없이 플래그만 기록: ${purchase.date} ${purchase.fundName}`);
      if (!DRY_RUN) writeAtomic(filepath, updateFrontmatter(content, { holdingsApplied: true, holdingsAppliedAt: new Date().toISOString() }));
      latestAppliedPurchaseDate = latestAppliedPurchaseDate && latestAppliedPurchaseDate > purchase.date ? latestAppliedPurchaseDate : purchase.date;
      continue;
    }

    let updated;
    try {
      updated = applyFundPurchase(holding, { ...purchase, account: purchase.account ?? FUND_PURCHASE_ACCOUNT });
    } catch (e) {
      collectWarning(`펀드 매수 반영 실패(${purchase.date} ${purchase.fundName}): ${e.message} — 건너뜀, 원본 카카오 메시지 재확인 필요`);
      skipped++;
      continue;
    }
    console.log(`  + [펀드적립반영${DRY_RUN ? '(예정)' : ''}] ${purchase.date} ${purchase.fundName} ${purchase.amount.toLocaleString()}원(${purchase.units.toFixed(2)}좌) → 누적 ${updated.qty.toFixed(2)}좌, 원금 ${updated.invest.toLocaleString()}원`);
    if (!DRY_RUN) {
      // writeHoldingSafely로 전환(2026-09-04 후속 — 처음엔 writeStateFile만 썼는데,
      // 그것만으론 update-holdings-prices.mjs가 이 파일에 stale 내용으로 덮어쓸 위험이
      // 남아있었다. 그 잡도 오늘 같은 안전장치로 전환해 이제 양쪽 다 보호됨 —
      // scripts/lib/state-writer.mjs patchFrontmatterFileSafely 헤더 주석 참고).
      await writeHoldingSafely(updated);
      writeAtomic(filepath, updateFrontmatter(content, { holdingsApplied: true, holdingsAppliedAt: new Date().toISOString() }));
    }
    holding = updated;
    latestAppliedPurchaseDate = latestAppliedPurchaseDate && latestAppliedPurchaseDate > purchase.date ? latestAppliedPurchaseDate : purchase.date;
    applied++;
  }

  // FundValuation 안전망 대조(파일 헤더 "정본/검증 역할 분리" 참고) — 반영 여부와
  // 무관하게 매번 확인(누락된 매수가 오래 방치돼도 계속 경보하도록). 단 valuation이
  // 방금 반영한 매수보다 옛날 기준이면(월초 매수 직후 아직 이번달 평가알림이 안 온
  // 상태) 비교 자체가 무의미해 스킵(isValuationStale, 코드리뷰 HIGH 지적 — 매달
  // 며칠간 정상인데 오탐 나던 것 방지).
  const latestValuation = readLatestFundValuation();
  if (!isValuationStale(latestAppliedPurchaseDate, latestValuation)) {
    const warning = checkFundValuationDrift(holding, latestValuation);
    if (warning) {
      collectWarning(warning);
      console.log(`  ⚠️ ${warning}`);
    }
  }
  await flushWarnings('update-fund-holdings-from-purchases', { dryRun: DRY_RUN });

  console.log(`\n✅ 완료 — 반영 ${applied}건 · 건너뜀 ${skipped}건` + (DRY_RUN ? ' (드라이런)' : ''));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(`update-fund-holdings-from-purchases 실패: ${e?.message ?? e}`); process.exitCode = 1; });
}
