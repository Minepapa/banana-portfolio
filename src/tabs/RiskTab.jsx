// 리스크 탭: B(논리)·D(거시) 신호 모니터 + 펀더멘털 기준선. App.jsx에서 추출 (동작 불변).
import { useState } from "react";
import { SectionTitle, Sentences } from '../lib/primitives.jsx';

export default function RiskTab({ riskMonitor, baselines }) {
  const [riskOpen, setRiskOpen] = useState(new Set());

  const today = new Date();
  const dateStr = `${today.getFullYear()}.${String(today.getMonth()+1).padStart(2,'0')}.${String(today.getDate()).padStart(2,'0')}`;
  const sigLevel = (s) => s.includes('🔴') ? 3 : s.includes('🟡') ? 2 : 1;
  const sigColor = (s) => s.includes('🔴') ? '#EF4444' : s.includes('🟡') ? '#F5C842' : '#10B981';
  // 검증 "항목"(무엇을 점검했나) — 중립 표기. 결과/상태와 분리.
  const typeLabel = (t) => t === 'B' ? '논리 점검' : t === 'D' ? '거시 점검' : t;
  // 점검 "결과"(상황) — 색상과 함께 표시.
  const statusLabel = (s) => s.includes('🔴') ? '경보' : s.includes('🟡') ? '주의' : '정상';
  // 기준선 수치 단위 통일(%): 숫자면 % 부착, 데이터 없으면 '데이터 부족'.
  const fmtPct = (v) => {
    const s = String(v ?? '').trim();
    if (!s || s === '—') return '—';
    if (/데이터\s*부족|N\/?A|없음|None|미분류/i.test(s)) return '데이터 부족';
    const n = parseFloat(s.replace(/[,%\s]/g, ''));
    if (isNaN(n)) return '데이터 부족';
    return `${Number.isInteger(n) ? n : parseFloat(n.toFixed(2))}%`;
  };

  // 동일 (유형+대상)은 최신 1건만 — riskMonitor는 최신순.
  // 거시(D)는 대상 텍스트가 실행마다 달라져 (유형+대상) 디듀프가 안 먹으므로,
  // 가장 최근 날짜의 D 신호만 노출(과거 날짜 누적분 자동 제거).
  const latestDDate = riskMonitor.reduce((mx, r) => (r.type === 'D' && r.date > mx ? r.date : mx), '');
  const seen = new Set();
  const latest = [];
  const oppSeen = new Set();   // 기회(O) 신호 — 종목당 최신 1건, 리스크와 분리
  const oppLatest = [];
  for (const r of riskMonitor) {                       // riskMonitor 최신순
    if (r.type === 'O') {                              // 가격 기회 트리거(§4) — 리스크 카운트에서 제외
      if (oppSeen.has(r.target)) continue;
      oppSeen.add(r.target);
      if (sigLevel(r.signal) === 1) continue;          // 🟢(해소된 기회)는 숨김
      oppLatest.push(r);
      continue;
    }
    if (r.type === 'D' && r.date !== latestDDate) continue;
    const k = `${r.type}|${r.target}`;
    if (seen.has(k)) continue;
    seen.add(k); latest.push(r);
  }
  latest.sort((a, b) => sigLevel(b.signal) - sigLevel(a.signal));
  oppLatest.sort((a, b) => sigLevel(b.signal) - sigLevel(a.signal));  // 급락매수(🔴) 먼저
  const counts = { red: 0, amber: 0, green: 0 };
  latest.forEach(r => { const l = sigLevel(r.signal); if (l === 3) counts.red++; else if (l === 2) counts.amber++; else counts.green++; });
  // 최신 점검일 — 행 순서에 의존하지 않게 실제 최대 날짜로 계산.
  const lastUpdated = riskMonitor.reduce((mx, r) => (r.date > mx ? r.date : mx), '') || '—';

  const renderEvidence = (ev) => {
    if (!ev) return null;
    let obj;
    try { obj = JSON.parse(ev); } catch { return null; }
    if (!obj || typeof obj !== 'object') return null;
    const entries = Object.entries(obj).filter(([, v]) => v != null && typeof v !== 'object');
    if (!entries.length) return null;
    return (
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
        {entries.map(([k, v], i) => (
          <div key={i} style={{ fontSize: 9, color: '#9CA3AF', background: '#12141C', borderRadius: 4, padding: '3px 7px' }}>
            <span style={{ color: '#8A9AB5' }}>{k}</span> {String(v)}
          </div>
        ))}
      </div>
    );
  };

  return (
    <div style={{ textAlign: 'left' }}>
      {/* 헤더 */}
      <SectionTitle color="#EF4444" size={15} sub={`최근 점검 ${lastUpdated}`}>리스크 모니터</SectionTitle>

      {riskMonitor.length === 0 ? (
        <div style={{ background: '#1A1D26', borderRadius: 12, padding: 24, textAlign: 'center' }}>
          <div style={{ fontSize: 28, marginBottom: 8 }}>🛡️</div>
          <div style={{ fontSize: 12, color: '#9CA3AF', lineHeight: 1.6 }}>
            아직 리스크 신호가 없습니다.<br />
            <span style={{ fontSize: 10, color: '#8A9AB5' }}>risk-monitor 실행 후 B(논리 훼손)·D(거시 충격) 신호가 표시됩니다.</span>
          </div>
        </div>
      ) : (
        <>
          {/* 신호 요약 */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginBottom: 12 }}>
            {[
              { label: '경보', n: counts.red, c: '#EF4444' },
              { label: '주의', n: counts.amber, c: '#F5C842' },
              { label: '정상', n: counts.green, c: '#10B981' },
            ].map((x, i) => (
              <div key={i} style={{ background: x.n > 0 ? `${x.c}14` : '#1A1D26', borderRadius: 12, padding: '14px 8px', textAlign: 'center', border: `1px solid ${x.n > 0 ? `${x.c}44` : '#232838'}` }}>
                <div style={{ fontSize: 24, fontWeight: 800, color: x.n > 0 ? x.c : '#3A4050', lineHeight: 1 }}>{x.n}</div>
                <div style={{ fontSize: 10, color: '#9CA3AF', marginTop: 6, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5 }}>
                  <span style={{ width: 6, height: 6, borderRadius: '50%', background: x.c, display: 'inline-block' }} />{x.label}
                </div>
              </div>
            ))}
          </div>

          {/* 신호 카드 목록 */}
          {latest.map((r, i) => {
            const color = sigColor(r.signal);
            const isOpen = riskOpen.has(i);
            // 거시(D) 머리글은 자산군 단위로 통합 — 구성종목 나열은 '자세히'로 내림
            let headTitle = r.target, headRest = '';
            if (r.type === 'D') {
              const parts = r.target.split(/\s+[—–-]\s+/);
              if (parts.length > 1) { headTitle = parts[0].trim(); headRest = parts.slice(1).join(' — ').trim(); }
              else if (r.target.length > 40) { headTitle = r.target.slice(0, 40).trim() + '…'; headRest = r.target; }
            }
            return (
              <div key={i} style={{ background: '#1A1D26', borderRadius: 12, padding: 14, marginBottom: 8, border: '1px solid #232838', borderLeft: `4px solid ${color}` }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', flex: 1, minWidth: 0 }}>
                    {/* 상태 점(이모지 대신 CSS 원 — 폰트 의존 없이 항상 정상 표시) */}
                    <span style={{ width: 9, height: 9, borderRadius: '50%', background: color, flexShrink: 0, display: 'inline-block' }} />
                    <span style={{ fontSize: 12, fontWeight: 700, color: '#E8EAF0' }}>{headTitle}</span>
                    {/* 검증 항목(중립 회색) */}
                    <span style={{ fontSize: 8, color: '#8A93A6', border: '1px solid #2E3442', borderRadius: 3, padding: '1px 5px' }}>{typeLabel(r.type)}</span>
                    {/* 결과 상태(색상) */}
                    <span style={{ fontSize: 8, color, background: `${color}22`, borderRadius: 3, padding: '1px 6px', fontWeight: 700 }}>{statusLabel(r.signal)}</span>
                  </div>
                  <span style={{ fontSize: 9, color: '#3A4050', flexShrink: 0 }}>{r.date}</span>
                </div>
                {/* 본문은 카드 전체 폭으로 — 날짜 아래까지 채워 자연스럽게 줄바꿈 */}
                <Sentences text={r.summary} sentenceOnly style={{ fontSize: 11, color: '#9CA3AF', lineHeight: 1.55, marginTop: 4 }} />
                {(r.detail || r.evidence) && (
                  <button onClick={() => setRiskOpen(prev => { const n = new Set(prev); if (n.has(i)) n.delete(i); else n.add(i); return n; })}
                    style={{ marginTop: 8, padding: '4px 0', background: 'transparent', border: 'none', color: '#8A9AB5', cursor: 'pointer', fontSize: 9 }}>
                    {isOpen ? '접기 ▲' : '자세히 ▼'}
                  </button>
                )}
                {isOpen && (
                  <div style={{ marginTop: 6, paddingTop: 8, borderTop: '1px solid #1E2233' }}>
                    {headRest && <div style={{ fontSize: 9, color: '#8A9AB5', lineHeight: 1.5, marginBottom: 6, wordBreak: 'break-word' }}>구성: {headRest}</div>}
                    {r.detail && <Sentences text={r.detail} sentenceOnly style={{ fontSize: 10, color: '#9CA3AF', lineHeight: 1.6, wordBreak: 'break-word', marginBottom: 2 }} />}
                    {renderEvidence(r.evidence)}
                    {r.baselineRef && <div style={{ fontSize: 9, color: '#8A9AB5', marginTop: 8 }}>기준선: {r.baselineRef}</div>}
                  </div>
                )}
              </div>
            );
          })}
        </>
      )}

      {/* 리밸런싱 기회 (§4 가격 트리거 — O 신호) */}
      {oppLatest.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <SectionTitle color="#52C8D4" size={12} mb={10} sub="§4 가격 트리거 — 펀더멘털 확인 후 판단">💡 리밸런싱 기회</SectionTitle>
          {oppLatest.map((r, i) => {
            const color = sigColor(r.signal);
            const isBuy = sigLevel(r.signal) === 3;          // 🔴 = 급락 매수 기회
            const key = `opp-${i}`;
            const isOpen = riskOpen.has(key);
            return (
              <div key={key} style={{ background: '#1A1D26', borderRadius: 12, padding: 14, marginBottom: 8, border: '1px solid #232838', borderLeft: `4px solid ${color}` }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', flex: 1, minWidth: 0 }}>
                    <span style={{ width: 9, height: 9, borderRadius: '50%', background: color, flexShrink: 0, display: 'inline-block' }} />
                    <span style={{ fontSize: 12, fontWeight: 700, color: '#E8EAF0' }}>{r.target}</span>
                    <span style={{ fontSize: 8, color, background: `${color}22`, borderRadius: 3, padding: '1px 6px', fontWeight: 700 }}>{isBuy ? '급락 매수' : '차익 검토'}</span>
                  </div>
                  <span style={{ fontSize: 9, color: '#3A4050', flexShrink: 0 }}>{r.date}</span>
                </div>
                <Sentences text={r.summary} sentenceOnly style={{ fontSize: 11, color: '#9CA3AF', lineHeight: 1.55, marginTop: 4 }} />
                {(r.detail || r.evidence) && (
                  <button onClick={() => setRiskOpen(prev => { const n = new Set(prev); if (n.has(key)) n.delete(key); else n.add(key); return n; })}
                    style={{ marginTop: 8, padding: '4px 0', background: 'transparent', border: 'none', color: '#8A9AB5', cursor: 'pointer', fontSize: 9 }}>
                    {isOpen ? '접기 ▲' : '자세히 ▼'}
                  </button>
                )}
                {isOpen && (
                  <div style={{ marginTop: 6, paddingTop: 8, borderTop: '1px solid #1E2233' }}>
                    {r.detail && <Sentences text={r.detail} sentenceOnly style={{ fontSize: 10, color: '#9CA3AF', lineHeight: 1.6, wordBreak: 'break-word', marginBottom: 2 }} />}
                    {renderEvidence(r.evidence)}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* 펀더멘털 기준선 */}
      {baselines.length > 0 && (
        <div style={{ background: '#1A1D26', borderRadius: 12, padding: 16, marginTop: 12 }}>
          <SectionTitle color="#F5C842" size={12} mb={14} sub="논리 훼손 비교 기준">펀더멘털 기준선</SectionTitle>
          <div style={{ display: 'flex', fontSize: 9, color: '#8A9AB5', padding: '0 0 6px', borderBottom: '1px solid #1E2233' }}>
            <span style={{ flex: 2, minWidth: 0 }}>종목</span>
            <span style={{ flex: 1, textAlign: 'right' }}>영익률</span>
            <span style={{ flex: 1, textAlign: 'right' }}>ROE</span>
            <span style={{ flex: 1, textAlign: 'right' }}>부채</span>
          </div>
          {baselines.map((b, i) => (
            <div key={i} style={{ display: 'flex', fontSize: 10, color: '#E8EAF0', padding: '7px 0', borderBottom: i < baselines.length - 1 ? '1px solid #15171F' : 'none' }}>
              <span style={{ flex: 2, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{b.name}</span>
              {[b.operatingMargin, b.roe, b.debtRatio].map((v, k) => {
                const f = fmtPct(v);
                return <span key={k} style={{ flex: 1, textAlign: 'right', color: f === '데이터 부족' ? '#8A9AB5' : '#9CA3AF', fontSize: f === '데이터 부족' ? 9 : 10 }}>{f}</span>;
              })}
            </div>
          ))}
          <div style={{ fontSize: 9, color: '#3A4050', marginTop: 8 }}>기준일 {baselines[0]?.date || '—'} · 가격 등락이 아닌 실적 훼손만 리스크로 평가</div>
        </div>
      )}

      <div style={{ fontSize: 9, color: '#3A4050', textAlign: 'center', marginTop: 16 }}>
        {dateStr} 조회 · 펀더멘털·거시 기반 (가격 과열 단독은 신호 아님)
      </div>
    </div>
  );
}
