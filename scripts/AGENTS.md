# scripts/AGENTS.md — 자동화 파이프라인 규칙

launchd로 도는 Node 자동화. plist는 `scripts/launchd/`(설치본 `~/Library/LaunchAgents/`는 심링크 → 저장소 사본 수정이 곧 반영, `launchctl unload/load`로 적용).

## 폴더 구조 (역할·실행환경별)
- `jobs/` — **launchd 무인 잡 진입점**. `launchd/run.sh`의 case 문이 호출(예: `scripts/jobs/risk-monitor.mjs`). 진입점을 추가·이동하면 **run.sh 경로를 반드시 같이 수정**.
- `tools/` — 수동 실행 도구(launchd 미등록). 백필·시드·자가검증 등. `recover-evals`는 `../jobs/drain-eval-queue.mjs`의 파서를 재사용.
- `setup/` — **일회성 마이그레이션**(시트 생성·스키마 변경, 실행 완료분). 운영 경로 아님 — 참조·복구용 보존.
- `lib/` — 공유 순수 모듈 + `*.test.js` + python 페처(`yf-*.py`). **이동 금지**(`instruments.mjs`의 `.cache` 상대경로·다수 진입점이 `../lib/`로 의존).
- `apps-script/` — Google Apps Script(`.gs`) 런타임. Node 아님 — 시트에 붙여 실행. `legacy/`는 구버전.
- 진입점이 `jobs/`·`tools/` 하위에 있으므로 lib import는 `../lib/...`, 같은 폴더 진입점 간은 `./...`.

## 결정론 원칙 (환각 차단 — 최우선)
- **Node가 모든 수치를 계산, claude(`claude -p`)는 판단·서술만.** RSI·52주·재무비율·KPI·거시지표는 `lib/fundamentals.mjs`·`kpi-calc.mjs` 등 순수 함수가 산출하고, 프롬프트에 주입한다. LLM에 수치 재조회·추정을 시키지 말 것.
- 데이터 없으면 "(데이터 부족)" 표기 강제, 추정 금지.

## claude 호출 규칙 (quota)
- 헤드리스 호출은 `runHeadlessClaude`(`lib/sheets-common.mjs`)만 사용. 한도 감지 시 전역 쿨다운 설정 + `err.isLimit` 태그.
- **새 claude 호출 잡은 반드시**: ① 호출 전 `cooldownActive()` 가드(쿨다운 중 skip), ② 한도(`e.isLimit`) catch 시 루프 중단. 확정 성향 주입은 `lib/preferences.mjs`(`renderPrefRows`·`prefBlock`, confirmedOnly).
- 빈 작업이면 claude 호출하지 말 것(예: drain 빈 큐 → 즉시 exit).

## 시트 쓰기
- 멱등성 유지(같은 키 중복 방지). `appendValues`는 **USER_ENTERED**(체결내역 수식 `=INDIRECT`·`=GOOGLEFINANCE` 보존 — RAW로 바꾸면 수식이 텍스트화되는 회귀). `getRange` 반환형 주의: `sheets-common`은 배열 직접 반환, `drain-eval-queue` 로컬 버전은 `{values}`.
- 날짜는 시트 셀 포맷에 따라 시리얼화될 수 있음 — 쓰기보다 앱 읽기측(`toDateStr`)에서 방어.

## 데이터 소스
- 가격·시세·RSI·52주: pykrx(KR)·yfinance(US). 재무·공시: OpenDart REST(curl, `$DART_API_KEY`)·UsStockInfo. 요청일 기준 직전 분기 우선(CLAUDE.md 데이터 기준).

## 테스트·검증
- 순수 로직(parser·계산·신호)은 `*.test.js`로 `node --test`. 선례: `behavior-signals`·`quota-cooldown`·`report-facts`·`eval-facts`.
- `.mjs`는 eslint 대상이 아니므로 변경 후 `node --check <file>`로 구문 확인. 실동작은 `--dry-run` 또는 SA 토큰으로 1회 실행 검증.
