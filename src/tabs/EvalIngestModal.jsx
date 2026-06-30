// 평가 카드 적재 모달: AI 평가 JSON을 붙여넣어 파싱·검토 후 시트에 적재. App.jsx에서 추출 (동작 불변).
// 표시·입력만 담당 — 파싱(tryParseEvalJson)·적재(ingestEvaluation) 로직과 상태는 App에서 prop으로 받는다.
export default function EvalIngestModal({
  evalIngestOpen, setEvalIngestOpen,
  evalIngestRaw, setEvalIngestRaw,
  evalIngestParsed, setEvalIngestParsed,
  evalIngestMsg, setEvalIngestMsg,
  evalIngestBusy, tryParseEvalJson, ingestEvaluation, baseFont,
}) {
  if (!evalIngestOpen) return null;
  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.65)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: 16, zIndex: 200,
    }} onClick={(e) => { if (e.target === e.currentTarget) setEvalIngestOpen(false); }}>
      <div style={{
        background: '#FFFFFF', borderRadius: 0, width: '100%', maxWidth: 560,
        maxHeight: '90vh', overflowY: 'auto', padding: '20px 18px',
        border: '1px solid #141414',
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: '#141414' }}>평가 결과 저장</div>
          <button onClick={() => setEvalIngestOpen(false)} style={{
            background: 'transparent', border: 'none', cursor: 'pointer',
            color: '#6B675C', fontSize: 18, padding: 0, lineHeight: 1,
          }}>✕</button>
        </div>

        <textarea
          value={evalIngestRaw}
          onChange={(e) => { setEvalIngestRaw(e.target.value); setEvalIngestParsed(null); setEvalIngestMsg(''); }}
          placeholder="JSON 블록 붙여넣기"
          style={{
            width: '100%', minHeight: 140, boxSizing: 'border-box',
            background: '#FFFFFF', color: '#141414', border: '1px solid #141414',
            borderRadius: 0, padding: 10, fontSize: 11, fontFamily: 'ui-monospace, Menlo, monospace',
            lineHeight: 1.5, resize: 'vertical', outline: 'none',
          }}
        />

        <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
          <button onClick={() => {
            const r = tryParseEvalJson(evalIngestRaw);
            if (r.ok) { setEvalIngestParsed(r.data); setEvalIngestMsg('✓ 파싱 완료. 검토 후 적재하세요.'); }
            else { setEvalIngestParsed(null); setEvalIngestMsg(`⚠️ ${r.error}`); }
          }} style={{
            flex: 1, padding: '8px 12px', borderRadius: 0, border: '1px solid #141414',
            background: 'transparent', color: '#6B675C', cursor: 'pointer',
            fontSize: 11, fontFamily: baseFont,
          }}>파싱</button>
          <button onClick={ingestEvaluation} disabled={!evalIngestParsed || evalIngestBusy} style={{
            flex: 1, padding: '8px 12px', borderRadius: 0, border: 'none',
            background: evalIngestParsed && !evalIngestBusy ? '#141414' : '#141414',
            color: evalIngestParsed && !evalIngestBusy ? '#fff' : '#6B675C',
            cursor: evalIngestParsed && !evalIngestBusy ? 'pointer' : 'not-allowed',
            fontSize: 11, fontWeight: 600, fontFamily: baseFont,
          }}>{evalIngestBusy ? '적재 중...' : '시트에 적재'}</button>
        </div>

        {evalIngestMsg && (
          <div style={{
            marginTop: 10, padding: '8px 12px', borderRadius: 0,
            background: '#FFFFFF', fontSize: 11,
            color: evalIngestMsg.startsWith('✓') ? '#159E52'
                 : evalIngestMsg.startsWith('⚠️') ? '#F59E0B'
                 : evalIngestMsg.includes('실패') ? '#E5484D' : '#6B675C',
            lineHeight: 1.5,
          }}>{evalIngestMsg}</div>
        )}

        {/* 파싱 결과 미리보기 + 편집 */}
        {evalIngestParsed && (
          <div style={{ marginTop: 14, paddingTop: 14, borderTop: '1px solid #141414' }}>
            <div style={{ fontSize: 10, letterSpacing: 2, color: '#6B675C', marginBottom: 8 }}>미리보기 (편집 가능)</div>
            {[
              { k: 'date', label: '평가일' },
              { k: 'name', label: '종목명' },
              { k: 'ticker', label: '종목코드' },
              { k: 'market', label: '시장' },
              { k: 'conclusion', label: '결론' },
              { k: 'status', label: '매수여부' },
              { k: 'buyDate', label: '매수일' },
              { k: 'buyPrice', label: '매수가' },
              { k: 'targetTerm', label: '목표기간' },
              { k: 'targetRet', label: '목표수익률' },
              { k: 'aiNote', label: 'AI 의견' },
              { k: 'frankMemo', label: 'Frank 메모' },
            ].map(({ k, label }) => (
              <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                <div style={{ width: 80, fontSize: 10, color: '#6B675C', textAlign: 'right', flexShrink: 0 }}>{label}</div>
                <input
                  value={evalIngestParsed[k] || ''}
                  onChange={(e) => setEvalIngestParsed({ ...evalIngestParsed, [k]: e.target.value })}
                  style={{
                    flex: 1, background: '#FFFFFF', border: '1px solid #141414',
                    borderRadius: 0, padding: '4px 8px', color: '#141414', fontSize: 11,
                    fontFamily: baseFont, outline: 'none',
                  }}
                />
              </div>
            ))}

            <div style={{ marginTop: 10 }}>
              <div style={{ fontSize: 10, color: '#6B675C', marginBottom: 4 }}>5축 등급</div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {Object.entries(evalIngestParsed.grades).map(([axis, val]) => (
                  <div key={axis} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    <span style={{ fontSize: 10, color: '#6B675C' }}>{axis}</span>
                    <input
                      value={val}
                      onChange={(e) => setEvalIngestParsed({
                        ...evalIngestParsed,
                        grades: { ...evalIngestParsed.grades, [axis]: e.target.value },
                      })}
                      style={{
                        width: 44, background: '#FFFFFF', border: '1px solid #141414',
                        borderRadius: 0, padding: '3px 6px', color: '#141414', fontSize: 11,
                        textAlign: 'center', fontFamily: baseFont, outline: 'none',
                      }}
                    />
                  </div>
                ))}
              </div>
            </div>

            <div style={{ marginTop: 10, fontSize: 10, color: '#6B675C' }}>
              근거 {evalIngestParsed.reasons.length}건 · 리스크 {evalIngestParsed.risks.length}건 · 액션 {evalIngestParsed.actions.length}건
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
