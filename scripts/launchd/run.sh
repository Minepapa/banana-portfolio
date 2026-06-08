#!/usr/bin/env bash
# launchd 래퍼 — 리포지토리 cwd 고정 · 서비스 계정 토큰 주입 · 로그 리다이렉트.
#
# launchd plist 들이 이 스크립트를 호출한다(예: run.sh risk-d).
# 토큰은 서비스 계정 키(sa-key.json)로 무인 발급해 각 스크립트의 positional <TOKEN> 인자로 넘긴다.
# 모든 대상 스크립트(drain·risk-monitor)가 positional 토큰을 받으므로 추가 코드 변경 없이 무인 동작.
# 서비스 계정 키가 없으면 토큰 없이 실행 → 대화형 OAuth 가 떠 무인 실행은 실패한다.
# (서비스 계정 설정 = docs/plans/ai-risk-engine.md Phase 7 참고.)
set -euo pipefail

REPO="/Users/huinique/Stockproject/banana-portfolio"
LOG_DIR="$HOME/Library/Logs/banana-portfolio"
SA_KEY_FILE="${SA_KEY_FILE:-$HOME/.config/banana-portfolio/sa-key.json}"

mkdir -p "$LOG_DIR"
cd "$REPO"

# launchd 는 최소 PATH 로 실행되므로 node 를 찾도록 보강
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
NODE="$(command -v node || true)"
if [ -z "$NODE" ]; then echo "[run.sh] node 를 PATH 에서 찾지 못했습니다" >&2; exit 127; fi

# 서비스 계정 키로 무인 토큰 발급 (sheets-common 의 getServiceAccountToken 재사용)
TOKEN=""
if [ -f "$SA_KEY_FILE" ]; then
  TOKEN="$("$NODE" -e 'import("./scripts/lib/sheets-common.mjs").then(m=>m.getServiceAccountToken()).then(t=>process.stdout.write(t)).catch(e=>{console.error(e.message);process.exit(1)})')" \
    || { echo "[run.sh] 서비스 계정 토큰 발급 실패 (키: $SA_KEY_FILE)" >&2; exit 1; }
fi
if [ -z "$TOKEN" ]; then
  echo "[run.sh] 경고: 서비스 계정 키($SA_KEY_FILE) 없음 → 무인 실행 실패 가능(대화형 OAuth)" >&2
fi

JOB="${1:-}"
case "$JOB" in
  drain)               CMD=(scripts/drain-eval-queue.mjs --auto) ;;
  risk-d)              CMD=(scripts/risk-monitor.mjs --mode=D) ;;
  risk-b)              CMD=(scripts/risk-monitor.mjs --mode=B) ;;
  report-sync)         CMD=(scripts/sync-reports.mjs) ;;
  parse-notifications) CMD=(scripts/parse-notifications.mjs) ;;
  journal-sync)        CMD=(scripts/setup/setup-position-journal.mjs) ;;
  *) echo "usage: run.sh {drain|risk-d|risk-b|report-sync|parse-notifications|journal-sync}" >&2; exit 2 ;;
esac

# 잡을 포그라운드로 실행해 종료코드·소요시간 포착 (exec 금지)
START=$(date +%s)
set +e
"$NODE" "${CMD[@]}" ${TOKEN:+"$TOKEN"}
CODE=$?
set -e
DUR=$(( $(date +%s) - START ))
STATUS=OK; [ "$CODE" -ne 0 ] && STATUS=FAIL

# 하트비트 기록 (잡 실패해도 기록은 시도; 기록 실패는 잡 종료코드를 가리지 않음)
HB_DETAIL="$(tail -n 3 "$LOG_DIR/$JOB.log" 2>/dev/null | tr '\n' ' ' | cut -c1-200)" \
  "$NODE" scripts/record-heartbeat.mjs "$JOB" "$STATUS" "$DUR" ${TOKEN:+"$TOKEN"} || true

exit "$CODE"
