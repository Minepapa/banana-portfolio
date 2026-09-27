// 목표비중은 오너가 2026-09-27 확정한 정책값(국내배당40/해외배당30/리츠20/
// 해외채권10, 국내채권은 아직 편입 계획 없어 0 — 합계 100 유지).
export const ISA_SUBCATEGORY_TARGET = {
  국내배당: 40,
  해외배당: 30,
  리츠: 20,
  해외채권: 10,
  국내채권: 0,
};

export const ISA_HOLDING_SUBCATEGORY = {
  'TIME Korea플러스배당액티브': '국내배당',
  'PLUS 고배당주': '국내배당',
  'TIGER 미국배당다우존스타겟데일리커버드콜': '해외배당',
  'TIGER 미국배당다우존스': '해외배당',
  'TIGER 리츠부동산인프라': '리츠',
  'ACE 미국하이일드액티브(H)': '해외채권',
};

const round1 = (n) => Math.round(n * 10) / 10;

export function computeIsaSubcategorySnapshot(holdings) {
  const isaHoldings = (holdings || []).filter((h) => h.account === 'ISA');
  const totalEval = isaHoldings.reduce((sum, h) => sum + (h.evalAmount || 0), 0);
  const categoryEval = Object.fromEntries(Object.keys(ISA_SUBCATEGORY_TARGET).map((name) => [name, 0]));
  let unclassifiedEval = 0;

  for (const holding of isaHoldings) {
    if (holding.assetClass !== '배당주') continue;
    const category = ISA_HOLDING_SUBCATEGORY[holding.name];
    if (category) categoryEval[category] += holding.evalAmount || 0;
    else unclassifiedEval += holding.evalAmount || 0;
  }

  const rows = Object.entries(ISA_SUBCATEGORY_TARGET).map(([assetName, targetPct]) => {
    const currentPct = totalEval > 0 ? (categoryEval[assetName] / totalEval) * 100 : 0;
    return {
      assetName,
      targetPct,
      currentPct: round1(currentPct),
      rebalAmt: Math.round(((targetPct - currentPct) / 100) * totalEval),
    };
  });

  if (unclassifiedEval > 0) {
    const currentPct = totalEval > 0 ? (unclassifiedEval / totalEval) * 100 : 0;
    rows.push({
      assetName: '미분류',
      targetPct: 0,
      currentPct: round1(currentPct),
      rebalAmt: Math.round(((0 - currentPct) / 100) * totalEval),
    });
  }
  return rows;
}
