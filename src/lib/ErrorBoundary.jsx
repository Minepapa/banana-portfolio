import { Component } from 'react';

// 최상위 에러 경계 — 2026-08-21 실사고 대응(로그인 직후 흰 화면, 원인 불명 신고).
// 이 앱은 어디에도 ErrorBoundary가 없어서 렌더 중 예외가 하나만 터져도 React가 트리
// 전체를 조용히 내려버리고(흰 화면), 콘솔 외엔 아무 단서도 안 남았다. 이 컴포넌트는
// 그 예외를 잡아 화면에 그대로 보여준다 — "무슨 일이 있었는지 아예 모른다"를 막는 게
// 목적이라, 메시지·스택을 가리지 않고 그대로 노출한다(가벼운 로컬 도구라 민감정보 우려 없음).
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error('[ErrorBoundary]', error, info?.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div style={{
        minHeight: '100vh', padding: 24, fontFamily: 'monospace', fontSize: 13,
        background: '#FBE3E4', color: '#141414', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
      }}>
        <div style={{ fontWeight: 800, fontSize: 16, marginBottom: 12 }}>⚠️ 화면 렌더링 중 오류 발생</div>
        <div style={{ marginBottom: 12 }}>{String(this.state.error?.message || this.state.error)}</div>
        <div style={{ fontSize: 11, opacity: 0.8, marginBottom: 16 }}>{this.state.error?.stack}</div>
        <button onClick={() => window.location.reload()} style={{
          padding: '8px 16px', border: '1px solid #141414', background: '#E4F5A0', cursor: 'pointer', fontWeight: 700,
        }}>
          새로고침
        </button>
      </div>
    );
  }
}
