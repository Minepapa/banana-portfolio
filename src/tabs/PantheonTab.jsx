// 판테온 현황판 — 대표 Zeus + 4부서(Athena·Themis·Hermes·Apollo)의 "지금 상황"을 한눈에.
// App.jsx에서 이미 가진 state를 props로만 받는 순수 프레젠테이션(새 fetch 없음, TodayTab.jsx와
// 동일한 배선 패턴). computeRiskCounts/pendingPreferences/nextReportDday는 원본 탭(RiskTab/
// PreferenceTab)과 동일 함수를 재사용해 숫자가 절대 어긋나지 않는다.
import { SectionTitle, DeptBadge } from '../lib/primitives.jsx';
import { DEPARTMENTS } from '../lib/colors.js';
import { computeRiskCounts } from '../lib/riskCounts.js';
import { pendingPreferences } from '../lib/preferencesPending.js';
import { nextReportDday } from '../lib/reportSchedule.js';
import { computeJobHealth } from '../lib/jobHealth.js';
import { JOB_CADENCE } from '../lib/constants.js';

const cardStyle = {
  background: '#FFFFFF', border: '2px solid #141414', boxShadow: '4px 4px 0 #141414',
  borderRadius: 0, padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 8,
};
const goBtnStyle = {
  alignSelf: 'flex-start', marginTop: 4, padding: '4px 10px', fontSize: 10, fontWeight: 700,
  border: '1px solid #141414', borderRadius: 0, background: '#F4F1E9', color: '#141414', cursor: 'pointer',
};

function DeptCard({ dept, statusText, onGo }) {
  const d = DEPARTMENTS[dept];
  return (
    <div style={cardStyle}>
      <DeptBadge dept={dept} size="md" />
      <div style={{ fontSize: 12, color: '#141414', lineHeight: 1.6 }}>{statusText}</div>
      {onGo && <button style={goBtnStyle} onClick={onGo}>{d.name} 바로가기 →</button>}
    </div>
  );
}

export default function PantheonTab({ evalQueue, riskMonitor, jobStatus, preferences, weeklyReports, setTab }) {
  const evalCounts = evalQueue?.counts || { pending: 0, processing: 0, done: 0, error: 0 };
  const { counts: riskCounts } = computeRiskCounts(riskMonitor);
  // jobStatus는 로그인 전 명시적으로 null("미로딩") — 0건 문제로 오판(허위 "정상")하지 않게 분리.
  const jobLoading = jobStatus === null;
  const jobProblems = jobLoading ? [] : computeJobHealth(jobStatus, JOB_CADENCE);
  const prefPendingCount = pendingPreferences(preferences).length;
  const { days: reportDday, lastDate: reportLastDate } = nextReportDday(weeklyReports);

  // Zeus 요약 — 우선순위: 리스크 경보 > 잡 실패/누락 > 평가 오류 > 대기건 합산 > 전부 정상.
  const zeusVerdict = (() => {
    if (riskCounts.red > 0) return `🔴 리스크 경보 ${riskCounts.red}건 — 리스크관리실 확인 필요`;
    if (!jobLoading && jobProblems.length > 0) return `⚠️ 무인 잡 ${jobProblems.length}건 점검 필요 — 운영실 확인 필요`;
    if (evalCounts.error > 0) return `⚠️ 평가 오류 ${evalCounts.error}건 — 투자전략실 확인 필요`;
    const totalPending = evalCounts.pending + riskCounts.amber + prefPendingCount;
    if (totalPending > 0) return `대기 중 ${totalPending}건 — 각 부서가 처리 중`;
    // jobLoading이면 "정상"을 단언할 수 없다(리뷰 지적) — Hermes 카드가 "점검 중..."을 보여주는데
    // Zeus 스트립만 "모두 정상"이라 하면 같은 화면 안에서 자기모순이 된다.
    return jobLoading ? '운영실 점검 중 — 나머지 3개 부서 정상' : '4개 부서 모두 정상 가동';
  })();

  return (
    <div>
      <SectionTitle sub="대표 Zeus + 4개 부서가 지금 무엇을 하고 있는지">판테온</SectionTitle>

      <div style={{ ...cardStyle, background: `${DEPARTMENTS.zeus.color}22`, marginBottom: 16 }}>
        <DeptBadge dept="zeus" size="md" />
        <div style={{ fontSize: 13, fontWeight: 700, color: '#141414' }}>{zeusVerdict}</div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <DeptCard dept="athena"
          statusText={evalCounts.pending > 0
            ? `평가 대기 ${evalCounts.pending}건${evalCounts.error > 0 ? ` · 오류 ${evalCounts.error}건` : ''}`
            : '평가 큐 비어있음'}
          onGo={() => setTab('평가')} />
        <DeptCard dept="themis"
          statusText={(riskCounts.red + riskCounts.amber) > 0
            ? `감시중 리스크 ${riskCounts.red + riskCounts.amber}건(경보${riskCounts.red}·주의${riskCounts.amber})`
            : '이상 없음 — 관측 계속'}
          onGo={() => setTab('리스크')} />
        <DeptCard dept="hermes"
          statusText={jobLoading ? '점검 중...' : (jobProblems.length > 0 ? `무인 잡 ${jobProblems.length}건 점검 필요` : '전 잡 정상 가동')}
          onGo={() => setTab('kpi')} />
        <DeptCard dept="apollo"
          statusText={`다음 리포트 D-${reportDday}${reportLastDate ? ` · 최근 발행 ${reportLastDate}` : ''} · 성향확인 ${prefPendingCount}건`}
          onGo={() => setTab('성향')} />
      </div>
    </div>
  );
}
