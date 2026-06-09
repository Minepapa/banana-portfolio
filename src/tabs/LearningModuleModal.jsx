// 학습 모듈 슬라이드 패널: 지표 클릭 시 하단에서 떠오르는 설명 카드. App.jsx에서 추출 (동작 불변).
// 순수 표시 — evalSelectedMetric 키로 LEARNING_MODULES 항목을 보여주고 닫기만 처리.
import { LEARNING_MODULES } from '../lib/constants.js';

export default function LearningModuleModal({ evalSelectedMetric, setEvalSelectedMetric }) {
  if (!evalSelectedMetric || !LEARNING_MODULES[evalSelectedMetric]) return null;
  const mod = LEARNING_MODULES[evalSelectedMetric];
  return (
    <div style={{
      position: 'fixed', bottom: 0, left: 0, right: 0,
      background: '#1A1D26', borderTop: '2px solid #3B82F6',
      padding: '16px 20px 24px', maxHeight: '60vh', overflowY: 'auto',
      boxShadow: '0 -8px 30px rgba(0,0,0,0.6)', zIndex: 100,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: '#60A5FA', display: 'flex', alignItems: 'center', gap: 6 }}>
          📘 {mod.title}
        </div>
        <button onClick={() => setEvalSelectedMetric(null)} style={{
          background: 'transparent', border: 'none', cursor: 'pointer',
          color: '#8A9AB5', fontSize: 18, padding: 0, lineHeight: 1,
        }}>✕</button>
      </div>
      <div style={{ fontSize: 12, color: '#E8EAF0', lineHeight: 1.6, marginBottom: 10 }}>
        {mod.summary}
      </div>
      <div style={{ background: '#0F1218', borderRadius: 6, padding: '8px 12px', fontSize: 11, color: '#9CA3AF', lineHeight: 1.5 }}>
        <span style={{ color: '#F5A623', marginRight: 6 }}>임계값</span>
        {mod.threshold}
      </div>
    </div>
  );
}
