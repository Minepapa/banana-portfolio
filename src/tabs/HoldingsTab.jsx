// 종목 탭: 계좌별 보유종목 목록 + 추가/삭제/인라인 편집(매수단가·예수금·달러RP). App.jsx에서 추출 (동작 불변).
// 모든 편집 상태·핸들러(시트 쓰기)와 AddHoldingForm은 App에 남기고 prop으로 받는다 — 시트 I/O는 App 책임.
import { PROFIT_POS, PROFIT_NEG, COLORS } from '../lib/constants.js';
import { useLongPress } from '../hooks/useLongPress.js';

export default function HoldingsTab({
  accounts, acct, acctKey, setAcctKey, isMobile, baseFont, fmt, sheets,
  holdSort, setHoldSort,
  showAddForm, setShowAddForm, showDeleteMode, setShowDeleteMode,
  selectedToDelete, setSelectedToDelete,
  editingHolding, setEditingHolding, editingCash, setEditingCash, editingDollar, setEditingDollar,
  editPrice, setEditPrice, editQty, setEditQty, editCurrentPrice, setEditCurrentPrice,
  editIncludeSavings, setEditIncludeSavings,
  editCashValue, setEditCashValue, editDollarValue, setEditDollarValue,
  beginEdit, saveEdit, saveCash, saveDollar, handleDeleteSelected,
  AddHoldingForm, onAddHoldingSave,
}) {
  const lp = useLongPress();
  // ── 전체 계좌 합산 ─────────────────────────────────────────
  const totalPortEval   = Object.values(accounts).reduce((s, a) => s + (a.total_eval   || 0), 0);
  const totalPortInvest = Object.values(accounts).reduce((s, a) => s + (a.total_invest || 0), 0);
  const totalPortProfit = totalPortEval - totalPortInvest;

  // 현재 표시할 종목 목록 (단일 계좌)
  const isTotalView = false;
  const rawHoldings = (acct.holdings || [])
    .map((h, origIdx) => ({ ...h, origIdx }))
    .filter(h => h.invest > 0 && h.eval > 0);

  // 정렬 (sheet = 시트 원래 순서 유지)
  const SORT_FN = {
    rate_desc:   (a, b) => b.rate   - a.rate,
    rate_asc:    (a, b) => a.rate   - b.rate,
    eval_desc:   (a, b) => b.eval   - a.eval,
    profit_desc: (a, b) => b.profit - a.profit,
  };
  const sortedHoldings = holdSort === 'sheet'
    ? rawHoldings
    : [...rawHoldings].sort(SORT_FN[holdSort] || SORT_FN.rate_desc);

  // 비중 계산 기준 (해당 계좌)
  const weightBase = acct.total_eval || 1;

  return (
    <div>
      {/* 계좌 선택 (4개) */}
      <div style={{ display: "flex", gap: 6, marginBottom: 16 }}>
        {Object.entries(accounts).map(([k, a]) => (
          <button key={k} onClick={() => { setAcctKey(k); setShowAddForm(false); setEditingHolding(null); setEditingCash(null); }} style={{
            flex: 1, padding: isMobile ? "8px 4px" : "6px 4px",
            textAlign: 'center',
            borderRadius: 20,
            border: `1px solid ${acctKey === k ? a.color : "#2A2F3E"}`,
            background: acctKey === k ? `${a.color}22` : "transparent",
            color: acctKey === k ? a.color : "#6B7280",
            cursor: "pointer", fontSize: 11, fontFamily: baseFont,
          }}>
            {a.label}
          </button>
        ))}
      </div>

      {/* 계좌 요약 카드 */}
      {isTotalView ? (
        <div style={{ background: 'linear-gradient(135deg, #8B5CF622, #1A1D26)', border: '1px solid #8B5CF644', borderRadius: 12, padding: "16px", marginBottom: 16 }}>
          <div style={{ fontSize: 10, letterSpacing: 2, color: '#8B5CF6', marginBottom: 4 }}>전체 포트폴리오</div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end" }}>
            <div>
              <div style={{ fontSize: isMobile ? 16 : 20, fontWeight: 700, color: "#F5F7FF" }}>₩{fmt(totalPortEval)}</div>
              <div style={{ fontSize: 11, color: "#9CA3AF", marginTop: 2 }}>투자금 ₩{fmt(totalPortInvest)}</div>
            </div>
            <div style={{ textAlign: "right" }}>
              <div style={{ fontSize: isMobile ? 13 : 16, fontWeight: 700, color: totalPortProfit >= 0 ? PROFIT_POS : PROFIT_NEG }}>
                ₩{fmt(totalPortProfit)}
              </div>
              <div style={{ fontSize: 11, color: totalPortProfit >= 0 ? PROFIT_POS : PROFIT_NEG }}>
                {totalPortProfit >= 0 ? '+' : ''}{totalPortInvest > 0 ? ((totalPortProfit / totalPortInvest) * 100).toFixed(1) : '0.0'}%
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div style={{
          background: `linear-gradient(135deg, ${acct.color}22, #1A1D26)`,
          border: `1px solid ${acct.color}44`,
          borderRadius: 12, padding: "16px", marginBottom: 16,
        }}>
          <div style={{ fontSize: 10, letterSpacing: 2, color: acct.color, marginBottom: 4 }}>
            {acct.sub.toUpperCase()}
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end" }}>
            <div>
              <div style={{ fontSize: isMobile ? 16 : 20, fontWeight: 700, color: "#F5F7FF" }}>
                ₩{fmt(acct.total_eval)}
              </div>
              <div style={{ fontSize: 11, color: "#9CA3AF", marginTop: 2 }}>
                투자금 ₩{fmt(acct.total_invest)}
              </div>
            </div>
            <div style={{ textAlign: "right" }}>
              <div style={{
                fontSize: isMobile ? 13 : 16, fontWeight: 700,
                color: acct.profit >= 0 ? PROFIT_POS : PROFIT_NEG,
              }}>
                ₩{fmt(acct.profit)}
              </div>
              <div style={{ fontSize: 11, color: acct.profit >= 0 ? PROFIT_POS : PROFIT_NEG }}>
                {acct.profit >= 0 ? '+' : ''}
                {acct.total_invest > 0 ? ((acct.profit / acct.total_invest) * 100).toFixed(1) : '0.0'}%
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 정렬 버튼 */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 12, alignItems: 'center' }}>
        <span style={{ fontSize: 10, color: '#8A9AB5', flexShrink: 0 }}>정렬</span>
        {[
          { key: 'sheet',       label: '자산군순' },
          { key: 'rate_desc',   label: '수익률↓' },
          { key: 'rate_asc',    label: '수익률↑' },
          { key: 'eval_desc',   label: '평가금↓' },
        ].map(s => (
          <button key={s.key} onClick={() => setHoldSort(s.key)} style={{
            padding: '4px 8px', borderRadius: 12, fontSize: 10,
            border: `1px solid ${holdSort === s.key ? '#3B82F6' : '#2A2F3E'}`,
            background: holdSort === s.key ? '#1E3A5F' : 'transparent',
            color: holdSort === s.key ? '#60A5FA' : '#6B7280',
            cursor: 'pointer', fontFamily: baseFont,
          }}>{s.label}</button>
        ))}
      </div>

      {/* 종목추가/삭제 버튼 + 폼 */}
      {sheets.auth === 'signed-in' && !isTotalView && (
        <div style={{ marginBottom: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginBottom: 8 }}>
            <button onClick={() => { setShowDeleteMode(p => !p); setSelectedToDelete(new Set()); setShowAddForm(false); }} style={{
              width: 30, height: 30, padding: 0, borderRadius: 6, flexShrink: 0,
              border: showDeleteMode ? `1px solid ${PROFIT_POS}` : '1px solid #2A2F3E',
              background: showDeleteMode ? '#2A1A1A' : 'transparent',
              color: showDeleteMode ? PROFIT_POS : '#6B7280',
              cursor: 'pointer', fontSize: 16, fontFamily: baseFont,
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            }}>
              {showDeleteMode ? '✕' : '−'}
            </button>
            <button onClick={() => { setShowAddForm(p => !p); setShowDeleteMode(false); }} style={{
              width: 30, height: 30, padding: 0, borderRadius: 6, flexShrink: 0,
              border: showAddForm ? `1px solid ${PROFIT_POS}` : '1px solid #2A2F3E',
              background: showAddForm ? '#2A1A1A' : 'transparent',
              color: showAddForm ? PROFIT_POS : '#6B7280',
              cursor: 'pointer', fontSize: 16, fontFamily: baseFont,
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            }}>
              {showAddForm ? '✕' : '+'}
            </button>
          </div>
          {showAddForm && (
            <AddHoldingForm
              acctKey={acctKey}
              accounts={accounts}
              readRange={sheets.readRange}
              insertRowAfter={sheets.insertRowAfter}
              onSave={onAddHoldingSave}
              onCancel={() => setShowAddForm(false)}
            />
          )}
        </div>
      )}

      {/* 보유 종목 목록 */}
      <div style={{ background: "#1A1D26", borderRadius: 12, overflow: "hidden" }}>
        <div style={{ padding: "12px 16px", borderBottom: "1px solid #2A2F3E", fontSize: 10, letterSpacing: 3, color: "#8A9AB5" }}>
          보유 종목 ({sortedHoldings.length})
        </div>
        {sortedHoldings.length === 0 && (
          <div style={{ padding: 24, textAlign: 'center', color: '#8A9AB5', fontSize: 12 }}>종목이 없습니다</div>
        )}
        {sortedHoldings.map((h, vi) => {
          const origIdx = h.origIdx ?? vi;
          const color = h.rate >= 0 ? PROFIT_POS : PROFIT_NEG;
          const typeName = h.type || '';
          const isEditing = !isTotalView && editingHolding?.origIdx === origIdx;
          const isEditingCash = !isTotalView && editingCash?.origIdx === origIdx;
          const isEditingDollar = !isTotalView && editingDollar?.origIdx === origIdx;
          const weightPct = weightBase > 0 ? (h.eval / weightBase * 100).toFixed(1) : '0.0';
          const canLP = !isTotalView && sheets.auth === 'signed-in' && !showDeleteMode;
          const lpActive = canLP && lp.activeId === origIdx;
          const lpHandlers = canLP ? lp.bind(origIdx, () => beginEdit(origIdx, h)) : {};
          return (
            <div key={`${h._acctKey ?? acctKey}-${origIdx}`} style={{ borderBottom: vi < sortedHoldings.length - 1 ? "1px solid #1E2233" : "none" }}>
              <div style={{
                position: 'relative',
                padding: isMobile ? "10px 16px" : "12px 16px",
                display: "flex", alignItems: "center", gap: 8,
                background: lpActive ? '#1E2A45' : isEditing || isEditingCash || isEditingDollar ? '#1A2035' : selectedToDelete.has(origIdx) ? '#1A1520' : 'transparent',
                transition: 'background 0.1s',
                userSelect: 'none', WebkitUserSelect: 'none',
              }} {...lpHandlers}>
                {lpActive && <div className="lp-progress" />}
                {!isTotalView && showDeleteMode && (
                  <input type="checkbox" checked={selectedToDelete.has(origIdx)}
                    onChange={() => setSelectedToDelete(prev => { const next = new Set(prev); if (next.has(origIdx)) next.delete(origIdx); else next.add(origIdx); return next; })}
                    style={{ marginRight: 2, accentColor: PROFIT_POS, flexShrink: 0 }}
                  />
                )}
                {/* 자산군 태그 or 계좌 태그(전체뷰) */}
                {isTotalView ? (
                  <div style={{ fontSize: 9, background: (accounts[h._acctKey]?.color || '#aaa') + '33', color: accounts[h._acctKey]?.color || '#aaa', padding: '2px 5px', borderRadius: 4, flexShrink: 0, whiteSpace: 'nowrap' }}>
                    {h._acct}
                  </div>
                ) : typeName ? (
                  <div style={{ fontSize: 10, background: (COLORS[typeName] || '#aaa') + '33', color: COLORS[typeName] || '#aaa', padding: '2px 6px', borderRadius: 4, flexShrink: 0, whiteSpace: 'nowrap' }}>
                    {typeName}
                  </div>
                ) : null}
                <div style={{ flex: 1, minWidth: 0, textAlign: 'left' }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: "#E8EAF0", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                    {h.name}
                  </div>
                  <div style={{ fontSize: 10, color: "#8A9AB5", marginTop: 2 }}>
                    {h.qty}주 · 매수 {String(h.type ?? '').includes('해외') ? `$${Number(h.price).toFixed(2)}` : `₩${fmt(h.price)}`}
                  </div>
                  {h.currentPrice > 0 && (
                    <div style={{ fontSize: 10, color: "#8A9AB5" }}>
                      현재 {String(h.type ?? '').includes('해외') ? `$${Number(h.currentPrice).toFixed(2)}` : `₩${fmt(h.currentPrice)}`}
                    </div>
                  )}
                </div>
                {/* 비중% */}
                <div style={{ textAlign: 'center', flexShrink: 0, minWidth: 32 }}>
                  <div style={{ fontSize: 10, color: '#9CA3AF', fontWeight: 600 }}>{weightPct}%</div>
                </div>
                <div style={{ textAlign: "right", flexShrink: 0 }}>
                  <div style={{ fontSize: isMobile ? 11 : 12, color: "#E8EAF0" }}>₩{fmt(h.eval)}</div>
                  <div style={{ fontSize: isMobile ? 10 : 11, fontWeight: 700, color }}>
                    {h.rate >= 0 ? '+' : ''}{h.rate.toFixed(1)}%
                  </div>
                  <div style={{ fontSize: 10, color }}>
                    ₩{fmt(Math.abs(h.profit))}
                  </div>
                </div>
              </div>
              {isEditing && (
                <div style={{ padding: '12px 16px', background: '#141927', borderTop: '1px solid #2A2F3E' }}>
                  <div style={{ fontSize: 10, letterSpacing: 2, color: '#8A9AB5', marginBottom: 10 }}>종목 수정</div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 10 }}>
                    <div>
                      <div style={{ fontSize: 10, color: '#8A9AB5', marginBottom: 4 }}>매수단가</div>
                      <input type="number" value={editPrice} onChange={e => setEditPrice(e.target.value)}
                        style={{ background: '#0D1520', border: '1px solid #2A2F3E', borderRadius: 6, color: '#E8EAF0', padding: '6px 10px', fontSize: 12, fontFamily: baseFont, width: '100%', boxSizing: 'border-box' }} />
                    </div>
                    <div>
                      <div style={{ fontSize: 10, color: '#8A9AB5', marginBottom: 4 }}>수량</div>
                      <input type="number" value={editQty} onChange={e => setEditQty(e.target.value)}
                        style={{ background: '#0D1520', border: '1px solid #2A2F3E', borderRadius: 6, color: '#E8EAF0', padding: '6px 10px', fontSize: 12, fontFamily: baseFont, width: '100%', boxSizing: 'border-box' }} />
                    </div>
                  </div>
                  {editingHolding?.isManual && (
                    <div style={{ marginBottom: 10 }}>
                      <div style={{ fontSize: 10, color: '#8A9AB5', marginBottom: 4 }}>현재가 (수기)</div>
                      <input type="number" value={editCurrentPrice} onChange={e => setEditCurrentPrice(e.target.value)}
                        style={{ background: '#0D1520', border: '1px solid #3B82F6', borderRadius: 6, color: '#E8EAF0', padding: '6px 10px', fontSize: 12, fontFamily: baseFont, width: '100%', boxSizing: 'border-box' }} />
                    </div>
                  )}
                  <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: '#9CA3AF', marginBottom: 10, cursor: 'pointer', userSelect: 'none' }}>
                    <input type="checkbox" checked={editIncludeSavings} onChange={e => setEditIncludeSavings(e.target.checked)} style={{ accentColor: '#3B82F6' }} />
                    신규 매수 반영 (저축금 업데이트)
                  </label>
                  <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                    <button onClick={() => { setEditingHolding(null); setEditIncludeSavings(false); }} style={{ padding: '6px 14px', borderRadius: 6, border: '1px solid #2A2F3E', background: 'transparent', color: '#6B7280', cursor: 'pointer', fontSize: 11, fontFamily: baseFont }}>취소</button>
                    <button onClick={saveEdit} style={{ padding: '6px 14px', borderRadius: 6, border: 'none', background: '#3B82F6', color: '#fff', cursor: 'pointer', fontSize: 11, fontFamily: baseFont }}>저장</button>
                  </div>
                </div>
              )}
              {isEditingCash && (
                <div style={{ padding: '12px 16px', background: '#141927', borderTop: '1px solid #2A2F3E' }}>
                  <div style={{ fontSize: 10, letterSpacing: 2, color: '#8A9AB5', marginBottom: 10 }}>예수금 수정</div>
                  <div style={{ marginBottom: 10 }}>
                    <div style={{ fontSize: 10, color: '#8A9AB5', marginBottom: 4 }}>예수금 잔액 (₩)</div>
                    <input type="number" inputMode="numeric" value={editCashValue} onChange={e => setEditCashValue(e.target.value)}
                      style={{ background: '#0D1520', border: '1px solid #3B82F6', borderRadius: 6, color: '#E8EAF0', padding: '6px 10px', fontSize: 12, fontFamily: baseFont, width: '100%', boxSizing: 'border-box' }} />
                  </div>
                  <div style={{ fontSize: 10, color: '#8A9AB5', marginBottom: 10, lineHeight: 1.5 }}>
                    입력값을 오늘 기준으로 리셋합니다. 이후 매수·매도·배당이 자동 가감됩니다.
                  </div>
                  <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                    <button onClick={() => setEditingCash(null)} style={{ padding: '6px 14px', borderRadius: 6, border: '1px solid #2A2F3E', background: 'transparent', color: '#6B7280', cursor: 'pointer', fontSize: 11, fontFamily: baseFont }}>취소</button>
                    <button onClick={saveCash} style={{ padding: '6px 14px', borderRadius: 6, border: 'none', background: '#3B82F6', color: '#fff', cursor: 'pointer', fontSize: 11, fontFamily: baseFont }}>저장</button>
                  </div>
                </div>
              )}
              {isEditingDollar && (
                <div style={{ padding: '12px 16px', background: '#141927', borderTop: '1px solid #2A2F3E' }}>
                  <div style={{ fontSize: 10, letterSpacing: 2, color: '#8A9AB5', marginBottom: 10 }}>달러RP 수정</div>
                  <div style={{ marginBottom: 10 }}>
                    <div style={{ fontSize: 10, color: '#8A9AB5', marginBottom: 4 }}>달러RP 잔액 (USD)</div>
                    <input type="number" inputMode="decimal" step="0.01" value={editDollarValue} onChange={e => setEditDollarValue(e.target.value)}
                      style={{ background: '#0D1520', border: '1px solid #3B82F6', borderRadius: 6, color: '#E8EAF0', padding: '6px 10px', fontSize: 12, fontFamily: baseFont, width: '100%', boxSizing: 'border-box' }} />
                  </div>
                  <div style={{ fontSize: 10, color: '#8A9AB5', marginBottom: 10, lineHeight: 1.5 }}>
                    USD 잔액을 오늘 기준으로 리셋합니다. 이후 환전·해외 매수·매도가 자동 가감됩니다. 원화 표시는 환율 수식으로 자동 환산됩니다.
                  </div>
                  <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                    <button onClick={() => setEditingDollar(null)} style={{ padding: '6px 14px', borderRadius: 6, border: '1px solid #2A2F3E', background: 'transparent', color: '#6B7280', cursor: 'pointer', fontSize: 11, fontFamily: baseFont }}>취소</button>
                    <button onClick={saveDollar} style={{ padding: '6px 14px', borderRadius: 6, border: 'none', background: '#3B82F6', color: '#fff', cursor: 'pointer', fontSize: 11, fontFamily: baseFont }}>저장</button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
        {!isTotalView && showDeleteMode && selectedToDelete.size > 0 && (
          <div style={{ padding: '12px 16px', borderTop: '1px solid #2A2F3E' }}>
            <button onClick={handleDeleteSelected} style={{ width: '100%', padding: 10, borderRadius: 6, border: 'none', background: PROFIT_POS, color: '#fff', cursor: 'pointer', fontSize: 12, fontFamily: baseFont }}>
              선택 삭제 ({selectedToDelete.size}개)
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
