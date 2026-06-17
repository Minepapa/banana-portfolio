# AGENTS.md — banana-portfolio

개인 투자 포트폴리오 **React PWA** + **Node 자동화 파이프라인**(launchd). Google Sheets가 데이터 정본.

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

## 커밋 워크플로우
- **비자명 변경**(다중 파일·로직·파이프라인·시트 쓰기)은 커밋 전 `code-reviewer` 패스를 거친다. 작성↔리뷰는 분리 컨텍스트(같은 패스에서 self-approve 금지). 사소 변경(문서·1줄·리네임)은 생략. 상세는 `CLAUDE.md` 커밋 워크플로우 절.
- 커밋/푸시는 사용자가 요청할 때만. 커밋 메시지 끝에 `Co-Authored-By` 트레일러.
