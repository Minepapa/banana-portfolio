// 체결내역 셀 편집 모달: 체결 행의 각 열 값을 입력해 시트에 저장. App.jsx에서 추출 (동작 불변).
// 표시·입력만 담당 — 저장 로직(saveTradeEdit)·상태는 App에서 prop으로 받는다.
import { CHEOL_COLS } from '../lib/constants.js';

export default function TradeEditModal({
  tradeEditOpen, tradeEditRowIdx, setTradeEditOpen,
  tradeEditValues, setTradeEditValues, saveTradeEdit, tradeEditBusy, baseFont,
}) {
  if (!tradeEditOpen || tradeEditRowIdx === null) return null;
  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.65)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: 16, zIndex: 200,
    }} onClick={(e) => { if (e.target === e.currentTarget) setTradeEditOpen(false); }}>
      <div style={{
        background: '#1A1D26', borderRadius: 12, width: '100%', maxWidth: 440,
        maxHeight: '90vh', overflowY: 'auto', padding: '20px 18px',
        border: '1px solid #2A2F3E',
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: '#F5A623' }}>셀 값 입력</div>
          <button onClick={() => setTradeEditOpen(false)} style={{
            background: 'transparent', border: 'none', cursor: 'pointer',
            color: '#8A9AB5', fontSize: 18, padding: 0, lineHeight: 1,
          }}>✕</button>
        </div>

        {CHEOL_COLS.map((col, ci) => {
          const isEmpty = !tradeEditValues[ci];
          return (
            <div key={col.key} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              <div style={{
                width: 64, fontSize: 10, color: isEmpty ? '#F59E0B' : '#8A9AB5',
                textAlign: 'right', flexShrink: 0,
              }}>
                {col.key} · {col.label}
              </div>
              <input
                value={tradeEditValues[ci]}
                onChange={(e) => {
                  const next = [...tradeEditValues];
                  next[ci] = e.target.value;
                  setTradeEditValues(next);
                }}
                placeholder={col.placeholder}
                style={{
                  flex: 1, background: isEmpty ? '#1E1A0F' : '#0F1218',
                  border: `1px solid ${isEmpty ? '#F59E0B' : '#2A2F3E'}`,
                  borderRadius: 4, padding: '6px 8px', color: '#E8EAF0',
                  fontSize: 12, fontFamily: baseFont, outline: 'none',
                }}
              />
            </div>
          );
        })}

        <button onClick={saveTradeEdit} disabled={tradeEditBusy} style={{
          width: '100%', marginTop: 12, padding: '10px 12px', borderRadius: 6, border: 'none',
          background: tradeEditBusy ? '#2A2F3E' : '#F5A623',
          color: tradeEditBusy ? '#8A9AB5' : '#1A1D26',
          cursor: tradeEditBusy ? 'not-allowed' : 'pointer',
          fontSize: 12, fontWeight: 700, fontFamily: baseFont,
        }}>{tradeEditBusy ? '저장 중...' : '시트에 저장'}</button>
      </div>
    </div>
  );
}
