// 종목 탭: 계좌별 보유종목 목록 + 추가/삭제/인라인 편집(매수단가·예수금·달러RP). App.jsx에서 추출 (동작 불변).
// 모든 편집 상태·핸들러(시트 쓰기)와 AddHoldingForm은 App에 남기고 prop으로 받는다 — 시트 I/O는 App 책임.
import { PROFIT_POS, PROFIT_NEG, COLORS } from '../lib/colors.js';
import { MONO } from '../lib/theme.js';
import { useLongPress } from '../hooks/useLongPress.js';
import { relTime } from '../lib/textFormat.js';

export default function HoldingsTab({
  accounts, acct, acctKey, setAcctKey, isMobile, baseFont, fmt, sheets,
  holdSort, setHoldSort, edits, realtimeQuotes,
}) {
  const {
    showAddForm, setShowAddForm, showDeleteMode, setShowDeleteMode,
    selectedToDelete, setSelectedToDelete,
    editingHolding, setEditingHolding, editingCash, setEditingCash, editingDollar, setEditingDollar,
    editPrice, setEditPrice, editQty, setEditQty, editCurrentPrice, setEditCurrentPrice,
    editIncludeSavings, setEditIncludeSavings,
    editCashValue, setEditCashValue, editDollarValue, setEditDollarValue,
    beginEdit, saveEdit, saveCash, saveDollar, handleDeleteSelected,
    AddHoldingForm, onAddHoldingSave,
  } = edits;
  const lp = useLongPress();
  // ── 전체 계좌 합산 ─────────────────────────────────────────
  const totalPortEval   = Object.values(accounts).reduce((s, a) => s + (a.total_eval   || 0), 0);
  const totalPortInvest = Object.values(accounts).reduce((s, a) => s + (a.total_invest || 0), 0);
  const totalPortProfit = totalPortEval - totalPortInvest;

  // 현재 표시할 종목 목록 (단일 계좌)
  const isTotalView = false;
  const rawHoldings = (acct.holdings || [])
    .map((h, origIdx) => ({ ...h, origIdx }))
    // 현금성 행(예수금·외화RP·MMF)은 잔액이 0이어도 유지 — 음수→행 소멸 버그 방지.
    // (데이터층 parse-notifications가 음수를 0으로 클램프하므로 정상 흐름에선 항상 ≥0)
    .filter(h => h.isCashLike || (h.invest > 0 && h.eval > 0));

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

  return (
    <div>
      {/* 계좌 선택 (4개) */}
      <div style={{ display: "flex", gap: 6, marginBottom: 16 }}>
        {Object.entries(accounts).map(([k, a]) => (
          <button key={k} onClick={() => { setAcctKey(k); setShowAddForm(false); setEditingHolding(null); setEditingCash(null); }} style={{
            flex: 1, padding: isMobile ? "8px 4px" : "6px 4px",
            textAlign: 'center',
            borderRadius: 0,
            border: `1px solid ${acctKey === k ? a.color : "#141414"}`,
            background: acctKey === k ? `${a.color}22` : "transparent",
            color: acctKey === k ? a.color : "#6B675C",
            cursor: "pointer", fontSize: 11, fontFamily: baseFont,
          }}>
            {a.label}
          </button>
        ))}
      </div>

      {/* 계좌 요약 카드 */}
      {isTotalView ? (
        <div style={{ background: '#FFFFFF', border: '2px solid #141414', boxShadow: '4px 4px 0 #141414', borderRadius: 0, padding: "16px", marginBottom: 16 }}>
          <div style={{ display: 'inline-block', fontSize: 10, letterSpacing: 2, fontWeight: 800, color: '#141414', background: '#C9F23E', padding: '2px 6px', marginBottom: 6 }}>전체 포트폴리오</div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end" }}>
            <div>
              <div style={{ fontSize: isMobile ? 16 : 20, fontWeight: 700, color: "#141414", fontFamily: MONO }}>₩{fmt(totalPortEval)}</div>
              <div style={{ fontSize: 11, color: "#6B675C", marginTop: 2 }}>투자금 ₩{fmt(totalPortInvest)}</div>
            </div>
            <div style={{ textAlign: "right" }}>
              <div style={{ fontSize: isMobile ? 13 : 16, fontWeight: 700, color: totalPortProfit >= 0 ? PROFIT_POS : PROFIT_NEG , fontFamily: MONO}}>
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
          background: `${acct.color}22`,
          border: '2px solid #141414', boxShadow: '4px 4px 0 #141414',
          borderRadius: 0, padding: "16px", marginBottom: 16,
        }}>
          <div style={{ fontSize: 10, letterSpacing: 2, color: acct.color, marginBottom: 4 }}>
            {acct.sub.toUpperCase()}
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end" }}>
            <div>
              <div style={{ fontSize: isMobile ? 16 : 20, fontWeight: 700, color: "#141414" , fontFamily: MONO}}>
                ₩{fmt(acct.total_eval)}
              </div>
              <div style={{ fontSize: 11, color: "#6B675C", marginTop: 2 }}>
                투자금 ₩{fmt(acct.total_invest)}
              </div>
            </div>
            <div style={{ textAlign: "right" }}>
              <div style={{
                fontSize: isMobile ? 13 : 16, fontWeight: 700,
                color: acct.profit >= 0 ? PROFIT_POS : PROFIT_NEG,
              fontFamily: MONO}}>
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
        <span style={{ fontSize: 10, color: '#6B675C', flexShrink: 0 }}>정렬</span>
        {[
          { key: 'sheet',       label: '자산군순' },
          { key: 'rate_desc',   label: '수익률↓' },
          { key: 'rate_asc',    label: '수익률↑' },
          { key: 'eval_desc',   label: '평가금↓' },
        ].map(s => (
          <button key={s.key} onClick={() => setHoldSort(s.key)} style={{
            padding: '4px 8px', borderRadius: 0, fontSize: 10,
            border: '1px solid #141414',
            background: holdSort === s.key ? '#E4F5A0' : 'transparent',
            color: '#141414', fontWeight: holdSort === s.key ? 800 : 600,
            cursor: 'pointer', fontFamily: baseFont,
          }}>{s.label}</button>
        ))}
      </div>

      {/* 종목추가/삭제 버튼 + 폼 */}
      {sheets.auth === 'signed-in' && !isTotalView && (
        <div style={{ marginBottom: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginBottom: 8 }}>
            <button onClick={() => { setShowDeleteMode(p => !p); setSelectedToDelete(new Set()); setShowAddForm(false); }} style={{
              width: 30, height: 30, padding: 0, borderRadius: 0, flexShrink: 0,
              border: showDeleteMode ? `1px solid ${PROFIT_POS}` : '1px solid #141414',
              background: showDeleteMode ? '#FBE3E4' : 'transparent',
              color: showDeleteMode ? PROFIT_POS : '#6B675C',
              cursor: 'pointer', fontSize: 16, fontFamily: baseFont,
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            }}>
              {showDeleteMode ? '✕' : '−'}
            </button>
            <button onClick={() => { setShowAddForm(p => !p); setShowDeleteMode(false); }} style={{
              width: 30, height: 30, padding: 0, borderRadius: 0, flexShrink: 0,
              border: showAddForm ? `1px solid ${PROFIT_POS}` : '1px solid #141414',
              background: showAddForm ? '#FBE3E4' : 'transparent',
              color: showAddForm ? PROFIT_POS : '#6B675C',
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
      <div style={{ background: "#FFFFFF", borderRadius: 0, overflow: "hidden" }}>
        <div style={{ padding: "12px 16px", borderBottom: "1px solid #141414", fontSize: 10, letterSpacing: 2, color: "#6B675C" }}>
          보유 종목 ({sortedHoldings.length})
        </div>
        {sortedHoldings.length === 0 && (
          <div style={{ padding: 24, textAlign: 'center', color: '#6B675C', fontSize: 12 }}>종목이 없습니다</div>
        )}
        {sortedHoldings.map((h, vi) => {
          const origIdx = h.origIdx ?? vi;
          const color = h.rate >= 0 ? PROFIT_POS : PROFIT_NEG;
          const typeName = h.type || '';
          // 위탁 계좌의 해외주식 개별종목만 달러 표시. 같은 '해외주식' 자산군이라도
          // 연금저축·ISA·IRP에 있으면 국내 상장 해외ETF(Tiger·Kodex 등)이므로 원화.
          const isUsDollar = String(typeName).includes('해외') && acctKey === '위탁';
          const isEditing = !isTotalView && editingHolding?.origIdx === origIdx;
          const isEditingCash = !isTotalView && editingCash?.origIdx === origIdx;
          const isEditingDollar = !isTotalView && editingDollar?.origIdx === origIdx;
          const canLP = !isTotalView && sheets.auth === 'signed-in' && !showDeleteMode;
          const lpActive = canLP && lp.activeId === origIdx;
          const lpHandlers = canLP ? lp.bind(origIdx, () => beginEdit(origIdx, h)) : {};
          return (
            <div key={`${h._acctKey ?? acctKey}-${origIdx}`} style={{ borderBottom: vi < sortedHoldings.length - 1 ? "1px solid #EAE6DA" : "none" }}>
              <div style={{
                position: 'relative',
                padding: isMobile ? "10px 16px" : "12px 16px",
                display: "flex", alignItems: "center", gap: 8,
                background: lpActive ? '#EAE6DA' : isEditing || isEditingCash || isEditingDollar ? '#EAE6DA' : selectedToDelete.has(origIdx) ? '#FFFFFF' : 'transparent',
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
                  <div style={{ fontSize: 9, background: (accounts[h._acctKey]?.color || '#aaa') + '33', color: accounts[h._acctKey]?.color || '#aaa', padding: '2px 5px', borderRadius: 0, flexShrink: 0, whiteSpace: 'nowrap' }}>
                    {h._acct}
                  </div>
                ) : typeName ? (
                  <div style={{ fontSize: 10, background: (COLORS[typeName] || '#aaa') + '33', color: COLORS[typeName] || '#aaa', padding: '2px 6px', borderRadius: 0, flexShrink: 0, whiteSpace: 'nowrap' }}>
                    {typeName}
                  </div>
                ) : null}
                <div style={{ flex: 1, minWidth: 0, textAlign: 'left' }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: "#141414", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                    {h.name}
                  </div>
                  <div style={{ fontSize: 10, color: "#6B675C", marginTop: 2 }}>
                    {h.qty}주 · 매수 {isUsDollar ? `$${Number(h.price).toFixed(2)}` : `₩${fmt(h.price)}`}
                  </div>
                  {h.currentPrice > 0 && (
                    <div style={{ fontSize: 10, color: "#6B675C" }}>
                      현재 {isUsDollar ? `$${Number(h.currentPrice).toFixed(2)}` : `₩${fmt(h.currentPrice)}`}
                    </div>
                  )}
                  {realtimeQuotes?.[h.name] && (
                    <div style={{ fontSize: 10, color: "#159E52" }}>
                      실시간 {realtimeQuotes[h.name].market === 'US'
                        ? `$${Number(realtimeQuotes[h.name].price).toFixed(2)}`
                        : `₩${fmt(realtimeQuotes[h.name].price)}`} ({relTime(realtimeQuotes[h.name].ts)})
                    </div>
                  )}
                </div>
                <div style={{ textAlign: "right", flexShrink: 0 }}>
                  <div style={{ fontSize: isMobile ? 11 : 12, color: "#141414", fontFamily: MONO }}>₩{fmt(h.eval)}</div>
                  <div style={{ fontSize: isMobile ? 10 : 11, fontWeight: 700, color }}>
                    {h.rate >= 0 ? '+' : ''}{h.rate.toFixed(1)}%
                  </div>
                  <div style={{ fontSize: 10, color , fontFamily: MONO}}>
                    ₩{fmt(Math.abs(h.profit))}
                  </div>
                </div>
              </div>
              {isEditing && (
                <div style={{ padding: '12px 16px', background: '#FFFFFF', borderTop: '1px solid #141414' }}>
                  <div style={{ fontSize: 10, letterSpacing: 2, color: '#6B675C', marginBottom: 10 }}>종목 수정</div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 10 }}>
                    <div>
                      <div style={{ fontSize: 10, color: '#6B675C', marginBottom: 4 }}>매수단가</div>
                      <input type="number" value={editPrice} onChange={e => setEditPrice(e.target.value)}
                        style={{ background: '#FFFFFF', border: '1px solid #141414', borderRadius: 0, color: '#141414', padding: '6px 10px', fontSize: 12, fontFamily: baseFont, width: '100%', boxSizing: 'border-box' }} />
                    </div>
                    <div>
                      <div style={{ fontSize: 10, color: '#6B675C', marginBottom: 4 }}>수량</div>
                      <input type="number" value={editQty} onChange={e => setEditQty(e.target.value)}
                        style={{ background: '#FFFFFF', border: '1px solid #141414', borderRadius: 0, color: '#141414', padding: '6px 10px', fontSize: 12, fontFamily: baseFont, width: '100%', boxSizing: 'border-box' }} />
                    </div>
                  </div>
                  {editingHolding?.isManual && (
                    <div style={{ marginBottom: 10 }}>
                      <div style={{ fontSize: 10, color: '#6B675C', marginBottom: 4 }}>현재가 (수기)</div>
                      <input type="number" value={editCurrentPrice} onChange={e => setEditCurrentPrice(e.target.value)}
                        style={{ background: '#FFFFFF', border: '1px solid #141414', borderRadius: 0, color: '#141414', padding: '6px 10px', fontSize: 12, fontFamily: baseFont, width: '100%', boxSizing: 'border-box' }} />
                    </div>
                  )}
                  <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: '#6B675C', marginBottom: 10, cursor: 'pointer', userSelect: 'none' }}>
                    <input type="checkbox" checked={editIncludeSavings} onChange={e => setEditIncludeSavings(e.target.checked)} style={{ accentColor: '#141414' }} />
                    신규 매수 반영 (저축금 업데이트)
                  </label>
                  <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                    <button onClick={() => { setEditingHolding(null); setEditIncludeSavings(false); }} style={{ padding: '6px 14px', borderRadius: 0, border: '1px solid #141414', background: 'transparent', color: '#6B675C', cursor: 'pointer', fontSize: 11, fontFamily: baseFont }}>취소</button>
                    <button onClick={saveEdit} style={{ padding: '6px 14px', borderRadius: 0, border: 'none', background: '#141414', color: '#fff', cursor: 'pointer', fontSize: 11, fontFamily: baseFont }}>저장</button>
                  </div>
                </div>
              )}
              {isEditingCash && (
                <div style={{ padding: '12px 16px', background: '#FFFFFF', borderTop: '1px solid #141414' }}>
                  <div style={{ fontSize: 10, letterSpacing: 2, color: '#6B675C', marginBottom: 10 }}>예수금 수정</div>
                  <div style={{ marginBottom: 10 }}>
                    <div style={{ fontSize: 10, color: '#6B675C', marginBottom: 4 }}>예수금 잔액 (₩)</div>
                    <input type="number" inputMode="numeric" value={editCashValue} onChange={e => setEditCashValue(e.target.value)}
                      style={{ background: '#FFFFFF', border: '1px solid #141414', borderRadius: 0, color: '#141414', padding: '6px 10px', fontSize: 12, fontFamily: baseFont, width: '100%', boxSizing: 'border-box' }} />
                  </div>
                  <div style={{ fontSize: 10, color: '#6B675C', marginBottom: 10, lineHeight: 1.5 }}>
                    입력값을 오늘 기준으로 리셋합니다. 이후 매수·매도·배당이 자동 가감됩니다.
                  </div>
                  <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                    <button onClick={() => setEditingCash(null)} style={{ padding: '6px 14px', borderRadius: 0, border: '1px solid #141414', background: 'transparent', color: '#6B675C', cursor: 'pointer', fontSize: 11, fontFamily: baseFont }}>취소</button>
                    <button onClick={saveCash} style={{ padding: '6px 14px', borderRadius: 0, border: 'none', background: '#141414', color: '#fff', cursor: 'pointer', fontSize: 11, fontFamily: baseFont }}>저장</button>
                  </div>
                </div>
              )}
              {isEditingDollar && (
                <div style={{ padding: '12px 16px', background: '#FFFFFF', borderTop: '1px solid #141414' }}>
                  <div style={{ fontSize: 10, letterSpacing: 2, color: '#6B675C', marginBottom: 10 }}>달러RP 수정</div>
                  <div style={{ marginBottom: 10 }}>
                    <div style={{ fontSize: 10, color: '#6B675C', marginBottom: 4 }}>달러RP 잔액 (USD)</div>
                    <input type="number" inputMode="decimal" step="0.01" value={editDollarValue} onChange={e => setEditDollarValue(e.target.value)}
                      style={{ background: '#FFFFFF', border: '1px solid #141414', borderRadius: 0, color: '#141414', padding: '6px 10px', fontSize: 12, fontFamily: baseFont, width: '100%', boxSizing: 'border-box' }} />
                  </div>
                  <div style={{ fontSize: 10, color: '#6B675C', marginBottom: 10, lineHeight: 1.5 }}>
                    USD 잔액을 오늘 기준으로 리셋합니다. 이후 환전·해외 매수·매도가 자동 가감됩니다. 원화 표시는 환율 수식으로 자동 환산됩니다.
                  </div>
                  <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                    <button onClick={() => setEditingDollar(null)} style={{ padding: '6px 14px', borderRadius: 0, border: '1px solid #141414', background: 'transparent', color: '#6B675C', cursor: 'pointer', fontSize: 11, fontFamily: baseFont }}>취소</button>
                    <button onClick={saveDollar} style={{ padding: '6px 14px', borderRadius: 0, border: 'none', background: '#141414', color: '#fff', cursor: 'pointer', fontSize: 11, fontFamily: baseFont }}>저장</button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
        {!isTotalView && showDeleteMode && selectedToDelete.size > 0 && (
          <div style={{ padding: '12px 16px', borderTop: '1px solid #141414' }}>
            <button onClick={handleDeleteSelected} style={{ width: '100%', padding: 10, borderRadius: 0, border: 'none', background: PROFIT_POS, color: '#fff', cursor: 'pointer', fontSize: 12, fontFamily: baseFont }}>
              선택 삭제 ({selectedToDelete.size}개)
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
