# src/AGENTS.md — 앱 구조 규칙

2026년 초 App.jsx 전면 개편으로 기능별 하위 트리로 구조화했다. **이 경계를 유지할 것 — 다시 App.jsx에 로직을 쌓지 말 것.**

## App.jsx = 순수 오케스트레이터
- 담당: 상태 선언(useState), 데이터 로딩 effect, `onData` 배선, 탭 라우팅. **기능 로직 0.**
- 새 기능을 App.jsx 렌더에 인라인으로 넣지 말 것(인라인 IIFE 금지 — `JobHealthBanner`·`SyncBanner`처럼 컴포넌트로 분리).
- App.jsx를 건드리는 정당한 경우: 새 탭 import·라우팅 추가, `onData`에 새 데이터 필드 배선, 새 상태 추가.

## 어디에 무엇을
- `tabs/` — 탭 컴포넌트 **및 비탭 UI 컴포넌트**(폼·모달·배너). 선례: `AddHoldingForm`, `TradeEditModal`, `EvalQueueModal`, `JobHealthBanner`, `SyncBanner`.
- `hooks/` — 상태+부수효과 재사용 로직(시트 I/O, 편집 플로우). 예: `useGoogleSheets`(인증·batchGet·쓰기), `usePortfolioEdits`, `useTradeSync`.
- `lib/` — **순수 함수·상수**(JSX 없음 원칙, primitives.jsx·markdown.jsx 예외). 예: `parseSheetData`(시트→상태), `textFormat`(parseNum·toDateStr), `metrics`, `constants`. 테스트는 여기 집중(`*.test.js`).

## 데이터 흐름
- `useGoogleSheets`가 batchGet → `parseSheetData`가 상태 객체로 파싱 → `onData`가 App 상태로. **3자(parseSheetData 반환 ↔ onData 전달 ↔ App 구조분해) 키가 일치해야 함** — 필드 추가 시 세 곳 모두 갱신(누락 시 탭이 빈 화면).
- 앱은 시트를 **FORMATTED_VALUE로 읽음** → 날짜가 시리얼 넘버일 수 있어 `toDateStr`로 방어.
- 시트 쓰기는 hooks가 담당. 자산 값(가격·수량·평가액)은 시트 정본을 읽고 추정·재계산 금지.

## 작업 후
`npm run build && npm run lint` 통과 확인. lib 순수 함수 변경 시 테스트 추가/실행.
