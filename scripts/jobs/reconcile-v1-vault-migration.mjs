#!/usr/bin/env node
/**
 * v1↔Vault 마이그레이션 대조 검증 (구현계획서 Phase 7 완료 기준)
 *
 * "완료 기준: 대조 검증 스크립트가 모든 계좌·자산군에서 0건의 불일치를 보고한다.
 * 불일치가 하나라도 있으면 원인 규명 전까지 컷오버하지 않는다."
 *
 * migrate-v1-to-vault.mjs가 쓴 것과 같은 계산을 재사용하지 않고, v1 시트를 다시
 * 직접 읽어(fresh read) 독립적으로 비교한다 — 마이그레이션 스크립트 자체의 계좌명·
 * 경로 실수(엉뚱한 폴더에 쓰기, 덮어쓰기 충돌로 유실 등)까지 잡아내기 위함(같은
 * 코드로 검산하면 같은 버그를 반복할 뿐이라 무의미).
 *
 * 검증 두 층위(코드리뷰 지적으로 2026-08-05 확장 — 처음엔 Holdings만 있었음):
 * 1. 보유종목(State/Holdings): 계좌별 종목명·수량·투자금액·평가금액까지 값 단위로 대조.
 * 2. 나머지 12종(Facts/Ledger 4종 + State/Allocation·Baselines + Decisions 4종 +
 *    Knowledge 2종): 건수만 대조 — "빌더가 조용히 몇 건을 못 쓴" 가장 심각한 실패
 *    유형(Holdings 로트유실 사고와 같은 클래스)을 잡아낸다. 값 하나하나까지 재대조하지
 *    않는 이유는 Holdings 검증이 "이 코드 전반에 숫자파싱 버그가 없다"를 이미 증명했기
 *    때문(낮은 한계효용).
 *
 * 사용법:
 *   node scripts/jobs/reconcile-v1-vault-migration.mjs
 *   node scripts/jobs/reconcile-v1-vault-migration.mjs <TOKEN>
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { getToken, getRange } from '../lib/sheets-common.mjs';
import { parseFrontmatter } from '../lib/vault-frontmatter.mjs';
import { VAULT_PATHS } from '../lib/vault-paths.mjs';
import { DEFAULT_ACCOUNTS } from '../../src/lib/constants.js';
// v1 시트 숫자 셀은 콤마·퍼센트 섞인 문자열 — Number()는 그걸 NaN으로, `|| 0`이 그걸
// 조용히 0으로 뭉갠다(2026-08-05 실사고: 이 버그 때문에 대조검증이 v1·Vault 양쪽에서
// 똑같이 0이 나와 "0건 불일치"로 오판했었다 — migration-vault-writer.mjs 주석 참고).
// 위 사고 이후 실제 데이터 전 범위(체결내역·배당금 등 통화기호·괄호식 음수 포함)를
// 스캔해 parseNum이 놓치는 형식이 없는지 확인함(2026-08-05) — 이 시트에선 안전.
import { parseNum } from '../../src/lib/textFormat.js';

const ACCOUNT_KEYS = ['ISA', '위탁', '연금저축', 'IRP'];
const EPS = 1; // 원 단위 반올림 오차 허용

// migrate-v1-to-vault.mjs writeEventLog와 동일한 "완전 빈 행" 판정 — 카운트 기준을
// 맞춰야 여기서 만든 v1건수가 실제 마이그레이션 로직이 스킵한 행까지 세는 걸 방지.
function countNonEmptyRows(rows) {
  return rows.filter((row) => row?.some((c) => String(c ?? '').trim())).length;
}

function countVaultFiles(dir) {
  if (!existsSync(dir)) return 0;
  return readdirSync(dir).filter((f) => f.endsWith('.md')).length;
}

function readVaultHoldings() {
  const dir = VAULT_PATHS.state.holdings;
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => parseFrontmatter(readFileSync(join(dir, f), 'utf8')));
}

// Holdings는 위에서 이름·수량·투자금·평가금까지 깊게 대조하지만, 나머지 12종은 값
// 하나하나까지 재파싱해 비교하는 대신 **건수**만 재대조한다(코드리뷰 지적, 2026-08-05
// — "Holdings만 검증되고 나머지 9종 이벤트로그는 안전망이 없다"). 건수 불일치는 "빌더가
// 조용히 몇 건을 못 쓴" 가장 심각한 실패 유형을 잡아낸다 — 그 이상의 필드별 정밀검증은
// Holdings 하나로 이미 "같은 버그 클래스(숫자 파싱)가 이 코드 전반에 없다"는 걸
// 증명했으므로 나머지 12종에 똑같은 로직을 반복하는 건 낮은 한계효용.
const EVENT_LOG_CHECKS = [
  ['체결내역!A2:M', VAULT_PATHS.facts.ledger.executions, '체결내역'],
  ['배당금!A2:C', VAULT_PATHS.facts.ledger.dividends, '배당금'],
  ['수익금!A2:F', VAULT_PATHS.facts.ledger.profits, '수익금'],
  ['일별스냅샷!A2:E', VAULT_PATHS.facts.ledger.dailySnapshots, '일별스냅샷'],
  ['종목투자노트!A2:U', VAULT_PATHS.decisions.evaluations, '종목투자노트'],
  ['포지션저널!A2:P', VAULT_PATHS.decisions.positionJournal, '포지션저널'],
  ['리스크모니터!A2:H', VAULT_PATHS.decisions.riskMonitor, '리스크모니터'],
  ['주문제안!A2:N', VAULT_PATHS.decisions.proposals, '주문제안(아카이브)'],
  ['주간리포트!A2:C', VAULT_PATHS.knowledge.reports, '주간리포트'],
  ['성향관찰!A2:H', VAULT_PATHS.knowledge.profile, '성향관찰'],
];

async function verifyEventLogCounts(token, mismatches) {
  console.log('\n[이벤트로그 건수 대조]');
  for (const [range, dir, label] of EVENT_LOG_CHECKS) {
    const rows = await getRange(token, range);
    const v1Count = countNonEmptyRows(rows);
    const vaultCount = countVaultFiles(dir);
    console.log(`  ${label}: v1 ${v1Count}건 / Vault ${vaultCount}건`);
    if (v1Count !== vaultCount) mismatches.push(`${label}: 건수 불일치(v1 ${v1Count} vs Vault ${vaultCount})`);
  }
}

// 자산분배 — assetNames 길이로 잘라내는 migrate-v1-to-vault.mjs와 동일 규칙으로 기대건수 계산.
// ⚠️ 금현물은 v1(구글시트)엔 없던 계좌라 REBAL_RANGES에 없다(2026-08-21 추가 — CMA와
// 동일 사유로 대시보드 계좌 블록 신설). v1엔 대응물이 없으므로 이 마이그레이션 대조에서는
// 제외하고, 금현물-*.md 7건은 "기대되는 추가분"으로 별도 표시한다 — v1에 없던 파일이라고
// 건수 불일치로 잘못 보고하면 이 잡이 실제 문제를 놓치게 된다.
async function verifyAllocationCounts(token, mismatches) {
  console.log('\n[자산분배 건수 대조]');
  const REBAL_RANGES = { 위탁: '자산분배!B3:D9', 연금저축: '자산분배!B12:D18', ISA: '자산분배!B21:D21', IRP: '자산분배!B24:D24' };
  let v1Total = 0;
  for (const [acctKey, range] of Object.entries(REBAL_RANGES)) {
    const rows = await getRange(token, range);
    const assetCount = DEFAULT_ACCOUNTS[acctKey].assets.length;
    v1Total += Math.min(rows.length, assetCount);
  }
  const allFiles = readdirSync(VAULT_PATHS.state.allocation).filter((f) => f.endsWith('.md'));
  const goldFiles = allFiles.filter((f) => f.startsWith('금현물-'));
  const vaultCount = allFiles.length - goldFiles.length;
  console.log(`  자산분배(4계좌 합산): v1(기대) ${v1Total}건 / Vault ${vaultCount}건` + (goldFiles.length ? ` (+금현물 ${goldFiles.length}건, v1에 없던 계좌라 대조 제외)` : ''));
  if (v1Total !== vaultCount) mismatches.push(`자산분배: 건수 불일치(v1 ${v1Total} vs Vault ${vaultCount})`);
}

async function verifyBaselineCounts(token, mismatches) {
  console.log('\n[리스크기준선 건수 대조]');
  const rows = await getRange(token, '리스크기준선!A2:K');
  const v1Count = rows.filter((r) => r[0]).length;
  const vaultCount = countVaultFiles(VAULT_PATHS.state.baselines);
  console.log(`  리스크기준선: v1 ${v1Count}건 / Vault ${vaultCount}건`);
  if (v1Count !== vaultCount) mismatches.push(`리스크기준선: 건수 불일치(v1 ${v1Count} vs Vault ${vaultCount})`);
}

async function main() {
  const token = await getToken(process.argv[2]?.trim() || null);
  const vaultHoldings = readVaultHoldings();
  const mismatches = [];

  console.log('[보유종목 계좌별 상세 대조]');
  for (const acctKey of ACCOUNT_KEYS) {
    const rows = await getRange(token, `${acctKey}!A2:I`);
    const v1Rows = rows.filter((r) => r[1]);
    const v1TotalInvest = v1Rows.reduce((s, r) => s + parseNum(r[4]), 0);
    const v1TotalEval = v1Rows.reduce((s, r) => s + parseNum(r[7]), 0);
    const v1Count = v1Rows.length;

    const vaultForAcct = vaultHoldings.filter((h) => h.account === acctKey);
    const vaultTotalInvest = vaultForAcct.reduce((s, h) => s + parseNum(h.invest), 0);
    const vaultTotalEval = vaultForAcct.reduce((s, h) => s + parseNum(h.evalAmount), 0);
    const vaultCount = vaultForAcct.length;

    console.log(`\n[${acctKey}] v1 ${v1Count}건 / Vault ${vaultCount}건`);
    console.log(`  투자금액: v1 ${v1TotalInvest.toLocaleString()} / Vault ${vaultTotalInvest.toLocaleString()}`);
    console.log(`  평가금액: v1 ${v1TotalEval.toLocaleString()} / Vault ${vaultTotalEval.toLocaleString()}`);

    if (v1Count !== vaultCount) mismatches.push(`${acctKey}: 종목 수 불일치(v1 ${v1Count} vs Vault ${vaultCount})`);
    if (Math.abs(v1TotalInvest - vaultTotalInvest) > EPS) mismatches.push(`${acctKey}: 투자금액 불일치(v1 ${v1TotalInvest} vs Vault ${vaultTotalInvest})`);
    if (Math.abs(v1TotalEval - vaultTotalEval) > EPS) mismatches.push(`${acctKey}: 평가금액 불일치(v1 ${v1TotalEval} vs Vault ${vaultTotalEval})`);

    // 종목별 대조 — 이름만으로는 못 잡는다(같은 종목이 서로 다른 매입 로트로 여러 행에
    // 나올 수 있음, 2026-08-05 위탁 삼성전자 2로트 실사고로 확인). (이름|수량) 조합을
    // 멀티셋으로 비교 — 순서·중복 다 그대로 반영해 로트별로 정확히 대응하는지 확인.
    const v1Bag = v1Rows.map((r) => `${String(r[1] ?? '').trim()}|${parseNum(r[3])}`).sort();
    const vaultBag = vaultForAcct.map((h) => `${String(h.name ?? '').trim()}|${parseNum(h.qty)}`).sort();
    if (JSON.stringify(v1Bag) !== JSON.stringify(vaultBag)) {
      const v1Only = v1Bag.filter((k) => !vaultBag.includes(k));
      const vaultOnly = vaultBag.filter((k) => !v1Bag.includes(k));
      if (v1Only.length) mismatches.push(`${acctKey}: v1에만 있음(종목|수량) — ${v1Only.join(', ')}`);
      if (vaultOnly.length) mismatches.push(`${acctKey}: Vault에만 있음(종목|수량) — ${vaultOnly.join(', ')}`);
    }
  }

  await verifyEventLogCounts(token, mismatches);
  await verifyAllocationCounts(token, mismatches);
  await verifyBaselineCounts(token, mismatches);

  console.log(`\n${'='.repeat(50)}`);
  if (mismatches.length === 0) {
    console.log('✅ 불일치 0건 — 모든 계좌·종목·이벤트로그 정합 확인');
    process.exit(0);
  } else {
    console.log(`❌ 불일치 ${mismatches.length}건 발견 — 컷오버 금지, 원인 규명 필요:`);
    mismatches.forEach((m) => console.log(`  - ${m}`));
    process.exit(1);
  }
}

main().catch((e) => { console.error('\n❌ 오류:', e.message); process.exit(1); });
