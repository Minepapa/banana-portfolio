// 오늘 탭: 매일 확인할 "오늘 할 일" 체크리스트. 홈(대시보드)이 숫자 확인용이라면,
// 이 탭은 행동 유도용 — 리스크·포지션·체결·리밸런싱·리포트에서 처리할 거리만 모은다.
// 대부분 항목은 데이터에서 자동 파생돼 처리하면 사라지고(auto), 읽기형(리스크·처방)만
// 당일 한정 수동 확인(localStorage banana_today_ack)으로 닫는다. 거래결정 탭을 대체.
import { useState } from 'react';
import { SectionTitle } from '../lib/primitives.jsx';
import { findThesisAlerts } from '../lib/thesisAlerts.js';
import { computeJobHealth } from '../lib/jobHealth.js';
import { JOB_CADENCE } from '../lib/constants.js';
import { PROFIT_POS, PROFIT_NEG, profitColor, SIGNAL_RED, SIGNAL_AMBER, SIGNAL_OPPORTUNITY } from '../lib/colors.js';
import { MONO } from '../lib/theme.js';

// KST 기준 오늘 날짜(YYYY-MM-DD). 마운트 시 1회만 평가해 렌더 순수성 유지.
function todayStr() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
}

export default function TodayTab({ riskMonitor, positionJournal, accounts, weeklyReports, execPending, jobStatus, preferences, movers = [], dailyBaseLabel, fmt, proposals = [], setTab, baseFont }) {
  const [day] = useState(todayStr);
  // 주말 여부는 마운트 시 고정된 day(KST 날짜)에서 파생 — 렌더 순수성 유지(Date.now 미사용).
  const isWeekend = (() => { const d = new Date(day).getUTCDay(); return d === 0 || d === 6; })();
  const [acked, setAcked] = useState(() => {
    try {
      const raw = JSON.parse(localStorage.getItem('banana_today_ack') || '{}');
      return raw.date === day ? new Set(raw.keys || []) : new Set();
    } catch { return new Set(); }
  });
  const ack = (key) => setAcked(prev => {
    const n = new Set(prev); n.add(key);
    localStorage.setItem('banana_today_ack', JSON.stringify({ date: day, keys: [...n] }));
    return n;
  });

  // 주말/월초 루틴 리마인더 — 당일 리셋(banana_today_ack)이 아니라 "그 주말·그 달 1회"만
  // 뜨도록 별도 저장(키가 바뀌면 자동 재등장, 지난 키는 안 지워도 무해).
  const [routineAcked, setRoutineAcked] = useState(() => {
    try { return new Set(JSON.parse(localStorage.getItem('banana_routine_ack') || '[]')); }
    catch { return new Set(); }
  });
  const ackRoutine = (key) => setRoutineAcked(prev => {
    const n = new Set(prev); n.add(key);
    localStorage.setItem('banana_routine_ack', JSON.stringify([...n]));
    return n;
  });

  // ── 1) 리스크 경보·주의 (RiskTab과 동일 dedup: 동일 유형+대상 최신 1건, 거시는 최신 날짜만) ──
  const latestDDate = (riskMonitor || []).reduce((mx, r) => (r.type === 'D' && r.date > mx ? r.date : mx), '');
  const seen = new Set();
  let riskRed = 0, riskAmber = 0;
  // 급락 매수 기회(O 🔴) — 리스크와 분리 집계. 종목당 최신 1건. 가격 상승은 매도 신호가 아니므로 매수만.
  const oppSeen = new Set();
  let oppBuy = 0;  // 🔴 급락 매수
  for (const r of (riskMonitor || [])) {
    if (r.type === 'O') {
      if (oppSeen.has(r.target)) continue;
      oppSeen.add(r.target);
      if (/🔴/.test(r.signal)) oppBuy++;
      continue;
    }
    if (r.type === 'D' && r.date !== latestDDate) continue;
    const k = `${r.type}|${r.target}`;
    if (seen.has(k)) continue;
    seen.add(k);
    if (/🔴/.test(r.signal)) riskRed++; else if (/🟡/.test(r.signal)) riskAmber++;
  }
  const riskActionable = riskRed + riskAmber;
  const oppActionable = oppBuy;
  const lastRiskDate = (riskMonitor || [])[0]?.date || '';

  // ── 2) 투자논리 훼손 / 3) 전제 확인 대기 / 4) 반성 필요 ──
  const thesisAlerts = findThesisAlerts(positionJournal, riskMonitor).length;
  const pendingConfirm = (positionJournal || []).filter(p => p.status !== '청산' && p.thesis && p.confirm !== '확인').length;
  const reflectNeeded = (positionJournal || []).filter(p => p.status === '청산' && !p.lesson).length;
  // ── 5) 성향 확인 대기 ──
  const prefPending = (preferences || []).filter(p => p.status === '관찰' || p.status === '승격후보').length;

  // ── 6) 리밸런싱 갭 ±5%p (거래결정 탭에서 이전) ──
  const rebalAlerts = Object.entries(accounts || {}).flatMap(([, a]) =>
    (a.assets || []).map(asset => {
      const curr = asset.ratio > 0 ? asset.ratio : (asset.sheetCurrent ?? 0);
      const diff = parseFloat((curr - asset.target).toFixed(1));
      return { acct: a.label, name: asset.name, diff, color: a.color };
    }).filter(x => Math.abs(x.diff) >= 5)
  );

  // ── 7) 이번 주 처방 (거래결정 탭 ③에서 이전: 최신 리포트의 '처방' 섹션 파싱) ──
  let rxAction = '', rxReason = '', rxDate = '';
  const rpt = (weeklyReports || [])[0];
  if (rpt) {
    const pSec = rpt.body.split(/^## /m).filter(Boolean).find(s => /처방/.test(s.split('\n')[0]));
    if (pSec) {
      const rest = pSec.split('\n').slice(1).join('\n').trim();
      const quote = rest.match(/^>\s*(.+)$/m);
      rxAction = quote ? quote[1].replace(/\*\*/g, '').replace(/^["“]\s*|\s*["”]$/g, '').trim() : '';
      let r2 = rest.replace(/^>.*$/m, '').trim();
      const sep = r2.indexOf('\n---'); if (sep >= 0) r2 = r2.slice(0, sep).trim();
      rxReason = r2.replace(/^근거\s*[:：]\s*/, '').replace(/\*\*/g, '').trim();
      rxDate = rpt.date;
    }
  }

  // ── 8) 무인 잡 문제 ──
  const jobProblems = jobStatus ? computeJobHealth(jobStatus, JOB_CADENCE) : [];

  // ── 0) 대기 주문서 (주문함 파이프라인 — 승인/기각하면 자동 소멸) ──
  const pendingOrders = (proposals || []).filter(p => p.status === '제안').length;
  const approvedOrders = (proposals || []).filter(p => p.status === '승인').length;

  // ── 항목 조립 ── kind:'read'=당일 확인으로 닫힘, 'auto'=처리하면 자동 소멸 ──
  const items = [];

  if (pendingOrders > 0 || approvedOrders > 0) {
    items.push({
      key: 'orders', kind: 'auto', accent: '#141414', icon: '📋',
      title: [pendingOrders > 0 ? `대기 주문서 ${pendingOrders}건` : '', approvedOrders > 0 ? `실행 대기 ${approvedOrders}건` : ''].filter(Boolean).join(' · '),
      sub: pendingOrders > 0 ? '완성된 주문서 — 승인 또는 기각' : '증권사 앱에서 입력하면 자동 완료',
      goLabel: '주문함 보기', go: () => setTab('주문'),
    });
  }
  if (!isWeekend && riskActionable > 0) {
    items.push({
      key: `risk:${lastRiskDate}`, kind: 'read', accent: riskRed > 0 ? SIGNAL_RED : SIGNAL_AMBER,
      icon: riskRed > 0 ? '🔴' : '🟡',
      title: `리스크 ${riskRed > 0 ? `경보 ${riskRed}건` : ''}${riskRed > 0 && riskAmber > 0 ? ' · ' : ''}${riskAmber > 0 ? `주의 ${riskAmber}건` : ''}`,
      sub: '펀더멘털·거시 신호 점검', goLabel: '리스크 보기', go: () => setTab('리스크'),
    });
  }
  if (!isWeekend && oppActionable > 0) {
    items.push({
      key: `opp:${lastRiskDate}`, kind: 'read', accent: SIGNAL_OPPORTUNITY,   // 리스크 탭 "기회" 칩과 동일한 카테고리색(경보와 구분)
      icon: '⚠️',
      title: `급락 알림 ${oppBuy}건`,
      sub: '§4 급락 트리거 발동 — 펀더멘털 확인 후 매수 검토', goLabel: '리스크 보기', go: () => setTab('리스크'),
    });
  }
  if (thesisAlerts > 0) {
    items.push({
      key: 'thesis', kind: 'auto', accent: '#E5484D', icon: '⚠️',
      title: `투자논리 훼손 ${thesisAlerts}종목`, sub: '이탈조건 대조 후 매도 검토',
      goLabel: '포지션 보기', go: () => setTab('저널'),
    });
  }
  if (execPending > 0) {
    items.push({
      key: 'exec', kind: 'auto', accent: '#E0A000', icon: '📥',
      title: `미처리 체결 ${execPending}건`, sub: '동기화하면 보유종목에 반영',
      goLabel: '체결 동기화', go: () => setTab('체결내역'),
    });
  }
  if (pendingConfirm > 0) {
    items.push({
      key: 'confirm', kind: 'auto', accent: '#159E52', icon: '⏳',
      title: `투자논리 확인 대기 ${pendingConfirm}건`, sub: '매수 전제에 동의 표시',
      goLabel: '포지션 보기', go: () => setTab('저널'),
    });
  }
  if (reflectNeeded > 0) {
    items.push({
      key: 'reflect', kind: 'auto', accent: '#A8D672', icon: '📝',
      title: `반성 필요 ${reflectNeeded}건`, sub: '청산 종목 교훈 기록',
      goLabel: '포지션 보기', go: () => setTab('저널'),
    });
  }
  if (rebalAlerts.length > 0) {
    items.push({
      key: 'rebal', kind: 'auto', accent: '#141414', icon: '⚖️',
      title: `리밸런싱 갭 ${rebalAlerts.length}건`, sub: '목표 비중 ±5%p 초과',
      goLabel: '자산분배 보기', go: () => setTab('rebalance'),
      body: (
        <div style={{ marginTop: 8 }}>
          {rebalAlerts.map((a, i) => (
            <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '4px 8px', borderRadius: 0, marginBottom: 3, background: '#FFFFFF', borderLeft: `3px solid ${a.diff > 0 ? PROFIT_POS : PROFIT_NEG}` }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <div style={{ width: 6, height: 6, borderRadius: 0, background: a.color, flexShrink: 0 }} />
                <span style={{ fontSize: 11, color: '#141414' }}>{a.name}</span>
                <span style={{ fontSize: 9, color: a.color }}>{a.acct}</span>
              </div>
              <span style={{ fontSize: 11, fontWeight: 700, color: a.diff > 0 ? PROFIT_POS : PROFIT_NEG }}>{a.diff > 0 ? '+' : ''}{a.diff}%p</span>
            </div>
          ))}
        </div>
      ),
    });
  }
  if (rxAction) {
    items.push({
      key: `rx:${rxDate}`, kind: 'read', accent: '#E0A000', icon: '💊',
      title: '이번 주 처방', sub: `${rxDate} 리포트`, goLabel: '리포트 보기', go: () => setTab('report'),
      body: (
        <div style={{ marginTop: 8, background: '#FFFFFF', border: '2px solid #141414', borderLeft: '5px solid #E0A000', borderRadius: 0, padding: 12 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: '#141414', lineHeight: 1.5, marginBottom: rxReason ? 8 : 0 }}>{rxAction}</div>
          {rxReason && <div style={{ fontSize: 10, color: '#6B675C', lineHeight: 1.6, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{rxReason}</div>}
        </div>
      ),
    });
  }
  if (jobProblems.length > 0) {
    const anyFail = jobProblems.some(p => p.problem === 'fail' || p.problem === 'missing');
    items.push({
      key: 'jobs', kind: 'auto', accent: anyFail ? '#E5484D' : '#E0A000', icon: '🔧',
      title: `무인 잡 점검 ${jobProblems.length}건`, sub: jobProblems.map(p => `${p.job}(${p.problem === 'fail' ? (p.failStreak >= 2 ? `연속 ${p.failStreak}회 실패` : '실패') : p.problem === 'missing' ? '미실행' : '정체'})`).join(' · '),
      goLabel: '잡 상태 보기', go: () => setTab('kpi'),
    });
  }
  if (prefPending > 0) {
    items.push({
      key: 'pref', kind: 'read', accent: '#E0A000', icon: '💬',
      title: `성향 확인 필요 ${prefPending}건`,
      sub: '행동에서 관찰된 내 투자 성향 — 확정 또는 기각',
      goLabel: '성향 보기', go: () => setTab('성향'),
    });
  }

  // ── 9) 주말 정리(15분) / 월초 회고(10분) — profile/app-usage-playbook.md §2-4 루틴 ──
  if (isWeekend) {
    const d = new Date(day);
    const satOffset = d.getUTCDay() === 0 ? 1 : 0;   // 일요일이면 하루 빼 토요일 날짜로 맞춤
    const weekendKey = new Date(d.getTime() - satOffset * 86400000).toISOString().slice(0, 10);
    items.push({
      key: `weekly:${weekendKey}`, kind: 'routine', accent: '#52C8D4', icon: '🗓️',
      title: '주간 정리 15분', sub: '리포트 처방 → 자산분배 갭 → 포지션 전제·교훈 소진',
      goLabel: '리포트 보기', go: () => setTab('report'),
    });
  }
  const domNum = parseInt(day.slice(8, 10), 10);
  if (domNum >= 1 && domNum <= 5) {
    items.push({
      key: `monthly:${day.slice(0, 7)}`, kind: 'routine', accent: '#8B5CF6', icon: '📊',
      title: '월간 회고 10분', sub: 'KPI 행동추적(500만 원칙·평가→매수 일치율) 먼저, 성과는 다음',
      goLabel: 'KPI 보기', go: () => setTab('kpi'),
    });
  }

  const doneOf = (it) => (it.kind === 'routine' ? routineAcked : acked).has(it.key);
  const allDone = items.length > 0 && items.every(doneOf);

  return (
    <div>
      <SectionTitle mb={14} sub={`${day} · 오늘 처리할 것만 모음`}>오늘 할 일</SectionTitle>

      {allDone && (
        <div style={{ background: '#C9F23E', border: '2px solid #141414', boxShadow: '4px 4px 0 #141414', borderRadius: 0, padding: '16px 20px', marginBottom: 14, textAlign: 'center' }}>
          <div style={{ fontSize: 24, marginBottom: 6 }}>✅</div>
          <div style={{ fontSize: 13, fontWeight: 800, color: '#141414' }}>오늘 할 일 모두 완료!</div>
          <div style={{ fontSize: 10, color: '#141414', marginTop: 4 }}>수고하셨습니다. 내일 다시 확인해주세요.</div>
        </div>
      )}

      {items.length === 0 ? (
        <div style={{ background: '#FFFFFF', borderRadius: 0, padding: 32, textAlign: 'center', border: '1px solid #141414' }}>
          <div style={{ fontSize: 32, marginBottom: 10 }}>✅</div>
          <div style={{ fontSize: 13, fontWeight: 700, color: '#141414', marginBottom: 4 }}>오늘 할 일 없음</div>
          <div style={{ fontSize: 11, color: '#6B675C', lineHeight: 1.6 }}>리스크·포지션·체결·리밸런싱 모두 정상.<br />홈에서 숫자만 확인하면 됩니다.</div>
        </div>
      ) : (
        items.map((it) => {
          const done = doneOf(it);
          return (
            <div key={it.key} style={{ background: done ? '#FFFFFF' : `${it.accent}10`, border: `1px solid ${done ? '#141414' : it.accent + '38'}`, borderLeft: `4px solid ${done ? '#159E5266' : it.accent}`, borderRadius: 0, padding: 14, marginBottom: 10, opacity: done ? 0.55 : 1, transition: 'opacity 0.2s' }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                <span style={{ fontSize: 16, lineHeight: 1.3, flexShrink: 0 }}>{done ? '✅' : it.icon}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: done ? '#6B675C' : '#141414', textDecoration: done ? 'line-through' : 'none' }}>{it.title}</div>
                  {it.sub && <div style={{ fontSize: 10, color: '#6B675C', marginTop: 2, lineHeight: 1.5, wordBreak: 'break-word' }}>{it.sub}</div>}
                </div>
                {done && <span style={{ fontSize: 10, color: '#159E52', flexShrink: 0, fontWeight: 700 }}>완료</span>}
              </div>
              {!done && it.body}
              <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                {!done && (
                  <button onClick={it.go} style={{ padding: '6px 12px', minHeight: 32, borderRadius: 0, border: `1px solid ${it.accent}55`, background: 'transparent', color: it.accent, cursor: 'pointer', fontSize: 11, fontWeight: 700, fontFamily: baseFont }}>
                    {it.goLabel} ›
                  </button>
                )}
                <button onClick={() => done ? null : (it.kind === 'routine' ? ackRoutine(it.key) : ack(it.key))} style={{ padding: '6px 12px', minHeight: 32, borderRadius: 0, border: `1px solid ${done ? '#141414' : '#141414'}`, background: done ? '#DDF3E4' : 'none', color: done ? '#159E52' : '#6B675C', cursor: done ? 'default' : 'pointer', fontSize: 11, fontFamily: baseFont }}>
                  {done ? '✓ 확인됨' : '확인 ✓'}
                </button>
              </div>
            </div>
          );
        })
      )}

      <div style={{ fontSize: 9, color: '#6B675C', textAlign: 'center', marginTop: 16, lineHeight: 1.6 }}>
        처리하면 자동으로 사라집니다 · 확인 표시는 오늘 하루만 유지됩니다
      </div>

      {/* 오늘의 변동 종목 — 일별스냅샷(매일 08:00 KST) 기준 등락률(%) 상위. 금액이 아니라
          변동성(가격이 얼마나 흔들렸나)을 보기 위한 목록이라 원화가 아닌 %로 정렬한다. */}
      {movers.length > 0 && (
        <div style={{ background: '#FFFFFF', border: '1px solid #141414', borderRadius: 0, padding: '14px 16px', marginTop: 20 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 10 }}>
            <div style={{ fontSize: 10, letterSpacing: 2, color: '#6B675C' }}>오늘의 변동 종목 (등락률순)</div>
            {dailyBaseLabel && <div style={{ fontSize: 9, color: '#6B675C' }}>{dailyBaseLabel} 기준</div>}
          </div>
          {movers.map((m, i) => {
            const color = profitColor(m.pct);
            const acctColor = accounts?.[m.account]?.color || '#aaa';
            const acctLabel = accounts?.[m.account]?.label || m.account;
            return (
              <div key={`${m.account}-${m.name}-${i}`} style={{
                display: 'flex', alignItems: 'center', gap: 8,
                padding: '8px 0', borderBottom: i < movers.length - 1 ? '1px solid #EAE6DA' : 'none',
              }}>
                <div style={{ fontSize: 9, background: acctColor + '33', color: acctColor, padding: '2px 5px', flexShrink: 0, whiteSpace: 'nowrap' }}>
                  {acctLabel}
                </div>
                <div style={{ flex: 1, minWidth: 0, fontSize: 12, fontWeight: 700, color: '#141414', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {m.name}
                  {m.traded && <span style={{ fontSize: 9, fontWeight: 400, color: '#6B675C', marginLeft: 4 }}>거래</span>}
                </div>
                <div style={{ textAlign: 'right', flexShrink: 0 }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color }}>
                    {m.pct >= 0 ? '+' : ''}{(m.pct * 100).toFixed(2)}%
                  </div>
                  <div style={{ fontSize: 10, color, fontFamily: MONO }}>
                    {m.wonDelta > 0 ? '▲ ' : m.wonDelta < 0 ? '▼ ' : ''}₩{fmt(Math.abs(m.wonDelta))}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
