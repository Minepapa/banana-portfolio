# AGENTS.md — banana-portfolio

개인 투자 포트폴리오 **React PWA** + **Node 자동화 파이프라인**(launchd). 데이터 정본은
Obsidian Vault(`~/Pantheon/Mouseion`, 무세이온 새 폴더 구조 — `90_Delphi/Schema/경로 등록부.md` 참고)다 — 2026-08-20
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

## 구현 주체 (Claude 직접 구현)
- **2026-10-23 오너 확정(결정 `구현-주체`, 결정 `구현-주체-순서`·`구현-모델-등급` 대체)**: Codex 구독 종료로 이 저장소의 코드·설정 구현은 **Claude가 직접** 한다. Codex CLI(`codex exec`)·Pumasi에 위임하지 않는다.
- 적용 대상은 앱·자동화의 코드와 개발 설정 변경이다. 투자 판단·포트폴리오 조회·장부 작업·텔레그램 운영 요청은 기존 도메인 및 부서 라우팅을 따른다.
- 작업 시작 전 `git status`와 diff를 확인하고, 요청 범위에 속하지 않는 미커밋 변경(다른 세션 작업)을 보존한다. launchd가 이 작업 트리를 직접 돌리므로 큰 변경은 worktree에서 하고, worktree에서는 증권사 실API를 부르지 않는다.
- 커밋 메시지·보고에 구현 주체(Claude)를 항상 밝힌다.
- 저자와 검토를 분리한다. 비자명 변경은 커밋 전 독립 코드리뷰 1회를 거치고, 무인 잡·실거래 인접 코드에서 CRITICAL/HIGH가 나오면 수정 뒤 독립 리뷰를 다시 받는다.
- 별도 요청이 없는 한 커밋·푸시·배포, `launchctl` 적용, 실거래 주문 등 외부 상태 변경을 하지 않는다.
- 이전 Codex 위임 규칙(2026-09-24 전환, 2026-10-02 권한 에스컬레이션, 2026-10-10 구현 주체 순서, 2026-10-11 모델 등급)은 git 이력과 대체된 결정 문서에 남아 있다.

### 실거래·상태기계 코드 작성 원칙 (2026-09-29 확정, 2026-10-23부터 Claude 직접 구현에 그대로 적용)
2026-09-29 돌파매매 청산관리 재설계(`reconcile-breakout-protection.mjs` 전면
재작성)에서 Codex 초안이 ①압축된 스타일(한글자 변수명·긴 줄, 이 프로젝트 관례
위반) ②기존 유틸의 명시된 불변식 무시(`vault-frontmatter.mjs`의 "중첩 객체
저장 불가" 주석을 안 보고 중첩 객체를 저장하려 함) ③재작성 중 기존 안전장치
조용히 유실(`retry-breakout-protection.mjs`에서 사전 KIS 상태 검증 3종이
통째로 사라짐, 원래 잡의 try/catch·알림 로직 누락)을 보였다. 이후 실거래
자동발주 코드에 Codex(또는 Claude 자신)를 투입할 때는:
- **전체 재작성 대신 최소 diff 패치를 요청한다.** 안전 critical 파일은 "이
  함수를 다시 써"가 아니라 "이 부분만 이렇게 바꿔, 나머지는 그대로 둬"로
  범위를 좁힌다 — 재작성은 지금 요청받은 기능은 넣지만 기존에 있던 부수적
  안전장치를 프롬프트에 안 적혀 있으면 그냥 빠뜨리는 경향이 있다.
- **지켜야 할 불변식을 Claude가 먼저 조사해 프롬프트에 명시한다.** "이
  유틸은 X를 절대 못 한다", "이 필드는 Y 이유로 항상 null이어야 한다" 같은
  제약을 Codex가 알아서 기존 코드에서 찾아내길 기대하지 않는다.
- **하우스 스타일을 매번 명시한다.** 장황한 주석·설명형 변수명·왜(why) 중심
  주석 — 이 프로젝트 관례를 "AGENTS.md를 읽었으니 알겠지"로 넘기지 말고,
  안전 critical 파일일수록 프롬프트에 직접 적는다.
- **작업을 더 잘게 쪼갠다.** "한 번에 한 작업" 원칙(위 항목)을 정말로
  지킨다 — 잡 오케스트레이션+보호주문 모듈+여러 호출부를 한 프롬프트에
  몰아넣지 않는다. 작을수록 검토 부담도, 유실 범위도 준다.
- **까다로운 제어흐름(상태기계)은 Claude가 직접 짜는 걸 우선 고려한다.**
  KIS 당일유효 주문+하루 1회 실행처럼 타이밍이 얽힌 로직은 Codex도
  Claude(이 세션의 직접 구현분 포함, 2~4회차 리뷰에서 발견된 CRITICAL/HIGH)도
  반복해서 틀렸다 — 이런 부분은 국소적 계산 함수(손절가 계산 등)만 위임하고
  오케스트레이션은 직접 쓰는 편이 이 프로젝트에서 더 안정적이었다.
- **실거래 자동발주 코드는 CRITICAL/HIGH가 나오는 한 독립 리뷰를 반복한다**
  (`feedback-verification-depth-by-blast-radius` 원칙 — 이 재설계는 5회
  거쳤고, 매 라운드 직전 수정이 새 결함을 만드는 패턴이 3회 반복됐다). 이건
  Codex 품질을 대체하지 않는 백스톱일 뿐이니, 위 5개 항목으로 애초에
  구멍이 덜 나게 하는 게 우선이다.

## 볼트(무세이온) 작업
- 볼트(`~/Pantheon/Mouseion`)를 읽거나 쓸 때는 볼트 헌법 `~/Pantheon/Mouseion/CLAUDE.md`와 `90_Delphi/Schema/경로 등록부`를 따른다
  (이관 4-1, 2026-10-08 — 위키 정본·키워드 색인·질문 큐·소급 수정 금지 규칙은 모두 헌법에 있다).
- 코드에서 볼트 경로는 `scripts/lib/vault-paths.mjs` 상수만 쓴다(경로 리터럴 금지 테스트). 결정 문서는 `resolveDecision(decisionKey)`로 읽는다.

## 커밋 워크플로우
- **비자명 변경**(다중 파일·로직·파이프라인·시트 쓰기)은 커밋 전 `code-reviewer` 패스를 거친다. 작성↔리뷰는 분리 컨텍스트(같은 패스에서 self-approve 금지). 사소 변경(문서·1줄·리네임)은 생략. 상세는 `CLAUDE.md` 커밋 워크플로우 절.
- 커밋/푸시는 사용자가 요청할 때만. 커밋 메시지 끝에 `Co-Authored-By` 트레일러.
