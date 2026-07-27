# banana-portfolio v1 — 아카이브 요약

> **왜 이 문서가 있나**: v1을 이 상태로 프로덕션에 남겨두고, 완전히 다른 컨셉으로 앱을
> 전면교체하는 v2를 별도 워크트리(`../banana-portfolio-v2`, `v2` 브랜치)에서 설계·개발한다.
> 이 문서는 그 분기 시점(2026-07-27, 커밋 `39e242d`)에 v1이 뭘 하는 앱이었는지 기록해
> v2 설계 때 "왜 이렇게 만들었었는지"를 다시 뒤지지 않아도 되게 하는 것이 목적이다.

## 한 줄 요약

판테온(Zeus 대표 + 4개 부서) 체제로 운영되는 **개인 포트폴리오 리스크모니터 + 주간리포트 +
평가 파이프라인** 앱. React 프론트엔드(Google Sheets를 정본으로 읽는 대시보드) + Node 무인
잡(launchd) 자동화 + 한국투자증권(KIS) Open API 연동으로 구성된다.

## 핵심 아키텍처

```
Google Sheets(정본: 보유종목·체결·리스크모니터·주간리포트 등)
        ↑ 읽기/쓰기
scripts/jobs/*.mjs (Node, launchd 무인 실행 14개)
   ├─ 리스크 감시: risk-monitor.mjs(D=거시/일간, B=논리훼손/주간)
   ├─ 시세/장부: realtime-quotes.mjs, reconcile-irp.mjs, daily-snapshot.mjs
   ├─ 평가·주문: drain-eval-queue.mjs, order-proposals.mjs
   ├─ 발행: weekly-report.mjs, sync-reports.mjs
   └─ 기타: parse-notifications.mjs, backfill-baselines.mjs, backup-sheet.mjs,
            sync-position-journal.mjs, record-heartbeat.mjs
        ↓
src/ (React, Vite) — App.jsx는 순수 오케스트레이터, 기능은 tabs/·hooks/·lib/
        ↓ 배포
GitHub Actions → GitHub Pages (push to main 시 자동)
```

**조직 프로토콜("판테온")**: 메인 세션(Zeus)이 라우팅·게이트 결정, 실무는 4개 부서
(Athena=투자전략·Themis=리스크관리·Hermes=운영·Apollo=비서)에 위임. 정본은
`.claude/agents/PANTHEON.md` + `.claude/agents/{zeus,athena,themis,hermes,apollo}.md`.

**투자 도메인 정본**: `CLAUDE.md`(gitignore, 로컬 전용) + `profile/investor-profile.md`
(투자자 프로필·성향·목표배분, gitignore) + `profile/kpi_baseline.md`(KPI·임계값 근거, gitignore).

## 리스크 신호 체계 (v1의 핵심 — 2026-07 세션에서 완성)

`리스크모니터` 시트에 3가지 유형(D/B/O)을 결정론(Node 계산) + LLM 판단(주입된 사실만 해석,
재계산 금지) 하이브리드로 적재:

- **D (거시, 매일)**: KOSPI/SP500/USDKRW/USDKRW볼린저밴드 — 임계값 초과 시 LLM 무관 강제 경보.
- **B (논리훼손, 주간)**: 위탁 개별주식(ETF·펀드 제외)만 대상. 하드 가드레일 3개(영업이익
  YoY 2분기 연속감소·부채비율 D/E>200%·현금흐름 흑자→적자전환) + LLM이 저장된 기준선·매수
  논리 대비 "전제가 깨졌는가"만 판단.
- **O (급락매수 기회, 매일)**: 5일 낙폭이 그 종목 ATR 기반 기대변동폭의 2배 이상, 또는
  RSI≤30 — 완전 결정론(LLM 무관). 외국인/기관 수급·증권사 투자의견·MACD/이동평균/ATR/
  Stochastic/거래량은 신호 색상에 개입하지 않는 **보조 컨빅션 텍스트**로만 결합.

**설계 원칙**(코드 전반에 관철): 숫자는 Node가 결정론으로 계산(LLM 환각 차단), 판단만 LLM.
펀더멘털 우선·가격은 후순위(52주 고점/RSI 과열만으로 매도 신호 금지). 임계값은 반드시
실증 데이터 또는 확립된 문헌 근거로 뒷받침(임의값 배제) — 근거 전체는
`profile/kpi_baseline.md` §8(로컬 전용) 참고.

## 최근 커밋 흐름 (`af2eaf6..39e242d`, 9개 — 이 아카이브의 직접 배경)

1. `11057e4` — 외국인·기관 수급을 O신호 보조 컨빅션으로 결합(KR만).
2. `1e96c2e` — 증권사 투자의견·목표주가를 B신호 프롬프트에 참고정보로 결합(KR만).
3. `5db8859` — KIS strategy_builder/backtester 조사 후 기술지표 5종(MACD·이동평균·ATR·
   Stochastic·거래량) 계산 로직만 흡수(별도 앱/Docker 없이), O/B신호 보조 참고정보로.
4. `09f3978` — 누락돼 있던 가드레일 2종(FCF 적자전환·투자의견하향 대리지표) 추가 + O신호
   ATR 컨빅션 상대화(이 시점엔 트리거 자체는 유지).
5. `62bd552` — 전체 임계값을 보유종목 3년치 실데이터+금융 문헌으로 재검증. 고정 -10%
   낙폭 트리거를 ATR 기반 변동성 상대화로 실제 교체(트리거 자체 변경, 오너 명시 승인).
6. `4613247` — 근거 없는 임계값 4개 삭제(부채비율 변화량·투자의견하향 건수·ATR폴백·거래량
   저조) + 거시(D) 임계값 동일 방법론 검증(값은 이미 타당해 유지) + KIS 알람스팸 1차 완화.
7. `08104ea` — KIS 레이트리밋(EGW00201)이 HTTP 500으로도 온다는 걸 몰라 재시도가 반쪽만
   작동하던 근본 버그 수정(모든 KIS API 공유 `fetchKis` 재작성).
8. `2a1ed51` — 잡상태 한글라벨 보강, 논리훼손 자동검증 오탐표면 축소, KPI/도움말 문서화.
9. `39e242d` — `/code-review` 스킬(Standards+Spec 2축)로 위 8개 커밋 전체를 재검토해 발견한
   낡은 주석 1건 수정.

## v2 진행 중

이 시점부터 앱을 완전히 다른 컨셉으로 전면교체하는 v2를 별도 워크트리에서 설계한다:

- 경로: `/Users/huinique/Stockproject/banana-portfolio-v2`
- 브랜치: `v2` (이 커밋에서 분기)
- `profile/`·`playbooks/`·`learning/`·`skills/`(투자철학·평가양식 정본)는 v1과 심볼릭링크로
  공유 — v2가 다른 앱이 되더라도 Frank의 투자철학 자체는 하나만 존재해야 한다.
- v1(이 디렉토리, `main` 브랜치)의 launchd 무인 잡 14개는 v2 작업과 무관하게 계속 실행된다
  (plist·`run.sh`가 이 디렉토리 절대경로를 하드코딩).
