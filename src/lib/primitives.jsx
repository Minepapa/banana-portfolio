// 공통 프레젠테이션 프리미티브. App.jsx에서 추출 (동작 불변).
import { gradeColor, breakUnits, breakSentences } from './textFormat.js';

// ── 섹션/카드 제목: 좌측 정렬 + 라임 하이라이트 블록 (네오 브루탈리즘) ──────────────
// color는 하이라이트 블록 색(기본 라임). 제목 텍스트는 항상 ink.
export function SectionTitle({ children, color = '#C9F23E', sub, size = 13, mb = 16 }) {
  return (
    <div style={{ textAlign: 'left', marginBottom: mb }}>
      <span style={{ display: 'inline-block', fontSize: size, fontWeight: 800, letterSpacing: 0.5, color: '#141414', background: color, padding: '2px 8px', border: '2px solid #141414' }}>{children}</span>
      {sub != null && sub !== '' && <div style={{ fontSize: 10, color: '#6B675C', marginTop: 6, lineHeight: 1.5 }}>{sub}</div>}
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
