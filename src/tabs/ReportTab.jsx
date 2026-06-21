// 리포트 탭: 주간 AI 리포트 표시 + 날짜 선택. App.jsx에서 추출 (동작 불변).
import { useState } from "react";

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
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: '#E8EAF0' }}>주간 리포트</div>
        <div style={{ fontSize: 10, color: '#8A9AB5' }}>{dateStr} 기준</div>
      </div>

      {/* 리포트 날짜 선택 */}
      {sorted.length > 1 && (
        <div style={{ display: 'flex', gap: 4, marginBottom: 12, marginTop: 4, flexWrap: 'wrap' }}>
          {sorted.map((r, i) => (
            <button key={r.date} onClick={() => { setSelectedIdx(i); setWeeklyExpanded(false); }}
              style={{ padding: '4px 10px', borderRadius: 4, border: `1px solid ${i === safeIdx ? '#3B82F6' : '#2A2F3E'}`, background: i === safeIdx ? '#1E3A5F' : 'transparent', color: i === safeIdx ? '#60A5FA' : '#8A9AB5', cursor: 'pointer', fontSize: 9 }}>
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
          <div style={{ background: '#1A1D26', borderRadius: 12, padding: 16, marginBottom: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <div style={{ fontSize: 10, letterSpacing: 3, color: '#8A9AB5' }}>📋 주간 AI 리포트</div>
              <div style={{ fontSize: 10, color: '#3A4050' }}>{latest.date}</div>
            </div>
            {visibleSections.map((sec, i) => (
              <div key={i} style={{ marginBottom: 10 }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: '#60A5FA', marginBottom: 6 }}>{sec.title}</div>
                <div style={{ fontSize: 10, color: '#9CA3AF', lineHeight: 1.6, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                  {sec.content.split('\n').map((line, j) => {
                    if (line.startsWith('|') && line.includes('|')) {
                      const cells = line.split('|').filter(Boolean).map(c => c.trim());
                      if (cells.every(c => /^[-:]+$/.test(c))) return null;
                      return (
                        <div key={j} style={{ display: 'flex', gap: 8, padding: '2px 0', fontSize: 9, borderBottom: '1px solid #1E2233' }}>
                          {cells.map((c, k) => <span key={k} style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.replace(/\*\*/g, '')}</span>)}
                        </div>
                      );
                    }
                    const cleaned = line.replace(/\*\*/g, '').replace(/^>\s*/, '');
                    if (!cleaned) return <br key={j} />;
                    if (line.startsWith('###')) return <div key={j} style={{ fontSize: 10, fontWeight: 600, color: '#E8EAF0', marginTop: 8, marginBottom: 4 }}>{cleaned.replace(/^#+\s*/, '')}</div>;
                    return <div key={j}>{cleaned}</div>;
                  })}
                </div>
              </div>
            ))}
            {sections.length > 3 && (
              <button onClick={() => setWeeklyExpanded(!weeklyExpanded)} style={{
                width: '100%', padding: '8px', borderRadius: 6, border: '1px solid #2A2F3E',
                background: 'transparent', color: '#8A9AB5', cursor: 'pointer', fontSize: 10,
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
