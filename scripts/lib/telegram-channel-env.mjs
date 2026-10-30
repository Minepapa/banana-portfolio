// 텔레그램 채널 세션 판정 — 훅이 "지금 오너의 텔레그램 입력을 처리하는 세션인가"를 환경변수로 본다.
// 두 경로가 있다(2026-10-30, 텔레그램 관문 0단계):
// - CLAUDE_TELEGRAM_SESSION=1: 지금의 상시 대화형 세션(com.banana2.telegram-session). reply 도구를 쓴다.
// - CLAUDE_TELEGRAM_GATE=1: 텔레그램 관문 데몬이 메시지마다 띄우는 헤드리스 claude. reply 도구가 없다.
// 관문 실행에 CLAUDE_TELEGRAM_SESSION을 그대로 넣으면 telegram-reply-guard(Stop)가 "reply 없이 끝남"으로 턴을
// 막고, telegram-session-context가 SessionStart마다 입력 규칙을 다시 넣는다. 그래서 관문은 별도 변수를 쓰고,
// 두 경로 모두에 같아야 하는 보안·라우팅 판정(금고 차단, 담당 기본 사실 연결)만 이 함수로 묶는다.
// 위키 질문 답 훅은 상시 세션 전용이다(관문은 WQ 답을 결정론으로 처리, 2단계 리뷰).
// reply 도구에 묶인 훅(reply-guard·progress-reaction·sender-label-guard·session-context)은 이 함수를 쓰지 않는다.
export function isTelegramChannel(env = process.env) {
  return env.CLAUDE_TELEGRAM_SESSION === '1' || env.CLAUDE_TELEGRAM_GATE === '1';
}
