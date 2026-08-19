#!/usr/bin/env bash
# 텔레그램 상시세션 매일 예방적 재시작 (2026-08-19)
#
# 왜: com.banana2.telegram-session이 "Remote Control disconnected — Claude.ai
# login expired"로 조용히 멈춘 적이 있었다 — 프로세스 자체는 안 죽어서(크래시가
# 아님) launchd KeepAlive가 못 잡는다. 오너가 텔레그램으로 질문했는데 몇 시간째
# 응답이 없어서 발견(2026-08-19 실사고). 재시작(launchctl kickstart -k)만으로
# 재로그인 없이 깨끗하게 복구되는 걸 실측 확인 — 문제 유무와 무관하게 매일 한 번
# 예방적으로 재기동한다.
#
# ⚠️ getUpdates 소비자는 봇 토큰당 1개만 허용된다(com.banana2.telegram-session.plist
# 주석 참고) — kickstart -k는 기존 프로세스를 먼저 죽이고 launchd가 관리하는 동일
# Label 안에서 새로 띄우므로 중복 소비자가 생기지 않는다.
set -euo pipefail

LOG_DIR="$HOME/Library/Logs/banana-portfolio-v2"
mkdir -p "$LOG_DIR"
echo "[$(date '+%Y-%m-%d %H:%M:%S')] 텔레그램 상시세션 예방적 재시작" >> "$LOG_DIR/telegram-session-restart.log"

launchctl kickstart -k "gui/$(id -u)/com.banana2.telegram-session"
