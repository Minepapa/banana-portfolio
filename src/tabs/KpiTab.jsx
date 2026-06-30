// KPI 탭: 무인 잡 상태 + 행동 추적 + 운용 성과(TWR/Sharpe/MDD) + 투자 기준. App.jsx에서 추출.
import { computeKPI, computeBehaviorMetrics } from '../lib/metrics.js';
import { JOB_CADENCE } from '../lib/constants.js';
import { relTime } from '../lib/textFormat.js';
import { computeJobHealth } from '../lib/jobHealth.js';

// 잡상태 시트(heartbeat) 표시용 — 잡 키 → 한글 라벨, 표시 순서 고정
const JOB_LABELS = {
  'parse-notifications': '체결 알림 파싱',
  'drain': '평가 큐 처리',
  'risk-d': '리스크 D (거시)',
  'risk-b': '리스크 B (논리)',
  'weekly-report': '주간 리포트 발행',
  'report-sync': '리포트 적재(보충)',
  'journal-sync': '포지션 저널',
  'backup': '시트 백업',
  'baseline': '펀더멘털 기준선',
};
// 각 잡의 무인 실행 주기(launchd plist 기준) — 표에 배지로 노출
const JOB_INTERVALS = {
  'parse-notifications': '평일 08–16:30 · 15분',
  'drain': '1·4·9·12·14·19·22시',
  'journal-sync': '매일 16:00',
  'risk-d': '평일 16:30',
  'risk-b': '주간 월 03:00',
  'weekly-report': '일요일 03:00',
  'report-sync': '매일 09:00',
  'backup': '매일 05:00',
  'baseline': '분기 4회',
};
const JOB_ORDER = ['parse-notifications', 'drain', 'journal-sync', 'risk-d', 'risk-b', 'weekly-report', 'report-sync', 'backup', 'baseline'];

function JobStatusPanel({ jobStatus }) {
  if (!jobStatus) return null;
  const byJob = new Map(jobStatus.map(j => [j.job, j]));
  // 시간 의존 판정(fail/stale/missing)은 순수 lib 함수에 위임 — render 내 Date.now() 직접 호출 회피(React Compiler purity)
  const problemByJob = new Map(computeJobHealth(jobStatus, JOB_CADENCE).map(p => [p.job, p.problem]));
  // missing(heartbeat 행 자체가 없는 필수 잡)도 행으로 노출 — byJob엔 없지만 problemByJob엔 있다
  const ordered = [
    ...JOB_ORDER.filter(k => byJob.has(k) || problemByJob.has(k)),
    ...jobStatus.map(j => j.job).filter(k => !JOB_ORDER.includes(k)),
  ];
  if (ordered.length === 0) return null;
  return (
    <div style={{ background: '#1A1D26', borderRadius: 12, padding: 16, marginBottom: 16 }}>
      <div style={{ fontSize: 10, letterSpacing: 3, color: '#8A9AB5', marginBottom: 4 }}>무인 잡 상태</div>
      <div style={{ fontSize: 10, color: '#5A6478', marginBottom: 12 }}>최근 실행 시간(마지막 점검/실행 시간, 실제 발행/적재 시간 아님)</div>
      {ordered.map((key, i, arr) => {
        const j = byJob.get(key);
        const problem = problemByJob.get(key);
        const color = (problem === 'fail' || problem === 'missing') ? '#EF4444' : problem === 'stale' ? '#F59E0B' : '#10B981';
        const icon = (problem === 'fail' || problem === 'missing') ? '🔴' : problem === 'stale' ? '⚠️' : '✅';
        const tsMs = j ? Date.parse(j.lastRun) : NaN;
        const when = problem === 'missing' ? '기록 없음' : isFinite(tsMs) ? relTime(new Date(tsMs)) : (j?.lastRun || '–');
        return (
          <div key={key} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', borderBottom: i < arr.length - 1 ? '1px solid #1E2233' : 'none' }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
              <span style={{ fontSize: 12, color: '#9CA3AF' }}>{JOB_LABELS[key] || key}</span>
              {JOB_INTERVALS[key] && <span style={{ fontSize: 9, color: '#5A6478', border: '1px solid #2A2F3E', borderRadius: 3, padding: '1px 5px', whiteSpace: 'nowrap' }}>{JOB_INTERVALS[key]}</span>}
            </span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              {j?.durationSec && <span style={{ fontSize: 9, color: '#3A4050' }}>{j.durationSec}s</span>}
              <span style={{ fontSize: 12, color: '#8A9AB5' }}>{when}</span>
              <span style={{ fontSize: 11, fontWeight: 700, color }}>{icon}</span>
            </span>
          </div>
        );
      })}
    </div>
  );
}

export default function KpiTab({ monthlyData, kpiTrades, evaluations, isMobile, evalSelectedMetric, setEvalSelectedMetric, jobStatus }) {
  const kpi = computeKPI(monthlyData);
  if (!kpi) return (
    <div>
      <JobStatusPanel jobStatus={jobStatus} />
      <div style={{ padding: 40, textAlign: 'center', color: '#8A9AB5', fontSize: 13 }}>
        월별잔고 데이터가 2개월 이상 있어야 KPI를 계산할 수 있습니다.
      </div>
    </div>
  );

  const twrPct    = (kpi.twr    * 100).toFixed(1);
  const twrCumPct = (kpi.twrCum * 100).toFixed(1);
  const mddPct    = (kpi.mdd    * 100).toFixed(1);
  const sharpeV   = kpi.sharpe !== null ? kpi.sharpe.toFixed(2) : '–';
  const bmPct     = kpi.benchmarkTWR !== null ? (kpi.benchmarkTWR * 100).toFixed(1) : null;
  const alphaPct  = bmPct !== null ? ((kpi.twr - kpi.benchmarkTWR) * 100).toFixed(1) : null;

  const twrStatus = alphaPct !== null
    ? (parseFloat(alphaPct) >= 3  ? { icon: '✅', color: '#10B981', label: `알파 +${alphaPct}%p` }
     : parseFloat(alphaPct) >= 0  ? { icon: '⚠️', color: '#F59E0B', label: `알파 +${alphaPct}%p` }
     :                              { icon: '🔴', color: '#EF4444', label: `알파 ${alphaPct}%p` })
    : kpi.twr >= 0 ? { icon: '✅', color: '#10B981', label: '양호' }
    :                { icon: '🔴', color: '#EF4444', label: '손실' };
  const sharpeStatus = kpi.sharpe === null ? { icon: '–', color: '#6B7280', label: '데이터 부족' }
    : kpi.sharpe >= 0.8 ? { icon: '✅', color: '#10B981', label: '양호' }
    : kpi.sharpe >= 0.5 ? { icon: '⚠️', color: '#F59E0B', label: '주의' }
    : { icon: '🔴', color: '#EF4444', label: '미달' };
  const mddStatus = kpi.mdd >= -0.25 ? { icon: '✅', color: '#10B981', label: '이내' }
    : kpi.mdd >= -0.35 ? { icon: '⚠️', color: '#F59E0B', label: '주의' }
    : { icon: '🔴', color: '#EF4444', label: '초과' };

  const cards = [
    { label: 'TWR (연환산)', value: `${kpi.twr >= 0 ? '+' : ''}${twrPct}%`, sub: bmPct !== null ? `시장 ${parseFloat(bmPct) >= 0 ? '+' : ''}${bmPct}% · ${kpi.months}M` : `누적 ${kpi.twrCum >= 0 ? '+' : ''}${twrCumPct}% · ${kpi.months}M`, status: twrStatus, metric: 'twr' },
    { label: 'Sharpe',       value: sharpeV,                                  sub: '목표 0.8~1.2',              status: sharpeStatus, metric: 'sharpe' },
    { label: 'MDD',          value: `${mddPct}%`,                             sub: '목표 −25% 이내',             status: mddStatus,    metric: 'mdd' },
  ];

  return (
    <div>
      <JobStatusPanel jobStatus={jobStatus} />
      {/* 행동 추적 */}
      {(() => {
        const bm = computeBehaviorMetrics(kpiTrades, evaluations);
        if (kpiTrades === null) return (
          <div style={{ background: '#1A1D26', borderRadius: 12, padding: 16, marginBottom: 16, textAlign: 'center', color: '#8A9AB5', fontSize: 11 }}>행동 추적 데이터 불러오는 중...</div>
        );
        if (!bm) return (
          <div style={{ background: '#1A1D26', borderRadius: 12, padding: 16, marginBottom: 16, textAlign: 'center', color: '#8A9AB5', fontSize: 11 }}>체결 내역 없음 — 체결 탭에서 먼저 동기화하세요</div>
        );
        const r500Color = bm.rule500Rate === null ? '#8A9AB5' : bm.rule500Rate >= 80 ? '#10B981' : bm.rule500Rate >= 60 ? '#F59E0B' : '#EF4444';
        const emColor   = bm.evalMatchRate === null ? '#8A9AB5' : bm.evalMatchRate >= 60 ? '#10B981' : bm.evalMatchRate >= 30 ? '#F59E0B' : '#EF4444';
        const sdColor   = bm.sellDisciplineRate === null ? '#8A9AB5' : bm.sellDisciplineRate >= 60 ? '#10B981' : bm.sellDisciplineRate >= 30 ? '#F59E0B' : '#EF4444';
        const freqColor = bm.freqRatio === null ? '#8A9AB5' : bm.freqRatio <= 1.0 ? '#10B981' : bm.freqRatio <= 1.5 ? '#F59E0B' : '#EF4444';
        return (
          <div style={{ background: '#1A1D26', borderRadius: 12, padding: 16, marginBottom: 16 }}>
            <div style={{ fontSize: 10, letterSpacing: 3, color: '#8A9AB5', marginBottom: 14 }}>행동 추적</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginBottom: 14 }}>
              {[
                { label: '500만 원칙', value: bm.rule500Rate !== null ? `${bm.rule500Rate}%` : '–', sub: `${bm.rule500OK}/${bm.rule500Total}건`, color: r500Color },
                { label: '평가→매수', value: bm.evalMatchRate !== null ? `${bm.evalMatchRate}%` : '–', sub: `${bm.evalMatchCount}/${bm.evalEligible}건`, color: emColor },
                { label: '매도 규율', value: bm.sellDisciplineRate !== null ? `${bm.sellDisciplineRate}%` : '–', sub: `점검 ${bm.sellDisciplineOK}/${bm.sellDisciplineTotal}건`, color: sdColor },
                { label: '거래빈도', value: bm.freqRatio !== null ? `${bm.freqRatio.toFixed(1)}×` : '–', sub: bm.freqAvg30 !== null ? `평소 ${Math.round(bm.freqAvg30)}건/월` : '기간 부족', color: freqColor },
                { label: '최근 30일', value: `${bm.recent30Count}건`, sub: `매수 ${bm.recent30Buys}건`, color: '#E8EAF0' },
              ].map((card, i) => (
                <div key={i} style={{ background: '#0F1117', borderRadius: 10, padding: '12px 10px', textAlign: 'center' }}>
                  <div style={{ fontSize: 9, color: '#8A9AB5', marginBottom: 4 }}>{card.label}</div>
                  <div style={{ fontSize: 18, fontWeight: 700, color: card.color }}>{card.value}</div>
                  <div style={{ fontSize: 9, color: '#8A9AB5', marginTop: 2 }}>{card.sub}</div>
                </div>
              ))}
            </div>
            {bm.unlinkedBuys > 0 && (
              <div style={{ fontSize: 9, color: '#8A9AB5', marginTop: 6 }}>
                평가에 연결 안 된 매수 {bm.unlinkedBuys}건 — 종목명 표기 차이 또는 평가 누락 점검
              </div>
            )}
            {bm.missedEvals.length > 0 && (
              <div>
                <div style={{ fontSize: 9, color: '#F59E0B', letterSpacing: 1, marginBottom: 8 }}>🟢 평가 후 {bm.matchWindowDays}일 내 미매수 {bm.missedEvals.length}건 — 검토 필요</div>
                {bm.missedEvals.slice(0, 5).map((ev, i, arr) => (
                  <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '5px 0', borderBottom: i < arr.length - 1 ? '1px solid #1E2233' : 'none', fontSize: 11 }}>
                    <span style={{ color: '#E8EAF0' }}>{ev.stock?.name}</span>
                    <span style={{ color: '#8A9AB5' }}>{ev.date}</span>
                  </div>
                ))}
                {bm.missedEvals.length > 5 && <div style={{ fontSize: 10, color: '#8A9AB5', textAlign: 'center', paddingTop: 6 }}>+{bm.missedEvals.length - 5}건 더</div>}
              </div>
            )}
          </div>
        );
      })()}
      <div style={{ background: '#1A1D26', borderRadius: 12, padding: 16, marginBottom: 12 }}>
        <div style={{ fontSize: 10, letterSpacing: 3, color: '#8A9AB5', marginBottom: 12 }}>운용 성과</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
          {cards.map(c => (
            <button key={c.label}
              onClick={() => setEvalSelectedMetric(prev => prev === c.metric ? null : c.metric)}
              style={{
                background: evalSelectedMetric === c.metric ? '#1E3A5F' : '#0F1117',
                borderRadius: 10, padding: '14px 8px', textAlign: 'center',
                border: `1px solid ${evalSelectedMetric === c.metric ? '#3B82F6' : c.status.color + '33'}`,
                cursor: 'pointer', fontFamily: 'inherit', width: '100%', display: 'block',
              }}>
              <div style={{ fontSize: 8, color: '#8A9AB5', marginBottom: 6, letterSpacing: 1 }}>
                {c.label} <span style={{ color: '#3B82F6' }}>📘</span>
              </div>
              <div style={{ fontSize: isMobile ? 15 : 17, fontWeight: 700, color: c.status.color, marginBottom: 4 }}>
                {c.value}
              </div>
              <div style={{ fontSize: 9, color: c.status.color, marginBottom: 4 }}>
                {c.status.icon} {c.status.label}
              </div>
              <div style={{ fontSize: 8, color: '#3A4050', lineHeight: 1.3 }}>{c.sub}</div>
            </button>
          ))}
        </div>
      </div>

      {/* 상세 지표 */}
      <div style={{ background: '#1A1D26', borderRadius: 12, padding: 16 }}>
        <div style={{ fontSize: 10, letterSpacing: 3, color: '#8A9AB5', marginBottom: 12 }}>지표 상세</div>
        {[
          { label: 'TWR 연환산', value: `${kpi.twr >= 0 ? '+' : ''}${twrPct}%`, color: twrStatus.color },
          { label: 'TWR 누적',   value: `${kpi.twrCum >= 0 ? '+' : ''}${twrCumPct}%`, color: kpi.twrCum >= 0 ? '#10B981' : '#EF4444' },
          ...(alphaPct !== null ? [{ label: '시장 대비 알파', value: `${parseFloat(alphaPct) >= 0 ? '+' : ''}${alphaPct}%p`, color: twrStatus.color }] : []),
          { label: 'Sharpe',     value: sharpeV,             color: sharpeStatus.color },
          { label: 'MDD',        value: `${mddPct}%`,        color: mddStatus.color },
          { label: '산출 기간',  value: `${kpi.months}개월`, color: '#9CA3AF' },
        ].map((row, i, arr) => (
          <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', borderBottom: i < arr.length - 1 ? '1px solid #1E2233' : 'none' }}>
            <span style={{ fontSize: 12, color: '#9CA3AF' }}>{row.label}</span>
            <span style={{ fontSize: 13, fontWeight: 700, color: row.color }}>{row.value}</span>
          </div>
        ))}
      </div>

      {/* 내 투자 기준 */}
      <div style={{ background: '#1A1D26', borderRadius: 12, padding: 16, marginTop: 12 }}>
        <div style={{ fontSize: 10, letterSpacing: 3, color: '#8A9AB5', marginBottom: 14 }}>내 투자 기준</div>
        {[
          { cat: '포트폴리오 성과', items: [
            { label: 'TWR 목표',    value: '시장 대비 +3~5%p' },
            { label: 'Sharpe 목표', value: '0.8~1.2 (1년)' },
            { label: 'MDD 한도',    value: '1년 −25% · 3년 −35%' },
            { label: 'MDD 회복',    value: '12개월 이내' },
          ]},
          { cat: '종목 매수 기준', items: [
            { label: '매출성장률',  value: '10%+ 3년 유지' },
            { label: 'ROIC',        value: '15%+ 5년 평균' },
            { label: 'RSI',         value: '30↓ 매수 · 70↑ 차익실현' },
            { label: '52주 위치',   value: '하단 20% 적극매수' },
            { label: '외국인수급',  value: '4일 연속 순매도 → 보류' },
          ]},
          { cat: '배당 기준', items: [
            { label: '배당성향',     value: '40~60%' },
            { label: 'FCF 커버리지', value: '80% 미만' },
          ]},
        ].map((section, si, all) => (
          <div key={si} style={{ marginBottom: si < all.length - 1 ? 16 : 0 }}>
            <div style={{ fontSize: 9, color: '#3B82F6', letterSpacing: 1, marginBottom: 6 }}>{section.cat}</div>
            {section.items.map((item, ii, arr) => (
              <div key={ii} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 0', borderBottom: ii < arr.length - 1 ? '1px solid #1E2233' : 'none' }}>
                <span style={{ fontSize: 12, color: '#9CA3AF' }}>{item.label}</span>
                <span style={{ fontSize: 12, fontWeight: 600, color: '#E8EAF0' }}>{item.value}</span>
              </div>
            ))}
          </div>
        ))}
      </div>

    </div>
  );
}
