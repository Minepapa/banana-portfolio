// 상시 텔레그램 세션(com.banana2.telegram-session) 생존 판정 — 순수 프로세스/API
// 확인 로직만, 액션(재시작·알림)은 안 함. health-watcher.mjs(30분 간격, 알림만)와
// telegram-session-health-check.mjs(10분 간격, 알림+재시작) 둘 다 이 모듈을 쓴다
// (2026-08-31 — 원래 health-watcher.mjs에만 있던 isProcessAlive·isPollingStuck를
// 여기로 옮김. 코드리뷰 지적: 두 번째 소비자가 생기는 순간 "같은 개념을 두 번
// 정의" 위험이 생긴다 — 이 세션 내내 지켜온 원칙과 동일 이유로 신설 시점에 바로
// 공유 모듈로 분리).
//
// ⚠️ 설계 변경(2026-08-31, 코드리뷰 지적) — 처음엔 세션의 raw 터미널 로그
// (`/usr/bin/script` 캡처, ANSI 이스케이프 섞임)에서 실패 문구를 grep하는 방식으로
// 만들었다가, 그 로그가 TUI 차등 리페인트라 마커 문자열이 화면 갱신 경계에서 실제로
// 쪼개지는 걸 실측으로 확인해(예: "login" 다음에 커서이동 코드가 끼어들어
// "login\x1b[49Gexpired"가 되는 경우가 실제 로그에 존재) 폐기했다. 아래 두 신호는
// 전부 결정론적이고 ANSI 파싱이 필요 없다.
import { execSync } from 'node:child_process';

export const TELEGRAM_SESSION_PROCESS_PATTERN = 'claude.*--channels.*telegram';

// telegram MCP 서버(bun 서브프로세스)가 살아있는지 직접 확인 — 2026-08-31 실측
// 확인된 실제 장애 형태(부모 claude 프로세스는 안 죽은 채 이 서브프로세스만 조용히
// 사라짐, 에러 로그도 없음)를 가장 직접적으로 잡는 신호. `bun run --cwd .../telegram/
// {version} --shell=bun --silent start`(plugin .mcp.json의 command 그대로) 커맨드라인
// 패턴 — 버전 디렉터리 숫자가 바뀌어도 매치되게 버전 부분은 패턴에서 뺐다.
export const TELEGRAM_MCP_SUBPROCESS_PATTERN = 'bun.*telegram.*start';

export function isProcessAlive(pattern) {
  try {
    execSync(`pgrep -f "${pattern}"`, { stdio: ['ignore', 'ignore', 'ignore'] });
    return true;
  } catch {
    return false; // pgrep이 못 찾으면 비영(exit 1) — 프로세스 없음
  }
}

// 좀비 감지(2026-08-13, task #34 — health-watcher.mjs에서 이관) — pgrep은 "프로세스가
// 존재하는가"만 보고 "실제로 메시지를 소비하고 있는가"는 못 본다. pending_update_count가
// 0보다 크면 텔레그램이 배달을 시도했는데 상시세션이 아직 안 가져간 업데이트가 큐에
// 남아있다는 뜻 — getUpdates 롱폴링이 정상이면 보통 즉시 소비되므로, 이 시점 스냅샷에서
// 잡힌다는 것 자체가 폴링이 멈췄다는 강한 신호다(오탐 여지: 체크 순간과 다음 폴링 사이의
// 아주 좁은 타이밍 경합 — 실무적으로 무시 가능한 수준).
//
// ⚠️ 한계 — 오너가 그 사이 메시지를 안 보냈으면 큐에 쌓일 게 없어 0으로 남는다(폴링이
// 죽었어도 못 잡음). TELEGRAM_MCP_SUBPROCESS_PATTERN 확인이 이 한계가 없는 더 직접적인
// 1차 신호이고, 이건 그걸로도 못 잡는 경우(서브프로세스는 떠있는데 내부적으로 멎은 경우)
// 를 잡는 보조 신호다.
export function isPollingStuck({ pendingUpdateCount }) {
  return Number.isFinite(pendingUpdateCount) && pendingUpdateCount > 0;
}
