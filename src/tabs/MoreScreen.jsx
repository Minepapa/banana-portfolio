import { CARD_BG, INK, INK_2, ACCENT, EMPHASIS_INK, BORDER, RADIUS, RADIUS_SM, PAPER_2 } from '../lib/theme.js';

export default function MoreScreen({ hideAmounts, syncLabel, auth, themePref, setThemePref }) {
  const themeOptions = [ ['system', '시스템'], ['light', '라이트'], ['dark', '다크'] ];
  const segmentStyle = (active) => ({
    padding: '4px 8px', border: BORDER, borderRadius: RADIUS_SM,
    background: active ? ACCENT : CARD_BG, color: active ? EMPHASIS_INK : INK_2,
    fontSize: 10, fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap',
  });
  const rowStyle = (last = false) => ({
    display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8,
    padding: '12px 16px', borderBottom: last ? 'none' : `1px solid ${PAPER_2}`,
  });
  const labelStyle = { fontSize: 11, color: INK, fontWeight: 700 };
  const valueStyle = { fontSize: 11, color: INK_2 };

  return (
    <div style={{ background: CARD_BG, border: BORDER, borderRadius: RADIUS, overflow: 'hidden' }}>
      <div style={{ ...rowStyle(), opacity: 0.55 }}><span style={labelStyle}>퀀트 트랙</span><span style={valueStyle}>준비 중</span></div>
      <div style={rowStyle()}><span style={labelStyle}>금액 표시</span><span style={valueStyle}>{hideAmounts ? '숨기기 켜짐' : '숨기기 꺼짐'}</span></div>
      <div style={rowStyle()}><span style={labelStyle}>화면 테마</span><div role="group" aria-label="화면 테마 선택" style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>{themeOptions.map(([value, label]) => <button key={value} type="button" aria-pressed={themePref === value} onClick={() => setThemePref(value)} style={segmentStyle(themePref === value)}>{label}</button>)}</div></div>
      <div style={rowStyle()}><span style={labelStyle}>데이터 갱신</span><span style={valueStyle}>{syncLabel || '갱신 이력 없음'}</span></div>
      <div style={rowStyle(true)}><span style={labelStyle}>계정</span><span style={valueStyle}>{auth === 'signed-in' ? 'Google 연결됨' : '로그인 필요'}</span></div>
    </div>
  );
}
