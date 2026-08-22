#!/usr/bin/env node
/**
 * 오늘 시점 총자산(State/Holdings 합산) → 이번 달 Facts/Ledger/MonthlyBalances 파일에
 * 매일 덮어쓰기 (2026-08-22, 오너 확정 — v1 "월별잔고" 시트를 더 이상 안 쓴다).
 *
 * 원리: "이번 달 파일"에 매일 오늘자 총자산을 덮어쓴다 — 그러면
 *   - 이번 달이 끝나고 다음 달로 넘어가면, 이 잡은 다음 달 파일을 쓰기 시작하고
 *     지난달 파일은 더 이상 안 건드린다 → 지난달의 "마지막으로 기록된 값"(보통
 *     말일 값)이 자연히 그 달의 확정치가 된다. 매달 1일에 "지난달 스냅"을 따로
 *     찍는 별도 로직이 필요 없다(오너가 요청한 "매달 1일 전달 값 확정"이 이 방식
 *     만으로 저절로 된다).
 *   - migrate-monthly-balance.mjs가 이미 가져온 2025-04~2026-07(완결된 과거 달)은
 *     이 잡이 절대 건드리지 않는다(오늘 날짜가 그 달들이 될 일이 없으므로) — "지금까지
 *     값은 가지고 온 것을 쓴다"는 오너 지시 그대로.
 *   - 2026-08(마이그레이션 당시엔 8/4 시점 스냅샷이었던 달)은 이 잡이 처음 실행되는
 *     오늘(2026-08-22)부터 라이브 값으로 자연스럽게 갱신되기 시작한다 — legacy 필드를
 *     빼서 "더 이상 얼린 값이 아님"을 표시한다.
 *
 * total은 State/Holdings 전체(현금성 보유 포함 — CMA·예수금류도 isCashLike:true로
 * State/Holdings에 이미 있음) evalAmount 합산 — firestore-mirror.mjs buildHomeMirror와
 * 완전히 같은 계산이라 홈 화면 총자산과 항상 일치한다(재계산 로직 중복 없음).
 *
 * ⚠️ v1 스키마에 있던 deposit(그달 신규입금)·isa/wita/pension/irp(계좌별 잔고)·
 * kospiIndex/spIndex(벤치마크 지수)는 이 잡이 채우지 않는다 — State/Holdings에서
 * 바로 계산 가능한 값이 아니고(신규입금은 별도 이벤트 집계가 필요, 지수는 별도 API),
 * 실제로 쓰는 곳(대시보드 막대그래프)도 total 하나만 필요하다 — 안 쓰는 값을
 * 억지로 채우지 않는다(추정 금지).
 *
 * 사용법:
 *   node scripts/jobs/update-monthly-balance-snapshot.mjs            # 실제로 Vault에 씀
 *   node scripts/jobs/update-monthly-balance-snapshot.mjs --dry-run  # 계산만 미리보기
 */
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { VAULT_PATHS } from '../lib/vault-paths.mjs';
import { parseFrontmatter, buildFrontmatter } from '../lib/vault-frontmatter.mjs';
import { writeAtomic } from '../lib/state-writer.mjs';
import { buildHomeMirror } from '../lib/firestore-mirror.mjs';
import { todayKST } from '../lib/sheets-api.mjs';

const DRY_RUN = process.argv.includes('--dry-run');

function readHoldings() {
  const dir = VAULT_PATHS.state.holdings;
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => parseFrontmatter(readFileSync(join(dir, f), 'utf8')));
}

// 순수함수 — holdings·오늘날짜(KST, "YYYY-MM-DD")를 받아 쓸 파일을 결정. 테스트 가능.
export function computeMonthlyBalanceSnapshot(holdings, todayStr) {
  const { totalEval } = buildHomeMirror({ holdings });
  const [yearStr, monthStr] = todayStr.split('-');
  const year = Number(yearStr), month = Number(monthStr);
  const content = buildFrontmatter({
    type: 'monthly-balance',
    year, month, ym: year * 100 + month,
    total: Math.round(totalEval),
    updatedAt: new Date().toISOString(),
  });
  const filename = `${yearStr}-${monthStr}.md`;
  return { filename, content, dir: VAULT_PATHS.facts.ledger.monthlyBalances, total: Math.round(totalEval) };
}

function main() {
  const holdings = readHoldings();
  if (!holdings.length) { console.log('⚠️ State/Holdings가 비어있음 — 스냅샷 건너뜀(추정 안 함)'); return; }
  const { filename, content, dir, total } = computeMonthlyBalanceSnapshot(holdings, todayKST());
  console.log(`  ${filename} — 총자산 ₩${total.toLocaleString()}`);
  if (!DRY_RUN) { mkdirSync(dir, { recursive: true }); writeAtomic(join(dir, filename), content); }
  console.log(`\n✅ 완료` + (DRY_RUN ? ' (드라이런 — 쓰기 없음)' : ''));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
