// 리밸런싱 탭: 자산군 파이 + 목표 vs 현재 비중 + 리밸런싱 필요액. App.jsx에서 추출 (동작 불변).
// 목표비중 편집(시트 쓰기) 상태·핸들러는 App에 남기고 prop으로 받는다 — 시트 I/O는 App 책임.
import {
  PieChart, Pie, Cell, Tooltip, ResponsiveContainer,
} from "recharts";
import { COLORS, PROFIT_POS, PROFIT_NEG } from '../lib/colors.js';

export default function RebalanceTab({
  accounts, acctKey, acct, setAcctKey, isMobile, baseFont, fmt, sheets,
  editingAllTargets, setEditingAllTargets, allTargetInputs, setAllTargetInputs, saveAllTargets,
}) {
  return (
    <div>
      {/* 계좌 선택 (4개) */}
      <div style={{ display: "flex", gap: 6, marginBottom: 16 }}>
        {Object.keys(accounts).map((k) => (
          <button key={k} onClick={() => setAcctKey(k)} style={{
            flex: 1, padding: isMobile ? "8px 4px" : "6px 4px",
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


      {/* 자산군 구성 파이 (최상단) */}
      {acct.assets.some(a => a.eval > 0) && (
        <div style={{ background: "#FFFFFF", borderRadius: 0, padding: "16px", marginBottom: 16 }}>
          <div style={{ fontSize: 10, letterSpacing: 3, color: "#6B675C", marginBottom: 12 }}>자산군 구성</div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <ResponsiveContainer width="100%" height={160}>
                <PieChart>
                  <Pie
                    data={acct.assets.filter(a => a.eval > 0).map(a => ({ name: a.name, value: a.eval }))}
                    cx="50%" cy="50%" innerRadius={40} outerRadius={65} dataKey="value" paddingAngle={3}>
                    {acct.assets.filter(a => a.eval > 0).map((a, i) => (
                      <Cell key={i} fill={COLORS[a.name] || "#aaa"} stroke="#F4F1E9" strokeWidth={2} />
                    ))}
                  </Pie>
                  <Tooltip formatter={(v) => `₩${v.toLocaleString()}`}
                    contentStyle={{ background: "#EAE6DA", border: "1px solid #141414", borderRadius: 0, fontSize: 11 }} />
                </PieChart>
              </ResponsiveContainer>
            </div>
            <div style={{ width: 120, flexShrink: 0 }}>
              {acct.assets.filter(a => a.eval > 0).map(a => (
                <div key={a.name} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                  <div style={{ width: 8, height: 8, borderRadius: 0, background: COLORS[a.name] || '#aaa', flexShrink: 0 }} />
                  <span style={{ fontSize: 11, color: '#6B675C', flex: 1 }}>{a.name}</span>
                  <span style={{ fontSize: 11, color: '#141414' }}>
                    {a.ratio.toFixed ? a.ratio.toFixed(1) : a.ratio}%
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* 현재 vs 목표 비중 테이블 */}
      <div style={{ background: "#FFFFFF", borderRadius: 0, padding: "16px", marginBottom: 16 }}>
        <div style={{ position: 'relative', display: 'flex', justifyContent: 'center', alignItems: 'center', marginBottom: 12 }}>
          <div style={{ fontSize: 10, letterSpacing: 3, color: "#6B675C" }}>목표 vs 현재 비중</div>
          {sheets.auth === 'signed-in' && (
            <button
              onClick={() => { setAllTargetInputs(acct.assets.map(a => String(a.target))); setEditingAllTargets(true); }}
              style={{ position: 'absolute', right: 0, padding: '4px 8px', borderRadius: 0, border: '1px solid #141414', background: 'transparent', color: '#6B675C', cursor: 'pointer', fontSize: 13, fontFamily: baseFont, lineHeight: 1 }}
            >⋯</button>
          )}
        </div>
        {editingAllTargets && (
          <div style={{ marginBottom: 12, background: '#FFFFFF', borderRadius: 0, padding: 12 }}>
            <div style={{ fontSize: 10, color: '#6B675C', marginBottom: 8 }}>목표 비중 수정 — 합계 100%</div>
            {acct.assets.map((a, i) => (
              <div key={a.name} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                <div style={{ width: 8, height: 8, borderRadius: 0, background: COLORS[a.name] || '#aaa', flexShrink: 0 }} />
                <span style={{ fontSize: 12, flex: 1, color: '#141414' }}>{a.name}</span>
                <input
                  type="number"
                  value={allTargetInputs[i] ?? ''}
                  onChange={e => setAllTargetInputs(prev => { const n = [...prev]; n[i] = e.target.value; return n; })}
                  style={{ width: 60, padding: '3px 6px', borderRadius: 0, border: '1px solid #141414', background: '#FFFFFF', color: '#141414', fontSize: 12, textAlign: 'right', fontFamily: baseFont, outline: 'none' }}
                />
                <span style={{ fontSize: 11, color: '#6B675C' }}>%</span>
              </div>
            ))}
            <div style={{ fontSize: 11, marginBottom: 8, color: (() => { const s = allTargetInputs.reduce((acc, v) => acc + (parseFloat(v)||0), 0); return Math.abs(s-100) < 0.1 ? '#159E52' : '#E5484D'; })() }}>
              합계: {allTargetInputs.reduce((acc, v) => acc + (parseFloat(v)||0), 0).toFixed(1)}%
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button onClick={() => setEditingAllTargets(false)} style={{ padding: '5px 12px', borderRadius: 0, border: '1px solid #141414', background: 'transparent', color: '#6B675C', cursor: 'pointer', fontSize: 11, fontFamily: baseFont }}>취소</button>
              <button onClick={saveAllTargets} style={{ padding: '5px 12px', borderRadius: 0, border: 'none', background: '#141414', color: '#fff', cursor: 'pointer', fontSize: 11, fontFamily: baseFont }}>저장</button>
            </div>
          </div>
        )}
        <div style={{ display: 'flex', alignItems: 'center', padding: '4px 8px', marginBottom: 4 }}>
          <div style={{ flex: 1, fontSize: 10, color: '#6B675C', textAlign: 'center' }}>자산군</div>
          <div style={{ width: 60, textAlign: 'center', fontSize: 10, color: '#6B675C' }}>목표%</div>
          <div style={{ width: 50, textAlign: 'center', fontSize: 10, color: '#6B675C' }}>현재%</div>
          <div style={{ width: 60, textAlign: 'center', fontSize: 10, color: '#6B675C' }}>차이</div>
        </div>
        {acct.assets.map((a) => {
          const curr = a.ratio > 0 ? a.ratio : (a.sheetCurrent ?? 0);
          const diff = parseFloat((curr - a.target).toFixed(1));
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
              <div style={{ width: 60, textAlign: 'center', fontSize: 12, color: '#6B675C' }}>
                {a.target}%
              </div>
              <div style={{ width: 50, textAlign: 'center', fontSize: 12, color: '#141414' }}>{curr}%</div>
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
        <div style={{ fontSize: 10, letterSpacing: 3, color: "#6B675C", marginBottom: 12 }}>리밸런싱 필요</div>
        {acct.assets.map((a) => {
          const amt = a.rebalAmt ?? 0;
          const curr = a.ratio > 0 ? a.ratio : (a.sheetCurrent ?? 0);
          const diff = parseFloat((curr - a.target).toFixed(1));
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
              <div style={{ fontSize: 12, fontWeight: 700, color: amt > 0 ? PROFIT_POS : amt < 0 ? PROFIT_NEG : '#6B675C' }}>
                ₩{fmt(amt)}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
