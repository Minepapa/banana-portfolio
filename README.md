# banana-portfolio

개인 은퇴 포트폴리오 대시보드. **React 19 SPA**(프론트)와 **Node 결정론 자동화**(launchd 무인 잡)로 구성되며, Google Sheets를 데이터 정본으로 사용한다. 일반 시장 분석이 아니라 **소유자 맞춤 판단**(성향 학습·5축 평가·리스크 경보)이 목적이다.

## 아키텍처

```
┌─ 프론트(React SPA, GitHub Pages) ──────────────┐
│  App.jsx (오케스트레이터) → tabs / hooks / lib   │
│      ▲ useGoogleSheets(batchGet) → parseSheetData │
└──────┼──────────────────────────────────────────┘
       │  Google Sheets (데이터 정본)
┌──────┼──────────────────────────────────────────┐
│  Node 자동화(launchd 무인 잡, scripts/)           │
│  평가 큐 드레인 · 리스크 모니터 · 주간 리포트 ·    │
│  체결 파싱 · KPI 계산  (Node 계산, claude 판단)    │
└──────────────────────────────────────────────────┘
```

- **프론트(`src/`)**: `App.jsx`는 순수 오케스트레이터(상태 선언·데이터 로딩·탭 라우팅만). 기능 로직은 `tabs/`(화면)·`hooks/`(상태+부수효과)·`lib/`(순수 함수·상수)에 위치. 데이터는 `useGoogleSheets` → `parseSheetData` → `onData` 경로로 흐른다.
- **자동화(`scripts/`)**: Node가 모든 수치를 결정론적으로 계산하고, `claude`는 해석·서술만 담당(수치 재조회·추정 금지 = 환각 차단). 무인 실행은 `scripts/launchd/`의 plist + `run.sh` 래퍼.

## 빌드 & 배포

```bash
npm install
npm run dev      # 로컬 개발 (Vite)
npm run build    # 프로덕션 빌드 → dist/
npm run lint     # eslint
npm test         # node:test (src/**, scripts/**)
```

배포는 자동: `main`에 push하면 GitHub Actions가 빌드해 GitHub Pages로 배포한다(`.github/workflows/deploy.yml`).

## 문서 색인

| 문서 | 내용 |
|------|------|
| `AGENTS.md` (루트) | 코드 구조·작업 규칙·커밋 워크플로우 |
| `src/AGENTS.md` | 프론트 구조 규칙(오케스트레이터·tabs/hooks/lib 배치·데이터 흐름) |
| `scripts/AGENTS.md` | 자동화 파이프라인 규칙(결정론 원칙·시트 쓰기·claude 호출) |
| `CLAUDE.md` | 투자 도메인 정본(프로필·평가·데이터 기준) — 로컬 전용 |
| `FEATURES.md` | 기능 목록 |
| `docs/USER-GUIDE.md` | 실전 사용 가이드(탭별 루틴·의사결정 흐름) |

> 투자 전략·KPI 실적·개인 재무 정보가 포함된 `profile/`·`playbooks/`·`learning/`·`skills/`·`reports/`와 `CLAUDE.md`는 gitignore(로컬 전용)다.
