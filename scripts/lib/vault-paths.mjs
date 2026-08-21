// Vault 물리 경로 — 이 상수 하나로 모든 잡·스크립트가 Vault 위치를 참조한다.
//
// ⚠️ 임시 상태(2026-08-04, 구현계획서 Phase 1): 지금은 Google Drive for desktop이
// 이 Mac에 아직 설치되지 않아 Vault를 로컬 경로(~/banana-vault)에 만들었다. 설계
// (docs/ARCHITECTURE-V2.md "Vault 물리적 위치·동기화" 절)는 Google Drive 동기화 폴더
// 안에 두는 것을 전제로 한다 — Drive 설치 후 이 폴더를 그 안으로 옮기고 VAULT_ROOT를
// 갱신해야 한다(또는 VAULT_PATH 환경변수로 새 경로를 가리키면 코드 변경 없이 전환 가능).
// 그 전까지는 Mac 로컬에서만 접근 가능하고 안드로이드에서는 열람 불가하다는 뜻이므로,
// 실사용(텔레그램 승인 흐름 등) 투입 전 반드시 Drive 이전을 완료할 것.

import { join } from 'node:path';
import { homedir } from 'node:os';

export const VAULT_ROOT = process.env.VAULT_PATH || join(homedir(), 'banana-vault');

export const VAULT_PATHS = {
  root: VAULT_ROOT,
  facts: {
    // Ledger는 이벤트 종류별로 하위폴더를 나눈다(2026-08-04 확정, 오너 요청) — 카카오
    // 알림이 파싱하는 6종(체결·배당·펀드매수·예수금앵커·환전 + 금현물)이 전부 같은
    // 평평한 폴더에 뒤섞이면 옵시디언에서 원본을 훑어보기 어렵다. 금현물은 v1에서
    // "별도 원장으로 뒀다가 버그(클로버 원인)가 나서 체결내역에 통합"한 전례가 있어
    // 여기서도 Executions에 합친다(별도 폴더 만들지 않음) — 같은 실수 반복 방지.
    // 계좌(위탁·ISA 등) 기준 폴더는 만들지 않는다 — 계좌 귀속은 State/Holdings 설계
    // (Phase 8·9) 전까지 확정 안 되는 값이라, 폴더가 아니라 frontmatter의 account
    // 필드로 나중에 채우고 Dataview로 재조회한다(이벤트 로그는 쓴 뒤 옮기지 않는다).
    ledgerRoot: join(VAULT_ROOT, 'Facts', 'Ledger'),
    ledger: {
      executions: join(VAULT_ROOT, 'Facts', 'Ledger', 'Executions'), // 체결(주식+금현물)
      dividends: join(VAULT_ROOT, 'Facts', 'Ledger', 'Dividends'),
      fundPurchases: join(VAULT_ROOT, 'Facts', 'Ledger', 'FundPurchases'), // 아직 미배선(파서만 존재)
      // "이 시각에 이 계좌 잔고가 이 값이었다"는 사실 기록(잔고 재계산은 State 몫).
      // NH 4계좌는 카카오 입출금 알림 자동파싱, 연금저축·IRP는 알림이 없어 오너가
      // 앱에서 직접 확인한 값을 수동으로 기록 — 2026-08-18부터 자동/수동 구분 없이
      // 같은 폴더·같은 레코드 모양(cash-ledger.mjs resolveCashAnchor 참고).
      cashEvents: join(VAULT_ROOT, 'Facts', 'Ledger', 'CashEvents'),
      exchanges: join(VAULT_ROOT, 'Facts', 'Ledger', 'Exchanges'), // 아직 미배선(파서만 존재)
      // 2026-08-05 Phase 7(v1→Vault 마이그레이션) 추가 — v1 시트에 있었지만 지금까지
      // Ledger 하위폴더가 없던 2종. 실현손익은 체결(매수·매도) 두 이벤트의 파생값이라
      // 다시 계산할 수도 있지만, v1이 이미 계산해둔 값을 그대로 옮기는 쪽이 손실 없음
      // (재계산 로직은 Phase 8·9 몫). 일별스냅샷은 TWR·Sharpe·MDD 등 과거 성과 재계산에
      // 필요한 시계열이라 State(현재값만)가 아니라 Facts/Ledger(이력)에 둔다.
      profits: join(VAULT_ROOT, 'Facts', 'Ledger', 'Profits'),
      dailySnapshots: join(VAULT_ROOT, 'Facts', 'Ledger', 'DailySnapshots'),
    },
    // ⚠️ marketPolls(가격폴링·추세신호 원자료) 경로는 2026-08-17 삭제됨 — 전제였던
    // 폴링 기반 추세추종이 ADR-0012 추신에서 이미 기각돼 코드로 한 번도 안 만들어졌음
    // (ARCHITECTURE-V2.md "정리된 항목과 그 이유" 표 참고). 재사용 필요해지면 그때
    // 새로 설계해 추가할 것 — 옛 값 그대로 복원하지 말 것(전제 자체가 무효).
  },
  state: {
    holdings: join(VAULT_ROOT, 'State', 'Holdings'),
    allocation: join(VAULT_ROOT, 'State', 'Allocation'),
    baselines: join(VAULT_ROOT, 'State', 'Baselines'),
    // 잡 하트비트(1잡=1파일, 매번 덮어쓰기) — 구현계획서 Phase 3, v1 record-heartbeat.mjs의
    // Vault판. 폴더가 아니라 이 State 카테고리에 두는 이유: "지금 상태"이지 이벤트 로그가
    // 아니다(잡이 실행될 때마다 파일이 늘지 않고 같은 파일이 갱신됨).
    jobHealth: join(VAULT_ROOT, 'State', 'JobHealth'),
    // Faber 10개월 이평 "지난 확인 시점 상태"(위/아래) 저장 — 구현계획서 Phase 8.
    // 크로스(상태변화) 판정에 필요(macro-overlay.mjs detectFaberCrossover). 이벤트로그가
    // 아니라 "지금 상태"라 jobHealth와 같은 원칙(1파일=덮어쓰기).
    macroOverlay: join(VAULT_ROOT, 'State', 'MacroOverlay'),
    // 신규현금배분(new-cash-allocation.mjs) 재트리거 방지 상태 — 1계좌=1파일, "직전에
    // 어느 실잔고 값으로 이미 배분판단을 트리거했는가"만 기억(macroOverlay·jobHealth와
    // 같은 원칙, 덮어쓰기). ⚠️ 2026-08-18 재설계 — 원래(2026-08-16)는 "배당·매도로
    // 생긴 현금"을 이벤트 단위로 누적하는 방식이었으나, 재투자분을 못 빼 10배 부풀림
    // 사고가 나서(State 파일명은 예전 그대로 남김 — 물리 경로 변경은 최소화) 실잔고
    // (State/Holdings/{계좌}-예수금.md) 기반으로 전면 교체했다. 이제 "누적"이 아니라
    // "마지막으로 이 잔고값으로 트리거했다"는 dedup 마커일 뿐이다.
    cashAccumulator: join(VAULT_ROOT, 'State', 'CashAccumulator'),
    // 킬스위치·체결모드(섀도우|실전) — 시스템 전체에 하나뿐인 상태라 폴더가 아니라 단일
    // 파일(구현계획서 Phase 9, 제안 흐름 연결 — kill-switch.mjs·shadow-mode.mjs는
    // Phase 4에서 순수 판정 로직만 만들어졌고 실제 파일 경로는 없었다). 파일이 아직
    // 없으면 두 모듈 다 안전한 기본값(킬스위치 꺼짐·섀도우모드)으로 떨어지므로 최초
    // 배포 시 이 파일들을 미리 만들 필요는 없다.
    killSwitch: join(VAULT_ROOT, 'State', 'KillSwitch.md'),
    executionMode: join(VAULT_ROOT, 'State', 'ExecutionMode.md'),
    // 체결 완료된 제안 ID의 영속 목록(Phase 11, 2026-08-09) — 크래시 후 재실행돼도
    // 이미 체결된 제안이 다시 브로커에 나가지 않도록 하는 idempotency 저장소.
    // executed-orders.mjs 헤더 주석 참고. 파일 없으면(최초) 빈 목록으로 안전하게 폴백.
    executedOrders: join(VAULT_ROOT, 'State', 'ExecutedOrders.md'),
  },
  decisions: {
    evaluations: join(VAULT_ROOT, 'Decisions', 'Evaluations'),
    positionJournal: join(VAULT_ROOT, 'Decisions', 'PositionJournal'),
    proposals: join(VAULT_ROOT, 'Decisions', 'Proposals'),
    // 2026-08-05 Phase 7 추가 — v1 "리스크모니터" 탭(과거 리스크 판정 이력) 이관 대상.
    // Themis의 판정 결과이지 아직 미확정 안건이 아니므로 Decisions 대분류가 맞다.
    riskMonitor: join(VAULT_ROOT, 'Decisions', 'RiskMonitor'),
  },
  knowledge: {
    profile: join(VAULT_ROOT, 'Knowledge', 'Profile'),
    playbook: join(VAULT_ROOT, 'Knowledge', 'Playbook'),
    reports: join(VAULT_ROOT, 'Knowledge', 'Reports'),
    // 성향관찰(구 구글시트 "성향관찰" 탭) Vault 네이티브 대체 — 한 관찰당 파일 하나.
    // weekly-report.mjs(v2, 2026-08-20 재작성)가 유일한 쓰기 주체.
    preferenceObservations: join(VAULT_ROOT, 'Knowledge', 'Profile', 'PreferenceObservations'),
  },
};
