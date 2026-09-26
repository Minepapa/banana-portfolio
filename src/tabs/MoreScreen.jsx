import { CARD_BG, INK, INK_2, ACCENT, EMPHASIS_INK, BORDER, RADIUS, RADIUS_SM } from '../lib/theme.js';

function InfoCard({ title, children, muted = false }) {
  return (
    <section style={{
      background: CARD_BG, border: BORDER, borderRadius: RADIUS, padding: 16,
      marginBottom: 12, opacity: muted ? 0.55 : 1,
    }}>
      <div style={{ fontSize: 12, fontWeight: 800, color: INK, marginBottom: 6 }}>{title}</div>
      {children}
    </section>
  );
}

export default function MoreScreen({ hideAmounts, syncLabel, auth, themePref, setThemePref }) {
  const themeOptions = [
    ['system', '시스템'],
    ['light', '라이트'],
    ['dark', '다크'],
  ];
  const segmentStyle = (active) => ({
    flex: 1, padding: '10px 8px', border: BORDER, borderRadius: RADIUS_SM,
    background: active ? ACCENT : CARD_BG, color: active ? EMPHASIS_INK : INK_2,
    fontWeight: 700, cursor: 'pointer',
  });

  return (
    <div>
      <InfoCard title="퀀트 트랙" muted>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 11, color: INK_2 }}>포지션·손절·수익 현황</span>
          <span style={{ fontSize: 10, fontWeight: 700, color: INK_2 }}>준비 중</span>
        </div>
      </InfoCard>
      <InfoCard title="금액 표시 설정">
        <div style={{ fontSize: 11, color: INK_2 }}>{hideAmounts ? '숨기기 켜짐' : '숨기기 꺼짐'}</div>
      </InfoCard>
      <InfoCard title="화면 테마">
        <div role="group" aria-label="화면 테마 선택" style={{ display: 'flex', gap: 8 }}>
          {themeOptions.map(([value, label]) => (
            <button key={value} type="button" aria-pressed={themePref === value}
              onClick={() => setThemePref(value)} style={segmentStyle(themePref === value)}>
              {label}
            </button>
          ))}
        </div>
      </InfoCard>
      <InfoCard title="데이터 갱신 상태">
        <div style={{ fontSize: 11, color: INK_2 }}>{syncLabel || '갱신 이력 없음'}</div>
      </InfoCard>
      <InfoCard title="계정">
        <div style={{ fontSize: 11, color: INK_2 }}>{auth === 'signed-in' ? 'Google 연결됨' : '로그인 필요'}</div>
      </InfoCard>
    </div>
  );
}
