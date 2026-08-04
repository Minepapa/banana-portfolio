// 섀도우모드 — docs/ARCHITECTURE-V2.md "안전장치 계층 > 섀도우모드" 절.
// 파이프라인 전체(가격폴링→신호생성→투자실행협의체→Zeus 승인→텔레그램 제안·Frank
// 승인/거부)는 실전과 동일하게 돌아가되, 마지막 브로커 API 호출만 실제 발주 대신 로그로
// 대체한다. **기본값은 반드시 섀도우** — State 파일이 아예 없거나 읽기 실패해도 안전한
// 쪽(섀도우)으로 떨어져야 한다("실전"이 기본이면 설정 유실이 곧 실거래 사고로 이어짐).
import { buildFrontmatter, parseFrontmatter } from './vault-frontmatter.mjs';

export const MODE_SHADOW = '섀도우';
export const MODE_LIVE = '실전';

export function buildExecutionModeState({ mode, now = new Date() }) {
  if (mode !== MODE_SHADOW && mode !== MODE_LIVE) {
    throw new Error(`알 수 없는 모드: ${mode} (허용: ${MODE_SHADOW}|${MODE_LIVE})`);
  }
  return buildFrontmatter({ mode, changedAt: now.toISOString() });
}

// content가 없거나(파일 미존재) 파싱 결과가 기대 밖이면 무조건 섀도우로 떨어진다 — 이
// 함수가 이 모듈에서 가장 중요한 안전장치다.
export function getExecutionMode(content) {
  if (!content) return MODE_SHADOW;
  const p = parseFrontmatter(content);
  return p.mode === MODE_LIVE ? MODE_LIVE : MODE_SHADOW;
}

export function isShadowMode(content) {
  return getExecutionMode(content) === MODE_SHADOW;
}

// 실제 "체결" 처리 — 섀도우면 브로커를 부르지 않고 로그 문자열만 만든다. 실전이면 이
// 함수는 브로커를 직접 호출하지 않는다(그건 Phase 11의 일) — 호출부가 executor를
// 주입하지 않고 실전 모드로 들어오면 명시적으로 에러를 던져, "아직 없는 실주문 경로가
// 조용히 아무 일도 안 하는" 사고를 막는다.
export function settleExecution({ mode, proposal, liveExecutor }) {
  if (mode === MODE_SHADOW) {
    return {
      status: '섀도우체결',
      log: `SHADOW: 실제였다면 ${proposal.assetKey} ${proposal.quantity}${proposal.side === '매수' ? '매수' : '매도'} 체결`,
      writesToLedger: false,
    };
  }
  if (typeof liveExecutor !== 'function') {
    // Phase 11(KIS 실주문 API)이 아직 없다 — "실전 모드인데 실행기가 없음"을 조용히
    // 넘기면 실거래가 필요한 순간에 아무 일도 안 일어나는 게 가장 위험한 실패모드다.
    throw new Error('실전 모드이지만 liveExecutor가 주입되지 않았습니다 — KIS 실주문 API(Phase 11) 미구현');
  }
  return { status: '체결', ...liveExecutor(proposal), writesToLedger: true };
}
