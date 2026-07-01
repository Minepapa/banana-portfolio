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
        background: '#FFFFFF', borderRadius: 0, width: '100%', maxWidth: 440,
        maxHeight: '90vh', overflowY: 'auto', padding: '20px 18px',
        border: '1px solid #141414',
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: '#E0A000' }}>셀 값 입력</div>
          <button onClick={() => setTradeEditOpen(false)} style={{
            background: 'transparent', border: 'none', cursor: 'pointer',
            color: '#6B675C', fontSize: 18, padding: 0, lineHeight: 1,
          }}>✕</button>
        </div>

        {CHEOL_COLS.map((col, ci) => {
          const isEmpty = !tradeEditValues[ci];
          return (
            <div key={col.key} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              <div style={{
                width: 64, fontSize: 10, color: isEmpty ? '#E0A000' : '#6B675C',
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
                  flex: 1, background: isEmpty ? '#FBF1D0' : '#FFFFFF',
                  border: `1px solid ${isEmpty ? '#E0A000' : '#141414'}`,
                  borderRadius: 0, padding: '6px 8px', color: '#141414',
                  fontSize: 12, fontFamily: baseFont, outline: 'none',
                }}
              />
            </div>
          );
        })}

        <button onClick={saveTradeEdit} disabled={tradeEditBusy} style={{
          width: '100%', marginTop: 12, padding: '10px 12px', borderRadius: 0, border: 'none',
          background: tradeEditBusy ? '#141414' : '#E0A000',
          color: tradeEditBusy ? '#6B675C' : '#FFFFFF',
          cursor: tradeEditBusy ? 'not-allowed' : 'pointer',
          fontSize: 12, fontWeight: 700, fontFamily: baseFont,
        }}>{tradeEditBusy ? '저장 중...' : '시트에 저장'}</button>
      </div>
    </div>
  );
}
