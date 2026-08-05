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
      cashEvents: join(VAULT_ROOT, 'Facts', 'Ledger', 'CashEvents'), // NH 입금·출금 원문(잔고 재계산은 State 몫)
      exchanges: join(VAULT_ROOT, 'Facts', 'Ledger', 'Exchanges'), // 아직 미배선(파서만 존재)
      // 2026-08-05 Phase 7(v1→Vault 마이그레이션) 추가 — v1 시트에 있었지만 지금까지
      // Ledger 하위폴더가 없던 2종. 실현손익은 체결(매수·매도) 두 이벤트의 파생값이라
      // 다시 계산할 수도 있지만, v1이 이미 계산해둔 값을 그대로 옮기는 쪽이 손실 없음
      // (재계산 로직은 Phase 8·9 몫). 일별스냅샷은 TWR·Sharpe·MDD 등 과거 성과 재계산에
      // 필요한 시계열이라 State(현재값만)가 아니라 Facts/Ledger(이력)에 둔다.
      profits: join(VAULT_ROOT, 'Facts', 'Ledger', 'Profits'),
      dailySnapshots: join(VAULT_ROOT, 'Facts', 'Ledger', 'DailySnapshots'),
    },
    marketPolls: join(VAULT_ROOT, 'Facts', 'MarketPolls'),
  },
  state: {
    holdings: join(VAULT_ROOT, 'State', 'Holdings'),
    allocation: join(VAULT_ROOT, 'State', 'Allocation'),
    baselines: join(VAULT_ROOT, 'State', 'Baselines'),
    // 잡 하트비트(1잡=1파일, 매번 덮어쓰기) — 구현계획서 Phase 3, v1 record-heartbeat.mjs의
    // Vault판. 폴더가 아니라 이 State 카테고리에 두는 이유: "지금 상태"이지 이벤트 로그가
    // 아니다(잡이 실행될 때마다 파일이 늘지 않고 같은 파일이 갱신됨).
    jobHealth: join(VAULT_ROOT, 'State', 'JobHealth'),
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
  },
};
