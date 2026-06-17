// 무인 잡 헬스 배너 — computeJobHealth 결과 중 문제 잡(실패/미실행/정체)만 상단에 경고.
// App.jsx에서 분리 (동작 불변). 문제 없으면 아무것도 렌더하지 않음.
import { computeJobHealth } from '../lib/jobHealth.js';
import { JOB_CADENCE } from '../lib/constants.js';

export default function JobHealthBanner({ jobStatus }) {
  if (!jobStatus) return null;
  const problems = computeJobHealth(jobStatus, JOB_CADENCE);
  if (problems.length === 0) return null;
  const anyFail = problems.some(p => p.problem === 'fail' || p.problem === 'missing');
  return (
    <div style={{
      margin: '8px 12px', padding: '8px 12px', borderRadius: 8,
      background: anyFail ? '#2A1416' : '#241F12',
      border: `1px solid ${anyFail ? '#7F1D1D' : '#78510F'}`,
      fontSize: 11, color: anyFail ? '#FCA5A5' : '#FCD34D', textAlign: 'left',
    }}>
      <div style={{ fontWeight: 700, marginBottom: 2 }}>
        ⚠️ 무인 잡 점검 필요 {problems.length}건
      </div>
      {problems.map((p, i) => (
        <div key={i} style={{ fontSize: 10, opacity: 0.9 }}>
          {p.job} — {p.problem === 'fail' ? '실패' : p.problem === 'missing' ? '미실행(기록 없음)' : '갱신 정체'}{p.detail ? ` (${p.detail.slice(0, 60)})` : ''}
        </div>
      ))}
    </div>
  );
}
