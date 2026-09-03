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
      fundPurchases: join(VAULT_ROOT, 'Facts', 'Ledger', 'FundPurchases'), // 2026-08-22 계좌귀속(연금저축)까지 배선 완료
      // 2026-09-03 신설 — 삼성증권 "펀드수익률 및 평가금액 안내"(매달 발송, 매수
      // 트리거가 아니라 정기 평가 스냅샷). FundPurchases와 성격이 달라 폴더 분리
      // (매수 이벤트가 아니라 "이 날짜 기준 원금·평가금액·수익률" 사실 기록) — 그래도
      // State가 아니라 Facts인 이유: 이 잡은 "원문 저장까지만" 책임진다는 파일 원칙
      // (parse-notifications-to-vault.mjs 헤더 참고) 그대로 유지, State/Holdings의
      // 현재값과 대조·검증하는 소비는 별도 몫으로 미룸(Strategy 문서 설계메모 참고).
      fundValuations: join(VAULT_ROOT, 'Facts', 'Ledger', 'FundValuations'),
      // "이 시각에 이 계좌 잔고가 이 값이었다"는 사실 기록(잔고 재계산은 State 몫).
      // NH 4계좌는 카카오 입출금 알림 자동파싱, 연금저축·IRP는 알림이 없어 오너가
      // 앱에서 직접 확인한 값을 수동으로 기록 — 2026-08-18부터 자동/수동 구분 없이
      // 같은 폴더·같은 레코드 모양(cash-ledger.mjs resolveCashAnchor 참고).
      cashEvents: join(VAULT_ROOT, 'Facts', 'Ledger', 'CashEvents'),
      exchanges: join(VAULT_ROOT, 'Facts', 'Ledger', 'Exchanges'), // 2026-08-22 계좌귀속(위탁)까지 배선 완료
      // 2026-08-05 Phase 7(v1→Vault 마이그레이션) 추가 — v1 시트에 있었지만 지금까지
      // Ledger 하위폴더가 없던 2종. 실현손익은 체결(매수·매도) 두 이벤트의 파생값이라
      // 다시 계산할 수도 있지만, v1이 이미 계산해둔 값을 그대로 옮기는 쪽이 손실 없음
      // (재계산 로직은 Phase 8·9 몫). 일별스냅샷은 TWR·Sharpe·MDD 등 과거 성과 재계산에
      // 필요한 시계열이라 State(현재값만)가 아니라 Facts/Ledger(이력)에 둔다.
      profits: join(VAULT_ROOT, 'Facts', 'Ledger', 'Profits'),
      dailySnapshots: join(VAULT_ROOT, 'Facts', 'Ledger', 'DailySnapshots'),
      // 2026-08-21 추가 — v1 "월별잔고" 시트(계좌별 월말 잔고+총잔고, 오너가 수동
      // 기록해온 이력) 1회성 이관(migrate-monthly-balance.mjs, 과거 2025-04~2026-07분).
      // 2026-08-22 오너 확정으로 v1 시트 의존을 완전히 끊음 —
      // update-monthly-balance-snapshot.mjs가 매일 State/Holdings 합산 총자산을
      // "이번 달" 파일에 덮어쓴다. 그래서 이 폴더는 두 종류가 섞여있다: 이미 끝난
      // 과거 달(더 이상 안 바뀜, legacy:true) + 이번 달(매일 갱신, legacy 필드 없음) —
      // 달이 바뀌면 그 달 파일은 자동으로 "과거 달" 쪽으로 편입된다(더 이상 안 쓰임).
      monthlyBalances: join(VAULT_ROOT, 'Facts', 'Ledger', 'MonthlyBalances'),
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
    // 장중 시장 급변 감시(intraday-market-move-monitor.mjs, 2026-09-01 신설) 신호별
    // 중복방지 마커 — 신호 1개=파일 1개(코스피·S&P500·VIX·DXY·USD/KRW·10Y수익률),
    // {date, tier} 덮어쓰기. jobHealth·macroOverlay와 같은 "지금 상태" 원칙.
    marketMoveMonitor: join(VAULT_ROOT, 'State', 'MarketMoveMonitor'),
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
    // 킬스위치·체결모드(섀도우|실전) — 시스템 전체에 하나뿐인 상태라는 성격은 그대로지만
    // (Phase 9), 2026-08-23 오너 지시로 State/ 바로 밑에 파일을 헐렁하게 흩어두지 않고
    // State의 다른 항목들(Holdings·Allocation·...)처럼 전부 자기 폴더 하나씩을 갖도록
    // 구조를 통일했다 — 폴더명=파일명(단일 상태 파일이라 개당 폴더 하나면 충분, 여러
    // 파일이 쌓이는 종류가 아님). 파일이 아직 없으면 두 모듈 다 안전한 기본값(킬스위치
    // 꺼짐·섀도우모드)으로 떨어지므로 최초 배포 시 이 파일들을 미리 만들 필요는 없다.
    killSwitch: join(VAULT_ROOT, 'State', 'KillSwitch', 'KillSwitch.md'),
    executionMode: join(VAULT_ROOT, 'State', 'ExecutionMode', 'ExecutionMode.md'),
    // 제안모드(허용|금지, 2026-08-29 신설) — 킬스위치·체결모드와 동일 패턴(파일 없으면
    // 안전한 기본값인 "허용"으로 폴백, proposal-mode.mjs 참고).
    proposalMode: join(VAULT_ROOT, 'State', 'ProposalMode', 'ProposalMode.md'),
    // 체결 완료된 제안 ID의 영속 목록(Phase 11, 2026-08-09) — 크래시 후 재실행돼도
    // 이미 체결된 제안이 다시 브로커에 나가지 않도록 하는 idempotency 저장소.
    // executed-orders.mjs 헤더 주석 참고. 파일 없으면(최초) 빈 목록으로 안전하게 폴백.
    executedOrders: join(VAULT_ROOT, 'State', 'ExecutedOrders', 'ExecutedOrders.md'),
    // 텔레그램 세션이 마지막으로 읽은 handoff 파일 마커(2026-08-29 신설) — SessionStart
    // 훅(scripts/hooks/telegram-session-context.mjs)이 매 세션 시작마다 갱신. "재시작
    // 시 이전 어떤 기록을 읽어왔다"는 오너 요구사항의 실제 증적.
    telegramSessionLastRead: join(VAULT_ROOT, 'State', 'TelegramSession', 'last-read.md'),
  },
  // Log/는 대부분 인터랙티브 세션이 Write 도구로 직접 쓰는 자유서술 기록이라 지금까지
  // VAULT_PATHS에 없었다(코드가 안 건드림) — telegramSession만 예외로 Node 잡
  // (telegram-session-handoff.mjs)이 직접 쓰는 구조화된 로그라 경로 상수가 필요하다.
  log: {
    telegramSession: join(VAULT_ROOT, 'Log', 'TelegramSession'),
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
