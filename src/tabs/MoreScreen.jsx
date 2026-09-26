import { CARD_BG, INK, INK_2, BORDER, RADIUS } from '../lib/theme.js';

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

export default function MoreScreen({ hideAmounts, syncLabel, auth }) {
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
      <InfoCard title="데이터 갱신 상태">
        <div style={{ fontSize: 11, color: INK_2 }}>{syncLabel || '갱신 이력 없음'}</div>
      </InfoCard>
      <InfoCard title="계정">
        <div style={{ fontSize: 11, color: INK_2 }}>{auth === 'signed-in' ? 'Google 연결됨' : '로그인 필요'}</div>
      </InfoCard>
    </div>
  );
}
