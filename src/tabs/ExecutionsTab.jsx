// 체결내역 탭: 체결 자동 동기화 목록 + 저축금 반영 토글. App.jsx에서 추출 (동작 불변).
// 동기화·저축금 반영·거래편집 상태는 App에 남기고 prop으로 받는다 — 시트 I/O는 App 책임.
import { parseNum } from '../lib/textFormat.js';
import { useLongPress } from '../hooks/useLongPress.js';

export default function ExecutionsTab({
  tradeRows, tradeSyncMsg, tradeSyncing, syncTradeExecutions,
  savingsMode, setSavingsMode, savingsAppliedRows, applySavingsFromTrade,
  setTradeEditValues, setTradeEditRowIdx, setTradeEditOpen,
  sheets, baseFont,
}) {
  const lp = useLongPress();
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <div style={{ fontSize: 10, letterSpacing: 3, color: '#8A9AB5' }}>체결내역 자동 동기화</div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {tradeSyncMsg && (
            <span style={{ fontSize: 10, color: tradeSyncMsg.includes('오류') ? '#F87171' : '#4ADE80' }}>
              {tradeSyncMsg}
            </span>
          )}
          <button onClick={() => setSavingsMode(p => !p)} disabled={sheets.auth !== 'signed-in'} style={{
            padding: '5px 12px', borderRadius: 6,
            border: `1px solid ${savingsMode ? '#3B82F6' : '#2A2F3E'}`,
            background: savingsMode ? '#1E3A5F' : 'transparent',
            color: savingsMode ? '#60A5FA' : '#9CA3AF',
            cursor: sheets.auth !== 'signed-in' ? 'not-allowed' : 'pointer',
            fontSize: 10, fontFamily: baseFont,
          }}>
            저축금
          </button>
          <button onClick={syncTradeExecutions} disabled={tradeSyncing || sheets.auth !== 'signed-in'} style={{
            padding: '5px 12px', borderRadius: 6, border: '1px solid #2A2F3E',
            background: 'transparent', color: '#9CA3AF',
            cursor: (tradeSyncing || sheets.auth !== 'signed-in') ? 'not-allowed' : 'pointer',
            fontSize: 10, fontFamily: baseFont,
          }}>
            ↻
          </button>
        </div>
      </div>

      {sheets.auth !== 'signed-in' ? (
        <div style={{ padding: 32, textAlign: 'center', color: '#8A9AB5', fontSize: 12 }}>
          로그인 후 이용할 수 있습니다
        </div>
      ) : tradeRows.length === 0 ? (
        <div style={{ padding: 32, textAlign: 'center', color: '#8A9AB5', fontSize: 12 }}>
          {tradeSyncing ? '불러오는 중...' : '체결내역이 없습니다'}
        </div>
      ) : (
        <div style={{ background: '#1A1D26', borderRadius: 12, overflow: 'hidden' }}>
          <div style={{ padding: '10px 16px', borderBottom: '1px solid #2A2F3E', fontSize: 10, letterSpacing: 3, color: '#8A9AB5' }}>
            전체 {tradeRows.length}건 · 처리완료 {tradeRows.filter(r => r.processed).length}건
          </div>
          {[...tradeRows].sort((a, b) => String(b.row[0] ?? '').localeCompare(String(a.row[0] ?? ''))).map(({ row, processed }, idx) => {
            const date     = String(row[0] ?? '').trim();
            const buySell  = String(row[1] ?? '').trim();
            const account  = String(row[2] ?? '').trim();
            const assetType = String(row[4] ?? '').trim();
            const stockName = String(row[5] ?? '').trim();
            const price    = parseNum(row[6]);
            const qty      = parseNum(row[7]);
            const amount   = Math.round(price * qty);
            // 위탁 계좌의 해외주식 개별종목만 달러. 연금저축·ISA·IRP의 해외ETF(Tiger·Kodex 등)는 원화.
            const isUsDollar = assetType === '해외주식' && account === '위탁';
            const currencySymbol = isUsDollar ? '$' : '₩';
            const isComplete = row.length >= 13 && row.slice(0, 13).every(cell => String(cell ?? '').trim() !== '');
            const isBuy = buySell.includes('매수');
            // 위치 인덱스가 아닌 거래 내용으로 식별 — 새로고침/행 이동에도 이중 반영 방지
            const tradeKey = `${date}|${buySell}|${account}|${stockName}|${amount}`;
            const savingsApplied = savingsAppliedRows.has(tradeKey);
            const canApplySavings = isComplete && amount > 0 && date && !savingsApplied;
            const openTradeEdit = () => {
              if (isComplete) return;
              const vals = Array(13).fill('').map((_, ci) => String(row[ci] ?? ''));
              setTradeEditValues(vals);
              setTradeEditRowIdx(idx);
              setTradeEditOpen(true);
            };
            return (
              <div key={idx}
                {...(!isComplete ? lp.bind(idx, openTradeEdit) : {})}
                style={{
                  position: 'relative',
                  padding: '12px 16px',
                  borderBottom: idx < tradeRows.length - 1 ? '1px solid #1E2233' : 'none',
                  display: 'flex', alignItems: 'center', gap: 12,
                  background: lp.activeId === idx ? '#1E2A45' : 'transparent',
                  opacity: processed ? 0.55 : 1,
                  cursor: !isComplete ? 'pointer' : 'default',
                }}>
                {lp.activeId === idx && <div className="lp-progress" />}
                <div style={{
                  width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
                  background: processed ? '#34A853' : isComplete ? '#F5A623' : '#3B4152',
                }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
                    <span style={{
                      fontSize: 10, padding: '1px 5px', borderRadius: 3,
                      background: isBuy ? '#1E3A5F' : '#4A1E1E',
                      color: isBuy ? '#60A5FA' : '#F87171',
                    }}>{buySell || '—'}</span>
                    <span style={{ fontSize: 10, color: '#8A9AB5' }}>{account}</span>
                    <span style={{ fontSize: 10, color: '#3A3F4E' }}>·</span>
                    <span style={{ fontSize: 10, color: '#8A9AB5' }}>{date}</span>
                  </div>
                  <div style={{ fontSize: 13, fontWeight: 700, color: '#E8EAF0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {stockName || '—'}
                  </div>
                  <div style={{ fontSize: 10, color: '#8A9AB5', marginTop: 2 }}>
                    {qty > 0 ? `${qty}주` : ''}{qty > 0 && price > 0 ? ' · ' : ''}{price > 0 ? `${currencySymbol}${price.toLocaleString()}` : ''}
                    {!isComplete && <span style={{ marginLeft: 6, color: '#F59E0B' }}>셀 미완성</span>}
                  </div>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4, flexShrink: 0 }}>
                  {processed && (
                    <span style={{ fontSize: 10, color: '#34A853' }}>완료</span>
                  )}
                  {savingsApplied ? (
                    <span style={{ fontSize: 10, color: '#4ADE80' }}>저축금 ✓</span>
                  ) : savingsMode && (
                    <button
                      onClick={() => canApplySavings && applySavingsFromTrade(date, amount, isBuy, tradeKey)}
                      disabled={!canApplySavings}
                      style={{
                        padding: '3px 8px', borderRadius: 4, border: '1px solid',
                        borderColor: canApplySavings ? (isBuy ? '#3B82F6' : '#EF4444') : '#2A2F3E',
                        background: 'transparent',
                        color: canApplySavings ? (isBuy ? '#60A5FA' : '#F87171') : '#3A3F4E',
                        cursor: canApplySavings ? 'pointer' : 'not-allowed',
                        fontSize: 10, fontFamily: baseFont,
                      }}
                    >
                      {isBuy ? '+저축' : '−저축'}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

    </div>
  );
}
