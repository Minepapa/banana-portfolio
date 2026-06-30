// 평가 의뢰 모달: 종목명·시장·메모를 입력해 평가 큐에 추가하고 최근 의뢰를 미리본다. App.jsx에서 추출 (동작 불변).
// 표시·입력만 담당 — 제출 로직(submitEvalQueue)과 상태·큐 데이터는 App에서 prop으로 받는다.
export default function EvalQueueModal({
  evalQueueOpen, setEvalQueueOpen,
  evalQueueName, setEvalQueueName,
  evalQueueMarket, setEvalQueueMarket,
  evalQueueMemo, setEvalQueueMemo,
  evalQueueMsg, setEvalQueueMsg,
  evalQueueBusy, submitEvalQueue, evalQueue, baseFont,
}) {
  if (!evalQueueOpen) return null;
  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.65)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: 16, zIndex: 200,
    }} onClick={(e) => { if (e.target === e.currentTarget) setEvalQueueOpen(false); }}>
      <div style={{
        background: '#FFFFFF', borderRadius: 0, width: '100%', maxWidth: 420,
        maxHeight: '90vh', overflowY: 'auto', padding: '20px 18px',
        border: '1px solid #141414',
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: '#F5A623' }}>평가 의뢰</div>
          <button onClick={() => setEvalQueueOpen(false)} style={{
            background: 'transparent', border: 'none', cursor: 'pointer',
            color: '#6B675C', fontSize: 18, padding: 0, lineHeight: 1,
          }}>✕</button>
        </div>

        {/* 종목명 */}
        <div style={{ marginBottom: 10 }}>
          <div style={{ fontSize: 10, color: '#6B675C', marginBottom: 4, letterSpacing: 1 }}>종목명</div>
          <input
            value={evalQueueName}
            onChange={(e) => { setEvalQueueName(e.target.value); setEvalQueueMsg(''); }}
            placeholder="예: 삼성전자 또는 NVDA"
            autoFocus
            style={{
              width: '100%', boxSizing: 'border-box',
              background: '#FFFFFF', border: '1px solid #141414',
              borderRadius: 0, padding: '8px 10px', color: '#141414', fontSize: 13,
              fontFamily: baseFont, outline: 'none',
            }}
          />
        </div>

        {/* 시장 */}
        <div style={{ marginBottom: 10 }}>
          <div style={{ fontSize: 10, color: '#6B675C', marginBottom: 4, letterSpacing: 1 }}>시장</div>
          <div style={{ display: 'flex', gap: 6 }}>
            {['KR', 'US'].map(m => (
              <button key={m} onClick={() => setEvalQueueMarket(m)} style={{
                flex: 1, padding: '8px 12px', borderRadius: 0,
                border: `1px solid ${evalQueueMarket === m ? '#141414' : '#141414'}`,
                background: evalQueueMarket === m ? '#EAE6DA' : 'transparent',
                color: evalQueueMarket === m ? '#141414' : '#6B675C',
                cursor: 'pointer', fontSize: 11, fontFamily: baseFont, fontWeight: 600,
              }}>{m}</button>
            ))}
          </div>
        </div>

        {/* 메모 */}
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 10, color: '#6B675C', marginBottom: 4, letterSpacing: 1 }}>메모 (선택)</div>
          <input
            value={evalQueueMemo}
            onChange={(e) => setEvalQueueMemo(e.target.value)}
            placeholder="평가 시 참고할 맥락 (예: 1분기 어닝 후 재평가)"
            style={{
              width: '100%', boxSizing: 'border-box',
              background: '#FFFFFF', border: '1px solid #141414',
              borderRadius: 0, padding: '8px 10px', color: '#141414', fontSize: 12,
              fontFamily: baseFont, outline: 'none',
            }}
          />
        </div>

        <button onClick={submitEvalQueue} disabled={!evalQueueName.trim() || evalQueueBusy} style={{
          width: '100%', padding: '10px 12px', borderRadius: 0, border: 'none',
          background: (evalQueueName.trim() && !evalQueueBusy) ? '#F5A623' : '#141414',
          color: (evalQueueName.trim() && !evalQueueBusy) ? '#FFFFFF' : '#6B675C',
          cursor: (evalQueueName.trim() && !evalQueueBusy) ? 'pointer' : 'not-allowed',
          fontSize: 12, fontWeight: 700, fontFamily: baseFont,
        }}>
          {evalQueueBusy ? '추가 중...' : '큐에 추가'}
        </button>

        {evalQueueMsg && (
          <div style={{
            marginTop: 10, padding: '8px 12px', borderRadius: 0,
            background: '#FFFFFF', fontSize: 11,
            color: evalQueueMsg.startsWith('✓') ? '#159E52'
                 : evalQueueMsg.startsWith('⚠️') ? '#F59E0B'
                 : evalQueueMsg.includes('실패') ? '#E5484D' : '#6B675C',
            lineHeight: 1.5,
          }}>{evalQueueMsg}</div>
        )}

        {/* 큐 미리보기 */}
        {evalQueue.entries.length > 0 && (
          <div style={{ marginTop: 16, paddingTop: 14, borderTop: '1px solid #141414' }}>
            <div style={{ fontSize: 10, letterSpacing: 2, color: '#6B675C', marginBottom: 8 }}>
              최근 의뢰 ({evalQueue.entries.length}건)
            </div>
            {evalQueue.entries.slice(0, 5).map((e, i) => (
              <div key={i} style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                padding: '6px 0', fontSize: 10, borderBottom: i < 4 ? '1px solid #EAE6DA' : 'none',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                  <span style={{
                    fontSize: 9, padding: '1px 6px', borderRadius: 0,
                    background: e.status === '완료' ? '#DDF3E4'
                              : e.status === '처리중' ? '#EAE6DA'
                              : e.status === '오류' ? '#FBE3E4' : '#FBF1D0',
                    color: e.status === '완료' ? '#159E52'
                         : e.status === '처리중' ? '#141414'
                         : e.status === '오류' ? '#E5484D' : '#F5A623',
                  }}>{e.status}</span>
                  <span style={{ color: '#141414', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {e.name}
                  </span>
                  {e.market && <span style={{ color: '#6B675C', fontSize: 9 }}>{e.market}</span>}
                </div>
                <span style={{ color: '#6B675C', fontSize: 9, flexShrink: 0, marginLeft: 8 }}>
                  {e.requestedAt.slice(5)}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
