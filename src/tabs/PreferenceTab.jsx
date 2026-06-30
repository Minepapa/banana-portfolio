// 성향확인 탭: 행동 학습 관찰을 표시·확정/기각. App.jsx에서 분리.
// 앱은 시트만 읽으므로 학습 데이터는 '성향관찰' 시트(parsePreferences)에서 온다.
// 확정/기각은 PositionJournalTab.confirmThesis 패턴 — sheets.writeRange(G·H열) → fetch.
import { SectionTitle } from '../lib/primitives.jsx';

export default function PreferenceTab({ preferences, sheets, baseFont }) {
  const list = preferences || [];
  const confirmed = list.filter(p => p.status === '확정');
  const pending = list.filter(p => p.status === '관찰' || p.status === '승격후보');
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
    const [bg, fg] = conflict ? ['#F59E0B22', '#F59E0B'] : match ? ['#4ADE8022', '#159E52'] : ['#14141422', '#141414'];
    return <span style={{ fontSize: 9, fontWeight: 700, padding: '2px 6px', borderRadius: 0, background: bg, color: fg }}>{v || '신규'}{conflict ? ' ⚑' : ''}</span>;
  };
  const confBadge = (c) => {
    const map = { '높음': ['#4ADE8022', '#159E52'], '보통': ['#F5C84222', '#F5C842'], '낮음': ['#6B675C22', '#6B675C'] };
    const [bg, fg] = map[c] || map['보통'];
    return <span style={{ fontSize: 9, fontWeight: 700, padding: '2px 6px', borderRadius: 0, background: bg, color: fg }}>신뢰도 {c || '보통'}</span>;
  };

  const Card = (p, opts = {}) => (
    <div key={p.rowIndex} style={{ background: '#FFFFFF', border: `1px solid ${opts.border || '#141414'}`, borderRadius: 0, marginBottom: 8, padding: '12px 14px', opacity: opts.dim ? 0.55 : 1 }}>
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
            style={{ padding: '6px 14px', minHeight: 34, borderRadius: 0, border: '1px solid #4ADE8055', background: '#DDF3E4', color: '#159E52', cursor: 'pointer', fontSize: 11, fontWeight: 700, fontFamily: baseFont }}>
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
    </div>
  );

  return (
    <div>
      <SectionTitle color="#52C8D4" mb={14} sub="실제 행동에서 학습한 내 투자 성향 — 맞으면 확정, 아니면 기각">성향</SectionTitle>
      {list.length === 0 ? (
        <div style={{ textAlign: 'center', color: '#6B675C', fontSize: 12, padding: '40px 0' }}>
          {sheets.auth === 'signed-in' ? '아직 학습된 성향이 없습니다 — 주간 리포트가 관찰을 쌓습니다' : '로그인하면 학습된 성향이 표시됩니다'}
        </div>
      ) : (
        <>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16, fontSize: 11 }}>
            <span style={{ color: '#159E52' }}>확정 <b>{confirmed.length}</b></span>
            {pending.length > 0 && <span style={{ color: '#F5C842', fontWeight: 700 }}>확인 필요 {pending.length}</span>}
            {rejected.length > 0 && <span style={{ color: '#6B675C' }}>기각 {rejected.length}</span>}
          </div>

          {pending.length > 0 && (<>
            <div style={{ fontSize: 10, letterSpacing: 2, color: '#F5C842', marginBottom: 8 }}>확인 필요 — 이게 내 성향이 맞나요?</div>
            {pending.map(p => Card(p, { actions: true, border: '#F5C84244' }))}
          </>)}

          {confirmed.length > 0 && (<>
            <div style={{ fontSize: 10, letterSpacing: 2, color: '#159E52', margin: '16px 0 8px' }}>확정된 내 성향 (분석의 기준)</div>
            {confirmed.map(p => Card(p, { border: '#4ADE8033' }))}
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
