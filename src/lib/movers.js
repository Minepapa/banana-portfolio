// 일일 변동·종목 무버 계산 — 순수 함수(테스트 movers.test.js). App.jsx에서 사용.
// 기준선 = 일별스냅샷 시트의 최신 1행(매일 08:00 KST 스냅). 계좌 전체 델타는 "거래 포함"으로
// 실제 내 계좌가 얼마 변했나를, 종목 무버는 "단가 변동만"으로 순수 가격 움직임을 등락률(%) 기준
// 상위로 보여준다(금액이 작아도 변동성이 큰 종목을 놓치지 않기 위해 원화가 아닌 % 정렬).

// 현금성(예수금·MMF·외화 RP)은 종목 무버에서 제외 — 가격 종목이 아니라 현금/FX 등가물.
// (계좌 전체 델타에는 총평가 기준이라 자연히 포함된다)
const isCashLike = (name) => {
  const n = String(name ?? '').trim();
  return n === '예수금' || n === '외화 RP' || n.includes('MMF');
};

const ACCT_KEYS = ['ISA', '위탁', '연금저축', 'IRP'];

// accounts: { ISA: { total_eval, holdings:[{name,eval,qty,type}] }, ... }
// snapshot: { date, ts, totalEval, byAccount, byHolding:{ "계좌|종목명": {e,q} } } | null
// 반환: null(스냅샷 없음 → 호출부가 localStorage 폴백) 또는 계좌 델타 + 무버 상위 N.
export function computeDailyChange(accounts, snapshot, { topN = 5 } = {}) {
  if (!snapshot || !(snapshot.totalEval > 0)) return null;

  const curTotal = ACCT_KEYS.reduce((s, k) => s + (accounts?.[k]?.total_eval || 0), 0);
  const totalDelta = curTotal - snapshot.totalEval;
  const totalPct = snapshot.totalEval > 0 ? totalDelta / snapshot.totalEval : 0;

  const byHolding = snapshot.byHolding || {};
  const movers = [];
  for (const acctKey of ACCT_KEYS) {
    const holdings = accounts?.[acctKey]?.holdings || [];
    for (const h of holdings) {
      if (isCashLike(h.name)) continue;
      if (!(h.eval > 0) || !(h.qty > 0)) continue;
      const snap = byHolding[`${acctKey}|${String(h.name ?? '').trim()}`];
      if (!snap || !(snap.e > 0) || !(snap.q > 0)) continue;   // 스냅샷 이후 신규 편입 등 → 기준 없음, skip
      const snapUnit = snap.e / snap.q;
      const curUnit = h.eval / h.qty;
      const wonDelta = Math.round((curUnit - snapUnit) * h.qty);
      const pct = snapUnit > 0 ? (curUnit / snapUnit - 1) : 0;
      movers.push({
        name: h.name,
        account: acctKey,
        type: h.type || '',
        wonDelta,
        pct,
        traded: h.qty !== snap.q,   // 스냅샷 이후 매수/매도로 수량 변동 → 단가델타는 순수가격이나 참고 표기
      });
    }
  }
  // 변동성(등락률 %) 기준 — 금액이 작아도 변동폭이 큰 종목을 잡아내기 위해 원화가 아닌 %로 정렬.
  // 변동 0%(예: 기준선을 방금 찍은 직후)는 무버가 아니므로 제외 → 의미 없는 목록 방지.
  const ranked = movers.filter(m => m.pct !== 0).sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct));

  return {
    totalDelta,
    totalPct,
    baselineDate: snapshot.date,
    baselineTs: snapshot.ts,
    movers: ranked.slice(0, topN),
  };
}
