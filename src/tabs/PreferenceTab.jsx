// 성향확인 탭: 행동 학습 관찰을 표시·확정/기각. App.jsx에서 분리.
// 앱은 시트만 읽으므로 학습 데이터는 '성향관찰' 시트(parsePreferences)에서 온다.
// 확정/기각은 PositionJournalTab.confirmThesis 패턴 — sheets.writeRange(G·H열) → fetch.
// 확정된 성향을 되돌리는 건 자주 안 쓰는 동작이라 버튼 대신 롱프레스(HoldingsTab과 동일 패턴).
import { useState } from 'react';
import { SectionTitle } from '../lib/primitives.jsx';
import { useLongPress } from '../hooks/useLongPress.js';
import { pendingPreferences } from '../lib/preferencesPending.js';

export default function PreferenceTab({ preferences, sheets, baseFont }) {
  const lp = useLongPress();
  const [rejectConfirm, setRejectConfirm] = useState(null); // 롱프레스로 기각 확인 중인 rowIndex
  const list = preferences || [];
  const confirmed = list.filter(p => p.status === '확정');
  const pending = pendingPreferences(list);
  const rejected = list.filter(p => p.status === '기각');

  // 상태 쓰기 → G열(상태) + H열(갱신시각). rowIndex 기준(시트 행 = rowIndex + 2).
  const setStatus = async (p, status) => {
    const nowStr = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Seoul' }).slice(0, 16);
    try {
      await sheets.writeRange(`성향관찰!G${p.rowIndex + 2}:H${p.rowIndex + 2}`, [status, nowStr]);
      await sheets.fetch();
    } catch (e) { console.error('성향 상태 변경 오류:', e); }
  };

  // §3 대비 라벨 색상 — 상충은 주의(주황), 일치는 초록, 신규는 파랑.
  const vsBadge = (v) => {
    const conflict = /상충/.test(v || '');
    const match = /일치|보강/.test(v || '');
    const [bg, fg] = conflict ? ['#E0A00022', '#E0A000'] : match ? ['#159E5222', '#159E52'] : ['#14141422', '#141414'];
    return <span style={{ fontSize: 9, fontWeight: 700, padding: '2px 6px', borderRadius: 0, background: bg, color: fg }}>{v || '신규'}{conflict ? ' ⚑' : ''}</span>;
  };
  const confBadge = (c) => {
    const map = { '높음': ['#159E5222', '#159E52'], '보통': ['#E0A00022', '#E0A000'], '낮음': ['#6B675C22', '#6B675C'] };
    const [bg, fg] = map[c] || map['보통'];
    return <span style={{ fontSize: 9, fontWeight: 700, padding: '2px 6px', borderRadius: 0, background: bg, color: fg }}>신뢰도 {c || '보통'}</span>;
  };

  const Card = (p, opts = {}) => {
    const canLP = opts.longPressReject && sheets.auth === 'signed-in';
    const lpActive = canLP && lp.activeId === p.rowIndex;
    const lpHandlers = canLP ? lp.bind(p.rowIndex, () => setRejectConfirm(p.rowIndex)) : {};
    const confirming = rejectConfirm === p.rowIndex;
    return (
      <div key={p.rowIndex} style={{
        position: 'relative', background: lpActive ? '#EAE6DA' : '#FFFFFF',
        border: `1px solid ${opts.border || '#141414'}`, borderRadius: 0, marginBottom: 8, padding: '12px 14px',
        opacity: opts.dim ? 0.55 : 1, transition: 'background 0.1s',
        userSelect: canLP ? 'none' : undefined, WebkitUserSelect: canLP ? 'none' : undefined,
      }} {...lpHandlers}>
        {lpActive && <div className="lp-progress" />}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginBottom: 6 }}>
          {p.type && <span style={{ fontSize: 9, fontWeight: 700, padding: '2px 6px', borderRadius: 0, background: '#52C8D422', color: '#52C8D4' }}>{p.type}</span>}
          {vsBadge(p.vsProfile)}
          {confBadge(p.confidence)}
          {p.date && <span style={{ marginLeft: 'auto', fontSize: 10, color: '#6B675C' }}>{p.date}</span>}
        </div>
        <div style={{ fontSize: 13, color: '#141414', lineHeight: 1.5, marginBottom: p.evidence ? 6 : 0 }}>{p.observation}</div>
        {p.evidence && (
          <div style={{ fontSize: 11, color: '#6B675C', lineHeight: 1.5, background: '#FFFFFF', borderRadius: 0, padding: '6px 8px' }}>
            <span style={{ color: '#6B675C' }}>근거 </span>{p.evidence}
          </div>
        )}
        {opts.actions && (
          <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
            <button onClick={() => setStatus(p, '확정')}
              style={{ padding: '6px 14px', minHeight: 34, borderRadius: 0, border: '1px solid #159E5255', background: '#DDF3E4', color: '#159E52', cursor: 'pointer', fontSize: 11, fontWeight: 700, fontFamily: baseFont }}>
              ✓ 확정 (내 성향 맞음)
            </button>
            <button onClick={() => setStatus(p, '기각')}
              style={{ padding: '6px 14px', minHeight: 34, borderRadius: 0, border: '1px solid #141414', background: 'none', color: '#6B675C', cursor: 'pointer', fontSize: 11, fontFamily: baseFont }}>
              기각
            </button>
          </div>
        )}
        {opts.restore && (
          <button onClick={() => setStatus(p, '관찰')}
            style={{ marginTop: 8, fontSize: 9, color: '#6B675C', background: 'none', border: 'none', cursor: 'pointer', fontFamily: baseFont, padding: 0 }}>되돌리기</button>
        )}
        {canLP && confirming && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10, paddingTop: 10, borderTop: '1px solid #14141422' }}>
            <span style={{ fontSize: 10, color: '#6B675C' }}>이 성향을 기각할까요? (잘못 확정했을 때)</span>
            <button onClick={() => { setStatus(p, '기각'); setRejectConfirm(null); }}
              style={{ padding: '5px 12px', minHeight: 30, borderRadius: 0, border: '1px solid #E5484D55', background: '#FBE3E4', color: '#E5484D', cursor: 'pointer', fontSize: 11, fontWeight: 700, fontFamily: baseFont }}>
              기각 확정
            </button>
            <button onClick={() => setRejectConfirm(null)}
              style={{ padding: '5px 12px', minHeight: 30, borderRadius: 0, border: '1px solid #141414', background: 'none', color: '#6B675C', cursor: 'pointer', fontSize: 11, fontFamily: baseFont }}>
              취소
            </button>
          </div>
        )}
      </div>
    );
  };

  return (
    <div>
      <SectionTitle mb={14} sub="실제 행동에서 학습한 내 투자 성향 — 맞으면 확정, 아니면 기각">성향</SectionTitle>
      {list.length === 0 ? (
        <div style={{ textAlign: 'center', color: '#6B675C', fontSize: 12, padding: '40px 0' }}>
          {sheets.auth === 'signed-in' ? '아직 학습된 성향이 없습니다 — 주간 리포트가 관찰을 쌓습니다' : '로그인하면 학습된 성향이 표시됩니다'}
        </div>
      ) : (
        <>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16, fontSize: 11 }}>
            <span style={{ color: '#159E52' }}>확정 <b>{confirmed.length}</b></span>
            {pending.length > 0 && <span style={{ color: '#E0A000', fontWeight: 700 }}>확인 필요 {pending.length}</span>}
            {rejected.length > 0 && <span style={{ color: '#6B675C' }}>기각 {rejected.length}</span>}
          </div>

          {pending.length > 0 && (<>
            <div style={{ fontSize: 10, letterSpacing: 2, color: '#E0A000', marginBottom: 8 }}>확인 필요 — 이게 내 성향이 맞나요?</div>
            {pending.map(p => Card(p, { actions: true, border: '#E0A00044' }))}
          </>)}

          {confirmed.length > 0 && (<>
            <div style={{ fontSize: 10, letterSpacing: 2, color: '#159E52', margin: '16px 0 8px' }}>
              확정된 내 성향 (분석의 기준) — 잘못 확정했으면 길게 눌러 기각
            </div>
            {confirmed.map(p => Card(p, { border: '#159E5233', longPressReject: true }))}
          </>)}

          {rejected.length > 0 && (<>
            <div style={{ fontSize: 10, letterSpacing: 2, color: '#6B675C', margin: '16px 0 8px' }}>기각 ({rejected.length})</div>
            {rejected.map(p => Card(p, { dim: true, restore: true }))}
          </>)}
        </>
      )}
    </div>
  );
}
