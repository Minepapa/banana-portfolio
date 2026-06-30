// 평가 탭(매수 모드): AI 능동 종목 평가 카드 + 매수/매도 토글. App.jsx에서 추출 (동작 불변).
// 매수/매도 토글은 tab==="평가"일 때 항상 렌더 — 이 컴포넌트가 토글의 소유자.
// evalSelectedIdx는 매수 전용이라 내려옴. 의뢰/적재 모달·재시도는 App 책임이라 prop.
import { SAMPLE_EVALUATION, AXIS_METRICS, LEARNING_MODULES, LABEL_TO_METRIC } from '../lib/constants.js';
import { GradeDot, SubLabel, NumberedItem } from '../lib/primitives.jsx';
import { gradeColor, stripGrade, stripPeriod } from '../lib/textFormat.js';

// "OpenDart 2025 반기보고서(연결)" → "2025 H1", "quarterly+info(TTM)" → "TTM"
// 매칭 안 되면 source 텍스트를 축약해서라도 표시 (일관된 출처 표기)
function parsePeriodBadge(source) {
  if (!source) return null;
  const od = source.match(/OpenDart (\d{4}) (사업보고서|1분기보고서|반기보고서|3분기보고서)/);
  if (od) {
    const label = { '사업보고서': '연간', '1분기보고서': 'Q1', '반기보고서': 'H1', '3분기보고서': 'Q3' }[od[2]];
    return `${od[1]} ${label}`;
  }
  if (source.includes('TTM') || source.includes('quarterly+info')) return 'TTM';
  if (source.includes('yfinance')) return 'yfinance';
  if (source.includes('pykrx')) return 'pykrx';
  if (source.includes('네이버')) return '네이버';
  return source.length <= 20 ? source : source.slice(0, 18) + '…';
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
            padding: '5px 16px', borderRadius: 0, fontSize: 11, fontWeight: evalMode === mode ? 800 : 600, fontFamily: baseFont,
            border: '1px solid #141414',
            background: evalMode === mode ? '#F5A623' : 'transparent',
            boxShadow: evalMode === mode ? '2px 2px 0 #141414' : 'none',
            color: evalMode === mode ? '#141414' : '#6B675C',
            cursor: 'pointer',
          }}>{mode}</button>
        ))}
      </div>

      {evalMode === '매수' && <>
      {/* 헤더 */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 700, color: '#141414' }}>AI 능동 종목 평가</div>
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <button onClick={() => setEvalQueueOpen(true)} disabled={sheets.auth !== 'signed-in'} style={{
            padding: '5px 12px', borderRadius: 0, border: '1px solid #141414',
            background: '#F5A623', color: '#141414',
            cursor: sheets.auth !== 'signed-in' ? 'not-allowed' : 'pointer',
            opacity: sheets.auth !== 'signed-in' ? 0.4 : 1,
            fontSize: 10, fontFamily: baseFont, fontWeight: 600,
          }}>평가 의뢰</button>
          <button onClick={() => setEvalIngestOpen(true)} disabled={sheets.auth !== 'signed-in'} style={{
            padding: '5px 10px', borderRadius: 0, border: '1px solid #141414',
            background: 'transparent', color: '#6B675C',
            cursor: sheets.auth !== 'signed-in' ? 'not-allowed' : 'pointer',
            opacity: sheets.auth !== 'signed-in' ? 0.4 : 1,
            fontSize: 10, fontFamily: baseFont,
          }} title="수동 평가 JSON 적재">💾</button>
        </div>
      </div>

      {/* 평가 의뢰 큐 상태 */}
      {(evalQueue.counts.pending + evalQueue.counts.processing + evalQueue.counts.error) > 0 && (
        <div style={{
          background: '#FFFFFF', borderRadius: 0, padding: '8px 12px', marginBottom: 12,
          fontSize: 10, color: '#6B675C', display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center',
        }}>
          <span style={{ color: '#6B675C', letterSpacing: 1 }}>의뢰 큐</span>
          {evalQueue.counts.pending > 0 && <span>대기 <span style={{ color: '#F5A623', fontWeight: 600 }}>{evalQueue.counts.pending}</span></span>}
          {evalQueue.counts.processing > 0 && <span>처리중 <span style={{ color: '#141414', fontWeight: 600 }}>{evalQueue.counts.processing}</span></span>}
          {evalQueue.counts.error > 0 && <span>오류 <span style={{ color: '#E5484D', fontWeight: 600 }}>{evalQueue.counts.error}</span></span>}
        </div>
      )}

      {/* 평가 오류 상세 — 사유 표시 + 재시도 (시트 진입 없이 앱에서 확인·재처리) */}
      {evalQueue.counts.error > 0 && (
        <div style={{ background: '#FBE3E4', border: '1px solid #FBE3E4', borderRadius: 0, padding: '10px 12px', marginBottom: 12 }}>
          <div style={{ fontSize: 10, letterSpacing: 1, color: '#E5484D', marginBottom: 8, fontWeight: 600 }}>
            ⚠ 평가 오류 {evalQueue.counts.error}건 — 사유 확인 후 재시도
          </div>
          {evalQueue.entries.filter(e => e.status === '오류').map((e, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '6px 0', borderTop: i > 0 ? '1px solid #141414' : 'none' }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: '#141414' }}>
                  {e.name}{e.market && <span style={{ color: '#6B675C', fontSize: 9, marginLeft: 4 }}>{e.market}</span>}
                </div>
                <div style={{ fontSize: 10, color: '#6B675C', marginTop: 2, lineHeight: 1.4, wordBreak: 'break-word' }}>
                  {e.memo || '사유 미기록'}
                </div>
              </div>
              <button
                onClick={() => requeueEval(e)}
                disabled={requeueBusyIdx === e.rowIndex || sheets.auth !== 'signed-in'}
                style={{
                  flexShrink: 0, padding: '4px 10px', borderRadius: 0, border: '1px solid #141414',
                  background: 'transparent', color: '#141414',
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
              padding: '4px 10px', borderRadius: 0,
              border: '1px solid #141414',
              background: i === evalSelectedIdx ? '#C9F23E' : 'transparent',
              color: '#141414', fontWeight: i === evalSelectedIdx ? 800 : 600,
              cursor: 'pointer', fontSize: 10, fontFamily: baseFont,
            }}>{ev.stock.name}</button>
          ))}
        </div>
      )}

      <div style={{ fontSize: 9, letterSpacing: 2, color: '#6B675C', marginBottom: 8 }}>
        {fromSheet ? `시트 데이터 (${card.stock.name} · ${card.date} 기준)` : `샘플 (${card.stock.name} · ${card.date} 기준)`}
      </div>

      {/* 평가 카드 */}
      <div style={{ background: '#FFFFFF', borderRadius: 0, padding: '18px 16px 12px', marginBottom: 16, border: '2px solid #141414', boxShadow: '4px 4px 0 #141414' }}>
        {/* 카드 헤더 — 중앙 정렬 히어로 */}
        <div style={{ textAlign: 'center', marginBottom: 14 }}>
          <div style={{ fontSize: 19, fontWeight: 800, color: '#141414', letterSpacing: -0.3 }}>
            {card.stock.name}{card.stock.ticker ? ` (${card.stock.ticker})` : ''}
          </div>
          <div style={{ fontSize: 10, color: '#6B675C', marginTop: 4, letterSpacing: 1 }}>
            {card.stock.market || '—'} · {card.date}
          </div>
          {card.axes.length > 0 && (
            <div style={{ display: 'flex', justifyContent: 'center', gap: 6, marginTop: 10 }}>
              {card.axes.map((axis, i) => (
                <div key={i} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3 }}>
                  <GradeDot grade={axis.grade} size={10} />
                  <span style={{ fontSize: 7, color: '#6B675C', letterSpacing: -0.3 }}>
                    {axis.label.replace('재무 ', '')}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* 5축 */}
        {card.axes.map((axis, ai) => (
          <div key={ai} style={{ borderTop: '1px solid #EAE6DA', padding: '10px 0' }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: '#141414', marginBottom: 6, display: 'flex', alignItems: 'center', gap: 7 }}>
              <GradeDot grade={axis.grade} size={9} />
              <span>{ai + 1}. {axis.label}</span>
            </div>
            {/* 시트 카드(items 없음)는 axis 단위 학습 모듈 칩으로 📘 진입 보장 */}
            {axis.items.length === 0 && AXIS_METRICS[axis.label] && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 4 }}>
                {AXIS_METRICS[axis.label].map(metric => (
                  <button key={metric} onClick={() => setEvalSelectedMetric(metric)} style={{
                    padding: '3px 8px', borderRadius: 0, border: '1px solid #141414',
                    background: 'transparent', color: '#6B675C',
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
                <div style={{ color: '#6B675C', display: 'flex', alignItems: 'center', gap: 4, flex: '0 0 auto', maxWidth: '42%', wordBreak: 'keep-all' }}>
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
                <div style={{ color: '#141414', display: 'flex', alignItems: 'baseline', gap: 5, justifyContent: 'flex-end', minWidth: 0 }}>
                  <span style={{ fontWeight: 600, wordBreak: 'break-word' }}>{item.value}</span>
                  {(() => {
                    const badge = parsePeriodBadge(item.source);
                    return badge ? (
                      <span style={{ fontSize: 7, color: '#6B675C', background: '#EAE6DA', border: '1px solid #141414', borderRadius: 0, padding: '1px 4px', letterSpacing: 0.3, whiteSpace: 'nowrap', flexShrink: 0 }}>{badge}</span>
                    ) : null;
                  })()}
                </div>
              </div>
            ))}
          </div>
        ))}

        {/* 결론·근거·리스크·액션·출처 */}
        <div style={{ borderTop: '1px solid #141414', marginTop: 10, paddingTop: 12 }}>
          {(() => {
            const concRaw = fromSheet ? card.conclusion.raw : `${card.conclusion.grade} ${card.conclusion.label}`;
            const cc = gradeColor(concRaw);
            return (
              <div style={{ textAlign: 'center', marginBottom: 14 }}>
                <div style={{ display: 'inline-flex', alignItems: 'center', gap: 9, padding: '8px 18px', borderRadius: 0, background: `${cc}1A`, border: `1px solid ${cc}66` }}>
                  <span style={{ fontSize: 10, color: '#6B675C', fontWeight: 600, letterSpacing: 1 }}>결론</span>
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
              <SubLabel color="#E5484D">리스크</SubLabel>
              {card.risks.map((r, i) => <NumberedItem key={i} n={i + 1} text={r} color="#F8A4A4" numColor="#E5484D" />)}
            </div>
          )}

          {card.actions.length > 0 && (
            <div style={{ marginBottom: 12 }}>
              <SubLabel color="#141414">Frank 액션 권고</SubLabel>
              {card.actions.map((a, i) => <NumberedItem key={i} n={'•'} text={a} color="#A9C7F5" numColor="#141414" />)}
            </div>
          )}

          {/* 시트 메타 (상태·매수일·목표 등) */}
          {fromSheet && (card.statusBar?.status || card.statusBar?.buyDate || card.statusBar?.targetTerm || card.statusBar?.aiNote || card.statusBar?.frankMemo) && (
            <div style={{ background: '#FFFFFF', borderRadius: 0, padding: '8px 12px', marginTop: 8, fontSize: 10, color: '#6B675C', lineHeight: 1.6 }}>
              {card.statusBar.status && <div>상태: <span style={{ color: card.statusBar.status === '매수' ? '#141414' : card.statusBar.status === '매도' ? '#E5484D' : '#141414', fontWeight: 600 }}>{card.statusBar.status}</span></div>}
              {card.statusBar.buyDate  && <div>매수일: <span style={{ color: '#141414' }}>{card.statusBar.buyDate}</span>{card.statusBar.buyPrice ? ` · ${card.statusBar.buyPrice}` : ''}</div>}
              {card.statusBar.targetTerm && <div>목표: <span style={{ color: '#141414' }}>{card.statusBar.targetTerm}{card.statusBar.targetRet ? ` · ${card.statusBar.targetRet}` : ''}</span></div>}
              {card.statusBar.aiNote   && <div>AI: <span style={{ color: '#141414' }}>{card.statusBar.aiNote}</span></div>}
              {card.statusBar.frankMemo && <div>Frank: <span style={{ color: '#141414' }}>{card.statusBar.frankMemo}</span></div>}
            </div>
          )}

          {card.sources?.length > 0 && (
            <div style={{ marginTop: 8 }}>
              <div style={{ fontSize: 10, color: '#6B675C', marginBottom: 4, letterSpacing: 1 }}>출처</div>
              {card.sources.map((s, i) => (
                <div key={i} style={{ fontSize: 9, color: '#6B675C', paddingLeft: 8, lineHeight: 1.4 }}>· {s}</div>
              ))}
            </div>
          )}
        </div>
      </div>

      </>}

    </div>
  );
}
