// 거래결정 탭: 팔기 전 4단계 점검(지금 시장·팔 것·옮길 곳·지난 교훈). App.jsx에서 추출 (동작 불변).
// 상태·시트 I/O 없는 순수 표시 탭 — 파생값은 prop 데이터로 계산.
import { PROFIT_POS, PROFIT_NEG } from '../lib/constants.js';
import { SectionTitle } from '../lib/primitives.jsx';
import { findThesisAlerts } from '../lib/thesisAlerts.js';

export default function TradeDecisionTab({ riskMonitor, positionJournal, accounts, weeklyReports, setTab, baseFont }) {
  // riskMonitor 는 최신순. 최신 거시(D)·논리(B) 신호 추출
  const macro = (riskMonitor || []).find(s => s.type === 'D');
  const logicReds = (riskMonitor || []).filter(s => s.type === 'B' && /🔴|🟡/.test(s.signal)).slice(0, 6);
  const alerts = findThesisAlerts(positionJournal, riskMonitor); // 팔 것 후보
  const lessons = (positionJournal || []).filter(p => p.status === '청산' && p.lesson).slice(0, 6);
  const rebalAlerts = Object.entries(accounts).flatMap(([, a]) =>
    (a.assets || []).map(asset => {
      const curr = asset.ratio > 0 ? asset.ratio : (asset.sheetCurrent ?? 0);
      const diff = parseFloat((curr - asset.target).toFixed(1));
      return { acct: a.label, name: asset.name, diff, color: a.color };
    }).filter(x => Math.abs(x.diff) >= 5)
  );

  // 옮길 곳: 최신 리포트 처방 재사용
  let action = '', reason = '', rptDate = '';
  const rpt = weeklyReports[0];
  if (rpt) {
    const pSec = rpt.body.split(/^## /m).filter(Boolean).find(s => /처방/.test(s.split('\n')[0]));
    if (pSec) {
      const rest = pSec.split('\n').slice(1).join('\n').trim();
      const quote = rest.match(/^>\s*(.+)$/m);
      action = quote ? quote[1].replace(/\*\*/g, '').replace(/^["“]\s*|\s*["”]$/g, '').trim() : '';
      let r2 = rest.replace(/^>.*$/m, '').trim();
      const sep = r2.indexOf('\n---'); if (sep >= 0) r2 = r2.slice(0, sep).trim();
      reason = r2.replace(/^근거\s*[:：]\s*/, '').replace(/\*\*/g, '').trim();
      rptDate = rpt.date;
    }
  }

  const sigColor = (s) => /🔴/.test(s) ? '#EF4444' : /🟡/.test(s) ? '#F5C842' : '#4ADE80';
  const StepHead = (n, title, sub) => (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 10 }}>
      <span style={{ fontSize: 13, fontWeight: 800, color: '#F5C842' }}>{n}</span>
      <span style={{ fontSize: 13, fontWeight: 700, color: '#F5F7FF' }}>{title}</span>
      {sub && <span style={{ fontSize: 10, color: '#8A9AB5' }}>{sub}</span>}
    </div>
  );
  const cardStyle = { background: '#1A1D26', border: '1px solid #262A3A', borderRadius: 12, padding: 16, marginBottom: 12 };

  return (
    <div>
      <SectionTitle color="#F4845F" mb={14} sub="팔기 전에 4단계 점검">거래결정</SectionTitle>

      {/* 1. 지금 시장 */}
      <div style={cardStyle}>
        {StepHead('1', '지금 시장', '거시·논리 신호')}
        {macro ? (
          <div style={{ background: sigColor(macro.signal) + '14', border: `1px solid ${sigColor(macro.signal)}44`, borderRadius: 8, padding: 10, marginBottom: logicReds.length ? 10 : 0 }}>
            <div style={{ fontSize: 12, color: '#F5F7FF', fontWeight: 600 }}>{macro.signal} 거시 — {macro.summary}</div>
            {macro.detail && <div style={{ fontSize: 11, color: '#C9D1E5', lineHeight: 1.5, marginTop: 4 }}>{macro.detail}</div>}
            <div style={{ fontSize: 9, color: '#8A9AB5', marginTop: 4 }}>{macro.date}</div>
          </div>
        ) : <div style={{ fontSize: 11, color: '#8A9AB5' }}>최근 거시 신호 없음</div>}
        {logicReds.length > 0 && (
          <div style={{ marginTop: 4 }}>
            {logicReds.map((s, i) => (
              <div key={i} style={{ fontSize: 11, color: '#C9D1E5', lineHeight: 1.5, padding: '3px 0' }}>
                <span style={{ color: sigColor(s.signal) }}>{s.signal}</span> <b style={{ color: '#E5E9F5' }}>{s.target}</b> — {s.summary}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 2. 팔 것 */}
      <div style={cardStyle}>
        {StepHead('2', '팔 것', '이탈조건이 흔들리는 보유')}
        {alerts.length === 0 ? (
          <div style={{ fontSize: 11, color: '#4ADE80' }}>지금 이탈조건이 깨진 보유는 없습니다 — 매도 서두를 필요 없음</div>
        ) : alerts.map((a, i) => (
          <div key={i} style={{ background: '#12141C', borderRadius: 8, padding: 10, marginBottom: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
              <span style={{ fontSize: 12, fontWeight: 700, color: '#F5F7FF' }}>{a.position.name}</span>
              <span style={{ fontSize: 10, color: sigColor(a.signal.signal) }}>{a.signal.signal} {a.signal.type}신호</span>
            </div>
            <div style={{ fontSize: 11, color: '#C9D1E5', lineHeight: 1.5 }}>{a.signal.summary}</div>
            {a.position.exit && <div style={{ fontSize: 10, color: '#F5C9B8', lineHeight: 1.5, marginTop: 4 }}>이탈조건: {a.position.exit}</div>}
          </div>
        ))}
        <button onClick={() => setTab('저널')} style={{ marginTop: 6, padding: '6px 12px', minHeight: 32, borderRadius: 6, border: '1px solid #2E3344', background: 'none', color: '#9CA3AF', cursor: 'pointer', fontSize: 10, fontFamily: baseFont }}>포지션에서 전체 보기 ›</button>
      </div>

      {/* 3. 옮길 곳 */}
      <div style={cardStyle}>
        {StepHead('3', '옮길 곳', '이번 주 처방 · 배분 갭')}
        {action ? (
          <div style={{ background: 'linear-gradient(135deg,#2A2410,#12141C)', border: '1px solid #F5C84244', borderRadius: 8, padding: 12 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: '#F5F7FF', lineHeight: 1.5, marginBottom: reason ? 8 : 0 }}>{action}</div>
            {reason && <div style={{ fontSize: 10, color: '#9CA3AF', lineHeight: 1.6, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{reason}</div>}
            {rptDate && <div style={{ fontSize: 9, color: '#8A9AB5', marginTop: 6 }}>{rptDate} 리포트</div>}
          </div>
        ) : <div style={{ fontSize: 11, color: '#8A9AB5' }}>최근 리포트 처방 없음 — 리포트 탭에서 주간 리포트를 생성하세요</div>}
        {rebalAlerts.length > 0 && (
          <div style={{ marginTop: 10 }}>
            <div style={{ fontSize: 9, letterSpacing: 1, color: '#8A9AB5', marginBottom: 6 }}>리밸런싱 갭 (±5%p 초과)</div>
            {rebalAlerts.map((a, i) => (
              <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '5px 8px', borderRadius: 5, marginBottom: 3, background: '#12141C', borderLeft: `3px solid ${a.diff > 0 ? PROFIT_POS : PROFIT_NEG}` }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <div style={{ width: 6, height: 6, borderRadius: '50%', background: a.color, flexShrink: 0 }} />
                  <span style={{ fontSize: 11, color: '#E8EAF0' }}>{a.name}</span>
                  <span style={{ fontSize: 9, color: a.color }}>{a.acct}</span>
                </div>
                <span style={{ fontSize: 11, fontWeight: 700, color: a.diff > 0 ? PROFIT_POS : PROFIT_NEG }}>{a.diff > 0 ? '+' : ''}{a.diff}%p</span>
              </div>
            ))}
          </div>
        )}
        {rebalAlerts.length === 0 && <div style={{ fontSize: 10, color: '#4ADE80', marginTop: 8 }}>✅ 모든 자산군 목표 비중 이내</div>}
        <button onClick={() => setTab('rebalance')} style={{ marginTop: 8, padding: '6px 12px', minHeight: 32, borderRadius: 6, border: '1px solid #2E3344', background: 'none', color: '#9CA3AF', cursor: 'pointer', fontSize: 10, fontFamily: baseFont }}>자산분배 갭 보기 ›</button>
      </div>

      {/* 4. 지난 교훈 */}
      <div style={cardStyle}>
        {StepHead('4', '지난 교훈', '같은 실수 반복 금지')}
        {lessons.length === 0 ? (
          <div style={{ fontSize: 11, color: '#8A9AB5' }}>아직 기록된 교훈이 없습니다 — 청산 종목을 반성하면 여기 쌓입니다</div>
        ) : lessons.map((p, i) => (
          <div key={i} style={{ fontSize: 11, color: '#A8D672', lineHeight: 1.5, padding: '4px 0', borderBottom: i < lessons.length - 1 ? '1px solid #1F2330' : 'none' }}>
            <b style={{ color: '#C9D1E5' }}>{p.name}</b>: {p.lesson}
          </div>
        ))}
      </div>
    </div>
  );
}
