// 자산분배 탭 — 자산군 파이 + 목표 vs 현재 비중 + 리밸런싱 필요액. v2 재배선
// (2026-08-13): 읽기 전용. 목표비중은 Athena 5/25 룰의 확정값(20/10/5/5/30/30)이라
// 애초에 앱에서 수동 조정하는 대상이 아니다(문서: "목표비중(확정 정본)") — 편집 UI
// 제거.
import {
  PieChart, Pie, Cell, Tooltip, ResponsiveContainer,
} from "recharts";
import { COLORS, PROFIT_POS, PROFIT_NEG } from '../lib/colors.js';
import { MONO } from '../lib/theme.js';
import { DeptBadge } from '../lib/primitives.jsx';

export default function RebalanceTab({ accounts, acctKey, acct, setAcctKey, isMobile, baseFont, fmt }) {
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8 }}>
        <DeptBadge dept="athena" />
      </div>
      {/* 계좌 선택 — 6개(ISA·위탁·연금저축·IRP·CMA·금현물, 2026-08-21 금현물 추가).
          flexWrap: 좁은 화면에서 6칸이 한 줄에 다 안 들어가면 둘째 줄로 넘어가게(브라우저
          실측 전이라 방어적으로 추가 — 코드리뷰 지적). */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 16 }}>
        {Object.keys(accounts).map((k) => (
          <button key={k} onClick={() => setAcctKey(k)} style={{
            flex: "1 1 auto", minWidth: 72, padding: isMobile ? "8px 4px" : "6px 4px",
            textAlign: 'center',
            borderRadius: 0,
            border: `1px solid ${acctKey === k ? accounts[k].color : "#141414"}`,
            background: acctKey === k ? `${accounts[k].color}22` : "transparent",
            color: acctKey === k ? accounts[k].color : "#6B675C",
            cursor: "pointer", fontSize: 11, fontFamily: baseFont,
          }}>
            {accounts[k].label}
          </button>
        ))}
      </div>

      {/* 자산군 구성 파이 (최상단) — 이 계좌 "자신의" 보유 비중(파이 조각·범례 %가 같은
          분모를 쓴다). 2026-08-21부터 목표/현재비중 테이블의 %는 위탁+연금저축+금현물
          합산 풀 기준으로 바뀌었지만, 이 파이는 계속 "이 계좌 안에 실제로 뭐가 얼마나
          있는지"를 보여주는 용도라 a.eval(계좌 자신의 보유액)을 그대로 분모로 쓴다 —
          합산 풀 비중(a.ratio)을 범례에 쓰면 조각 크기와 라벨 %가 어긋난다(코드리뷰
          지적: 금현물처럼 단일 자산군만 있는 계좌는 조각이 100%인데 라벨이 예: "6.2%"로
          찍히는 모순이 생겼었음). */}
      {acct.assets.some(a => a.eval > 0) && (() => {
        const pieAssets = acct.assets.filter(a => a.eval > 0);
        const pieTotal = pieAssets.reduce((s, a) => s + a.eval, 0);
        return (
          <div style={{ background: "#FFFFFF", borderRadius: 0, padding: "16px", marginBottom: 16 }}>
            <div style={{ fontSize: 10, letterSpacing: 2, color: "#6B675C", marginBottom: 12 }}>자산군 구성 (이 계좌 보유 기준)</div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <ResponsiveContainer width="100%" height={160}>
                  <PieChart accessibilityLayer={false}>
                    <Pie
                      data={pieAssets.map(a => ({ name: a.name, value: a.eval }))}
                      cx="50%" cy="50%" innerRadius={40} outerRadius={65} dataKey="value" paddingAngle={3}>
                      {pieAssets.map((a, i) => (
                        <Cell key={i} fill={COLORS[a.name] || "#aaa"} stroke="#F4F1E9" strokeWidth={2} />
                      ))}
                    </Pie>
                    <Tooltip formatter={(v) => `₩${v.toLocaleString()}`}
                      contentStyle={{ background: "#EAE6DA", border: "1px solid #141414", borderRadius: 0, fontSize: 11 }} />
                  </PieChart>
                </ResponsiveContainer>
              </div>
              <div style={{ width: 120, flexShrink: 0 }}>
                {pieAssets.map(a => (
                  <div key={a.name} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                    <div style={{ width: 8, height: 8, borderRadius: 0, background: COLORS[a.name] || '#aaa', flexShrink: 0 }} />
                    <span style={{ fontSize: 11, color: '#6B675C', flex: 1 }}>{a.name}</span>
                    <span style={{ fontSize: 11, color: '#141414' , fontFamily: MONO}}>
                      {(pieTotal > 0 ? (a.eval / pieTotal) * 100 : 0).toFixed(1)}%
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        );
      })()}

      {/* 현재 vs 목표 비중 테이블 */}
      <div style={{ background: "#FFFFFF", borderRadius: 0, padding: "16px", marginBottom: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', marginBottom: 12 }}>
          <div style={{ fontSize: 10, letterSpacing: 2, color: "#6B675C" }}>목표 vs 현재 비중</div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', padding: '4px 8px', marginBottom: 4 }}>
          <div style={{ flex: 1, fontSize: 10, color: '#6B675C', textAlign: 'center' }}>자산군</div>
          <div style={{ width: 60, textAlign: 'center', fontSize: 10, color: '#6B675C' }}>목표%</div>
          <div style={{ width: 50, textAlign: 'center', fontSize: 10, color: '#6B675C' }}>현재%</div>
          <div style={{ width: 60, textAlign: 'center', fontSize: 10, color: '#6B675C' }}>차이</div>
        </div>
        {acct.assets.map((a) => {
          const diff = parseFloat((a.ratio - a.target).toFixed(1));
          const highlight = Math.abs(diff) >= 5;
          return (
            <div key={a.name} style={{
              display: 'flex', alignItems: 'center', padding: '7px 8px',
              borderRadius: 0, marginBottom: 2,
              background: highlight ? '#EAE6DA' : 'transparent',
              borderLeft: highlight ? `3px solid ${diff > 0 ? PROFIT_POS : PROFIT_NEG}` : '3px solid transparent',
            }}>
              <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 6 }}>
                <div style={{ width: 8, height: 8, borderRadius: 0, background: COLORS[a.name] || '#aaa', flexShrink: 0 }} />
                <span style={{ fontSize: 12 }}>{a.name}</span>
              </div>
              <div style={{ width: 60, textAlign: 'center', fontSize: 12, color: '#6B675C' , fontFamily: MONO}}>
                {a.target}%
              </div>
              <div style={{ width: 50, textAlign: 'center', fontSize: 12, color: '#141414' , fontFamily: MONO}}>{a.ratio}%</div>
              <div style={{ width: 60, textAlign: 'right', fontSize: 12, fontWeight: 700,
                color: diff > 0 ? PROFIT_POS : diff < 0 ? PROFIT_NEG : '#6B675C' }}>
                {diff > 0 ? '+' : ''}{diff}%p
              </div>
            </div>
          );
        })}
      </div>

      {/* 리밸런싱 필요 */}
      <div style={{ background: "#FFFFFF", borderRadius: 0, padding: "16px" }}>
        <div style={{ fontSize: 10, letterSpacing: 2, color: "#6B675C", marginBottom: 12 }}>리밸런싱 필요</div>
        {acct.assets.map((a) => {
          const amt = a.rebalAmt ?? 0;
          const diff = parseFloat((a.ratio - a.target).toFixed(1));
          const highlight = Math.abs(diff) >= 5;
          return (
            <div key={a.name} style={{
              display: 'flex', alignItems: 'center', padding: '10px 12px',
              borderRadius: 0, marginBottom: 4,
              background: highlight ? '#EAE6DA' : 'transparent',
              borderLeft: highlight ? `3px solid ${amt > 0 ? PROFIT_POS : PROFIT_NEG}` : '3px solid transparent',
            }}>
              <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 6 }}>
                <div style={{ width: 8, height: 8, borderRadius: 0, background: COLORS[a.name] || '#aaa', flexShrink: 0 }} />
                <span style={{ fontSize: 12 }}>{a.name}</span>
              </div>
              <div style={{ fontSize: 12, fontWeight: 700, color: amt > 0 ? PROFIT_POS : amt < 0 ? PROFIT_NEG : '#6B675C' , fontFamily: MONO}}>
                ₩{fmt(amt)}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
