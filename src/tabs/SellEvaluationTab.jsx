// 평가 탭(매도 모드): 보유 + 평가완료 종목의 매도 검토. App.jsx에서 추출 (동작 불변).
// 선택·요청 상태(noteSelectedStock/noteSellBusy/noteSellCopied)는 매도 전용이라 함께 내려옴.
// 매도 평가 큐 추가(sheets.appendValues)는 탭 로컬 핸들러 — sheets prop만 사용.
import { useState } from 'react';
import { PROFIT_POS, PROFIT_NEG } from '../lib/constants.js';
import { SectionTitle, GradeDot, SubLabel, NumberedItem, Sentences } from '../lib/primitives.jsx';
import { stripGrade } from '../lib/textFormat.js';
import { findThesisAlerts } from '../lib/thesisAlerts.js';

export default function SellEvaluationTab({
  accounts, evaluations, positionJournal, riskMonitor, setEvalMode, sheets, baseFont, fmt,
}) {
  const [noteSelectedStock, setNoteSelectedStock] = useState(null);
  const [noteSellCopied, setNoteSellCopied] = useState(false);
  const [noteSellBusy, setNoteSellBusy] = useState(false);

  // 4계좌 holdings 합산 — 종목명 key로 unique
  const stockMap = {};
  Object.entries(accounts).forEach(([acctKey, acct]) => {
    (acct.holdings || []).forEach(h => {
      const name = String(h.name ?? '').trim();
      if (!name) return;
      if (!stockMap[name]) {
        stockMap[name] = { name, type: h.type, qty: 0, investSum: 0, evalSum: 0, profitSum: 0, accounts: [] };
      }
      const s = stockMap[name];
      s.qty += h.qty || 0;
      s.investSum += h.invest || 0;
      s.evalSum   += h.eval   || 0;
      s.profitSum += h.profit || 0;
      s.accounts.push({ acct: acctKey, qty: h.qty, price: h.price, currentPrice: h.currentPrice });
    });
  });
  const stocks = Object.values(stockMap)
    .filter(s => s.qty > 0 && evaluations.some(e => e.stock?.name === s.name))
    .map(s => ({
      ...s,
      avgPrice: s.investSum > 0 && s.qty > 0 ? s.investSum / s.qty : 0,
      rate: s.investSum > 0 ? (s.profitSum / s.investSum) * 100 : 0,
    }))
    .sort((a, b) => b.evalSum - a.evalSum);

  const currentName = noteSelectedStock || stocks[0]?.name || null;
  const stock = stocks.find(s => s.name === currentName);
  const stockEvals = evaluations.filter(e => e.stock?.name === currentName);

  if (sheets.auth !== 'signed-in') {
    return (
      <div style={{ padding: 32, textAlign: 'center', color: '#8A9AB5', fontSize: 12 }}>
        로그인 후 이용할 수 있습니다
      </div>
    );
  }
  if (stocks.length === 0) {
    return (
      <div style={{ padding: 32, textAlign: 'center', color: '#8A9AB5', fontSize: 12 }}>
        평가가 완료된 보유 종목이 없습니다.<br/>
        <span style={{ fontSize: 11, color: '#3A4050' }}>[매수] 모드에서 평가 후 보유 중이면 여기에 표시됩니다.</span>
      </div>
    );
  }

  const thesisAlertMap = (() => {
    const alerts = findThesisAlerts(positionJournal, riskMonitor);
    const m = new Map();
    alerts.forEach(a => m.set(a.position.name, a));
    return m;
  })();

  return (
    <div style={{ textAlign: 'left' }}>
      {/* 헤더 */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <div>
          <div style={{ fontSize: 13, fontWeight: 700, color: '#E8EAF0' }}>매도 검토</div>
          <div style={{ width: 26, height: 3, borderRadius: 2, background: '#F87171', marginTop: 6 }} />
        </div>
        <div style={{ fontSize: 10, color: '#8A9AB5' }}>평가 완료 {stocks.length}종목 · 보유 중</div>
      </div>

      {/* 종목 선택 칩 */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 16, flexWrap: 'wrap' }}>
        {stocks.map(s => {
          const evCount = evaluations.filter(e => e.stock?.name === s.name).length;
          const isSelected = s.name === currentName;
          const profitColor = s.profitSum >= 0 ? PROFIT_POS : PROFIT_NEG;
          const hasThesisAlert = thesisAlertMap.has(s.name);
          return (
            <button key={s.name} onClick={() => setNoteSelectedStock(s.name)} style={{
              padding: '5px 10px', borderRadius: 6,
              border: `1px solid ${isSelected ? '#F87171' : hasThesisAlert ? '#EF444466' : '#2A2F3E'}`,
              background: isSelected ? '#4A1E1E' : '#1A1D26',
              color: isSelected ? '#F87171' : '#9CA3AF',
              cursor: 'pointer', fontSize: 10, fontFamily: baseFont,
              display: 'flex', alignItems: 'center', gap: 6,
            }}>
              <span>{s.name}</span>
              <span style={{ fontSize: 9, color: profitColor }}>
                {s.profitSum >= 0 ? '+' : ''}{s.rate.toFixed(1)}%
              </span>
              {hasThesisAlert && <span style={{ fontSize: 8, color: '#EF4444' }}>🔴</span>}
              {evCount > 0 && (
                <span style={{
                  fontSize: 8, padding: '0 4px', borderRadius: 8,
                  background: '#2A2F3E', color: '#9CA3AF',
                }}>📘{evCount}</span>
              )}
            </button>
          );
        })}
      </div>

      {stock && (() => {
        const earliestEval = stockEvals[stockEvals.length - 1] || null;
        const latestEval = stockEvals[0] || null;
        const canSellEval = !!earliestEval && earliestEval.reasons.length > 0 && sheets.auth === 'signed-in' && !noteSellBusy;

        // ── 상태 모니터 파생값 ──
        const _evalTs = latestEval?.date ? Date.parse(latestEval.date) : NaN;
        const daysSinceEval = Number.isNaN(_evalTs)
          ? null
          // 평가 후 경과일 — 표시용 상대시간 계산이라 렌더 시점 now 사용 (원본 동작 유지)
          // eslint-disable-next-line react-hooks/purity
          : Math.floor((Date.now() - _evalTs) / 86400000);
        const _momentum = latestEval?.axisItems?.모멘텀 || [];
        const rsiItem = _momentum.find(i => i.metric === 'rsi' || String(i.label||'').toUpperCase().includes('RSI'));
        const pos52Item = _momentum.find(i => i.metric === 'pos_52w' || String(i.label||'').includes('52주'));
        const rsiVal = rsiItem ? (parseFloat(String(rsiItem.value||'').replace(/[^0-9.]/g, '')) || null) : null;
        const pos52Val = pos52Item ? (parseFloat(String(pos52Item.value||'').replace(/[^0-9.]/g, '')) || null) : null;
        const rsiOver = rsiVal !== null && rsiVal > 70;
        const rsiUnder = rsiVal !== null && rsiVal < 30;
        const pos52Over = pos52Val !== null && pos52Val > 80;
        const hasAlerts = rsiOver || rsiUnder || pos52Over;
        const onSellEvalClick = async () => {
          if (!canSellEval) return;
          setNoteSellBusy(true);
          try {
            const market = earliestEval?.stock?.market || (/^[0-9]{6}$/.test(earliestEval?.stock?.ticker || '') ? 'KR' : 'US');
            const _now2 = new Date();
            const requestedAt = `${_now2.getFullYear()}-${String(_now2.getMonth()+1).padStart(2,'0')}-${String(_now2.getDate()).padStart(2,'0')} ${String(_now2.getHours()).padStart(2,'0')}:${String(_now2.getMinutes()).padStart(2,'0')}`;
            const row = [requestedAt, stock.name, market, '대기', '', '매도 평가'];
            await sheets.appendValues('평가요청!A2:F', [row]);
            setNoteSellCopied(true);
            setTimeout(() => setNoteSellCopied(false), 2000);
          } catch (e) {
            console.error('매도 평가 큐 추가 실패:', e);
          } finally {
            setNoteSellBusy(false);
          }
        };
        return (
        <>
          {/* 보유 정보 카드 */}
          <div style={{ background: '#1A1D26', borderRadius: 12, padding: '16px 16px 14px', marginBottom: 12, border: thesisAlertMap.has(stock.name) ? '1px solid #EF444455' : '1px solid transparent' }}>
            {/* 투자논리 훼손 경보 — findThesisAlerts 기준 (포지션·거래결정 탭과 동일 소스) */}
            {thesisAlertMap.has(stock.name) && (() => {
              const ta = thesisAlertMap.get(stock.name);
              return (
                <div style={{ marginBottom: 10, padding: '7px 10px', borderRadius: 8, background: '#4A1E1E55', border: '1px solid #EF444455', fontSize: 10, color: '#F87171', fontWeight: 600, lineHeight: 1.5 }}>
                  {ta.signal.signal} 논거 훼손 경보
                  {ta.signal.summary && <div style={{ fontWeight: 400, color: '#F5C9B8', marginTop: 3 }}>{ta.signal.summary}</div>}
                </div>
              );
            })()}
            {/* 기술적 신호 (RSI / 52주) */}
            {hasAlerts && (
              <div style={{ marginBottom: 10, padding: '6px 10px', borderRadius: 8, background: '#3A2A1E44', border: '1px solid #FBBF2444', fontSize: 10, color: '#FBBF24', fontWeight: 600 }}>
                기술적 신호 · {[
                  rsiOver ? `RSI ${Math.round(rsiVal)} 과열` : null,
                  rsiUnder ? `RSI ${Math.round(rsiVal)} 급락` : null,
                  pos52Over ? `52주 ${Math.round(pos52Val)}% 고점 근접` : null,
                ].filter(Boolean).join(' · ')}
              </div>
            )}
            <div style={{ textAlign: 'center', marginBottom: 12 }}>
              <div style={{ fontSize: 18, fontWeight: 800, color: '#E8EAF0', letterSpacing: 0.3 }}>{stock.name}</div>
              <div style={{ fontSize: 9, color: '#8A9AB5', marginTop: 3, letterSpacing: 1 }}>
                {stock.type || '—'} · {stock.accounts.map(a => a.acct).join(' / ')}
              </div>
              <div style={{ marginTop: 8, display: 'flex', justifyContent: 'center', alignItems: 'baseline', gap: 8 }}>
                <span style={{ fontSize: 20, fontWeight: 800, color: stock.profitSum >= 0 ? PROFIT_POS : PROFIT_NEG }}>
                  {stock.profitSum >= 0 ? '+' : ''}{stock.rate.toFixed(1)}%
                </span>
                <span style={{ fontSize: 11, color: '#8A9AB5' }}>
                  {stock.profitSum >= 0 ? '+' : ''}₩{fmt(stock.profitSum)}
                </span>
              </div>
            </div>

            {/* 매도 평가 의뢰 */}
            <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
              <button onClick={onSellEvalClick} disabled={!canSellEval} title={canSellEval ? '매도 평가를 큐에 추가' : '최초 매수 이유가 없어 매도 평가 불가'} style={{
                flex: 1, padding: '6px 10px', borderRadius: 6,
                border: `1px solid ${canSellEval ? '#F87171' : '#2A2F3E'}`,
                background: canSellEval ? (noteSellCopied ? '#4ADE8033' : '#4A1E1E33') : 'transparent',
                color: canSellEval ? (noteSellCopied ? '#4ADE80' : '#F87171') : '#3A3F4E',
                cursor: canSellEval ? 'pointer' : 'not-allowed',
                fontSize: 10, fontFamily: baseFont, fontWeight: 600,
              }}>
                {noteSellBusy ? '요청 중...' : noteSellCopied ? '✓ 큐에 추가됨' : `근거 점검${daysSinceEval !== null ? ` · ${daysSinceEval}일 전 평가` : ''}`}
              </button>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, fontSize: 10 }}>
              <div>
                <div style={{ color: '#8A9AB5', letterSpacing: 1, marginBottom: 2 }}>보유</div>
                <div style={{ color: '#E8EAF0', fontWeight: 600 }}>{fmt(stock.qty)}주</div>
              </div>
              <div>
                <div style={{ color: '#8A9AB5', letterSpacing: 1, marginBottom: 2 }}>평균단가</div>
                <div style={{ color: '#E8EAF0', fontWeight: 600 }}>₩{fmt(stock.avgPrice)}</div>
              </div>
              <div>
                <div style={{ color: '#8A9AB5', letterSpacing: 1, marginBottom: 2 }}>평가금</div>
                <div style={{ color: '#E8EAF0', fontWeight: 600 }}>₩{fmt(stock.evalSum)}</div>
              </div>
            </div>

            {/* 상태 배지 — 마지막 평가 기준 */}
            {(rsiVal !== null || pos52Val !== null || daysSinceEval !== null) && (
              <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid #1E2233', display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                {rsiVal !== null && (
                  <span style={{ padding: '2px 8px', borderRadius: 10, fontSize: 9, fontWeight: 600, background: rsiOver ? '#4A1E1E33' : rsiUnder ? '#1A3A2633' : '#1E2233', color: rsiOver ? '#F87171' : rsiUnder ? '#4ADE80' : '#9CA3AF', border: `1px solid ${rsiOver ? '#F8717144' : rsiUnder ? '#4ADE8044' : '#2A2F3E'}` }}>
                    RSI {Math.round(rsiVal)}
                  </span>
                )}
                {pos52Val !== null && (
                  <span style={{ padding: '2px 8px', borderRadius: 10, fontSize: 9, fontWeight: 600, background: pos52Over ? '#4A3A1E33' : '#1E2233', color: pos52Over ? '#FBBF24' : '#9CA3AF', border: `1px solid ${pos52Over ? '#FBBF2444' : '#2A2F3E'}` }}>
                    52주 {Math.round(pos52Val)}%
                  </span>
                )}
                {daysSinceEval !== null && (
                  <span style={{ padding: '2px 8px', borderRadius: 10, fontSize: 9, background: daysSinceEval > 90 ? '#4A1E1E33' : daysSinceEval > 30 ? '#3A2A1E33' : '#1E2233', color: daysSinceEval > 90 ? '#F87171' : daysSinceEval > 30 ? '#FBBF24' : '#8A9AB5', border: `1px solid ${daysSinceEval > 90 ? '#F8717144' : daysSinceEval > 30 ? '#FBBF2444' : '#2A2F3E'}` }}>
                    평가 {daysSinceEval}일 전
                  </span>
                )}
              </div>
            )}

            {stock.accounts.length > 1 && (
              <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid #1E2233' }}>
                <div style={{ fontSize: 9, letterSpacing: 1, color: '#8A9AB5', marginBottom: 4 }}>계좌별 보유</div>
                {stock.accounts.map((a, i) => (
                  <div key={i} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, padding: '2px 0' }}>
                    <span style={{ color: '#9CA3AF' }}>{a.acct}</span>
                    <span style={{ color: '#E8EAF0' }}>
                      {fmt(a.qty)}주 · 매수가 ₩{fmt(a.price)}{a.currentPrice ? ` · 현재가 ₩${fmt(a.currentPrice)}` : ''}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* 매수 이유 — 첫 평가의 reasons 또는 최신 평가의 reasons */}
          {stockEvals.length > 0 && (() => {
            const earliest = stockEvals[stockEvals.length - 1]; // evaluations는 최신순이므로 last가 가장 오래된 = 최초
            const latest = stockEvals[0];
            return (
              <div style={{ background: '#1A1D26', borderRadius: 12, padding: '14px 16px', marginBottom: 12 }}>
                <SectionTitle color="#60A5FA" size={12} mb={10}
                  sub={`매수일 ${earliest.buyDate || '미입력'} · 평가일 ${earliest.date}`}>
                  최초 매수 근거
                </SectionTitle>
                {earliest.reasons.length === 0 ? (
                  <div style={{ fontSize: 11, color: '#8A9AB5' }}>(근거 미기록)</div>
                ) : earliest.reasons.map((r, i) => (
                  <NumberedItem key={i} n={i + 1} text={r} color="#9CA3AF" numColor="#60A5FA" />
                ))}

                {latest.aiNote && (
                  <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid #1E2233' }}>
                    <SubLabel>AI 한 줄 (최신 평가)</SubLabel>
                    <Sentences text={latest.aiNote} style={{ fontSize: 11, color: '#E8EAF0', lineHeight: 1.6 }} />
                  </div>
                )}

                {latest.frankMemo && (
                  <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid #1E2233' }}>
                    <SubLabel>Frank 메모</SubLabel>
                    <Sentences text={latest.frankMemo} style={{ fontSize: 11, color: '#E8EAF0', lineHeight: 1.6 }} />
                  </div>
                )}

                {(latest.targetTerm || latest.targetRet || latest.status) && (
                  <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid #1E2233', display: 'flex', gap: 12, fontSize: 10, color: '#8A9AB5' }}>
                    {latest.status && <span>상태: <span style={{ color: '#E8EAF0' }}>{latest.status}</span></span>}
                    {latest.targetTerm && <span>목표기간: <span style={{ color: '#E8EAF0' }}>{latest.targetTerm}</span></span>}
                    {latest.targetRet && <span>목표수익률: <span style={{ color: '#E8EAF0' }}>{latest.targetRet}</span></span>}
                  </div>
                )}
              </div>
            );
          })()}

          {/* 평가 히스토리 시계열 */}
          {stockEvals.length > 0 ? (
            <div style={{ background: '#1A1D26', borderRadius: 12, padding: '14px 16px', marginBottom: 12 }}>
              <SectionTitle color="#3B82F6" size={12} mb={12} sub="최신순">평가 히스토리 {stockEvals.length}건</SectionTitle>
              {stockEvals.map((ev, i) => (
                <div key={i} style={{
                  padding: '8px 0',
                  borderTop: i === 0 ? 'none' : '1px solid #1E2233',
                }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 4 }}>
                    <div style={{ fontSize: 11, color: '#E8EAF0', fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span>{ev.date}</span>
                      <GradeDot grade={ev.conclusion.raw} size={8} />
                      <span>{stripGrade(ev.conclusion.raw) || '—'}</span>
                    </div>
                    <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                      {[ev.axisGrades.수익성, ev.axisGrades.안정성, ev.axisGrades.밸류에이션, ev.axisGrades.현금흐름, ev.axisGrades.모멘텀].map((g, gi) => <GradeDot key={gi} grade={g} size={7} />)}
                    </div>
                  </div>
                  {ev.aiNote && (
                    <div style={{ fontSize: 10, color: '#9CA3AF', lineHeight: 1.5, paddingLeft: 4 }}>
                      {ev.aiNote}
                    </div>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <div style={{ background: '#1A1D26', borderRadius: 12, padding: '20px 16px', marginBottom: 12, textAlign: 'center' }}>
              <div style={{ fontSize: 11, color: '#8A9AB5', marginBottom: 8 }}>
                아직 평가 기록이 없습니다
              </div>
              <button onClick={() => setEvalMode('매수')} style={{
                padding: '6px 12px', borderRadius: 6, border: '1px solid #F5A623',
                background: '#3D2E14', color: '#F5A623',
                cursor: 'pointer', fontSize: 10, fontFamily: baseFont,
              }}>
                매수 평가 추가 →
              </button>
            </div>
          )}

        </>
        );
      })()}
    </div>
  );
}
