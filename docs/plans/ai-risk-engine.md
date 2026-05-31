# AI 리스크 엔진 + 큐 자동화 Implementation Plan

## Overview

banana-portfolio(정적 GitHub Pages SPA)에 AI 기반 리스크 관리를 접목한다. 앱은 서버가 없으므로
AI는 **로컬 PC의 예약 스크립트(`launchd` + 헤드리스 `claude -p`)가 분석 → Google Sheets 기록 →
앱이 표시**하는 패턴으로만 동작한다. 추가 과금 0(구독 Claude Code 헤드리스 실행).

투자자(Frank) 철학: **펀더멘털·실적이 우선, 절대 가격(52주 고점/RSI 과열)은 후순위.** 따라서 리스크
신호는 가격 과열이 아니라 (B)논리 훼손과 (D)거시 충격 중심이다.
참조: `/Users/huinique/.claude/projects/-Users-huinique-Stockproject-banana-portfolio/memory/feedback-investment-philosophy.md`

## Current State

- **앱**: `src/App.jsx`(~4100줄). gviz(`SHEET_ID` + 탭별 `GID`)로 클라이언트에서 시트 읽음(~line 1160).
  탭: 노트 / KPI / 리포트 / (평가·보유 등). recharts 사용. GitHub Actions → Pages 자동 배포.
- **평가 큐(반자동)**: `scripts/drain-eval-queue.mjs`. OAuth → `평가요청!A2:F` 대기행 읽기 →
  종목별 프롬프트 출력 → **사람이 Claude Pro에 복붙 → JSON 회수**(`readMultiline`) → `종목투자노트!A2:U`
  append + 큐 상태 '완료'. `parseEvalJson`이 ```json 펜스 파싱, `buildRow`가 21열 생성.
- **종목투자노트 스키마(A:U, 21열)**: date, name, ticker, market, conclusion, 수익성, 안정성, 밸류에이션,
  현금흐름, 모멘텀, reasons, risks, actions, frankMemo, status(O/idx14 매수여부), buyDate, buyPrice,
  targetTerm, targetRet, aiNote, axisItems(U/idx20 JSON).
- **평가요청 스키마(A:F)**: requestedAt, name, market, status, completedAt, memo.
- **보유 4계좌**: `위탁/연금저축/ISA/IRP!A2:I`. **자산분배** 시트(`B3:D9` 위탁, `B12:D18` 연금저축).
- **MCP 데이터 소스**(로컬 Claude Code에 등록됨): opendart, UsStockInfo, NaverSearch. KR 모멘텀은
  네이버금융 비공식 JSON / pykrx. 텔레그램 MCP(`plugin_telegram_telegram`) 연결됨.
- **갭**: 보유종목 대부분이 매수 평가·논리 없음 → "매수 논리 대비 훼손 감시"가 성립 안 함.
- **정본(Hub)**: `/Users/huinique/Claude/Agent/Trading Agent/` (CLAUDE.md §4 거시 트리거, playbooks, learning/).

## Desired End State

1. 평가 큐가 복붙 없이 로컬에서 자동 드레인(`--auto`).
2. 보유종목 전부에 펀더멘털 기준선 존재(없던 것은 AI가 `추정 기준선` 생성).
3. 리스크 모니터가 B(논리 훼손, 주1회)·D(거시 충격, 매일) 결과를 `리스크모니터` 탭에 기록.
4. 앱 "리스크" 탭에서 종목별 신호등(🟢🟡🔴) + 거시 영향 카드 확인.
5. 🔴 발생 시 텔레그램 즉시 푸시.
6. 위 작업이 `launchd`로 예약 실행.

## 설계 원칙

- **불확실성 front-load**: 가장 큰 미지수 = "헤드리스 `claude -p`가 MCP로 실제 데이터를 떠서 유효한 평가
  JSON을 끝까지 만드는가". 이걸 Phase 1에서 단독 검증한 뒤 나머지를 쌓는다.
- 자동 생성 평가의 status는 항상 **"보류"** — 매수 의사결정은 Frank가 앱 카드 보고 직접. 자동화는 복붙
  토일만 제거한다.
- 자동 산출물에는 출처/기준일 표기 + `자동`/`추정 기준선` 태그로 사람 검토 가능하게.

---

## Phases

### Phase 1: 헤드리스 평가 검증 스파이크 (de-risk)
**Goal:** `claude -p`가 MCP 데이터 fetch + 5축 평가 + 유효 JSON 출력을 헤드리스로 해내는지 1건으로 실측.

**Tasks:**
1. 종목 1건(KR 1, 가능하면 US 1도)에 대해 `buildBuyPrompt`가 만드는 것과 동일한 프롬프트를 준비.
2. 터미널에서 직접 실행해 동작 확인:
   `claude -p "<프롬프트>" --allowedTools "mcp__*,Bash" --output-format text`
   (정확한 플래그·MCP 허용 방식은 `claude --help`로 확인. 권한 모드/`--permission-mode` 포함 검토.)
3. 출력에 ```json 펜스 + 21필드 필수키(date/name/conclusion/axisItems)가 있는지,
   데이터 최신성 룰(직전 분기)을 지켰는지 육안 검증.
4. 실패 시 대안 기록: (a) `--permission-mode acceptEdits`/`bypassPermissions`, (b) MCP만 허용,
   (c) 프롬프트에 도구 사용 지시 명시, (d) API 폴백 여부.

**Success criteria:**
- [ ] `claude -p` 헤드리스 1회 실행으로 OpenDart/UsStockInfo 실제 수치가 담긴 평가 JSON 산출
- [ ] `parseEvalJson`이 그 출력을 에러 없이 파싱
- [ ] 사용한 정확한 명령/플래그를 이 플랜 또는 스크립트 주석에 기록

**⚠️ 이 Phase가 실패하면** 자동화(Phase 2·4) 설계를 API 호출 또는 반자동 유지로 재검토. 나머지 Phase는 영향 적음.

---

### Phase 2: 평가 큐 자동 드레인 (`--auto`)
**Goal:** 복붙 없이 큐 자동 처리. 기존 수동 모드는 폴백 유지.

**Tasks:**
1. `scripts/drain-eval-queue.mjs`에 `--auto` 플래그 추가(`args.includes('--auto')`).
2. `--auto`일 때 `readMultiline(rl)`(사람 입력) 대신 `runClaudeHeadless(prompt)` 호출:
   - `child_process`로 Phase 1에서 검증한 `claude -p ...` 실행, stdout 캡처.
   - 기존 `parseEvalJson(stdout)` 재사용.
3. 자동 적재 행은 식별 가능하게: `frankMemo` 또는 aiNote 앞에 `[자동]` 프리픽스 또는 별도 표식.
4. 실패/타임아웃 시 큐 상태 `오류` + 메모 기록(기존 로직 재사용). 토큰 만료 대비 재시도 1회.
5. 동시성: 한 번에 1건씩 순차(Claude 구독 레이트 고려).

**Success criteria:**
- [ ] `node scripts/drain-eval-queue.mjs --auto --dry-run`이 사람 개입 없이 프롬프트→평가→파싱까지 수행
- [ ] 실제 1건 자동 적재 후 앱 노트/평가 탭에서 카드 확인(status='보류')
- [ ] 수동 모드(`--auto` 없이)는 기존대로 동작(회귀 없음)

---

### Phase 3: 보유종목 기준선 백필
**Goal:** 매수 논리 없는 보유종목에 현재 펀더멘털 기준선을 1회 생성.

**Tasks:**
1. 신규 스크립트 `scripts/backfill-baselines.mjs`(또는 drain에 `--baseline` 모드):
   - 4계좌(`위탁/연금저축/ISA/IRP`) 보유종목 목록 수집(`findHolding` 로직 재사용).
   - 각 종목에 대해 `종목투자노트`에 기존 평가(매수 논리) 있는지 확인.
   - 없는 종목만 Phase 1/2의 헤드리스 평가로 5축 스냅샷 생성.
2. 적재 시 구분: status='보류', `frankMemo`/aiNote에 `[추정 기준선]` 태그(매수 논리와 구분, 추후 보정 가능).
3. 첫 실행 = 일괄 처리. 레이트 고려해 종목당 간격/배치.

**Success criteria:**
- [ ] 보유종목 중 평가 없던 종목 전부에 `[추정 기준선]` 행이 종목투자노트에 생성됨
- [ ] 이미 매수 논리 있는 종목은 건너뜀(중복 생성 안 함)
- [ ] 앱 노트 탭에서 신규 기준선 카드 표시

---

### Phase 4: 리스크 모니터 (B 주간 + D 일간)
**Goal:** 논리 훼손·거시 충격을 분석해 `리스크모니터` 시트 탭에 기록.

**Tasks:**
1. `리스크모니터` 시트 탭 생성(`scripts/setup-*.mjs` 패턴 참조). 제안 스키마:
   `날짜 | 유형(B/D) | 대상(종목 or 자산군) | 신호(🟢🟡🔴) | 요약 | 상세 | 근거데이터(JSON) | 기준선참조`
2. 신규 스크립트 `scripts/risk-monitor.mjs`:
   - **모드 B(주1회)**: 보유종목별로 현재 펀더멘털·분기실적·뉴스 재fetch → 저장된 기준선/매수논리와
     AI 종합 판단(가드레일 룰: 영업이익 YoY 2분기 연속 감소, 가이던스 하향, FCF 적자전환, 부채 급증 등은
     강제 🟡 이상). 가격 과열 단독은 신호로 쓰지 않음(철학). 출력: 신호 + "무엇이 어떻게 바뀌었나".
   - **모드 D(매일)**: USDKRW·미10년물·VIX·KOSPI/S&P fetch → Trading Agent CLAUDE.md §4 트리거 대조 →
     **내 보유 포지션/자산군에 연결된 영향만** 산출(노출 비중 매핑).
   - 둘 다 헤드리스 `claude -p`로 분석, 결과 JSON 파싱 후 `리스크모니터!A2:H` append.
3. 플래그: `--mode=B` / `--mode=D`.

**Success criteria:**
- [ ] `리스크모니터` 탭에 B·D 결과가 정상 스키마로 적재
- [ ] B 신호가 가격이 아닌 펀더멘털 근거를 명시(철학 준수 확인)
- [ ] D 결과가 일반 지표 나열이 아니라 Frank 보유 포지션에 매핑됨

---

### Phase 5: 앱 "리스크" 탭 UI
**Goal:** 리스크모니터 데이터를 앱에서 표시.

**Tasks:**
1. `리스크모니터` 탭의 GID 확인 → `src/App.jsx`(~line 1160) gviz GID 매핑에 추가.
2. 탭 네비게이션에 "리스크" 추가(기존 노트/KPI/리포트 탭 구조 따라).
3. UI: ① 종목별 신호등 리스트(🔴 상단 정렬) + "무엇이 바뀌었나" 1줄, 클릭 시 상세.
   ② 거시 영향 카드(D 결과). 최신 날짜 기준 표시.
4. 데이터 없을 때 빈 상태 처리.

**Success criteria:**
- [ ] `npm run build 2>&1 | tail -8` 에러 없음, `npm run lint` 통과
- [ ] dev 서버에서 리스크 탭이 시트 데이터로 렌더(🔴 우선 정렬, 거시 카드 표시)
- [ ] 데이터 없을 때도 깨지지 않음

---

### Phase 6: 🔴 텔레그램 즉시 푸시 — ✅ 완료 (커밋 1fa7145)
**Goal:** 새 🔴 신호 발생 시에만 텔레그램 알림.

**구현:**
1. `risk-monitor.mjs` 가 적재 전 `리스크모니터` 기존 행에서 직전 🔴 `유형|대상` 키를 모아
   신규 🔴 만 푸시(같은 실행 내 중복도 차단). `--no-push` 로 끔.
2. 봇 API 직접 호출(`sendTelegram` in `scripts/lib/sheets-common.mjs`). 봇 토큰·chat_id 는
   telegram 채널 설정 재사용 — 토큰 `~/.claude/channels/telegram/.env`,
   chat_id `~/.claude/channels/telegram/access.json` 의 `allowFrom[0]`.
3. 메시지 포맷: 유형(거시/논리) + 대상 + 요약 + 상세(300자) + 날짜. (앱 탭 링크는 추후.)

**Success criteria:**
- [x] 신규 🔴만 1회 푸시(같은 신호 반복 푸시 없음)
- [x] 🟡🟢는 푸시 안 함(앱에서만 확인)
- [ ] 라이브 검증(실제 🔴 발생 시 수신) — OAuth 라이브 세션에서 확인

---

### Phase 7: launchd 예약
**Goal:** 전체 파이프라인 무인 예약 실행.

**스캐폴딩 — ✅ 완료 (`scripts/launchd/`):**
- `run.sh <drain|risk-d|risk-b>` — cwd 고정 · 토큰 캐시 주입 · 로그 리다이렉트 래퍼.
- `com.banana.risk-d.plist` — 평일 08:00 (거시/일간)
- `com.banana.risk-b.plist` — 월요일 08:10 (논리/주간)
- `com.banana.drain.plist` — 3시간 간격 (평가 큐 자동 드레인)
- `install.sh` / `uninstall.sh` — `launchctl bootstrap/bootout` 기반 idempotent 설치·제거.
- 로그: `~/Library/Logs/banana-portfolio/{risk-d,risk-b,drain}.log`

**남은 결정사항 — 무인 토큰 캐싱 (Frank 선택 필요):**

| 방식 | 동작 | 장점 | 단점/필요작업 |
|------|------|------|---------------|
| **서비스 계정 (권장)** | GCP SA JWT → access token, 시트를 SA 이메일에 공유 | 완전 무인, 대화형 로그인 0회 | GCP 콘솔에서 SA·키 생성 + 시트 공유 1회 |
| **Refresh token** | 1회 대화형 동의(offline access) → refresh token 저장, 갱신 | 기존 OAuth 클라이언트 재사용 | implicit→auth-code 흐름 전환 필요, client_secret 보관 |

- 결정 후: 토큰 헬퍼가 `~/.config/banana-portfolio/token.txt`(또는 SA 키) 를 채우도록 구현 →
  `run.sh` 가 이미 그 파일을 읽어 주입함.
- PC 꺼짐 대비: `launchd` 는 놓친 `StartCalendarInterval` 을 깨어날 때 1회 캐치업 실행(문서화).

**Success criteria:**
- [x] plist · 설치/제거 스크립트 작성, `plutil -lint` · `bash -n` 통과
- [ ] (인증 결정 후) 토큰 캐시 구현 → `launchctl kickstart` 무인 1회 실행으로 시트 갱신
- [ ] 로그에서 각 작업 성공/실패 추적 가능

---

## 진행 메모
- Phase 순서는 의존성 순(1→2→3은 헤드리스 실행 공유, 4는 3의 기준선 의존, 5는 4 데이터 의존).
- 각 Phase는 독립적으로 가치 있음(2만 해도 복붙 제거, 3만 해도 보유종목 평가 확보).
- 빌드/배포: `npm run build 2>&1 | tail -8`, `npm run lint`. push to main → Pages 자동 배포.

## 진행 현황 (2026-05-30 기준)
- ✅ **Phase 1** 검증 완료 — 헤드리스 `claude -p` + OpenDart curl로 삼성전자 5축 평가 JSON 실측(실데이터).
- ✅ **Phase 2** `drain-eval-queue.mjs --auto` 구현·syntax OK. 라이브(OAuth+큐 적재)만 대기.
- ✅ **Phase 3** `scripts/backfill-baselines.mjs` + 공통 `scripts/lib/sheets-common.mjs`. `리스크기준선` 탭 자동 생성(ensureSheet). dry-run OK.
- ✅ **Phase 4** `scripts/risk-monitor.mjs` (`--mode=B` 논리훼손 / `--mode=D` 거시). `리스크모니터` 탭 자동 생성. D 프롬프트는 Hub CLAUDE.md §4 트리거를 런타임 Read로 참조(정본 유지). dry-run OK.
- ⏳ **남은 라이브 작업(Frank 맥 필요, OAuth 팝업)**: ① `backfill-baselines` 1회 실행 → 기준선 적재, ② `risk-monitor --mode=D` / `--mode=B` 실행 → `리스크모니터` 적재. 이후 두 탭의 GID 확보 → Phase 5 진행.
- 공통 헬퍼는 `scripts/lib/sheets-common.mjs`로 모듈화(신규 2스크립트가 import). drain은 검증본이라 미이전(추후 통합 가능).
- `리스크모니터` 스키마(8열): 날짜|유형(B/D)|대상|신호(🟢🟡🔴)|요약|상세|근거데이터(JSON)|기준선참조
- `리스크기준선` 스키마(10열): 종목|티커|시장|기준일|매출총이익률|영업이익률|ROE|부채비율|EPS|비고
