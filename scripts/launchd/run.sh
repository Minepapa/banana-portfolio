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

# launchd는 최소 PATH로 실행되므로 node/python3를 찾도록 보강.
#
# ⚠️ 순서 CRITICAL(2026-09-18 실사고) — 이 머신엔 python3가 두 곳에 따로 설치돼
# 있다: /opt/homebrew/bin(Homebrew, 2026-09-14경 설치/갱신된 것으로 보임 — 패키지
# 없는 맨몸)과 /usr/local/bin(Python.framework 심볼릭링크, FinanceDataReader·certifi
# 등 이 프로젝트가 실제로 쓰는 패키지가 전부 이쪽에 pip install돼 있음). 예전엔
# /opt/homebrew/bin이 먼저라 launchd로 도는 모든 python3 호출(historical-universe.py
# 등)이 조용히 "패키지 없는" 쪽으로 resolve되고 있었다 — update-breakout-price-cache가
# 2026-09-17·18 이틀 연속 FAIL(ModuleNotFoundError: FinanceDataReader)로 처음 표면화,
# daily-breakout-signal-scan.mjs(같은 buildCandidatePool 경유)도 2026-09-18 첫 launchd
# 실행부터 동일하게 실패할 뻔했다(우연히 그 전까지의 검증은 전부 대화형 셸의 python3로
# 돌려서 — 즉 run.sh를 실제로 거치지 않아서 — 이 버그를 못 잡았다는 뜻이기도 함, 교훈:
# "라이브 재검증"도 실제 launchd 경로(run.sh)를 통해야 의미 있다). node는 양쪽 다
# 있어(버전만 다름, 24.7.0 vs 24.15.0) 순서를 바꿔도 무해 — 그래서 /usr/local/bin을
# 앞에 둔다. 향후 또 다른 homebrew 패키지가 같은 방식으로 끼어들 수 있으니, python3를
# pip install할 일이 생기면 반드시 이 경로(/usr/local/bin/python3)에 설치할 것.
#
# ⚠️ 이 재정렬로 launchd 잡이 쓰는 node도 24.7.0(/opt/homebrew/bin)→24.15.0
# (/usr/local/bin)으로 같이 바뀐다(공통 바이너리라 분리 불가) — 코드리뷰(2026-09-18)
# 가 v24.15.0으로 전체 스위트를 재실행해 2561건 전부 통과 확인. 대화형 셸의
# `node`는 여전히 24.7.0을 가리키므로(PATH가 다름), 이후 "npm test 통과했다"는
# 확인만으로는 이 재정렬 이후 실제 launchd 경로에서 쓰는 node 버전까지 검증한 게
# 아니라는 점을 기억할 것 — 필요하면 `PATH="/usr/local/bin:$PATH" npm test`로 재확인.
export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:$PATH"
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
# $1(잡 이름)을 소비한 뒤 나머지 인자(--dry-run·--force 등)는 그대로 스크립트에
# 전달한다(2026-09-19 코드리뷰 지적 — 이전엔 이 스크립트가 인자를 아예 안 받아서
# `bash scripts/launchd/run.sh <job> --dry-run`으로 실제 launchd 경로를 흉내내
# 테스트하려 해도 --dry-run이 조용히 사라졌다. 그 탓에 한 번은 의도치 않게 실제
# 오늘자 락을 건드린 적도 있음). shift 실패(인자가 아예 없을 때)는 무시 — 그러면
# 아래 case문이 빈 JOB으로 usage를 출력하고 정상 종료.
shift || true
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
  annual-instrument-rescore) CMD=(scripts/jobs/annual-instrument-rescore.mjs) ;;
  monthly-macro-tilt-proposal) CMD=(scripts/jobs/monthly-macro-tilt-proposal.mjs) ;;
  update-breakout-price-cache) CMD=(scripts/jobs/update-breakout-price-cache.mjs) ;;
  daily-breakout-signal-scan) CMD=(scripts/jobs/daily-breakout-signal-scan.mjs) ;;
  place-breakout-fallback-entry) CMD=(scripts/jobs/place-breakout-fallback-entry.mjs) ;;
  update-macro-indicators-cache) CMD=(scripts/jobs/update-macro-indicators-cache.mjs) ;;
  *) echo "usage: run.sh {backup-vault|health-watcher|execute-quant|execute-asset-allocation|daily-asset-allocation-check|parse-notifications-to-vault|update-holdings-from-executions|daily-execution-report|update-holdings-prices|sync-firestore-mirror|new-cash-allocation|reconcile-irp|reconcile-nh-cash|reconcile-irp-executions|reconcile-nh-executions|intraday-portfolio-sync|update-cash-from-ledger|weekly-report|update-allocation-from-holdings|update-monthly-balance-snapshot|morning-briefing|themis-risk-review|weekly-schedule-summary|quarterly-allocation-review|rebalance-proposal|proposal-execution-reminder|telegram-session-handoff|isa-maturity-check|telegram-session-health-check|intraday-market-move-monitor|weekly-vault-health-check|pension-balance-reminder|update-fund-holdings-from-purchases|annual-instrument-rescore|monthly-macro-tilt-proposal|update-breakout-price-cache|daily-breakout-signal-scan|place-breakout-fallback-entry|update-macro-indicators-cache}" >&2; exit 2 ;;
esac

# 잡을 포그라운드로 실행해 종료코드·소요시간 포착 (exec 금지). "$@"는 위 shift 이후라
# 잡 이름을 뺀 나머지 인자(--dry-run 등, 없으면 빈 배열이라 무해)만 남아있다.
START=$(date +%s)
set +e
"$NODE" "${CMD[@]}" "$@"
CODE=$?
set -e
DUR=$(( $(date +%s) - START ))
STATUS=OK; [ "$CODE" -ne 0 ] && STATUS=FAIL

# 하트비트 기록 (잡 실패해도 기록은 시도; 기록 실패는 잡 종료코드를 가리지 않음)
HB_DETAIL="$(tail -n 3 "$LOG_DIR/$JOB.log" 2>/dev/null | tr '\n' ' ' | cut -c1-200)" \
  "$NODE" scripts/jobs/record-heartbeat-vault.mjs "$JOB" "$STATUS" "$DUR" || true

exit "$CODE"
