#!/usr/bin/env bash
# launchd 작업 제거 — 언로드 후 심볼릭 링크 삭제.
#
# 사용: bash scripts/launchd/uninstall.sh [drain|risk-d|risk-b ...]
#   인자 없으면 셋 다 제거.
set -euo pipefail

AGENTS="$HOME/Library/LaunchAgents"
JOBS=("$@")
if [ ${#JOBS[@]} -eq 0 ]; then JOBS=(drain risk-d risk-b); fi

for job in "${JOBS[@]}"; do
  launchctl bootout "gui/$(id -u)/com.banana.$job" 2>/dev/null || true
  rm -f "$AGENTS/com.banana.$job.plist"
  echo "🗑️  제거: com.banana.$job"
done
