// 공통 프레젠테이션 프리미티브. App.jsx에서 추출 (동작 불변).
import { gradeColor, breakUnits, breakSentences } from './textFormat.js';

// ── 섹션/카드 제목: 중앙 정렬 + 색 밑줄 강조 ─────────────────────────────────────
export function SectionTitle({ children, color = '#3B82F6', sub, size = 13, mb = 16 }) {
  return (
    <div style={{ textAlign: 'center', marginBottom: mb }}>
      <div style={{ fontSize: size, fontWeight: 700, letterSpacing: 0.5, color: '#E8EAF0' }}>{children}</div>
      {sub != null && sub !== '' && <div style={{ fontSize: 10, color: '#8A9AB5', marginTop: 4, lineHeight: 1.5 }}>{sub}</div>}
      <div style={{ width: 26, height: 3, borderRadius: 2, background: color, margin: '8px auto 0' }} />
    </div>
  );
}

export function GradeDot({ grade, size = 9 }) {
  return <span style={{ width: size, height: size, borderRadius: '50%', background: gradeColor(grade), flexShrink: 0, display: 'inline-block' }} />;
}
// 문장 단위로 각 줄을 렌더(공통 스타일 적용). sentenceOnly=true면 문장 종결에서만 줄바꿈.
export function Sentences({ text, style, sentenceOnly }) {
  const lines = sentenceOnly ? breakSentences(text) : breakUnits(text);
  return lines.map((l, i) => <div key={i} style={style}>{l}</div>);
}
// 소제목 캡션: 색 점 + 라벨(좌측, 리스트 머리)
export function SubLabel({ children, color = '#8A9AB5' }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
      <span style={{ width: 5, height: 5, borderRadius: '50%', background: color, flexShrink: 0, display: 'inline-block' }} />
      <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1, color: '#7A8499' }}>{children}</span>
    </div>
  );
}
// 번호 매김 리스트: 번호 열 + 문장 단위 줄바꿈
export function NumberedItem({ n, text, color = '#9CA3AF', numColor = '#8A9AB5' }) {
  return (
    <div style={{ display: 'flex', gap: 8, marginBottom: 7 }}>
      <span style={{ fontSize: 11, fontWeight: 700, color: numColor, flexShrink: 0, lineHeight: 1.6 }}>{n}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        {breakUnits(text).map((l, i) => (
          <div key={i} style={{ fontSize: 11, color, lineHeight: 1.6 }}>{l}</div>
        ))}
      </div>
    </div>
  );
}
