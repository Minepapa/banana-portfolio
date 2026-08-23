// State/Allocation 화면표시용 계좌별 스냅샷 계산 — 순수 함수(2026-08-13, 페이지별
// Vault 감사에서 발견: 대시보드 "자산분배" 탭이 8/13 마이그레이션 스냅샷에 멈춰있었음).
//
// ⚠️ 2026-08-21 오너 확정으로 관점이 바뀌었다 — "위탁·연금저축은 서로 다른 계좌가
// 아니라, 위탁+연금저축+금현물 3계좌를 합쳐서 목표비중과 비교하는 것"(그 전엔 이 모듈이
// 계좌별로 "자기 자신의 보유 내에서" 각자 100%를 맞추는 별개 관점으로 일부러 설계돼
// 있었는데, 그 전제 자체가 틀렸다는 오너 지적). 지금은 Athena의 실제 리밸런싱 판단
// (rebalance-gap.mjs computeCurrentAllocation, 위탁+연금저축+금현물 합산 풀)과 같은
// 원리(normalizeAccount)를 쓴다 — 위탁 탭·연금저축 탭·금현물 탭이 이제 서로 다른
// 계좌가 아니라 같은 합산 풀을 보여주는 세 개의 창이다.
// ⚠️ 2026-08-23 — "달러"는 더 이상 화면표시 전용 특별취급이 아니다. rebalance-gap.mjs
// TARGET_ALLOCATION에 정식 10% 목표군으로 승격됐고, Object.keys(TARGET_ALLOCATION)에
// 이미 포함되므로 예전처럼 별도로 덧붙이면 배열에 "달러"가 중복된다 — 그래서 아래
// POOLED_ASSET_NAMES는 이제 TARGET_ALLOCATION의 키를 그대로 쓴다(수동 append 제거).
// 각 탭의 개별 보유종목 목록(eval)은 여전히 그 계좌 자신의 보유만 보여주지만
// (프론트엔드 mirrorAdapters.js), 목표/현재비중/리밸필요액(target/current/rebalAmt)은
// 합산 풀 기준 공통값이다.
import { TARGET_ALLOCATION, normalizeAccount } from './rebalance-gap.mjs';

// DEFAULT_ACCOUNTS(src/lib/constants.js)의 위탁·연금저축·금현물 자산군 목록과 정합.
const POOLED_ASSET_NAMES = Object.keys(TARGET_ALLOCATION);
// 실제 합산 풀의 구성원(정규화된 계좌명 기준) — 금현물은 normalizeAccount가 항상
// 위탁으로 바꿔주므로 여기엔 안 들어간다(들어가도 절대 매치되지 않는 죽은 멤버가 된다).
const POOLED_ACCOUNTS = new Set(['위탁', '연금저축']);
// 이 풀을 조회할 수 있는 "탭 이름"(대시보드 계좌 블록 키) — 금현물은 normalizeAccount로
// 위탁에 합산되는 계좌지만, 대시보드엔 CMA와 동일 패턴으로 자기 블록이 있다(2026-08-21,
// 오너 확정). 위 POOLED_ACCOUNTS와 의미가 달라 이름을 분리해둔다 — 합치면 "어떤 계좌가
// 진짜로 풀에 합산되는지"와 "어떤 이름으로 조회 가능한지"가 뒤섞여, 나중에
// ACCOUNT_ALIASES가 바뀌었을 때 여기가 조용히 잘못된 의미로 흘러갈 수 있다.
const POOLED_QUERY_KEYS = new Set(['위탁', '연금저축', '금현물']);
// 단일자산 계좌 — 목표 100%(그 자산군 하나만 있어야 정상), 실제 드리프트가 있으면 정직하게 반영.
// ⚠️ CMA 누락 버그(2026-08-22 오너 지적) — CMA는 애초에 이 목록에 없어서 목표비중이
// 항상 0%로 나오고 있었다(위 SINGLE_ASSET_ACCOUNTS[account] 조회가 undefined→falsy라
// 아래 풀링 분기로 새서 CMA 자신은 POOLED_ACCOUNTS에도 없어 결국 아무 목표도 못 얻음).
const SINGLE_ASSET_ACCOUNTS = { ISA: '배당주', IRP: 'TDF', CMA: '현금' };

const round1 = (n) => Math.round(n * 10) / 10;

// 위탁+연금저축+금현물 합산 풀 — 어느 쪽 탭에서 물어봐도 동일한 결과를 반환한다.
function computePooledSnapshot(holdings) {
  const inScope = (holdings || []).filter(
    (h) => POOLED_ACCOUNTS.has(normalizeAccount(h.account)) && POOLED_ASSET_NAMES.includes(h.assetClass),
  );
  const byClass = Object.fromEntries(POOLED_ASSET_NAMES.map((c) => [c, 0]));
  for (const h of inScope) byClass[h.assetClass] += h.evalAmount || 0;
  const totalEval = Object.values(byClass).reduce((s, v) => s + v, 0);
  return POOLED_ASSET_NAMES.map((assetName) => {
    const targetPct = TARGET_ALLOCATION[assetName] ?? 0;
    const currentPct = totalEval > 0 ? (byClass[assetName] / totalEval) * 100 : 0;
    return { assetName, targetPct, currentPct: round1(currentPct), rebalAmt: Math.round(((targetPct - currentPct) / 100) * totalEval) };
  });
}

// holdings: State/Holdings 전체 배열({ account, assetClass, evalAmount, ... }).
// account: '위탁'|'연금저축'|'금현물'|'ISA'|'IRP' 중 하나. 반환: [{assetName, targetPct, currentPct, rebalAmt}, ...]
export function computeAccountAllocationSnapshot(holdings, account) {
  if (SINGLE_ASSET_ACCOUNTS[account]) {
    const assetName = SINGLE_ASSET_ACCOUNTS[account];
    const acctHoldings = (holdings || []).filter((h) => h.account === account);
    const totalEval = acctHoldings.reduce((s, h) => s + (h.evalAmount || 0), 0);
    const assetEval = acctHoldings.filter((h) => h.assetClass === assetName).reduce((s, h) => s + (h.evalAmount || 0), 0);
    const currentPct = totalEval > 0 ? (assetEval / totalEval) * 100 : 0;
    const targetPct = 100;
    return [{ assetName, targetPct, currentPct: round1(currentPct), rebalAmt: Math.round(((targetPct - currentPct) / 100) * totalEval) }];
  }
  if (POOLED_QUERY_KEYS.has(account)) return computePooledSnapshot(holdings);
  return [];
}
