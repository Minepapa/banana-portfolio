// Vault 물리 경로 — 판테온·무세이온 이관 1단계(2026-10-07) 기본 위치는
// ~/Pantheon/Mouseion이다. 경로 정의는 이 파일과 vault-layout.mjs 두 곳에만 둔다.
// VAULT_PATH는 테스트·특수 실행에서 기본 경로를 덮어쓸 때 사용한다.

import { join } from 'node:path';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';

export const VAULT_ROOT = process.env.VAULT_PATH || join(homedir(), 'Pantheon', 'Mouseion');

export const VAULT_REL = {
  agentCharters: '90_Delphi/Agents',
  // 루트(~/Pantheon) 파일 사본 — 어떤 git에도 속하지 않는 루트 파일을 볼트 git·암호화 백업에 태운다(이관 4-7).
  rootFilesBackup: '95_Etna/Jobs/RootFiles',
  telegramChannelFile: '90_Delphi/Channels/텔레그램 세션 운영 규칙.md', // 2026-10-10 '텔레그램'에서 개명
  calendarOwnersFile: '90_Delphi/Config/캘린더 소유자.md',
  telegramInputRulesFile: '90_Delphi/Channels/텔레그램 입력 규칙.md', // 텔레그램 입력 형식 정본 — 세션 시작 때 주입(2026-10-10)
  archivedAgentDefs: '80_Archive/agents-2026-10-08',
  stateHoldings: '95_Etna/Investing/Holdings',
  stateAllocation: '95_Etna/Investing/Allocation',
  stateBaselines: '95_Etna/Investing/Baselines',
  factsLedger: '95_Etna/Investing/Ledger',
  factsLedgerDividends: '95_Etna/Investing/Ledger/Dividends',
  factsLedgerExecutions: '95_Etna/Investing/Ledger/Executions',
  factsLedgerProfits: '95_Etna/Investing/Ledger/Profits',
  logImplementation: '40_Projects/banana-portfolio/Implementation',
  logDevRequests: '40_Projects/banana-portfolio/Requests',
  logStrategy: '50_Outputs/Decisions',
  decisionsCanonical: '50_Outputs/Decisions',
  logSessions: '60_Logs/Zeus',
  logWarningEvents: '95_Etna/Jobs/WarningEvents',
  decisionsProposals: '95_Etna/Investing/Orders',
  decisionsProfile: '20_Records/21_Notes',
  knowledge: '30_Wiki',
  knowledgeTopics: '30_Wiki/34_Topics',
  wikiObjects: '30_Wiki/33_Objects',
  projectFeatures: '40_Projects/banana-portfolio/Features',
  knowledgeMeta: '90_Delphi',
  knowledgeInfra: '30_Wiki/34_Topics',
  knowledgeApi: '30_Wiki/34_Topics',
  knowledgeIndexFile: '90_Delphi/index.md',
  knowledgeMetaIndexFile: '80_Archive/Knowledge/Meta/Index.md',
  wiringMapFile: '90_Delphi/Schema/파일 배선도.md', // 4-7: 경로 등록부(정본)와 분리
  // 2026-10-08 등록부 정리: 90_Delphi 바로 아래 운영 문서를 등록부가 정한 하위 폴더로 옮겼다.
  registryFile: '90_Delphi/Schema/경로 등록부.md',
  homeDir: '01_Home', // 카테고리 노트 폴더(category 링크 대상)
  portfolioKpiTopics: '30_Wiki/34_Topics/PortfolioKPI', // 폴더는 영문 유지, 노트 제목만 한글(2026-10-08)
  inboxRoot: '00_Inbox',
  periodicRoot: '10_Periodic',
  people: '30_Wiki/31_People', // 헤르메스 생일 브리핑 대상
  places: '30_Wiki/32_Places',
  location: '95_Etna/Location',
  locationCandidates: '95_Etna/Location/place-candidates.json',
  locationGeocodeCache: '95_Etna/Location/geocode-cache.json',
  jobHealth: '95_Etna/Jobs/JobHealth',
  spending: '95_Etna/Spending',
  dailyNotes: '10_Periodic/Daily', // 데일리 노트(D85) — {YYYY}/YYYY-MM-DD.md
  // 등록부 lint 범위 밖 최상위 폴더: 보관본(원래 type 유지)·코드가 쓰는 기계 데이터·금고(내용을 읽지 않음)
  archiveRoot: '80_Archive',
  etnaRoot: '95_Etna',
  adytonRoot: '99_Adyton',
  statusStandardFile: '90_Delphi/Schema/상태표준.md',
  jobCatalogFile: '90_Delphi/Schema/무인잡-카탈로그.md',
  departmentReportFile: '90_Delphi/Channels/텔레그램 발신 카탈로그.md', // 2026-10-10 '부서별-텔레그램-보고'에서 개명
  mcpLossLogFile: '95_Etna/Jobs/mcp-loss-diagnostics.md',
  stateBreakoutPositions: '95_Etna/Investing/BreakoutPositions',
  stateBreakoutPendingEntries: '95_Etna/Investing/BreakoutPendingEntries',
  stateTelegramSession: '95_Etna/Jobs/TelegramSession',
  stateTelegramSessionHealth: '95_Etna/Jobs/TelegramSessionHealth',
  stateWikiQuestions: '95_Etna/Questions',
  stateInstrumentRescoring: '95_Etna/Investing/InstrumentRescoring',
  stateQuarterlyAllocationReview: '95_Etna/Investing/QuarterlyAllocationReview',
  stateMorningBriefing: '95_Etna/Investing/MorningBriefing',
  stateIsaMaturity: '95_Etna/Investing/IsaMaturity',
  stateRebalanceProposal: '95_Etna/Investing/RebalanceProposal',
  stateRebalanceReminder: '95_Etna/Investing/RebalanceReminder',
  stateProposalResponseReminder: '95_Etna/Investing/ProposalResponseReminder',
  stateMacroTiltProposal: '95_Etna/Investing/MacroTiltProposal',
  factsLedgerExecutions: '95_Etna/Investing/Ledger/Executions',
  factsLedgerProfits: '95_Etna/Investing/Ledger/Profits',
  factsRawNotificationsApiCovered: '95_Etna/Investing/RawNotifications/ExecutionApiCovered',
};

export function vaultAbs(rel) { return join(VAULT_ROOT, ...rel.split('/')); }

export function vaultYearDir(baseAbsDir, date = new Date()) {
  const year = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Seoul', year: 'numeric' })
    .format(date instanceof Date ? date : new Date(date));
  return join(baseAbsDir, year);
}

export function vaultYearFiles(baseAbsDir) {
  if (!existsSync(baseAbsDir)) return [];
  return readdirSync(baseAbsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^\d{4}$/.test(entry.name))
    .flatMap((entry) => readdirSync(join(baseAbsDir, entry.name))
      .filter((name) => name.endsWith('.md'))
      .map((name) => join(baseAbsDir, entry.name, name)));
}

export const VAULT_PATHS = {
  root: VAULT_ROOT,
  spending: vaultAbs(VAULT_REL.spending),
  location: {
    root: vaultAbs(VAULT_REL.location),
    candidates: vaultAbs(VAULT_REL.locationCandidates),
    geocodeCache: vaultAbs(VAULT_REL.locationGeocodeCache),
    places: vaultAbs(VAULT_REL.places),
  },
  facts: {
    // Ledger는 이벤트 종류별로 하위폴더를 나눈다(2026-08-04 확정, 오너 요청) — 카카오
    // 알림이 파싱하는 6종(체결·배당·펀드매수·예수금앵커·환전 + 금현물)이 전부 같은
    // 평평한 폴더에 뒤섞이면 옵시디언에서 원본을 훑어보기 어렵다. 금현물은 v1에서
    // "별도 원장으로 뒀다가 버그(클로버 원인)가 나서 체결내역에 통합"한 전례가 있어
    // 여기서도 Executions에 합친다(별도 폴더 만들지 않음) — 같은 실수 반복 방지.
    // 계좌(위탁·ISA 등) 기준 폴더는 만들지 않는다 — 계좌 귀속은 State/Holdings 설계
    // (Phase 8·9) 전까지 확정 안 되는 값이라, 폴더가 아니라 frontmatter의 account
    // 필드로 나중에 채우고 Dataview로 재조회한다(이벤트 로그는 쓴 뒤 옮기지 않는다).
    ledgerRoot: join(VAULT_ROOT, '95_Etna', 'Investing', 'Ledger'),
    ledger: {
      executions: join(VAULT_ROOT, '95_Etna', 'Investing', 'Ledger', 'Executions'), // 체결(주식+금현물)
      dividends: join(VAULT_ROOT, '95_Etna', 'Investing', 'Ledger', 'Dividends'),
      fundPurchases: join(VAULT_ROOT, '95_Etna', 'Investing', 'Ledger', 'FundPurchases'), // 2026-08-22 계좌귀속(연금저축)까지 배선 완료
      // 2026-09-03 신설 — 삼성증권 "펀드수익률 및 평가금액 안내"(매달 발송, 매수
      // 트리거가 아니라 정기 평가 스냅샷). FundPurchases와 성격이 달라 폴더 분리
      // (매수 이벤트가 아니라 "이 날짜 기준 원금·평가금액·수익률" 사실 기록) — 그래도
      // State가 아니라 Facts인 이유: 이 잡은 "원문 저장까지만" 책임진다는 파일 원칙
      // (parse-notifications-to-vault.mjs 헤더 참고) 그대로 유지, State/Holdings의
      // 현재값과 대조·검증하는 소비는 별도 몫으로 미룸(Strategy 문서 설계메모 참고).
      fundValuations: join(VAULT_ROOT, '95_Etna', 'Investing', 'Ledger', 'FundValuations'),
      // "이 시각에 이 계좌 잔고가 이 값이었다"는 사실 기록(잔고 재계산은 State 몫).
      // NH 4계좌는 카카오 입출금 알림 자동파싱, 연금저축·IRP는 알림이 없어 오너가
      // 앱에서 직접 확인한 값을 수동으로 기록 — 2026-08-18부터 자동/수동 구분 없이
      // 같은 폴더·같은 레코드 모양(cash-ledger.mjs resolveCashAnchor 참고).
      cashEvents: join(VAULT_ROOT, '95_Etna', 'Investing', 'Ledger', 'CashEvents'),
      exchanges: join(VAULT_ROOT, '95_Etna', 'Investing', 'Ledger', 'Exchanges'), // 2026-08-22 계좌귀속(위탁)까지 배선 완료
      // 2026-08-05 Phase 7(v1→Vault 마이그레이션) 추가 — v1 시트에 있었지만 지금까지
      // Ledger 하위폴더가 없던 2종. 실현손익은 체결(매수·매도) 두 이벤트의 파생값이라
      // 다시 계산할 수도 있지만, v1이 이미 계산해둔 값을 그대로 옮기는 쪽이 손실 없음
      // (재계산 로직은 Phase 8·9 몫). 일별스냅샷은 TWR·Sharpe·MDD 등 과거 성과 재계산에
      // 필요한 시계열이라 State(현재값만)가 아니라 Facts/Ledger(이력)에 둔다.
      profits: join(VAULT_ROOT, '95_Etna', 'Investing', 'Ledger', 'Profits'),
      dailySnapshots: join(VAULT_ROOT, '95_Etna', 'Investing', 'Ledger', 'DailySnapshots'),
      // 2026-08-21 추가 — v1 "월별잔고" 시트(계좌별 월말 잔고+총잔고, 오너가 수동
      // 기록해온 이력) 1회성 이관(migrate-monthly-balance.mjs, 과거 2025-04~2026-07분).
      // 2026-08-22 오너 확정으로 v1 시트 의존을 완전히 끊음 —
      // update-monthly-balance-snapshot.mjs가 매일 State/Holdings 합산 총자산을
      // "이번 달" 파일에 덮어쓴다. 그래서 이 폴더는 두 종류가 섞여있다: 이미 끝난
      // 과거 달(더 이상 안 바뀜, legacy:true) + 이번 달(매일 갱신, legacy 필드 없음) —
      // 달이 바뀌면 그 달 파일은 자동으로 "과거 달" 쪽으로 편입된다(더 이상 안 쓰임).
      monthlyBalances: join(VAULT_ROOT, '95_Etna', 'Investing', 'Ledger', 'MonthlyBalances'),
    },
    // ⚠️ marketPolls(가격폴링·추세신호 원자료) 경로는 2026-08-17 삭제됨 — 전제였던
    // 폴링 기반 추세추종이 ADR-0012 추신에서 이미 기각돼 코드로 한 번도 안 만들어졌음
    // (ARCHITECTURE-V2.md "정리된 항목과 그 이유" 표 참고). 재사용 필요해지면 그때
    // 새로 설계해 추가할 것 — 옛 값 그대로 복원하지 말 것(전제 자체가 무효).
  },
  state: {
    holdings: join(VAULT_ROOT, '95_Etna', 'Investing', 'Holdings'),
    allocation: join(VAULT_ROOT, '95_Etna', 'Investing', 'Allocation'),
    baselines: join(VAULT_ROOT, '95_Etna', 'Investing', 'Baselines'),
    // 잡 하트비트(1잡=1파일, 매번 덮어쓰기) — 구현계획서 Phase 3, v1 record-heartbeat.mjs의
    // Vault판. 폴더가 아니라 이 State 카테고리에 두는 이유: "지금 상태"이지 이벤트 로그가
    // 아니다(잡이 실행될 때마다 파일이 늘지 않고 같은 파일이 갱신됨).
    jobHealth: join(VAULT_ROOT, '95_Etna', 'Jobs', 'JobHealth'),
    // 장중 시장 급변 감시(intraday-market-move-monitor.mjs, 2026-09-01 신설) 신호별
    // 중복방지 마커 — 신호 1개=파일 1개(코스피·S&P500·VIX·DXY·USD/KRW·10Y수익률),
    // {date, tier} 덮어쓰기. jobHealth·macroOverlay와 같은 "지금 상태" 원칙.
    marketMoveMonitor: join(VAULT_ROOT, '95_Etna', 'Investing', 'MarketMoveMonitor'),
    // Faber 10개월 이평 "지난 확인 시점 상태"(위/아래) 저장 — 구현계획서 Phase 8.
    // 크로스(상태변화) 판정에 필요(macro-overlay.mjs detectFaberCrossover). 이벤트로그가
    // 아니라 "지금 상태"라 jobHealth와 같은 원칙(1파일=덮어쓰기).
    macroOverlay: join(VAULT_ROOT, '95_Etna', 'Investing', 'MacroOverlay'),
    // 신규현금배분(new-cash-allocation.mjs) 재트리거 방지 상태 — 1계좌=1파일, "직전에
    // 어느 실잔고 값으로 이미 배분판단을 트리거했는가"만 기억(macroOverlay·jobHealth와
    // 같은 원칙, 덮어쓰기). ⚠️ 2026-08-18 재설계 — 원래(2026-08-16)는 "배당·매도로
    // 생긴 현금"을 이벤트 단위로 누적하는 방식이었으나, 재투자분을 못 빼 10배 부풀림
    // 사고가 나서(State 파일명은 예전 그대로 남김 — 물리 경로 변경은 최소화) 실잔고
    // (State/Holdings/{계좌}-예수금.md) 기반으로 전면 교체했다. 이제 "누적"이 아니라
    // "마지막으로 이 잔고값으로 트리거했다"는 dedup 마커일 뿐이다.
    cashAccumulator: join(VAULT_ROOT, '95_Etna', 'Investing', 'CashAccumulator'),
    // 킬스위치·체결모드(섀도우|실전) — 시스템 전체에 하나뿐인 상태라는 성격은 그대로지만
    // (Phase 9), 2026-08-23 오너 지시로 State/ 바로 밑에 파일을 헐렁하게 흩어두지 않고
    // State의 다른 항목들(Holdings·Allocation·...)처럼 전부 자기 폴더 하나씩을 갖도록
    // 구조를 통일했다 — 폴더명=파일명(단일 상태 파일이라 개당 폴더 하나면 충분, 여러
    // 파일이 쌓이는 종류가 아님). 파일이 아직 없으면 두 모듈 다 안전한 기본값(킬스위치
    // 꺼짐·섀도우모드)으로 떨어지므로 최초 배포 시 이 파일들을 미리 만들 필요는 없다.
    killSwitch: join(VAULT_ROOT, '95_Etna', 'Investing', 'KillSwitch', 'KillSwitch.md'),
    executionMode: join(VAULT_ROOT, '95_Etna', 'Investing', 'ExecutionMode', 'ExecutionMode.md'),
    // 제안모드(허용|금지, 2026-08-29 신설) — 킬스위치·체결모드와 동일 패턴(파일 없으면
    // 안전한 기본값인 "허용"으로 폴백, proposal-mode.mjs 참고).
    proposalMode: join(VAULT_ROOT, '95_Etna', 'Investing', 'ProposalMode', 'ProposalMode.md'),
    // 체결 완료된 제안 ID의 영속 목록(Phase 11, 2026-08-09) — 크래시 후 재실행돼도
    // 이미 체결된 제안이 다시 브로커에 나가지 않도록 하는 idempotency 저장소.
    // executed-orders.mjs 헤더 주석 참고. 파일 없으면(최초) 빈 목록으로 안전하게 폴백.
    executedOrders: join(VAULT_ROOT, '95_Etna', 'Investing', 'ExecutedOrders', 'ExecutedOrders.md'),
    // 텔레그램 세션이 마지막으로 읽은 handoff 파일 마커(2026-08-29 신설) — SessionStart
    // 훅(scripts/hooks/telegram-session-context.mjs)이 매 세션 시작마다 갱신. "재시작
    // 시 이전 어떤 기록을 읽어왔다"는 오너 요구사항의 실제 증적.
    telegramSessionLastRead: join(VAULT_ROOT, '95_Etna', 'Jobs', 'TelegramSession', 'last-read.md'),
    // 거시지표(fetchMacroIndicators) 공유 캐시(2026-09-06 신설) — macro-cache.mjs 참고.
    // KST 달력일 하나당 계산 1회만 — 같은 날 여러 무인 잡(Themis·weekly-report·
    // quarterly-review)이 각자 독립 호출하다 서로 다른 수치를 내던 사고 방지.
    macroIndicators: join(VAULT_ROOT, '95_Etna', 'Investing', 'MacroIndicators', 'MacroIndicators.md'),
    // monthly-macro-tilt-proposal.mjs 전용 Faber 크로스 상태(2026-09-06 신설, "자산분배
    // 트랙 핵심 로직 설계" §4) — daily-asset-allocation-check.mjs가 매 평일 갱신하는
    // State/MacroOverlay(macroOverlay 키)와 의도적으로 분리된 폴더. 같은 파일을 공유하면
    // "직전 확인"이 매일 도는 일일 점검 기준이 돼버려 이 잡의 월간 크로스 판정이 무의미
    // 해진다 — macro-overlay-facts.mjs readPreviousFaberState/writeFaberState의
    // stateDir 파라미터로 이 경로를 넘겨 쓴다.
    macroTiltProposal: join(VAULT_ROOT, '95_Etna', 'Investing', 'MacroTiltProposal'),
    // 돌파매매 전략(퀀트 트랙, 2026-09-13 실전 구현) 포지션 상태 — 포지션 1건=파일
    // 1개(proposals·holdings와 같은 폴더 패턴, breakout-position-vault.mjs 참고).
    // "지금 상태"이면서 동시에 "이력"(청산 후에도 파일을 지우지 않고 status만
    // 갱신 — proposal-vault.mjs와 동일 이유, 나중에 되짚기 위함)이라 killSwitch류
    // 단일파일이 아니라 holdings류 폴더로 분류.
    breakoutPositions: join(VAULT_ROOT, '95_Etna', 'Investing', 'BreakoutPositions'),
    // 돌파매매 진입이 장후시간외(15:40~16:00)에서 전혀 체결 안 됐을 때(다음날 시가로
    // 넘겨야 할 항목) 대기열 — 대기 1건=파일 1개(breakoutPositions와 동일 패턴),
    // breakout-pending-entry-vault.mjs 참고. place-breakout-entry-order.mjs가 쓰고
    // place-breakout-fallback-entry.mjs(시가 근처 실행)가 읽어 소비한다.
    breakoutPendingEntries: join(VAULT_ROOT, '95_Etna', 'Investing', 'BreakoutPendingEntries'),
    // 일별 신호스캔 잡(daily-breakout-signal-scan.mjs)의 하루 1회 실행 보장 마커 —
    // monthly-macro-tilt-proposal.mjs의 last-month.md와 동일 원칙(1파일=덮어쓰기,
    // "오늘 이미 돌았다"만 기억). 코드리뷰 HIGH 지적(2026-09-13) 재발방지 — 재실행이
    // 같은 신호를 또 발주하는 이중매수를 막는다.
    breakoutScanRuns: join(VAULT_ROOT, '95_Etna', 'Investing', 'BreakoutScanRuns', 'last-run.md'),
    // 자동 체결기록이 계좌·원본 정합을 확정할 수 없을 때 오너 확인을 기다리는 대기열 —
    // 대기 건 1개=파일 1개. 원문 Firestore 문서는 확인 완료 뒤에만 삭제한다.
    executionConfirmations: join(VAULT_ROOT, '95_Etna', 'Investing', 'ExecutionConfirmations'),
  },
  // Log/는 대부분 인터랙티브 세션이 Write 도구로 직접 쓰지만, 자동 리포트와
  // TelegramSession은 Node 잡도 기록하므로 해당 경로를 상수로 관리한다.
  log: {
    telegramSession: join(VAULT_ROOT, '60_Logs', 'Zeus', 'Telegram'),
    reports: join(VAULT_ROOT, '50_Outputs', 'Reports'),
    // 2026-09-04 신설 — weekly-vault-health-check.mjs가 progress:"진행중"/"보류" 문서와
    // "## 남은 것" 섹션을 훑어 미완료 작업을 집계하려면 코드가 이 폴더들을 직접 읽어야
    // 한다(CLAUDE.md "완료 상태 추적" 절이 progress 필드를 규정하는 대상 그대로).
    implementation: join(VAULT_ROOT, '40_Projects', 'banana-portfolio', 'Implementation'),
    devRequests: join(VAULT_ROOT, '40_Projects', 'banana-portfolio', 'Requests'),
  },
  decisions: {
    evaluations: join(VAULT_ROOT, '95_Etna', 'Investing', 'Evaluations'),
    positionJournal: join(VAULT_ROOT, '95_Etna', 'Investing', 'PositionJournal'),
    proposals: join(VAULT_ROOT, '95_Etna', 'Investing', 'Orders'),
    // 주간 리포트에서 자동 추출한 투자성향 관찰과 승격 상태 기록.
    profile: join(VAULT_ROOT, '20_Records', '21_Notes'),
    // 2026-08-05 Phase 7 추가 — v1 "리스크모니터" 탭(과거 리스크 판정 이력) 이관 대상.
    // Themis의 판정 결과이지 아직 미확정 안건이 아니므로 Decisions 대분류가 맞다.
    riskMonitor: join(VAULT_ROOT, '95_Etna', 'Investing', 'RiskMonitor'),
  },
  knowledge: {
    playbook: join(VAULT_ROOT, '30_Wiki', '34_Topics'),
    // 2026-09-04 므네모시네 대정리에서 신설 — weekly-vault-health-check.mjs가 고립
    // 노트·"자동 갱신" 주장 대비 최신성을 이 세 폴더 대상으로 점검한다.
    topics: join(VAULT_ROOT, '30_Wiki', '34_Topics'),
    meta: join(VAULT_ROOT, '90_Delphi'),
    infra: join(VAULT_ROOT, '30_Wiki', '34_Topics'),
  },
};

// 카테고리 노트 위키링크(예: categoryLink('700 자산') → '[[01_Home/700 자산]]').
export function categoryLink(name) {
  return `[[${VAULT_REL.homeDir}/${name}]]`;
}
