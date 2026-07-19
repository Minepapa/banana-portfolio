// 공통 프레젠테이션 프리미티브. App.jsx에서 추출 (동작 불변).
import { gradeColor, breakUnits, breakSentences } from './textFormat.js';
import { DEPARTMENTS } from './colors.js';

// ── 섹션/탭 제목: 모든 탭 진입 제목의 통일 포맷 (주간 리포트 헤더 기준) ─────────────
// 제목 14px·weight 700·ink 좌측 정렬 + sub는 그 아래 10px 뮤트. (color prop은 하위호환용, 미사용)
export function SectionTitle({ children, sub, size = 14, mb = 16 }) {
  return (
    <div style={{ textAlign: 'left', marginBottom: mb }}>
      <div style={{ fontSize: size, fontWeight: 700, color: '#141414', letterSpacing: -0.2 }}>{children}</div>
      {sub != null && sub !== '' && <div style={{ fontSize: 10, color: '#6B675C', marginTop: 4, lineHeight: 1.5 }}>{sub}</div>}
    </div>
  );
}

// 등급 사각형 (원→직각). 브루탈 톤.
export function GradeDot({ grade, size = 9 }) {
  return <span style={{ width: size, height: size, borderRadius: 0, background: gradeColor(grade), flexShrink: 0, display: 'inline-block' }} />;
}
// 문장 단위로 각 줄을 렌더(공통 스타일 적용). sentenceOnly=true면 문장 종결에서만 줄바꿈.
export function Sentences({ text, style, sentenceOnly }) {
  const lines = sentenceOnly ? breakSentences(text) : breakUnits(text);
  return lines.map((l, i) => <div key={i} style={style}>{l}</div>);
}
// 소제목 캡션: 색 사각형 + 라벨(좌측, 리스트 머리)
export function SubLabel({ children, color = '#141414' }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
      <span style={{ width: 6, height: 6, borderRadius: 0, background: color, flexShrink: 0, display: 'inline-block' }} />
      <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: 1, color: '#6B675C' }}>{children}</span>
    </div>
  );
}
// 번호 매김 리스트: 번호 열(mono) + 문장 단위 줄바꿈
export function NumberedItem({ n, text, color = '#141414', numColor = '#6B675C' }) {
  return (
    <div style={{ display: 'flex', gap: 8, marginBottom: 7 }}>
      <span style={{ fontSize: 11, fontWeight: 800, color: numColor, flexShrink: 0, lineHeight: 1.6, fontFamily: "ui-monospace, 'SF Mono', Menlo, monospace" }}>{n}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        {breakUnits(text).map((l, i) => (
          <div key={i} style={{ fontSize: 11, color, lineHeight: 1.6 }}>{l}</div>
        ))}
      </div>
    </div>
  );
}

// 판테온 부서 배지 — 아이콘+라벨, 부서색 22% 배경. 기존 인라인 배지들(RiskTab typeLabel/
// statusLabel, PreferenceTab vsBadge/confBadge)과 동일 규격(fontSize/padding/직각)으로
// 시각 일관성 유지. "이건 어느 부서 소관인가"를 알려주는 축 — 기존 배지들과 병렬 배치.
export function DeptBadge({ dept, size = 'sm' }) {
  const d = DEPARTMENTS[dept];
  if (!d) return null;
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 3,
      fontSize: size === 'sm' ? 9 : 10, fontWeight: 700,
      padding: '2px 6px', borderRadius: 0,
      background: `${d.color}22`, color: d.color, whiteSpace: 'nowrap',
    }}>
      <span>{d.icon}</span><span>{d.label}</span>
    </span>
  );
}
