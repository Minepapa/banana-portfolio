// 리스크 탭: B(논리)·D(거시) 신호 모니터 + 펀더멘털 기준선. App.jsx에서 추출 (동작 불변).
import { useState } from "react";
import { SectionTitle, Sentences } from '../lib/primitives.jsx';
import { SIGNAL_RED, SIGNAL_AMBER, SIGNAL_GREEN, SIGNAL_OPPORTUNITY, signalColor } from '../lib/colors.js';

export default function RiskTab({ riskMonitor, baselines, setTab }) {
  const [riskOpen, setRiskOpen] = useState(new Set());

  const today = new Date();
  const dateStr = `${today.getFullYear()}.${String(today.getMonth()+1).padStart(2,'0')}.${String(today.getDate()).padStart(2,'0')}`;
  const sigLevel = (s) => s.includes('🔴') ? 3 : s.includes('🟡') ? 2 : 1;
  // 검증 "항목"(무엇을 점검했나) — 중립 표기. 결과/상태와 분리.
  const typeLabel = (t) => t === 'B' ? '논리 점검' : t === 'D' ? '거시 점검' : t === 'O' ? '급락매수' : t;
  // 점검 "결과"(상황) — 색상과 함께 표시. O(급락매수)는 리스크가 아니라 기회라 이모지와
  // 무관하게 항상 "기회"(상단 칩과 동일 라벨·색) — 🔴라고 "경보"로 잘못 읽히지 않게.
  const statusLabel = (type, s) => type === 'O' ? '기회' : s.includes('🔴') ? '경보' : s.includes('🟡') ? '주의' : '정상';
  // 카드 색도 같은 원칙: O는 심각도(signalColor)가 아니라 상단 "기회" 칩과 같은 고정색.
  const cardColor = (r) => r.type === 'O' ? SIGNAL_OPPORTUNITY : signalColor(r.signal);
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
  const oppSeen = new Set();   // 기회(O) 신호 — 종목당 최신 1건
  for (const r of riskMonitor) {                       // riskMonitor 최신순
    if (r.type === 'O') {
      if (oppSeen.has(r.target)) continue;
      oppSeen.add(r.target);
      if (sigLevel(r.signal) === 1) continue;          // 🟢(해소된 기회)는 숨김
      latest.push(r);                                  // 대시보드 카운트에 포함
      continue;
    }
    if (r.type === 'D' && r.date !== latestDDate) continue;
    const k = `${r.type}|${r.target}`;
    if (seen.has(k)) continue;
    seen.add(k); latest.push(r);
  }
  latest.sort((a, b) => sigLevel(b.signal) - sigLevel(a.signal));
  // 기회(O)는 리스크가 아니므로 경보/주의에 안 섞고 별도 집계 — 오늘 탭(급락 알림 분리)과 동일 의미.
  // (섞으면 급락 "매수 기회"가 경보 수를 부풀려 두 탭 숫자가 어긋난다 — 2026-07-10 실측)
  const counts = { red: 0, amber: 0, green: 0, opp: 0 };
  latest.forEach(r => {
    if (r.type === 'O') { counts.opp++; return; }
    const l = sigLevel(r.signal); if (l === 3) counts.red++; else if (l === 2) counts.amber++; else counts.green++;
  });
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
          <div key={i} style={{ fontSize: 9, color: '#6B675C', background: '#FFFFFF', borderRadius: 0, padding: '3px 7px' }}>
            <span style={{ color: '#6B675C' }}>{k}</span> {String(v)}
          </div>
        ))}
      </div>
    );
  };

  return (
    <div style={{ textAlign: 'left' }}>
      {/* 헤더 */}
      <SectionTitle sub={`최근 점검 ${lastUpdated}`}>리스크 모니터</SectionTitle>

      {riskMonitor.length === 0 ? (
        <div style={{ background: '#FFFFFF', borderRadius: 0, padding: 24, textAlign: 'center' }}>
          <div style={{ fontSize: 28, marginBottom: 8 }}>🛡️</div>
          <div style={{ fontSize: 12, color: '#6B675C', lineHeight: 1.6 }}>
            아직 리스크 신호가 없습니다.<br />
            <span style={{ fontSize: 10, color: '#6B675C' }}>risk-monitor 실행 후 B(논리 훼손)·D(거시 충격) 신호가 표시됩니다.</span>
          </div>
        </div>
      ) : (
        <>
          {/* 신호 요약 — 기회(O)는 리스크(경보/주의)와 분리된 칩 */}
          <div style={{ display: 'grid', gridTemplateColumns: counts.opp > 0 ? '1fr 1fr 1fr 1fr' : '1fr 1fr 1fr', gap: 8, marginBottom: 12 }}>
            {[
              { label: '경보', n: counts.red, c: SIGNAL_RED },
              { label: '주의', n: counts.amber, c: SIGNAL_AMBER },
              ...(counts.opp > 0 ? [{ label: '기회', n: counts.opp, c: SIGNAL_OPPORTUNITY }] : []),
              { label: '정상', n: counts.green, c: SIGNAL_GREEN },
            ].map((x, i) => {
              // 0건이면 숫자·점 둘 다 회색으로 죽인다(숫자만 죽고 점은 원색이면 서로 안 맞아 보임).
              const shown = x.n > 0 ? x.c : '#6B675C';
              return (
                <div key={i} style={{ background: x.n > 0 ? `${x.c}14` : '#FFFFFF', borderRadius: 0, padding: '14px 8px', textAlign: 'center', border: `1px solid ${x.n > 0 ? `${x.c}44` : '#141414'}` }}>
                  <div style={{ fontSize: 24, fontWeight: 800, color: shown, lineHeight: 1 }}>{x.n}</div>
                  <div style={{ fontSize: 10, color: '#6B675C', marginTop: 6, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5 }}>
                    <span style={{ width: 6, height: 6, borderRadius: 0, background: shown, display: 'inline-block' }} />{x.label}
                  </div>
                </div>
              );
            })}
          </div>

          {/* 신호 카드 목록 */}
          {latest.map((r, i) => {
            const color = cardColor(r);
            const isOpen = riskOpen.has(i);
            // 거시(D) 머리글은 자산군 단위로 통합 — 구성종목 나열은 '자세히'로 내림
            let headTitle = r.target, headRest = '';
            if (r.type === 'D') {
              const parts = r.target.split(/\s+[—–-]\s+/);
              if (parts.length > 1) { headTitle = parts[0].trim(); headRest = parts.slice(1).join(' — ').trim(); }
              else if (r.target.length > 40) { headTitle = r.target.slice(0, 40).trim() + '…'; headRest = r.target; }
            }
            return (
              <div key={i} style={{ background: '#FFFFFF', borderRadius: 0, padding: 14, marginBottom: 8, border: '1px solid #141414', borderLeft: `4px solid ${color}` }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', flex: 1, minWidth: 0 }}>
                    {/* 상태 점(이모지 대신 CSS 원 — 폰트 의존 없이 항상 정상 표시) */}
                    <span style={{ width: 9, height: 9, borderRadius: 0, background: color, flexShrink: 0, display: 'inline-block' }} />
                    <span style={{ fontSize: 12, fontWeight: 700, color: '#141414' }}>{headTitle}</span>
                    {/* 검증 항목(중립 회색) */}
                    <span style={{ fontSize: 8, color: '#6B675C', border: '1px solid #141414', borderRadius: 0, padding: '1px 5px' }}>{typeLabel(r.type)}</span>
                    {/* 결과 상태(색상) */}
                    <span style={{ fontSize: 8, color, background: `${color}22`, borderRadius: 0, padding: '1px 6px', fontWeight: 700 }}>{statusLabel(r.type, r.signal)}</span>
                  </div>
                  <span style={{ fontSize: 9, color: '#6B675C', flexShrink: 0 }}>{r.date}</span>
                </div>
                {/* 본문은 카드 전체 폭으로 — 날짜 아래까지 채워 자연스럽게 줄바꿈 */}
                <Sentences text={r.summary} sentenceOnly style={{ fontSize: 11, color: '#6B675C', lineHeight: 1.55, marginTop: 4 }} />
                {/* 신호→행동 원탭: B(논리)=포지션·매도검토, O(급락)=평가. D(거시)는 읽기형 — 링크 없음.
                    🟢(정상)은 조치 불필요라 버튼 생략. (스타일: TodayTab go 버튼과 동일) */}
                {setTab && sigLevel(r.signal) >= 2 && (r.type === 'B' || r.type === 'O') && (
                  <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                    {r.type === 'B' && (
                      <>
                        <button onClick={() => setTab('저널')} style={{ padding: '5px 12px', minHeight: 30, borderRadius: 0, border: `1px solid ${color}55`, background: 'transparent', color, cursor: 'pointer', fontSize: 10, fontWeight: 700 }}>
                          포지션 보기 ›
                        </button>
                        <button onClick={() => setTab('평가')} style={{ padding: '5px 12px', minHeight: 30, borderRadius: 0, border: '1px solid #141414', background: 'transparent', color: '#141414', cursor: 'pointer', fontSize: 10, fontWeight: 700 }}>
                          매도 검토 ›
                        </button>
                      </>
                    )}
                    {r.type === 'O' && (
                      <button onClick={() => setTab('평가')} style={{ padding: '5px 12px', minHeight: 30, borderRadius: 0, border: `1px solid ${color}55`, background: 'transparent', color, cursor: 'pointer', fontSize: 10, fontWeight: 700 }}>
                        평가 보기 ›
                      </button>
                    )}
                  </div>
                )}
                {(r.detail || r.evidence) && (
                  <button onClick={() => setRiskOpen(prev => { const n = new Set(prev); if (n.has(i)) n.delete(i); else n.add(i); return n; })}
                    style={{ marginTop: 8, padding: '4px 0', background: 'transparent', border: 'none', color: '#6B675C', cursor: 'pointer', fontSize: 9 }}>
                    {isOpen ? '접기 ▲' : '자세히 ▼'}
                  </button>
                )}
                {isOpen && (
                  <div style={{ marginTop: 6, paddingTop: 8, borderTop: '1px solid #EAE6DA' }}>
                    {headRest && <div style={{ fontSize: 9, color: '#6B675C', lineHeight: 1.5, marginBottom: 6, wordBreak: 'break-word' }}>구성: {headRest}</div>}
                    {r.detail && <Sentences text={r.detail} sentenceOnly style={{ fontSize: 10, color: '#6B675C', lineHeight: 1.6, wordBreak: 'break-word', marginBottom: 2 }} />}
                    {renderEvidence(r.evidence)}
                    {r.baselineRef && <div style={{ fontSize: 9, color: '#6B675C', marginTop: 8 }}>기준선: {r.baselineRef}</div>}
                  </div>
                )}
              </div>
            );
          })}
        </>
      )}


      {/* 펀더멘털 기준선 */}
      {baselines.length > 0 && (
        <div style={{ background: '#FFFFFF', borderRadius: 0, padding: 16, marginTop: 12 }}>
          <SectionTitle size={12} mb={14} sub="논리 훼손 비교 기준">펀더멘털 기준선</SectionTitle>
          <div style={{ display: 'flex', fontSize: 9, color: '#6B675C', padding: '0 0 6px', borderBottom: '1px solid #EAE6DA' }}>
            <span style={{ flex: 2, minWidth: 0 }}>종목</span>
            <span style={{ flex: 1, textAlign: 'right' }}>영익률</span>
            <span style={{ flex: 1, textAlign: 'right' }}>ROE</span>
            <span style={{ flex: 1, textAlign: 'right' }}>부채</span>
          </div>
          {baselines.map((b, i) => (
            <div key={i} style={{ display: 'flex', fontSize: 10, color: '#141414', padding: '7px 0', borderBottom: i < baselines.length - 1 ? '1px solid #141414' : 'none' }}>
              <span style={{ flex: 2, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{b.name}</span>
              {[b.operatingMargin, b.roe, b.debtRatio].map((v, k) => {
                const f = fmtPct(v);
                return <span key={k} style={{ flex: 1, textAlign: 'right', color: f === '데이터 부족' ? '#6B675C' : '#6B675C', fontSize: f === '데이터 부족' ? 9 : 10 }}>{f}</span>;
              })}
            </div>
          ))}
          <div style={{ fontSize: 9, color: '#6B675C', marginTop: 8 }}>기준일 {baselines[0]?.date || '—'} · 가격 등락이 아닌 실적 훼손만 리스크로 평가</div>
        </div>
      )}

      <div style={{ fontSize: 9, color: '#6B675C', textAlign: 'center', marginTop: 16 }}>
        {dateStr} 조회 · 펀더멘털·거시 기반 (가격 과열 단독은 신호 아님)
      </div>
    </div>
  );
}
