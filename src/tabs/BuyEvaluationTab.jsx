// 평가 탭(매수 모드): AI 능동 종목 평가 카드 + 매수/매도 토글. App.jsx에서 추출 (동작 불변).
// 매수/매도 토글은 tab==="평가"일 때 항상 렌더 — 이 컴포넌트가 토글의 소유자.
// evalSelectedIdx는 매수 전용이라 내려옴. 의뢰/적재 모달·재시도는 App 책임이라 prop.
import { SAMPLE_EVALUATION, AXIS_METRICS, LEARNING_MODULES, LABEL_TO_METRIC } from '../lib/constants.js';
import { GradeDot, SubLabel, NumberedItem } from '../lib/primitives.jsx';
import { gradeColor, stripGrade, stripPeriod } from '../lib/textFormat.js';

// "OpenDart 2025 반기보고서(연결)" → "2025 H1", "quarterly+info(TTM)" → "TTM", 순수 yfinance → null
function parsePeriodBadge(source) {
  if (!source) return null;
  const od = source.match(/OpenDart (\d{4}) (사업보고서|1분기보고서|반기보고서|3분기보고서)/);
  if (od) {
    const label = { '사업보고서': '연간', '1분기보고서': 'Q1', '반기보고서': 'H1', '3분기보고서': 'Q3' }[od[2]];
    return `${od[1]} ${label}`;
  }
  if (source.includes('TTM') || source.includes('quarterly+info')) return 'TTM';
  return null;
}

export default function BuyEvaluationTab({
  evaluations, accounts, evalMode, setEvalMode, setEvalSelectedMetric,
  setEvalQueueOpen, setEvalIngestOpen, evalQueue, requeueEval, requeueBusyIdx,
  evalSelectedIdx, setEvalSelectedIdx, sheets, baseFont,
}) {
  const fromSheet = evaluations.length > 0;
  // 종목별 최신 평가만 추출 + 노트 탭과 동일하게 evalSum 내림차순 정렬
  const uniqueEvals = (() => {
    const seen = new Map();
    evaluations.forEach((ev) => {
      const name = ev.stock?.name;
      if (name && !seen.has(name)) seen.set(name, ev);
    });
    const evalSumMap = {};
    Object.values(accounts).forEach(acct => {
      (acct.holdings || []).forEach(h => {
        const n = String(h.name ?? '').trim();
        if (!n) return;
        evalSumMap[n] = (evalSumMap[n] || 0) + (h.eval || 0);
      });
    });
    return [...seen.values()].sort((a, b) => (evalSumMap[b.stock?.name] || 0) - (evalSumMap[a.stock?.name] || 0));
  })();
  const current = fromSheet ? (uniqueEvals[evalSelectedIdx] || uniqueEvals[0]) : null;
  // 시트 카드를 SAMPLE 카드와 같은 모양으로 정규화 (axes는 grade만, items 없음)
  const card = current ? {
    stock: current.stock,
    date: current.date,
    axes: [
      { label: '수익성',     grade: current.axisGrades.수익성,     items: current.axisItems?.['수익성'] || [] },
      { label: '재무 안정성', grade: current.axisGrades.안정성,     items: current.axisItems?.['안정성'] || [] },
      { label: '밸류에이션',  grade: current.axisGrades.밸류에이션, items: current.axisItems?.['밸류에이션'] || [] },
      { label: '현금흐름',    grade: current.axisGrades.현금흐름,   items: current.axisItems?.['현금흐름'] || [] },
      { label: '모멘텀',      grade: current.axisGrades.모멘텀,     items: current.axisItems?.['모멘텀'] || [] },
    ],
    conclusion: { raw: current.conclusion.raw, label: current.conclusion.raw },
    reasons: current.reasons,
    risks: current.risks,
    actions: current.actions,
    sources: [],
    statusBar: { status: current.status, buyDate: current.buyDate, buyPrice: current.buyPrice, targetTerm: current.targetTerm, targetRet: current.targetRet, aiNote: current.aiNote, frankMemo: current.frankMemo },
  } : SAMPLE_EVALUATION;

  return (
    <div style={{ textAlign: 'left' }}>
      {/* 매수/매도 토글 */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 14 }}>
        {['매수', '매도'].map(mode => (
          <button key={mode} onClick={() => setEvalMode(mode)} style={{
            padding: '5px 16px', borderRadius: 6, fontSize: 11, fontWeight: 600, fontFamily: baseFont,
            border: evalMode === mode ? '1px solid #F5A623' : '1px solid #2A2F3E',
            background: evalMode === mode ? '#3D2E14' : 'transparent',
            color: evalMode === mode ? '#F5A623' : '#6B7280',
            cursor: 'pointer',
          }}>{mode}</button>
        ))}
      </div>

      {evalMode === '매수' && <>
      {/* 헤더 */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <div>
          <div style={{ fontSize: 13, fontWeight: 700, color: '#E8EAF0' }}>AI 능동 종목 평가</div>
          <div style={{ width: 26, height: 3, borderRadius: 2, background: '#F5A623', marginTop: 6 }} />
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <button onClick={() => setEvalQueueOpen(true)} disabled={sheets.auth !== 'signed-in'} style={{
            padding: '5px 12px', borderRadius: 6, border: '1px solid #F5A623',
            background: '#3D2E14', color: '#F5A623',
            cursor: sheets.auth !== 'signed-in' ? 'not-allowed' : 'pointer',
            opacity: sheets.auth !== 'signed-in' ? 0.4 : 1,
            fontSize: 10, fontFamily: baseFont, fontWeight: 600,
          }}>평가 의뢰</button>
          <button onClick={() => setEvalIngestOpen(true)} disabled={sheets.auth !== 'signed-in'} style={{
            padding: '5px 10px', borderRadius: 6, border: '1px solid #2A2F3E',
            background: 'transparent', color: '#8A9AB5',
            cursor: sheets.auth !== 'signed-in' ? 'not-allowed' : 'pointer',
            opacity: sheets.auth !== 'signed-in' ? 0.4 : 1,
            fontSize: 10, fontFamily: baseFont,
          }} title="수동 평가 JSON 적재">💾</button>
        </div>
      </div>

      {/* 평가 의뢰 큐 상태 */}
      {(evalQueue.counts.pending + evalQueue.counts.processing + evalQueue.counts.error) > 0 && (
        <div style={{
          background: '#0F1218', borderRadius: 8, padding: '8px 12px', marginBottom: 12,
          fontSize: 10, color: '#9CA3AF', display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center',
        }}>
          <span style={{ color: '#8A9AB5', letterSpacing: 1 }}>의뢰 큐</span>
          {evalQueue.counts.pending > 0 && <span>대기 <span style={{ color: '#F5A623', fontWeight: 600 }}>{evalQueue.counts.pending}</span></span>}
          {evalQueue.counts.processing > 0 && <span>처리중 <span style={{ color: '#60A5FA', fontWeight: 600 }}>{evalQueue.counts.processing}</span></span>}
          {evalQueue.counts.error > 0 && <span>오류 <span style={{ color: '#F87171', fontWeight: 600 }}>{evalQueue.counts.error}</span></span>}
        </div>
      )}

      {/* 평가 오류 상세 — 사유 표시 + 재시도 (시트 진입 없이 앱에서 확인·재처리) */}
      {evalQueue.counts.error > 0 && (
        <div style={{ background: '#1A1012', border: '1px solid #4A1E1E', borderRadius: 8, padding: '10px 12px', marginBottom: 12 }}>
          <div style={{ fontSize: 10, letterSpacing: 1, color: '#F87171', marginBottom: 8, fontWeight: 600 }}>
            ⚠ 평가 오류 {evalQueue.counts.error}건 — 사유 확인 후 재시도
          </div>
          {evalQueue.entries.filter(e => e.status === '오류').map((e, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '6px 0', borderTop: i > 0 ? '1px solid #2A1518' : 'none' }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: '#E8EAF0' }}>
                  {e.name}{e.market && <span style={{ color: '#8A9AB5', fontSize: 9, marginLeft: 4 }}>{e.market}</span>}
                </div>
                <div style={{ fontSize: 10, color: '#C98A8A', marginTop: 2, lineHeight: 1.4, wordBreak: 'break-word' }}>
                  {e.memo || '사유 미기록'}
                </div>
              </div>
              <button
                onClick={() => requeueEval(e)}
                disabled={requeueBusyIdx === e.rowIndex || sheets.auth !== 'signed-in'}
                style={{
                  flexShrink: 0, padding: '4px 10px', borderRadius: 5, border: '1px solid #3B82F6',
                  background: 'transparent', color: '#60A5FA',
                  cursor: (requeueBusyIdx === e.rowIndex || sheets.auth !== 'signed-in') ? 'not-allowed' : 'pointer',
                  opacity: (requeueBusyIdx === e.rowIndex || sheets.auth !== 'signed-in') ? 0.5 : 1,
                  fontSize: 10, fontFamily: baseFont, whiteSpace: 'nowrap',
                }}>
                {requeueBusyIdx === e.rowIndex ? '등록 중...' : '다시 시도'}
              </button>
            </div>
          ))}
        </div>
      )}

      {/* 종목 선택 칩 (시트 데이터 있을 때만) — 노트 탭과 동일 순서 */}
      {fromSheet && uniqueEvals.length > 1 && (
        <div style={{ display: 'flex', gap: 6, marginBottom: 12, flexWrap: 'wrap' }}>
          {uniqueEvals.map((ev, i) => (
            <button key={i} onClick={() => setEvalSelectedIdx(i)} style={{
              padding: '4px 10px', borderRadius: 6,
              border: `1px solid ${i === evalSelectedIdx ? '#3B82F6' : '#2A2F3E'}`,
              background: i === evalSelectedIdx ? '#1E3A5F' : 'transparent',
              color: i === evalSelectedIdx ? '#60A5FA' : '#9CA3AF',
              cursor: 'pointer', fontSize: 10, fontFamily: baseFont,
            }}>{ev.stock.name}</button>
          ))}
        </div>
      )}

      <div style={{ fontSize: 9, letterSpacing: 2, color: '#8A9AB5', marginBottom: 8 }}>
        {fromSheet ? `시트 데이터 (${card.stock.name} · ${card.date} 기준)` : `샘플 (${card.stock.name} · ${card.date} 기준)`}
      </div>

      {/* 평가 카드 */}
      <div style={{ background: 'linear-gradient(180deg, #1C2030 0%, #1A1D26 60%)', borderRadius: 14, padding: '18px 16px 12px', marginBottom: 16, border: '1px solid #232838' }}>
        {/* 카드 헤더 — 중앙 정렬 히어로 */}
        <div style={{ textAlign: 'center', marginBottom: 14 }}>
          <div style={{ fontSize: 19, fontWeight: 800, color: '#F5F7FF', letterSpacing: -0.3 }}>
            {card.stock.name}{card.stock.ticker ? ` (${card.stock.ticker})` : ''}
          </div>
          <div style={{ fontSize: 10, color: '#8A9AB5', marginTop: 4, letterSpacing: 1 }}>
            {card.stock.market || '—'} · {card.date}
          </div>
          {fromSheet && card.statusBar?.status && (
            <div style={{
              display: 'inline-block', marginTop: 8,
              padding: '3px 12px', borderRadius: 20, fontSize: 10, fontWeight: 600,
              background: card.statusBar.status === '매수' ? '#1E3A5F'
                        : card.statusBar.status === '매도' ? '#4A1E1E' : '#2A2F3E',
              color:      card.statusBar.status === '매수' ? '#60A5FA'
                        : card.statusBar.status === '매도' ? '#F87171' : '#9CA3AF',
            }}>{card.statusBar.status}</div>
          )}
        </div>

        {/* 5축 */}
        {card.axes.map((axis, ai) => (
          <div key={ai} style={{ borderTop: '1px solid #1E2233', padding: '10px 0' }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: '#E8EAF0', marginBottom: 6, display: 'flex', alignItems: 'center', gap: 7 }}>
              <GradeDot grade={axis.grade} size={9} />
              <span>{ai + 1}. {axis.label}</span>
            </div>
            {/* 시트 카드(items 없음)는 axis 단위 학습 모듈 칩으로 📘 진입 보장 */}
            {axis.items.length === 0 && AXIS_METRICS[axis.label] && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 4 }}>
                {AXIS_METRICS[axis.label].map(metric => (
                  <button key={metric} onClick={() => setEvalSelectedMetric(metric)} style={{
                    padding: '3px 8px', borderRadius: 4, border: '1px solid #2A2F3E',
                    background: 'transparent', color: '#9CA3AF',
                    cursor: 'pointer', fontSize: 10, fontFamily: baseFont,
                    display: 'inline-flex', alignItems: 'center', gap: 4,
                  }} title={LEARNING_MODULES[metric]?.title}>
                    <span>📘</span>
                    <span>{LEARNING_MODULES[metric]?.title}</span>
                  </button>
                ))}
              </div>
            )}
            {axis.items.map((item, ii) => (
              <div key={ii} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', padding: '4px 0', fontSize: 11, gap: 6 }}>
                <div style={{ color: '#9CA3AF', display: 'flex', alignItems: 'center', gap: 4, flex: '0 0 auto', maxWidth: '42%', wordBreak: 'keep-all' }}>
                  <span>{stripPeriod(item.label)}</span>
                  {(() => {
                    const m = item.metric || LABEL_TO_METRIC[item.label?.toLowerCase()];
                    return m ? (
                      <button onClick={() => setEvalSelectedMetric(m)} style={{
                        background: 'transparent', border: 'none', cursor: 'pointer', padding: 0, fontSize: 10, lineHeight: 1, flexShrink: 0,
                      }} title={LEARNING_MODULES[m]?.title}>📘</button>
                    ) : null;
                  })()}
                </div>
                <div style={{ color: '#E8EAF0', display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2, textAlign: 'right', minWidth: 0 }}>
                  <span style={{ fontWeight: 600, wordBreak: 'break-word' }}>{item.value}</span>
                  {(() => {
                    const badge = parsePeriodBadge(item.source);
                    return badge ? (
                      <span style={{ fontSize: 8, color: '#6B7A9A', background: '#1A2030', border: '1px solid #2A3348', borderRadius: 3, padding: '1px 4px', letterSpacing: 0.3 }}>{badge}</span>
                    ) : null;
                  })()}
                </div>
              </div>
            ))}
          </div>
        ))}

        {/* 결론·근거·리스크·액션·출처 */}
        <div style={{ borderTop: '1px solid #2A2F3E', marginTop: 10, paddingTop: 12 }}>
          {(() => {
            const concRaw = fromSheet ? card.conclusion.raw : `${card.conclusion.grade} ${card.conclusion.label}`;
            const cc = gradeColor(concRaw);
            return (
              <div style={{ textAlign: 'center', marginBottom: 14 }}>
                <div style={{ display: 'inline-flex', alignItems: 'center', gap: 9, padding: '8px 18px', borderRadius: 22, background: `${cc}1A`, border: `1px solid ${cc}66` }}>
                  <span style={{ fontSize: 10, color: '#8A9AB5', fontWeight: 600, letterSpacing: 1 }}>결론</span>
                  <GradeDot grade={concRaw} size={11} />
                  <span style={{ fontSize: 15, fontWeight: 800, color: cc, letterSpacing: 0.3 }}>{stripGrade(concRaw) || '—'}</span>
                </div>
              </div>
            );
          })()}

          {card.reasons.length > 0 && (
            <div style={{ marginBottom: 12 }}>
              <SubLabel color="#10B981">근거</SubLabel>
              {card.reasons.map((r, i) => <NumberedItem key={i} n={i + 1} text={r} color="#C2C8D4" numColor="#10B981" />)}
            </div>
          )}

          {card.risks.length > 0 && (
            <div style={{ marginBottom: 12 }}>
              <SubLabel color="#F87171">리스크</SubLabel>
              {card.risks.map((r, i) => <NumberedItem key={i} n={i + 1} text={r} color="#F8A4A4" numColor="#F87171" />)}
            </div>
          )}

          {card.actions.length > 0 && (
            <div style={{ marginBottom: 12 }}>
              <SubLabel color="#60A5FA">Frank 액션 권고</SubLabel>
              {card.actions.map((a, i) => <NumberedItem key={i} n={'•'} text={a} color="#A9C7F5" numColor="#60A5FA" />)}
            </div>
          )}

          {/* 시트 메타 (매수일·목표 등) */}
          {fromSheet && (card.statusBar?.buyDate || card.statusBar?.targetTerm || card.statusBar?.aiNote || card.statusBar?.frankMemo) && (
            <div style={{ background: '#0F1218', borderRadius: 6, padding: '8px 12px', marginTop: 8, fontSize: 10, color: '#9CA3AF', lineHeight: 1.6 }}>
              {card.statusBar.buyDate  && <div>매수일: <span style={{ color: '#E8EAF0' }}>{card.statusBar.buyDate}</span>{card.statusBar.buyPrice ? ` · ${card.statusBar.buyPrice}` : ''}</div>}
              {card.statusBar.targetTerm && <div>목표: <span style={{ color: '#E8EAF0' }}>{card.statusBar.targetTerm}{card.statusBar.targetRet ? ` · ${card.statusBar.targetRet}` : ''}</span></div>}
              {card.statusBar.aiNote   && <div>AI: <span style={{ color: '#E8EAF0' }}>{card.statusBar.aiNote}</span></div>}
              {card.statusBar.frankMemo && <div>Frank: <span style={{ color: '#E8EAF0' }}>{card.statusBar.frankMemo}</span></div>}
            </div>
          )}

          {card.sources?.length > 0 && (
            <div style={{ marginTop: 8 }}>
              <div style={{ fontSize: 10, color: '#8A9AB5', marginBottom: 4, letterSpacing: 1 }}>출처</div>
              {card.sources.map((s, i) => (
                <div key={i} style={{ fontSize: 9, color: '#8A9AB5', paddingLeft: 8, lineHeight: 1.4 }}>· {s}</div>
              ))}
            </div>
          )}
        </div>
      </div>

      </>}

    </div>
  );
}
