// 포지션 탭: 거래 생애주기(거래직전→감시→반성) 투자논리 관리. App.jsx에서 추출 (동작 불변).
// 편집 상태(journalOpen/lessonDraft/exitDraft/exitEditing/thesisDraft/thesisEditing)는
// 이 탭 전용이라 함께 내려옴. 시트 쓰기 핸들러는 sheets prop만 사용 — 탭 로컬.
import { useState } from 'react';
import { SectionTitle, DeptBadge } from '../lib/primitives.jsx';
import { findThesisAlerts, thesisAlertLabel, isThesisBreach } from '../lib/thesisAlerts.js';
import { useLongPress } from '../hooks/useLongPress.js';
import { signalColor } from '../lib/colors.js';
import { stripGrade } from '../lib/textFormat.js';

// 매수평가 카드(결론+근거)에서 전제 초안을 구성 — 새로 지어내지 않고 이미 기록된 내용만
// 재사용(환각 차단 원칙). 종목당 최신 매수(비매도) 카드 사용, evaluations는 이미 최신순.
// 매칭 카드가 없으면 빈 문자열 반환(그럴 땐 직접 작성).
function draftThesisFrom(evaluations, name) {
  const card = (evaluations || []).find(e => e.stock?.name === name && e.status !== '매도');
  if (!card) return '';
  const concl = stripGrade(card.conclusion?.raw);
  const reasons = (card.reasons || []).join(' · ');
  // 평가 시점을 명시(CLAUDE.md 기간 표기 규칙) — "매수관망" 같은 과거 결론이 최신 판단인
  // 것처럼 읽히지 않도록. 날짜가 오래됐으면 검토 시 사용자가 그대로 감안할 수 있음.
  const body = [concl, reasons].filter(Boolean).join(' — ');
  return body ? `(${card.date} 평가카드 기준) ${body}` : '';
}

export default function PositionJournalTab({ positionJournal, riskMonitor, evaluations, sheets, baseFont }) {
  const lp = useLongPress();
  const [journalOpen, setJournalOpen] = useState(new Set());
  const [lessonDraft, setLessonDraft] = useState({}); // rowIndex → 교훈 입력값 (반성 카드)
  const [exitDraft, setExitDraft] = useState({}); // rowIndex → 이탈조건 편집값
  const [exitEditing, setExitEditing] = useState(new Set()); // 이탈조건 편집 중인 rowIndex
  const [thesisDraft, setThesisDraft] = useState({}); // rowIndex → 전제 편집값(초안 프리필)
  const [thesisEditing, setThesisEditing] = useState(new Set()); // 전제 편집 중인 rowIndex

  const held = positionJournal.filter(p => p.status !== '청산');
  const closed = positionJournal.filter(p => p.status === '청산');
  const alertByRow = new Map(findThesisAlerts(positionJournal, riskMonitor).map(a => [a.position.rowIndex, a.signal]));
  // 🔴=훼손(확정)·🟡=주의(약화)로 분리 집계 — 요약 칩에서 두 상태를 다른 말로(주문 가드와 동일 어휘).
  const breachCount = [...alertByRow.values()].filter(s => isThesisBreach(s.signal)).length;
  const cautionCount = alertByRow.size - breachCount;
  const byAlert = (a, b) => (alertByRow.has(b.rowIndex) ? 1 : 0) - (alertByRow.has(a.rowIndex) ? 1 : 0);
  const conviction = held.filter(p => p.kind === '확신').sort(byAlert);
  const alloc = held.filter(p => p.kind !== '확신').sort(byAlert);
  // "확인대기"(전제는 있고 동의만 하면 됨)와 "전제 미작성"(전제 자체가 없어 확인할 게 없음)은
  // 필요한 행동이 다르다 — 하나로 묶으면 "확인대기 1"인데 눌러도 확인 버튼이 없어 헷갈린다.
  const pendingConfirm = held.filter(p => p.confirm === '대기').length;
  const unwritten = held.filter(p => p.confirm === '미작성').length;
  // 논리 점검(risk-b)은 보유종목을 한 배치로 점검하므로, B신호 최신 날짜 = 일괄 점검일.
  const lastChecked = (riskMonitor || []).filter(r => r.type === 'B').reduce((mx, r) => (r.date > mx ? r.date : mx), '');

  const kindBadge = (kind) => (
    <span style={{ fontSize: 9, fontWeight: 700, padding: '2px 6px', borderRadius: 0,
      background: kind === '확신' ? '#F4845F22' : '#52C8D422',
      color: kind === '확신' ? '#F4845F' : '#52C8D4' }}>
      {kind === '확신' ? '확신' : '배분'}
    </span>
  );
  const confirmBadge = (c) => {
    const map = { '확인': ['#159E5222', '#159E52', '✓ 확인'], '대기': ['#E0A00022', '#E0A000', '확인 대기'], '미작성': ['#6B675C22', '#6B675C', '전제 미작성'] };
    const [bg, fg, label] = map[c] || map['미작성'];
    return <span style={{ fontSize: 9, fontWeight: 700, padding: '2px 6px', borderRadius: 0, background: bg, color: fg }}>{label}</span>;
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

  // 전제 저장 → F열(전제) + P열(갱신시각). 처음 쓰는 경우(미작성→)만 O열을 '대기'로 전환해
  // 기존 확인여부 표시와 맞춘다 — 이미 확인된 전제를 고쳤을 땐 확인 상태를 건드리지 않는다.
  const saveThesis = async (p) => {
    const text = (thesisDraft[p.rowIndex] ?? '').trim();
    if (!text) return;
    const nowStr = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Seoul' }).slice(0, 16);
    try {
      await sheets.writeRange(`포지션저널!F${p.rowIndex + 2}`, [text]);
      if (p.confirm === '미작성') {
        await sheets.writeRange(`포지션저널!O${p.rowIndex + 2}:P${p.rowIndex + 2}`, ['대기', nowStr]);
      } else {
        await sheets.writeRange(`포지션저널!P${p.rowIndex + 2}`, [nowStr]);
      }
      setThesisEditing(prev => { const n = new Set(prev); n.delete(p.rowIndex); return n; });
      setThesisDraft(prev => { const n = { ...prev }; delete n[p.rowIndex]; return n; });
      await sheets.fetch();
    } catch (e) { console.error('전제 저장 오류:', e); }
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
    const sigColor = sig ? signalColor(sig.signal) : '#141414';
    return (
      <div key={p.rowIndex} style={{ background: '#FFFFFF', border: `1px solid ${sig ? sigColor + '66' : '#141414'}`, borderRadius: 0, marginBottom: 8, overflow: 'hidden' }}>
        <button onClick={() => setJournalOpen(prev => { const n = new Set(prev); n.has(p.rowIndex) ? n.delete(p.rowIndex) : n.add(p.rowIndex); return n; })}
          style={{ width: '100%', textAlign: 'left', background: 'none', border: 'none', cursor: 'pointer', padding: '12px 14px', fontFamily: baseFont }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 13, fontWeight: 700, color: '#141414' }}>{p.name}</span>
            {kindBadge(p.kind)}
            {confirmBadge(p.confirm)}
            {sig && <span style={{ fontSize: 9, fontWeight: 700, padding: '2px 6px', borderRadius: 0, background: sigColor + '22', color: sigColor }}>⚠ {thesisAlertLabel(sig.signal)}</span>}
            <span style={{ marginLeft: 'auto', fontSize: 10, color: '#6B675C' }}>{p.account}</span>
          </div>
          {!open && sig && (
            <div style={{ fontSize: 11, color: sigColor, marginTop: 6, lineHeight: 1.4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{sig.signal} {sig.summary}</div>
          )}
          {!open && !sig && p.thesis && (
            <div style={{ fontSize: 11, color: '#6B675C', marginTop: 6, lineHeight: 1.4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.thesis}</div>
          )}
        </button>
        {open && (
          <div style={{ padding: '0 14px 14px' }}>
            {sig && (
              <div style={{ background: sigColor + '14', border: `1px solid ${sigColor}44`, borderRadius: 0, padding: 10, marginBottom: 10 }}>
                <div style={{ fontSize: 10, fontWeight: 700, color: sigColor, marginBottom: 3 }}>⚠ {thesisAlertLabel(sig.signal)} — 이탈조건 대조 필요 · {sig.type}신호 {sig.date}</div>
                <div style={{ fontSize: 12, color: '#141414', lineHeight: 1.5 }}>{sig.signal} {sig.summary}</div>
                {sig.detail && <div style={{ fontSize: 11, color: '#6B675C', lineHeight: 1.5, marginTop: 4 }}>{sig.detail}</div>}
              </div>
            )}
            {p.status !== '청산' ? (
              thesisEditing.has(p.rowIndex) ? (
                <div style={{ marginBottom: 10 }}>
                  <div style={{ fontSize: 9, letterSpacing: 1, color: '#141414', marginBottom: 4 }}>투자논리 편집</div>
                  <textarea
                    value={thesisDraft[p.rowIndex] ?? p.thesis ?? ''}
                    onChange={e => setThesisDraft(prev => ({ ...prev, [p.rowIndex]: e.target.value }))}
                    rows={3}
                    style={{ width: '100%', boxSizing: 'border-box', background: '#FFFFFF', border: '1px solid #14141455', borderRadius: 0, color: '#141414', fontSize: 12, fontFamily: baseFont, padding: 8, resize: 'vertical' }}
                  />
                  {!p.thesis && (
                    <div style={{ fontSize: 9, color: '#6B675C', marginTop: 4, lineHeight: 1.5 }}>
                      {draftThesisFrom(evaluations, p.name)
                        ? '매수평가 카드의 결론·근거로 초안을 채워뒀습니다 — 검토 후 필요하면 고쳐서 저장하세요.'
                        : '매칭되는 매수평가 카드가 없어 초안을 못 채웠습니다 — 직접 작성해 주세요.'}
                    </div>
                  )}
                  <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                    <button onClick={() => saveThesis(p)} disabled={!(thesisDraft[p.rowIndex] ?? p.thesis ?? '').trim()}
                      style={{ padding: '6px 12px', minHeight: 32, borderRadius: 0, border: '1px solid #141414', background: '#DDF3E4', color: '#159E52', cursor: 'pointer', fontSize: 11, fontWeight: 700, fontFamily: baseFont }}>
                      저장
                    </button>
                    <button onClick={() => { setThesisEditing(prev => { const n = new Set(prev); n.delete(p.rowIndex); return n; }); setThesisDraft(prev => { const n = { ...prev }; delete n[p.rowIndex]; return n; }); }}
                      style={{ padding: '6px 12px', minHeight: 32, borderRadius: 0, border: '1px solid #141414', background: 'none', color: '#6B675C', cursor: 'pointer', fontSize: 11, fontFamily: baseFont }}>
                      취소
                    </button>
                  </div>
                </div>
              ) : (
                <div
                  {...lp.bind(`${p.rowIndex}-thesis`, () => {
                    setThesisDraft(prev => ({ ...prev, [p.rowIndex]: p.thesis || draftThesisFrom(evaluations, p.name) }));
                    setThesisEditing(prev => { const n = new Set(prev); n.add(p.rowIndex); return n; });
                  })}
                  style={{ position: 'relative', cursor: 'pointer', borderRadius: 0, padding: '6px 8px', margin: '0 -8px 10px', userSelect: 'none', background: lp.activeId === `${p.rowIndex}-thesis` ? '#14141408' : 'transparent' }}>
                  {lp.activeId === `${p.rowIndex}-thesis` && <div className="lp-progress" />}
                  <div style={{ fontSize: 9, letterSpacing: 1, color: '#141414', marginBottom: 3 }}>투자논리</div>
                  {p.thesis ? (
                    <div style={{ fontSize: 12, color: '#141414', lineHeight: 1.5 }}>{p.thesis}</div>
                  ) : (
                    <div style={{ fontSize: 11, color: '#6B675C' }}>
                      투자논리 없음 — 길게 눌러 작성{draftThesisFrom(evaluations, p.name) ? ' (초안 준비됨)' : ''}
                    </div>
                  )}
                </div>
              )
            ) : (
              p.thesis && (<><div style={{ fontSize: 9, letterSpacing: 1, color: '#141414', marginBottom: 3 }}>투자논리</div>
                <div style={{ fontSize: 12, color: '#141414', lineHeight: 1.5, marginBottom: 10 }}>{p.thesis}</div></>)
            )}
            <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 10 }}>
              {p.target && <div><div style={{ fontSize: 9, color: '#6B675C' }}>목표</div><div style={{ fontSize: 11, color: '#141414' }}>{p.target}</div></div>}
              {p.hold && <div><div style={{ fontSize: 9, color: '#6B675C' }}>예상보유</div><div style={{ fontSize: 11, color: '#141414' }}>{p.hold}</div></div>}
              {p.entry && <div><div style={{ fontSize: 9, color: '#6B675C' }}>진입일</div><div style={{ fontSize: 11, color: '#141414' }}>{p.entry}</div></div>}
            </div>
            {p.status !== '청산' ? (
              exitEditing.has(p.rowIndex) ? (
                <div style={{ marginBottom: 10 }}>
                  <div style={{ fontSize: 9, letterSpacing: 1, color: '#F4845F', marginBottom: 4 }}>이탈조건 편집</div>
                  <textarea
                    value={exitDraft[p.rowIndex] ?? p.exit ?? ''}
                    onChange={e => setExitDraft(prev => ({ ...prev, [p.rowIndex]: e.target.value }))}
                    rows={2}
                    style={{ width: '100%', boxSizing: 'border-box', background: '#FFFFFF', border: '1px solid #F4845F55', borderRadius: 0, color: '#6B675C', fontSize: 11, fontFamily: baseFont, padding: 8, resize: 'vertical' }}
                  />
                  <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                    <button onClick={() => saveExit(p)}
                      style={{ padding: '6px 12px', minHeight: 32, borderRadius: 0, border: '1px solid #141414', background: '#FBE3E4', color: '#141414', cursor: 'pointer', fontSize: 11, fontWeight: 700, fontFamily: baseFont }}>
                      저장
                    </button>
                    <button onClick={() => setExitEditing(prev => { const n = new Set(prev); n.delete(p.rowIndex); return n; })}
                      style={{ padding: '6px 12px', minHeight: 32, borderRadius: 0, border: '1px solid #141414', background: 'none', color: '#6B675C', cursor: 'pointer', fontSize: 11, fontFamily: baseFont }}>
                      취소
                    </button>
                  </div>
                </div>
              ) : (
                <div
                  {...lp.bind(p.rowIndex, () => setExitEditing(prev => { const n = new Set(prev); n.add(p.rowIndex); return n; }))}
                  style={{ position: 'relative', cursor: 'pointer', borderRadius: 0, padding: '6px 8px', margin: '0 -8px 10px', userSelect: 'none', background: lp.activeId === p.rowIndex ? '#F4845F14' : 'transparent' }}>
                  {lp.activeId === p.rowIndex && <div className="lp-progress" />}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
                    <div style={{ fontSize: 9, letterSpacing: 1, color: '#F4845F' }}>이탈조건 (이게 깨지면 매도 검토)</div>
                  </div>
                  {p.exit ? (
                    <div style={{ fontSize: 12, color: '#6B675C', lineHeight: 1.5 }}>{p.exit}</div>
                  ) : (
                    <div style={{ fontSize: 11, color: '#6B675C' }}>이탈조건 없음 — 길게 눌러 추가</div>
                  )}
                </div>
              )
            ) : (
              p.exit && (<><div style={{ fontSize: 9, letterSpacing: 1, color: '#F4845F', marginBottom: 3 }}>이탈조건</div>
                <div style={{ fontSize: 12, color: '#6B675C', lineHeight: 1.5, marginBottom: 10 }}>{p.exit}</div></>)
            )}
            {p.status === '청산' && (
              <div style={{ background: '#FFFFFF', borderRadius: 0, padding: 12, marginBottom: 10 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
                  <span style={{ fontSize: 9, letterSpacing: 1, color: '#159E52', fontWeight: 700 }}>반성 — 투자논리는 맞았나?</span>
                  {p.exitDate && <span style={{ fontSize: 9, color: '#6B675C' }}>청산 {p.exitDate}</span>}
                  {!p.lesson && <span style={{ marginLeft: 'auto', fontSize: 9, fontWeight: 700, padding: '2px 6px', borderRadius: 0, background: '#FBF1D0', color: '#E0A000' }}>반성 필요</span>}
                </div>
                {p.result && <div style={{ fontSize: 11, color: '#141414', marginBottom: 6 }}>청산결과: {p.result}</div>}
                {p.lesson ? (
                  <div style={{ fontSize: 11, color: '#141414', lineHeight: 1.5 }}>교훈: {p.lesson}</div>
                ) : (
                  <div>
                    <div style={{ fontSize: 10, color: '#6B675C', lineHeight: 1.5, marginBottom: 6 }}>
                      이 매도에서 배운 한 가지를 남기세요. {p.exit ? '이탈조건대로 팔았는지, 너무 일찍/늦게 팔았는지.' : '왜 팔았고, 다음엔 무엇을 다르게 할지.'}
                    </div>
                    <textarea
                      value={lessonDraft[p.rowIndex] ?? ''}
                      onChange={e => setLessonDraft(prev => ({ ...prev, [p.rowIndex]: e.target.value }))}
                      placeholder="예: 이탈조건 신호 후에도 미루다 -8%. 다음엔 신호 즉시 절반 정리."
                      rows={2}
                      style={{ width: '100%', boxSizing: 'border-box', background: '#FFFFFF', border: '1px solid #141414', borderRadius: 0, color: '#141414', fontSize: 11, fontFamily: baseFont, padding: 8, resize: 'vertical' }}
                    />
                    <button onClick={() => saveLesson(p)} disabled={!(lessonDraft[p.rowIndex] ?? '').trim()}
                      style={{ marginTop: 6, padding: '6px 12px', minHeight: 32, borderRadius: 0, border: '1px solid #141414', background: '#DDF3E4', color: '#159E52', cursor: (lessonDraft[p.rowIndex] ?? '').trim() ? 'pointer' : 'not-allowed', opacity: (lessonDraft[p.rowIndex] ?? '').trim() ? 1 : 0.5, fontSize: 11, fontWeight: 700, fontFamily: baseFont }}>
                      교훈 저장
                    </button>
                  </div>
                )}
              </div>
            )}
            {p.confirm !== '확인' && p.thesis && p.status !== '청산' && (
              <button onClick={() => confirmThesis(p)} style={{ padding: '8px 14px', minHeight: 36, borderRadius: 0, border: '1px solid #159E5255', background: '#DDF3E4', color: '#159E52', cursor: 'pointer', fontSize: 11, fontWeight: 700, fontFamily: baseFont }}>
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
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
        <SectionTitle mb={14} sub={`거래 생애주기 투자논리 관리${lastChecked ? ` · 최근 논리 점검 ${lastChecked}` : ''}`}>포지션</SectionTitle>
        <DeptBadge dept="themis" />
      </div>
      {positionJournal.length === 0 ? (
        <div style={{ textAlign: 'center', color: '#6B675C', fontSize: 12, padding: '40px 0' }}>
          {sheets.auth === 'signed-in' ? '포지션이 비어있습니다' : '로그인하면 투자논리가 표시됩니다'}
        </div>
      ) : (
        <>
          {/* 1행: 보유 구성(전량 분할) — 보유 = 확신 + 배분. 2행: 처리 필요(교차 플래그) —
              같은 포지션이 확신/배분 어느 쪽이든 동시에 여러 개 걸릴 수 있어 1행 합계에 안 더해짐. */}
          <div style={{ display: 'flex', gap: 6, alignItems: 'baseline', marginBottom: 8, fontSize: 11 }}>
            <span style={{ color: '#6B675C' }}>보유 <b style={{ color: '#141414', fontSize: 14 }}>{held.length}</b></span>
            <span style={{ color: '#6B675C' }}>=</span>
            <span style={{ color: '#F4845F' }}>확신 {conviction.length}</span>
            <span style={{ color: '#6B675C' }}>+</span>
            <span style={{ color: '#52C8D4' }}>배분 {alloc.length}</span>
          </div>
          {(pendingConfirm > 0 || unwritten > 0 || alertByRow.size > 0 || closed.filter(p => !p.lesson).length > 0) && (
            <>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', fontSize: 10 }}>
                <span style={{ color: '#6B675C', letterSpacing: 1 }}>처리 필요</span>
                {pendingConfirm > 0 && <span style={{ color: '#E0A000', background: '#E0A00022', padding: '2px 6px' }}>확인대기 {pendingConfirm}</span>}
                {unwritten > 0 && <span style={{ color: '#6B675C', background: '#6B675C22', padding: '2px 6px' }}>전제 미작성 {unwritten}</span>}
                {breachCount > 0 && <span style={{ color: '#E5484D', background: '#E5484D22', padding: '2px 6px', fontWeight: 700 }}>⚠ 투자논리 훼손 {breachCount}</span>}
                {cautionCount > 0 && <span style={{ color: '#E0A000', background: '#E0A00022', padding: '2px 6px', fontWeight: 700 }}>⚠ 논리 주의 {cautionCount}</span>}
                {closed.filter(p => !p.lesson).length > 0 && <span style={{ color: '#E0A000', background: '#E0A00022', padding: '2px 6px', fontWeight: 700 }}>반성 필요 {closed.filter(p => !p.lesson).length}</span>}
              </div>
              <div style={{ fontSize: 9, color: '#6B675C', lineHeight: 1.5, marginTop: 4, marginBottom: 16 }}>
                확인대기=AI 초안 매수전제에 동의 표시만 하면 됨 · 전제 미작성=매수전제 자체가
                비어있어 직접 작성 필요(카드의 "투자논리"를 길게 눌러 작성) · 훼손(🔴)=매수 논리가
                펀더멘털상 깨짐, 이탈조건 대조 필요 · 주의(🟡)=논리 약화 진행(훼손 확정 아님)
              </div>
            </>
          )}
          {conviction.length > 0 && (<>
            <div style={{ fontSize: 10, letterSpacing: 2, color: '#F4845F', marginBottom: 8 }}>확신형 (논리 주의·훼손을 감시)</div>
            {conviction.map(Card)}
          </>)}
          {alloc.length > 0 && (<>
            <div style={{ fontSize: 10, letterSpacing: 2, color: '#52C8D4', margin: '16px 0 8px' }}>배분형 (비중 드리프트를 감시)</div>
            {alloc.map(Card)}
          </>)}
          {closed.length > 0 && (<>
            <div style={{ fontSize: 10, letterSpacing: 2, color: '#6B675C', margin: '16px 0 8px' }}>청산 ({closed.length}) · 반성</div>
            {closed.map(Card)}
          </>)}
        </>
      )}
    </div>
  );
}
