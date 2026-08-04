#!/usr/bin/env bash
# launchd 래퍼 (v2) — 리포지토리 cwd 고정·로그 리다이렉트·잡 종료 후 하트비트 기록.
#
# v1(banana-portfolio)의 scripts/launchd/run.sh와 같은 패턴이지만 완전히 별개 파일이다
# — v2 잡은 대부분 Vault(로컬 파일) + git + 텔레그램만 쓰고 구글 시트 서비스계정 토큰이
# 필요 없어서(카카오 파싱류 제외) 그 부분은 뺐다. 시트가 필요한 v2 잡(예:
# parse-notifications-to-vault)이 늘어나면 그때 v1 run.sh의 토큰 발급 블록을 가져온다.
#
# launchd plist들이 이 스크립트를 호출한다(예: run.sh backup-vault).
set -euo pipefail

REPO="/Users/huinique/Stockproject/banana-portfolio-v2"
LOG_DIR="$HOME/Library/Logs/banana-portfolio-v2"

mkdir -p "$LOG_DIR"
cd "$REPO"

# launchd는 최소 PATH로 실행되므로 node를 찾도록 보강
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
NODE="$(command -v node || true)"
if [ -z "$NODE" ]; then echo "[run.sh] node를 PATH에서 찾지 못했습니다" >&2; exit 127; fi

JOB="${1:-}"
case "$JOB" in
  backup-vault)   CMD=(scripts/jobs/backup-vault-snapshot.mjs) ;;
  health-watcher) CMD=(scripts/jobs/health-watcher.mjs) ;;
  *) echo "usage: run.sh {backup-vault|health-watcher}" >&2; exit 2 ;;
esac

# 잡을 포그라운드로 실행해 종료코드·소요시간 포착 (exec 금지)
START=$(date +%s)
set +e
"$NODE" "${CMD[@]}"
CODE=$?
set -e
DUR=$(( $(date +%s) - START ))
STATUS=OK; [ "$CODE" -ne 0 ] && STATUS=FAIL

# 하트비트 기록 (잡 실패해도 기록은 시도; 기록 실패는 잡 종료코드를 가리지 않음)
HB_DETAIL="$(tail -n 3 "$LOG_DIR/$JOB.log" 2>/dev/null | tr '\n' ' ' | cut -c1-200)" \
  "$NODE" scripts/jobs/record-heartbeat-vault.mjs "$JOB" "$STATUS" "$DUR" || true

exit "$CODE"
