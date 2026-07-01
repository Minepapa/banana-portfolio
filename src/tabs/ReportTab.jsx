// 리포트 탭: 주간 AI 리포트 표시 + 날짜 선택. App.jsx에서 추출 (동작 불변).
import { useState } from "react";
import { SectionTitle } from '../lib/primitives.jsx';

export default function ReportTab({ weeklyReports }) {
  const [weeklyExpanded, setWeeklyExpanded] = useState(false);
  const [selectedIdx, setSelectedIdx] = useState(0);

  const today = new Date();
  const dateStr = `${today.getFullYear()}.${String(today.getMonth()+1).padStart(2,'0')}.${String(today.getDate()).padStart(2,'0')}`;

  const sorted = weeklyReports;
  const safeIdx = selectedIdx < sorted.length ? selectedIdx : 0;

  return (
    <div>
      {/* 헤더 */}
      <SectionTitle sub={`${dateStr} 기준`}>주간 리포트</SectionTitle>

      {/* 리포트 날짜 선택 */}
      {sorted.length > 1 && (
        <div style={{ display: 'flex', gap: 4, marginBottom: 12, marginTop: 4, flexWrap: 'wrap' }}>
          {sorted.map((r, i) => (
            <button key={r.date} onClick={() => { setSelectedIdx(i); setWeeklyExpanded(false); }}
              style={{ padding: '4px 10px', borderRadius: 0, border: '1px solid #141414', background: i === safeIdx ? '#E4F5A0' : 'transparent', color: '#141414', fontWeight: i === safeIdx ? 800 : 600, cursor: 'pointer', fontSize: 9 }}>
              {r.date}
            </button>
          ))}
        </div>
      )}

      {/* 섹션 4: 주간 AI 리포트 */}
      {sorted.length > 0 && (() => {
        const latest = sorted[safeIdx];
        const sections = latest.body.split(/^## /m).filter(Boolean).map(s => {
          const lines = s.split('\n');
          const title = lines[0].trim();
          const content = lines.slice(1).join('\n').trim();
          return { title, content };
        });
        const visibleSections = weeklyExpanded ? sections : sections.slice(0, 3);
        return (
          <div style={{ background: '#FFFFFF', borderRadius: 0, padding: 16, marginBottom: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <div style={{ fontSize: 10, letterSpacing: 3, color: '#6B675C' }}>📋 주간 AI 리포트</div>
              <div style={{ fontSize: 10, color: '#3A4050' }}>{latest.date}</div>
            </div>
            {visibleSections.map((sec, i) => (
              <div key={i} style={{ marginBottom: 10 }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: '#141414', marginBottom: 6 }}>{sec.title}</div>
                <div style={{ fontSize: 10, color: '#6B675C', lineHeight: 1.6, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                  {sec.content.split('\n').map((line, j) => {
                    if (line.startsWith('|') && line.includes('|')) {
                      const cells = line.split('|').filter(Boolean).map(c => c.trim());
                      if (cells.every(c => /^[-:]+$/.test(c))) return null;
                      return (
                        <div key={j} style={{ display: 'flex', gap: 8, padding: '2px 0', fontSize: 9, borderBottom: '1px solid #EAE6DA' }}>
                          {cells.map((c, k) => <span key={k} style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.replace(/\*\*/g, '')}</span>)}
                        </div>
                      );
                    }
                    const cleaned = line.replace(/\*\*/g, '').replace(/^>\s*/, '');
                    if (!cleaned) return <br key={j} />;
                    if (line.startsWith('###')) return <div key={j} style={{ fontSize: 10, fontWeight: 600, color: '#141414', marginTop: 8, marginBottom: 4 }}>{cleaned.replace(/^#+\s*/, '')}</div>;
                    return <div key={j}>{cleaned}</div>;
                  })}
                </div>
              </div>
            ))}
            {sections.length > 3 && (
              <button onClick={() => setWeeklyExpanded(!weeklyExpanded)} style={{
                width: '100%', padding: '8px', borderRadius: 0, border: '1px solid #141414',
                background: 'transparent', color: '#6B675C', cursor: 'pointer', fontSize: 10,
              }}>
                {weeklyExpanded ? '접기 ▲' : `전체 보기 (${sections.length}섹션) ▼`}
              </button>
            )}
          </div>
        );
      })()}

    </div>
  );
}
