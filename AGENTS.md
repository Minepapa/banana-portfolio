# AGENTS.md — banana-portfolio

개인 투자 포트폴리오 **React PWA** + **Node 자동화 파이프라인**(launchd). 데이터 정본은
Obsidian Vault(`~/banana-vault`, Facts/State/Decisions/Knowledge 4대 분류)다 — 2026-08-20
Vault 네이티브 전환 완료(`scripts/tools/ledger-facts.mjs` 헤더 주석 참고). Google Sheets는
일부 레거시 입력 경로(예: [종목투자노트] 탭, 매수논리 기록 — 아직 Vault 미이관, `scripts/
jobs/weekly-report.mjs` 헤더의 "아직 Vault 네이티브 쓰기 주체가 없는 입력" 목록 참고)에만
남아있다.

이 파일은 **코드 구조·작업 규칙** 레이어다. **투자 도메인 정본은 `CLAUDE.md`**(투자 성향·계좌 구조·데이터 기준·평가 규칙·성향 학습) — 도메인 내용은 여기 중복하지 말 것.

## 명령
- build: `npm run build 2>&1 | tail -8`
- lint: `npm run lint` (⚠️ `.js/.jsx`만 검사 — `scripts/*.mjs`는 lint 대상 아님. `node --check`로 구문 확인)
- test: `npm test` (node --test, `**/*.test.js`)
- 배포: push to main → GitHub Actions → GitHub Pages 자동

## 디렉토리
- `src/` — 앱. 상세 규칙 `src/AGENTS.md`.
- `scripts/` — 자동화 파이프라인. 상세 규칙 `scripts/AGENTS.md`.
- `profile/`·`playbooks/`·`learning/`·`skills/` — 투자 전략·KPI(gitignore, 로컬 전용). CLAUDE.md 참조.

## 단일 quota 모델 (중요)
헤드리스 `claude -p`(drain·risk-d·risk-b·weekly-report)와 **대화형 Claude Code가 macOS Keychain의 단일 구독 OAuth quota를 공유**한다. API 키 미사용.
- 다중 병렬 에이전트(ultrawork/team/ccg/autopilot)는 quota를 빠르게 소모 → **비권장**.
- 한도 도달 시 전역 쿨다운(`scripts/lib/sheets-common.mjs`의 `cooldownActive`/`setCooldown`)이 잡들을 조용히 skip시킨다. 새 claude 호출 잡을 추가하면 이 가드를 반드시 통과시킬 것.

## Claude → Codex 구현 라우팅
- 오너는 평소처럼 **Claude Code만 통해 작업을 지시**한다. Claude Code가 대화·요구사항 정리·범위 결정·결과 설명을 맡고, 이 저장소의 코드·설정 구현은 로컬 **Codex CLI 단일 작업**에 위임한다.
- 라우팅 대상은 앱·자동화의 코드와 개발 설정 변경이다. 투자 판단·포트폴리오 조회·장부 작업·텔레그램 운영 요청에는 적용하지 않고 기존 도메인 및 부서 라우팅을 따른다.
- 이 규칙은 `/pumasi` 호출 여부와 무관하게 모든 대화형 구현 요청에 적용한다. `.md`에 역할을 적는 것만으로 위임이 발생하는 것은 아니므로, Claude는 실제로 `codex exec`를 실행해야 한다.
- Codex는 실행 전 `AGENTS.md`, `CLAUDE.md`, 변경 대상 경로의 중첩 `AGENTS.md`를 읽고 따라야 한다. Claude는 작업 프롬프트에 요청 범위와 수용 조건을 명확히 전달한다.
- Codex는 기본적으로 현재 프로젝트 작업 트리에서 한 번에 한 작업만 수행한다. 작업 시작 전 기존 `git status`와 diff를 확인하고, 요청 범위에 속하지 않는 미커밋 변경을 보존한다. 동시 Codex 실행이나 Pumasi 병렬 워커는 오너가 병렬화를 명시적으로 요청한 경우에만 쓴다.
- Codex는 `codex exec --cd "$PWD" --sandbox workspace-write -` 형태로 실행한다. 기본 샌드박스를 유지하고 `--dangerously-bypass-approvals-and-sandbox`를 사용하지 않는다. 승인·권한 문제로 진행할 수 없으면 우회하지 말고 Claude에 상태를 반환한다.
- **모델 선택(2026-09-25 오너 확정)**: Claude가 작업 난이도·리스크를 보고 매번 `-m/--model`을 직접 지정해 호출한다(오너가 매번 지정하라고 안 해도 Claude 판단으로 정함). 므네모시네 문서 정리·단순 문구 치환처럼 판단이 단순한 작업은 저가형 모델(예: `gpt-6-luna`)로 토큰을 아낀다. 실거래·장부 반영·주문 게이트처럼 잘못되면 돈이 움직이는 작업은 지금까지 쓰던 등급(`gpt-5.6-terra`) 이상을 유지한다 — 이 세션에서 `gpt-5.6-terra`도 CRITICAL급 버그를 두 번 냈다가 검증으로 잡은 전례가 있어(NH 위탁 해외주식 체결확인 API, 날짜 역산 공식 오류·컷오버 소급대사 위험), 실거래 인접 작업의 모델 등급을 함부로 낮추지 않는다. `~/.codex/config.toml`의 기본값(`gpt-5.6-terra`)은 그대로 두고, 매 호출마다 필요에 따라 `-m`으로 override한다.
- Codex는 구현과 필요한 프로젝트 검증을 수행하고 변경 파일·검증 결과·남은 위험을 보고한다. Claude는 diff와 결과를 확인하고 오너에게 보고한다. 프로젝트의 독립 코드리뷰 규칙도 그대로 적용한다.
- 별도 요청이 없는 한 Codex와 Claude 모두 커밋·푸시·배포, `launchctl` 적용, 실거래 주문 등 외부 상태 변경을 하지 않는다.
- Pumasi는 여러 개의 독립 작업을 오너가 명시적으로 병렬 처리하라고 한 경우에만 선택한다. 현재 플러그인 기본 명령은 샌드박스·승인 우회 옵션을 사용하므로, 안전한 프로젝트별 실행 설정을 먼저 마련하고 파일 범위를 분리하기 전에는 실행하지 않는다.
- 모델별 사용량은 인증 방식과 작업 크기에 따라 달라지므로, 이 분업은 호출을 나누는 구성이지 Claude와 Codex 사용량 비율을 보장하지 않는다.

## 므네모시네 Knowledge Wiki
- 투자 로직·기준·선호·시스템 지식을 다룰 때 `~/banana-vault/Knowledge/Index.md`와 `Knowledge/Meta/지식위키-운영규칙.md`를 먼저 읽고 정본을 근거로 답한다. 날짜별 Facts/Log/Decisions만으로 현재 기준을 추정하지 않는다.
- 수정 중 반복해서 등장하는 미등록 지식 키워드를 발견하면 근거 노트, 정본 후보, 바뀔 색인·링크를 포함해 현재 진행 중인 텔레그램 대화에서 등록/보류/제외를 묻는다. 명시적 승인을 받기 전에는 등록하지 않는다. 승인된 키워드는 색인·별칭·관련 노트 링크를 갱신한다. 세션을 넘는 질문은 State/WikiQuestions 큐와 Telegram UserPromptSubmit 훅에서 ID 기반으로 처리한다.
- Knowledge 정본 변경 시 운영 규칙에 따라 종속 노트와 과거 기록을 구분한다. Facts/Log 원문은 소급 수정하지 않고 메타데이터 또는 색인으로 연결한다.
- 정본 변경 후 볼트 전체에서 정본·별칭을 검색해 `derived_from` 파생 노트와 Topic map의 현재형 설명을 점검한다. `related` 링크만으로 내용 동기화를 추정하지 않는다.
- 오너 판단이 필요한 위키 질문은 `State/WikiQuestions/`에 고유 ID로 저장한다. 답변이 해당 질문과 명확히 연결되지 않으면 상태를 바꾸지 않으며, 투자 제안 승인 CLI와 혼용하지 않는다.

## 커밋 워크플로우
- **비자명 변경**(다중 파일·로직·파이프라인·시트 쓰기)은 커밋 전 `code-reviewer` 패스를 거친다. 작성↔리뷰는 분리 컨텍스트(같은 패스에서 self-approve 금지). 사소 변경(문서·1줄·리네임)은 생략. 상세는 `CLAUDE.md` 커밋 워크플로우 절.
- 커밋/푸시는 사용자가 요청할 때만. 커밋 메시지 끝에 `Co-Authored-By` 트레일러.
