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

# ⚠️ 이 머신의 Node 20+ 기본 Happy Eyeballs(이중스택 동시접속, RFC 8305)가 IPv6가
# 즉각 거부되고 IPv4는 느리게 응답하는 조건에서 오작동해 외부 API 호출이 fetch
# failed(ETIMEDOUT)로 실패하는 걸 실측 확인(2026-08-18, task #34 — "텔레그램 상시세션
# 재연결 불안정"으로 보고됐던 증상의 실제 원인. scripts/lib/telegram.mjs에도 같은
# 수정을 넣었지만, 이 잡들이 앞으로 호출할 다른 외부 API(KIS·Google·DART·KRX)도 같은
# 네트워크 조건에 노출돼 있어 여기서도 전역으로 끈다 — 방어적 이중화).
export NODE_OPTIONS="${NODE_OPTIONS:-} --no-network-family-autoselection"

JOB="${1:-}"
case "$JOB" in
  backup-vault)   CMD=(scripts/jobs/backup-vault-snapshot.mjs) ;;
  health-watcher) CMD=(scripts/jobs/health-watcher.mjs) ;;
  execute-quant)  CMD=(scripts/tools/execute-quant-proposal.mjs) ;;
  execute-asset-allocation) CMD=(scripts/tools/execute-asset-allocation-proposal.mjs) ;;
  daily-asset-allocation-check) CMD=(scripts/jobs/daily-asset-allocation-check.mjs) ;;
  parse-notifications-to-vault) CMD=(scripts/jobs/parse-notifications-to-vault.mjs) ;;
  update-holdings-from-executions) CMD=(scripts/jobs/update-holdings-from-executions.mjs) ;;
  daily-execution-report) CMD=(scripts/jobs/daily-execution-report.mjs) ;;
  update-holdings-prices) CMD=(scripts/jobs/update-holdings-prices.mjs) ;;
  sync-firestore-mirror) CMD=(scripts/jobs/sync-firestore-mirror.mjs) ;;
  new-cash-allocation) CMD=(scripts/jobs/new-cash-allocation.mjs) ;;
  reconcile-irp) CMD=(scripts/jobs/reconcile-irp.mjs) ;;
  reconcile-nh-cash) CMD=(scripts/jobs/reconcile-nh-cash.mjs) ;;
  reconcile-irp-executions) CMD=(scripts/jobs/reconcile-irp-executions.mjs) ;;
  reconcile-nh-executions) CMD=(scripts/jobs/reconcile-nh-executions.mjs) ;;
  intraday-portfolio-sync) CMD=(scripts/jobs/intraday-portfolio-sync.mjs) ;;
  update-cash-from-ledger) CMD=(scripts/jobs/update-cash-from-ledger.mjs) ;;
  weekly-report) CMD=(scripts/jobs/weekly-report.mjs) ;;
  update-allocation-from-holdings) CMD=(scripts/jobs/update-allocation-from-holdings.mjs) ;;
  update-monthly-balance-snapshot) CMD=(scripts/jobs/update-monthly-balance-snapshot.mjs) ;;
  morning-briefing) CMD=(scripts/jobs/morning-briefing.mjs) ;;
  themis-risk-review) CMD=(scripts/jobs/themis-risk-review.mjs) ;;
  weekly-schedule-summary) CMD=(scripts/jobs/weekly-schedule-summary.mjs) ;;
  quarterly-allocation-review) CMD=(scripts/jobs/quarterly-allocation-review.mjs) ;;
  rebalance-proposal) CMD=(scripts/jobs/rebalance-proposal.mjs) ;;
  proposal-execution-reminder) CMD=(scripts/jobs/proposal-execution-reminder.mjs) ;;
  telegram-session-handoff) CMD=(scripts/jobs/telegram-session-handoff.mjs) ;;
  isa-maturity-check) CMD=(scripts/jobs/isa-maturity-check.mjs) ;;
  telegram-session-health-check) CMD=(scripts/jobs/telegram-session-health-check.mjs) ;;
  intraday-market-move-monitor) CMD=(scripts/jobs/intraday-market-move-monitor.mjs) ;;
  weekly-vault-health-check) CMD=(scripts/jobs/weekly-vault-health-check.mjs) ;;
  pension-balance-reminder) CMD=(scripts/jobs/pension-balance-reminder.mjs) ;;
  update-fund-holdings-from-purchases) CMD=(scripts/jobs/update-fund-holdings-from-purchases.mjs) ;;
  *) echo "usage: run.sh {backup-vault|health-watcher|execute-quant|execute-asset-allocation|daily-asset-allocation-check|parse-notifications-to-vault|update-holdings-from-executions|daily-execution-report|update-holdings-prices|sync-firestore-mirror|new-cash-allocation|reconcile-irp|reconcile-nh-cash|reconcile-irp-executions|reconcile-nh-executions|intraday-portfolio-sync|update-cash-from-ledger|weekly-report|update-allocation-from-holdings|update-monthly-balance-snapshot|morning-briefing|themis-risk-review|weekly-schedule-summary|quarterly-allocation-review|rebalance-proposal|proposal-execution-reminder|telegram-session-handoff|isa-maturity-check|telegram-session-health-check|intraday-market-move-monitor|weekly-vault-health-check|pension-balance-reminder|update-fund-holdings-from-purchases}" >&2; exit 2 ;;
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
