#!/usr/bin/env bash
# launchd 작업 설치 — plist 를 ~/Library/LaunchAgents 에 심볼릭 링크하고 로드.
#
# 사용: bash scripts/launchd/install.sh [drain|risk-d|risk-b ...]
#   인자 없으면 risk-d · risk-b · drain · report-sync · parse-notifications 모두 설치(서비스 계정 키로 무인 동작).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
AGENTS="$HOME/Library/LaunchAgents"
LOG_DIR="$HOME/Library/Logs/banana-portfolio"
mkdir -p "$AGENTS" "$LOG_DIR"

JOBS=("$@")
if [ ${#JOBS[@]} -eq 0 ]; then JOBS=(risk-d risk-b baseline drain report-sync parse-notifications backup); fi

for job in "${JOBS[@]}"; do
  src="$HERE/com.banana.$job.plist"
  dst="$AGENTS/com.banana.$job.plist"
  if [ ! -f "$src" ]; then echo "❌ plist 없음: $src" >&2; exit 1; fi
  ln -sf "$src" "$dst"
  # 이미 로드돼 있으면 먼저 언로드(idempotent)
  launchctl bootout "gui/$(id -u)/com.banana.$job" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$dst"
  echo "✅ 설치·로드: com.banana.$job  (로그: $LOG_DIR/$job.log)"
done

echo
echo "확인: launchctl list | grep com.banana"
echo "수동 1회 실행: launchctl kickstart -k gui/$(id -u)/com.banana.risk-d"
echo "⚠️ 무인 실행은 서비스 계정 키(\$HOME/.config/banana-portfolio/sa-key.json) 필요."
echo "   설정: GCP 서비스 계정 생성 → JSON 키 저장 → 시트를 SA client_email 에 편집자 공유 (docs/plans/ai-risk-engine.md Phase 7)."
