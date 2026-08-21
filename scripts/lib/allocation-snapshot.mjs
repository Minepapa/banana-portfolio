// State/Allocation 화면표시용 계좌별 스냅샷 계산 — 순수 함수(2026-08-21, 페이지별
// Vault 감사에서 발견: 대시보드 "자산분배" 탭이 8/13 마이그레이션 스냅샷에 멈춰있었음).
//
// ⚠️ 이건 Athena의 실제 리밸런싱 판단(rebalance-gap.mjs computeRebalanceGaps, 위탁+
// 연금저축 "합산 풀" 기준)과 관점이 다르다 — 그건 실시간으로 매번 새로 계산되고 Vault에
// 안 남는다(Node는 사실만 조립, 이 파일을 안 읽음 — 이 잡이 통째로 실패해도 Athena
// 판단엔 영향 없음). 이 모듈은 순수하게 "대시보드 자산분배 탭에 계좌별로 뭘 보여줄지"를
// 위한 것 — 각 계좌가 "자기 자신의 보유 내에서" 목표 대비 어디 있는지를 계산한다(계좌
// 간 합산 풀이 아님). 그래서 여기 currentPct는 Athena가 실제 트레이드 판단에 쓰는
// "위탁+연금저축 합산" 숫자와 다를 수 있다 — 근사가 아니라 관점 자체가 다르다.
import { TARGET_ALLOCATION } from './rebalance-gap.mjs';

// DEFAULT_ACCOUNTS(src/lib/constants.js)의 위탁·연금저축 자산군 목록과 정합 —
// TARGET_ALLOCATION 6개 + "달러"(잔여 헤지성 소액, 공식 목표 없음=0%지만 화면엔 표시).
const POOLED_ASSET_NAMES = [...Object.keys(TARGET_ALLOCATION), '달러'];
const POOLED_ACCOUNTS = new Set(['위탁', '연금저축']);
// 단일자산 계좌 — 목표 100%(그 자산군 하나만 있어야 정상), 실제 드리프트가 있으면 정직하게 반영.
const SINGLE_ASSET_ACCOUNTS = { ISA: '배당주', IRP: 'TDF' };

const round1 = (n) => Math.round(n * 10) / 10;

// holdings: State/Holdings 전체 배열({ account, assetClass, evalAmount, ... }).
// account: '위탁'|'연금저축'|'ISA'|'IRP' 중 하나. 반환: [{assetName, targetPct, currentPct, rebalAmt}, ...]
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
  if (POOLED_ACCOUNTS.has(account)) {
    const acctHoldings = (holdings || []).filter((h) => h.account === account && POOLED_ASSET_NAMES.includes(h.assetClass));
    const byClass = Object.fromEntries(POOLED_ASSET_NAMES.map((c) => [c, 0]));
    for (const h of acctHoldings) byClass[h.assetClass] += h.evalAmount || 0;
    const totalEval = Object.values(byClass).reduce((s, v) => s + v, 0);
    return POOLED_ASSET_NAMES.map((assetName) => {
      const targetPct = TARGET_ALLOCATION[assetName] ?? 0; // 달러는 0(공식 목표 밖)
      const currentPct = totalEval > 0 ? (byClass[assetName] / totalEval) * 100 : 0;
      return { assetName, targetPct, currentPct: round1(currentPct), rebalAmt: Math.round(((targetPct - currentPct) / 100) * totalEval) };
    });
  }
  return [];
}
