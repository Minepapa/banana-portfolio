#!/usr/bin/env bash
# 텔레그램 상시세션 매일 예방적 재시작 (2026-08-19, 2026-08-30 kickstart→bootout+bootstrap로 교체)
#
# 왜: com.banana2.telegram-session이 "Remote Control disconnected — Claude.ai
# login expired"로 조용히 멈춘 적이 있었다 — 프로세스 자체는 안 죽어서(크래시가
# 아님) launchd KeepAlive가 못 잡는다. 오너가 텔레그램으로 질문했는데 몇 시간째
# 응답이 없어서 발견(2026-08-19 실사고). 재시작만으로 재로그인 없이 깨끗하게
# 복구되는 걸 실측 확인 — 문제 유무와 무관하게 매일 한 번 예방적으로 재기동한다.
#
# ⚠️ 실사고(2026-08-30, 오너 신고) — 원래 `launchctl kickstart -k`를 썼는데, 이
# 명령은 프로세스만 죽였다 살릴 뿐 **plist 파일을 다시 읽지 않는다**(launchd가
# 최초 로드 시점의 ProgramArguments를 메모리에 캐싱해두고 그걸로만 재시작).
# 그 결과 전날 plist에 `--name`·`CLAUDE_TELEGRAM_SESSION=1`을 추가했는데도 다음날
# 04:00 재시작 후에도 실제 프로세스는 옛 명령줄 그대로였다 — CLAUDE_TELEGRAM_SESSION이
# 없으니 SessionStart 훅(telegram-session-context.mjs)도 못 알아채 인수인계
# 메커니즘 자체가 조용히 무효화돼 있었다(State/TelegramSession/last-read.md가
# 하루 전 값에 멈춰있던 걸로 발견). `bootout`+`bootstrap`은 job을 완전히 내렸다
# 다시 올려 launchd가 plist를 disk에서 새로 파싱하게 만든다 — kickstart와 동일하게
# 프로세스를 죽였다 살리는 것뿐이라 로그인 상태(Claude Code 인증)에는 영향 없고,
# 앞으로는 plist를 고치면 실제로 다음 재시작부터 적용된다(이제 이 코멘트가 참이 됨).
#
# ⚠️ getUpdates 소비자는 봇 토큰당 1개만 허용된다(com.banana2.telegram-session.plist
# 주석 참고) — bootout이 완전히 내린 뒤에야 bootstrap이 새로 띄우므로(중간에 약간의
# 공백 있음, kickstart보다 아주 살짝 느릴 뿐) 중복 소비자가 생기지 않는다.
set -euo pipefail

LOG_DIR="$HOME/Library/Logs/banana-portfolio-v2"
mkdir -p "$LOG_DIR"
echo "[$(date '+%Y-%m-%d %H:%M:%S')] 텔레그램 상시세션 예방적 재시작" >> "$LOG_DIR/telegram-session-restart.log"

launchctl bootout "gui/$(id -u)/com.banana2.telegram-session" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.banana2.telegram-session.plist"
