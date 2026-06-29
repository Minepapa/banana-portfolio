// 포지션 탭: 거래 생애주기(거래직전→감시→반성) 투자논리 관리. App.jsx에서 추출 (동작 불변).
// 편집 상태(journalOpen/lessonDraft/exitDraft/exitEditing)는 이 탭 전용이라 함께 내려옴.
// 시트 쓰기 핸들러(confirmThesis/saveExit/saveLesson)는 sheets prop만 사용 — 탭 로컬.
import { useState } from 'react';
import { SectionTitle } from '../lib/primitives.jsx';
import { findThesisAlerts } from '../lib/thesisAlerts.js';
import { useLongPress } from '../hooks/useLongPress.js';

export default function PositionJournalTab({ positionJournal, riskMonitor, sheets, baseFont }) {
  const lp = useLongPress();
  const [journalOpen, setJournalOpen] = useState(new Set());
  const [lessonDraft, setLessonDraft] = useState({}); // rowIndex → 교훈 입력값 (반성 카드)
  const [exitDraft, setExitDraft] = useState({}); // rowIndex → 이탈조건 편집값
  const [exitEditing, setExitEditing] = useState(new Set()); // 이탈조건 편집 중인 rowIndex

  const held = positionJournal.filter(p => p.status !== '청산');
  const closed = positionJournal.filter(p => p.status === '청산');
  const alertByRow = new Map(findThesisAlerts(positionJournal, riskMonitor).map(a => [a.position.rowIndex, a.signal]));
  const byAlert = (a, b) => (alertByRow.has(b.rowIndex) ? 1 : 0) - (alertByRow.has(a.rowIndex) ? 1 : 0);
  const conviction = held.filter(p => p.kind === '확신').sort(byAlert);
  const alloc = held.filter(p => p.kind !== '확신').sort(byAlert);
  const pending = held.filter(p => p.confirm !== '확인').length;
  // 논리 점검(risk-b)은 보유종목을 한 배치로 점검하므로, B신호 최신 날짜 = 일괄 점검일.
  const lastChecked = (riskMonitor || []).filter(r => r.type === 'B').reduce((mx, r) => (r.date > mx ? r.date : mx), '');

  const kindBadge = (kind) => (
    <span style={{ fontSize: 9, fontWeight: 700, padding: '2px 6px', borderRadius: 4,
      background: kind === '확신' ? '#F4845F22' : '#52C8D422',
      color: kind === '확신' ? '#F4845F' : '#52C8D4' }}>
      {kind === '확신' ? '확신' : '배분'}
    </span>
  );
  const confirmBadge = (c) => {
    const map = { '확인': ['#4ADE8022', '#4ADE80', '✓ 확인'], '대기': ['#F5C84222', '#F5C842', '확인 대기'], '미작성': ['#8A9AB522', '#8A9AB5', '미작성'] };
    const [bg, fg, label] = map[c] || map['미작성'];
    return <span style={{ fontSize: 9, fontWeight: 700, padding: '2px 6px', borderRadius: 4, background: bg, color: fg }}>{label}</span>;
  };

  const confirmThesis = async (p) => {
    const nowStr = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Seoul' }).slice(0, 16);
    try {
      await sheets.writeRange(`포지션저널!O${p.rowIndex + 2}:P${p.rowIndex + 2}`, ['확인', nowStr]);
      await sheets.fetch();
    } catch (e) { console.error('전제 확인 오류:', e); }
  };

  // 이탈조건 저장 → H열(이탈조건) + P열(갱신시각)
  const saveExit = async (p) => {
    const text = (exitDraft[p.rowIndex] ?? '').trim();
    const nowStr = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Seoul' }).slice(0, 16);
    try {
      await sheets.writeRange(`포지션저널!H${p.rowIndex + 2}`, [text]);
      await sheets.writeRange(`포지션저널!P${p.rowIndex + 2}`, [nowStr]);
      setExitEditing(prev => { const n = new Set(prev); n.delete(p.rowIndex); return n; });
      setExitDraft(prev => { const n = { ...prev }; delete n[p.rowIndex]; return n; });
      await sheets.fetch();
    } catch (e) { console.error('이탈조건 저장 오류:', e); }
  };

  // 청산 포지션의 교훈 저장 → N(교훈) + P(갱신시각). 다음 매수 때 ①에서 경고로 재노출
  const saveLesson = async (p) => {
    const text = (lessonDraft[p.rowIndex] ?? '').trim();
    if (!text) return;
    const nowStr = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Seoul' }).slice(0, 16);
    try {
      await sheets.writeRange(`포지션저널!N${p.rowIndex + 2}`, [text]);
      await sheets.writeRange(`포지션저널!P${p.rowIndex + 2}`, [nowStr]);
      setLessonDraft(prev => { const n = { ...prev }; delete n[p.rowIndex]; return n; });
      await sheets.fetch();
    } catch (e) { console.error('교훈 저장 오류:', e); }
  };

  const Card = (p) => {
    const needReflect = p.status === '청산' && !p.lesson;
    const open = journalOpen.has(p.rowIndex) || needReflect; // 반성 필요 카드는 기본 펼침
    const sig = alertByRow.get(p.rowIndex);
    const sigColor = sig && /🔴/.test(sig.signal) ? '#EF4444' : '#F5C842';
    return (
      <div key={p.rowIndex} style={{ background: '#1A1D26', border: `1px solid ${sig ? sigColor + '66' : '#262A3A'}`, borderRadius: 10, marginBottom: 8, overflow: 'hidden' }}>
        <button onClick={() => setJournalOpen(prev => { const n = new Set(prev); n.has(p.rowIndex) ? n.delete(p.rowIndex) : n.add(p.rowIndex); return n; })}
          style={{ width: '100%', textAlign: 'left', background: 'none', border: 'none', cursor: 'pointer', padding: '12px 14px', fontFamily: baseFont }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 13, fontWeight: 700, color: '#F5F7FF' }}>{p.name}</span>
            {kindBadge(p.kind)}
            {confirmBadge(p.confirm)}
            {sig && <span style={{ fontSize: 9, fontWeight: 700, padding: '2px 6px', borderRadius: 4, background: '#EF444422', color: '#EF4444' }}>⚠ 투자논리 훼손</span>}
            <span style={{ marginLeft: 'auto', fontSize: 10, color: '#8A9AB5' }}>{p.account}</span>
          </div>
          {!open && sig && (
            <div style={{ fontSize: 11, color: sigColor, marginTop: 6, lineHeight: 1.4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{sig.signal} {sig.summary}</div>
          )}
          {!open && !sig && p.thesis && (
            <div style={{ fontSize: 11, color: '#9CA3AF', marginTop: 6, lineHeight: 1.4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.thesis}</div>
          )}
        </button>
        {open && (
          <div style={{ padding: '0 14px 14px' }}>
            {sig && (
              <div style={{ background: sigColor + '14', border: `1px solid ${sigColor}44`, borderRadius: 8, padding: 10, marginBottom: 10 }}>
                <div style={{ fontSize: 10, fontWeight: 700, color: sigColor, marginBottom: 3 }}>⚠ 투자논리 훼손 — 이탈조건 대조 필요 · {sig.type}신호 {sig.date}</div>
                <div style={{ fontSize: 12, color: '#F5F7FF', lineHeight: 1.5 }}>{sig.signal} {sig.summary}</div>
                {sig.detail && <div style={{ fontSize: 11, color: '#C9D1E5', lineHeight: 1.5, marginTop: 4 }}>{sig.detail}</div>}
              </div>
            )}
            {p.thesis && (<><div style={{ fontSize: 9, letterSpacing: 1, color: '#60A5FA', marginBottom: 3 }}>투자논리</div>
              <div style={{ fontSize: 12, color: '#E5E9F5', lineHeight: 1.5, marginBottom: 10 }}>{p.thesis}</div></>)}
            <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 10 }}>
              {p.target && <div><div style={{ fontSize: 9, color: '#8A9AB5' }}>목표</div><div style={{ fontSize: 11, color: '#F5F7FF' }}>{p.target}</div></div>}
              {p.hold && <div><div style={{ fontSize: 9, color: '#8A9AB5' }}>예상보유</div><div style={{ fontSize: 11, color: '#F5F7FF' }}>{p.hold}</div></div>}
              {p.entry && <div><div style={{ fontSize: 9, color: '#8A9AB5' }}>진입일</div><div style={{ fontSize: 11, color: '#F5F7FF' }}>{p.entry}</div></div>}
            </div>
            {p.status !== '청산' ? (
              exitEditing.has(p.rowIndex) ? (
                <div style={{ marginBottom: 10 }}>
                  <div style={{ fontSize: 9, letterSpacing: 1, color: '#F4845F', marginBottom: 4 }}>이탈조건 편집</div>
                  <textarea
                    value={exitDraft[p.rowIndex] ?? p.exit ?? ''}
                    onChange={e => setExitDraft(prev => ({ ...prev, [p.rowIndex]: e.target.value }))}
                    rows={2}
                    style={{ width: '100%', boxSizing: 'border-box', background: '#1A1D26', border: '1px solid #F4845F55', borderRadius: 6, color: '#F5C9B8', fontSize: 11, fontFamily: baseFont, padding: 8, resize: 'vertical' }}
                  />
                  <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                    <button onClick={() => saveExit(p)}
                      style={{ padding: '6px 12px', minHeight: 32, borderRadius: 6, border: '1px solid #F4845F55', background: '#2A1A12', color: '#F4845F', cursor: 'pointer', fontSize: 11, fontWeight: 700, fontFamily: baseFont }}>
                      저장
                    </button>
                    <button onClick={() => setExitEditing(prev => { const n = new Set(prev); n.delete(p.rowIndex); return n; })}
                      style={{ padding: '6px 12px', minHeight: 32, borderRadius: 6, border: '1px solid #2E3344', background: 'none', color: '#9CA3AF', cursor: 'pointer', fontSize: 11, fontFamily: baseFont }}>
                      취소
                    </button>
                  </div>
                </div>
              ) : (
                <div
                  {...lp.bind(p.rowIndex, () => setExitEditing(prev => { const n = new Set(prev); n.add(p.rowIndex); return n; }))}
                  style={{ position: 'relative', cursor: 'pointer', borderRadius: 6, padding: '6px 8px', margin: '0 -8px 10px', userSelect: 'none', background: lp.activeId === p.rowIndex ? '#F4845F14' : 'transparent' }}>
                  {lp.activeId === p.rowIndex && <div className="lp-progress" />}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
                    <div style={{ fontSize: 9, letterSpacing: 1, color: '#F4845F' }}>이탈조건 (이게 깨지면 매도 검토)</div>
                  </div>
                  {p.exit ? (
                    <div style={{ fontSize: 12, color: '#F5C9B8', lineHeight: 1.5 }}>{p.exit}</div>
                  ) : (
                    <div style={{ fontSize: 11, color: '#3A4050' }}>이탈조건 없음 — 길게 눌러 추가</div>
                  )}
                </div>
              )
            ) : (
              p.exit && (<><div style={{ fontSize: 9, letterSpacing: 1, color: '#F4845F', marginBottom: 3 }}>이탈조건</div>
                <div style={{ fontSize: 12, color: '#F5C9B8', lineHeight: 1.5, marginBottom: 10 }}>{p.exit}</div></>)
            )}
            {p.status === '청산' && (
              <div style={{ background: '#12141C', borderRadius: 8, padding: 12, marginBottom: 10 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
                  <span style={{ fontSize: 9, letterSpacing: 1, color: '#A8D672', fontWeight: 700 }}>반성 — 투자논리는 맞았나?</span>
                  {p.exitDate && <span style={{ fontSize: 9, color: '#8A9AB5' }}>청산 {p.exitDate}</span>}
                  {!p.lesson && <span style={{ marginLeft: 'auto', fontSize: 9, fontWeight: 700, padding: '2px 6px', borderRadius: 4, background: '#F5C84222', color: '#F5C842' }}>반성 필요</span>}
                </div>
                {p.result && <div style={{ fontSize: 11, color: '#E5E9F5', marginBottom: 6 }}>청산결과: {p.result}</div>}
                {p.lesson ? (
                  <div style={{ fontSize: 11, color: '#A8D672', lineHeight: 1.5 }}>교훈: {p.lesson}</div>
                ) : (
                  <div>
                    <div style={{ fontSize: 10, color: '#8A9AB5', lineHeight: 1.5, marginBottom: 6 }}>
                      이 매도에서 배운 한 가지를 남기세요. {p.exit ? '이탈조건대로 팔았는지, 너무 일찍/늦게 팔았는지.' : '왜 팔았고, 다음엔 무엇을 다르게 할지.'}
                    </div>
                    <textarea
                      value={lessonDraft[p.rowIndex] ?? ''}
                      onChange={e => setLessonDraft(prev => ({ ...prev, [p.rowIndex]: e.target.value }))}
                      placeholder="예: 이탈조건 신호 후에도 미루다 -8%. 다음엔 신호 즉시 절반 정리."
                      rows={2}
                      style={{ width: '100%', boxSizing: 'border-box', background: '#1A1D26', border: '1px solid #2E3344', borderRadius: 6, color: '#E5E9F5', fontSize: 11, fontFamily: baseFont, padding: 8, resize: 'vertical' }}
                    />
                    <button onClick={() => saveLesson(p)} disabled={!(lessonDraft[p.rowIndex] ?? '').trim()}
                      style={{ marginTop: 6, padding: '6px 12px', minHeight: 32, borderRadius: 6, border: '1px solid #A8D67255', background: '#1B2913', color: '#A8D672', cursor: (lessonDraft[p.rowIndex] ?? '').trim() ? 'pointer' : 'not-allowed', opacity: (lessonDraft[p.rowIndex] ?? '').trim() ? 1 : 0.5, fontSize: 11, fontWeight: 700, fontFamily: baseFont }}>
                      교훈 저장
                    </button>
                  </div>
                )}
              </div>
            )}
            {p.confirm !== '확인' && p.thesis && p.status !== '청산' && (
              <button onClick={() => confirmThesis(p)} style={{ padding: '8px 14px', minHeight: 36, borderRadius: 6, border: '1px solid #4ADE8055', background: '#13301F', color: '#4ADE80', cursor: 'pointer', fontSize: 11, fontWeight: 700, fontFamily: baseFont }}>
                투자논리 확인 (동의)
              </button>
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <div style={{ textAlign: 'left' }}>
      <SectionTitle color="#52C8D4" mb={14} sub={`거래 생애주기 투자논리 관리${lastChecked ? ` · 최근 논리 점검 ${lastChecked}` : ''}`}>포지션</SectionTitle>
      {positionJournal.length === 0 ? (
        <div style={{ textAlign: 'center', color: '#8A9AB5', fontSize: 12, padding: '40px 0' }}>
          {sheets.auth === 'signed-in' ? '포지션이 비어있습니다' : '로그인하면 투자논리가 표시됩니다'}
        </div>
      ) : (
        <>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16, fontSize: 11 }}>
            <span style={{ color: '#8A9AB5' }}>보유 <b style={{ color: '#F5F7FF' }}>{held.length}</b></span>
            <span style={{ color: '#F4845F' }}>확신 {conviction.length}</span>
            <span style={{ color: '#52C8D4' }}>배분 {alloc.length}</span>
            {pending > 0 && <span style={{ color: '#F5C842' }}>확인대기 {pending}</span>}
            {alertByRow.size > 0 && <span style={{ color: '#EF4444', fontWeight: 700 }}>⚠ 투자논리 훼손 {alertByRow.size}</span>}
            {closed.filter(p => !p.lesson).length > 0 && <span style={{ color: '#F5C842', fontWeight: 700 }}>반성 필요 {closed.filter(p => !p.lesson).length}</span>}
          </div>
          {conviction.length > 0 && (<>
            <div style={{ fontSize: 10, letterSpacing: 2, color: '#F4845F', marginBottom: 8 }}>확신형 (논리 훼손을 감시)</div>
            {conviction.map(Card)}
          </>)}
          {alloc.length > 0 && (<>
            <div style={{ fontSize: 10, letterSpacing: 2, color: '#52C8D4', margin: '16px 0 8px' }}>배분형 (비중 드리프트를 감시)</div>
            {alloc.map(Card)}
          </>)}
          {closed.length > 0 && (<>
            <div style={{ fontSize: 10, letterSpacing: 2, color: '#8A9AB5', margin: '16px 0 8px' }}>청산 ({closed.length}) · 반성</div>
            {closed.map(Card)}
          </>)}
        </>
      )}
    </div>
  );
}
