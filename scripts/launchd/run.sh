#!/usr/bin/env bash
# launchd 래퍼 — 리포지토리 cwd 고정 · 토큰 주입 · 로그 리다이렉트.
#
# launchd plist 들이 이 스크립트를 호출한다(예: run.sh risk-d).
# 토큰은 캐시 파일에서 읽어 스크립트의 positional <TOKEN> 인자로 넘긴다.
# 캐시 파일이 없으면 토큰 없이 실행 → 대화형 OAuth 가 뜨므로 무인 실행은 실패한다.
# (토큰 캐시 채우는 방식 = Phase 7 인증 결정사항. docs/plans/ai-risk-engine.md 참고.)
set -euo pipefail

REPO="/Users/huinique/Stockproject/banana-portfolio"
LOG_DIR="$HOME/Library/Logs/banana-portfolio"
TOKEN_FILE="${RISK_TOKEN_FILE:-$HOME/.config/banana-portfolio/token.txt}"

mkdir -p "$LOG_DIR"
cd "$REPO"

# launchd 는 최소 PATH 로 실행되므로 node 를 찾도록 보강
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
NODE="$(command -v node || true)"
if [ -z "$NODE" ]; then echo "[run.sh] node 를 PATH 에서 찾지 못했습니다" >&2; exit 127; fi

TOKEN=""
if [ -f "$TOKEN_FILE" ]; then TOKEN="$(tr -d '[:space:]' < "$TOKEN_FILE")"; fi
if [ -z "$TOKEN" ]; then
  echo "[run.sh] 경고: 토큰 캐시($TOKEN_FILE) 없음 → 무인 실행 실패 가능(대화형 OAuth)" >&2
fi

case "${1:-}" in
  drain)  exec "$NODE" scripts/drain-eval-queue.mjs --auto ${TOKEN:+"$TOKEN"} ;;
  risk-d) exec "$NODE" scripts/risk-monitor.mjs --mode=D ${TOKEN:+"$TOKEN"} ;;
  risk-b) exec "$NODE" scripts/risk-monitor.mjs --mode=B ${TOKEN:+"$TOKEN"} ;;
  *) echo "usage: run.sh {drain|risk-d|risk-b}" >&2; exit 2 ;;
esac
