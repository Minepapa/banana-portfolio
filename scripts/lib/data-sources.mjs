// 데이터 출처 신선도 표 — import 없는 순수 상수(2026-11-03, 데이터 체계 개선 ④ "데이터 신선도 감시").
// health-watcher가 30분마다 이 표대로 출처를 읽어(data-freshness.mjs findStaleSources) 끊긴 출처를 알리고,
// 결과를 볼트 95_Etna/Jobs/DataFreshness.json에 남긴다. 잡 하트비트(JobHealth)는 "잡이 돌았나"만 보므로,
// 잡은 도는데 들어오는 데이터가 멈춘 경우(폰 앱 정지·알림 수집 끊김 등)를 여기서 따로 본다.
//
// 항목 필드:
// - id: 이슈 키(source:<id>:stale)와 DataFreshness.json의 키. 바꾸면 기존 경고 상태가 끊긴다.
// - owner: 그 데이터의 주인(6인 영문 키, job-owners.mjs 관례). 비긴급 묶음은 이 담당 이름으로 나간다.
// - producer: 데이터를 만드는 쪽. EXPECTED_INTERVALS_MS의 잡 이름 또는 'phone:*'(폰 앱).
//   producer 잡이 이미 '조용함' 경보 중이면 이 출처 경보는 내지 않는다(같은 고장을 두 번 알리지 않게).
// - probe: 읽는 방법. pathKey는 vault-paths.mjs VAULT_REL 키(경로 리터럴 금지).
//   events-type(아르고스 이벤트 jsonl에서 type·payload.kind로 거름) / dated-jsonl(날짜 파일별 줄 수) /
//   dated-files(날짜로 시작하는 파일 이름) / frontmatter-field(머리말 시각 칸) / file-mtime / not-collected.
// - kind: continuous(마지막 수신이 maxAgeMs보다 오래되면) / daily-rhythm(0건인 날이 zeroDays일 연속이거나,
//   날짜 파일이 마감 시각까지 없으면) / bursty(몰아서 들어옴 — 표시만) / market-day(직전 거래일 + 여유) /
//   display-only(표시만).
// - threshold: kind별 기준값. urgent: true면 처음 감지 즉시(processHealthIssues 일정), false면 09·19시 담당별 묶음.
// - liveness: 상위 채널 출처 id. 상위가 끊겼으면 이 출처 경보는 내지 않고 상위 한 건으로 묶는다.
//
// 임계값 근거(2026-11-03 볼트 실측 11일치 — 공개 저장소라 날짜·건수는 적지 않는다. 상세는 볼트 Requests):
// - core.heartbeat: 15분마다. 정상 간격 99%가 1시간 미만.
// - location.point_recorded: 정상 간격 99%가 20분 미만. 3시간 넘는 공백은 모두 상태 신호 공백과 겹쳤다
//   → 상태 신호가 살아 있는데 3시간 없으면 위치 수집만 멈춘 것.
// - notification.received: 0건인 날이 없었다. 밤 사이 최대 공백 16시간 → 24시간.
// - 통화(media.transferred kind=Calls): 0건인 날은 하루씩 떨어져서만 있었다 → 2일 연속이면 경보.
// - 카메라·카톡 사진: 며칠씩 비는 게 정상(몰아서 옮김) → 건수 경보 없음.
// - 소비(Spending): 0건인 날은 하루씩 떨어져서만 있었다 → 3일 연속이면 경보.

const HOUR_MS = 60 * 60 * 1000;

export const DATA_SOURCE_KINDS = Object.freeze(['continuous', 'daily-rhythm', 'bursty', 'market-day', 'display-only']);
export const PHONE_PRODUCERS = Object.freeze(['phone:argos', 'phone:kakao-notification']);

export const DATA_SOURCES = Object.freeze([
  {
    id: 'argos-heartbeat', label: '아르고스 상태 신호', owner: 'hermes',
    // 수신 잡(argos-ingest) 기대값 1시간 × 2와 같은 2시간. 수신 잡 자체가 조용하면 그쪽 경보로 갈음한다.
    producer: 'argos-ingest',
    probe: { type: 'events-type', pathKey: 'argosEvents', eventType: 'core.heartbeat' },
    kind: 'continuous', threshold: { maxAgeMs: 2 * HOUR_MS }, urgent: true, liveness: null,
  },
  {
    id: 'argos-location', label: '아르고스 위치점', owner: 'hermes', producer: 'phone:argos',
    probe: { type: 'events-type', pathKey: 'argosEvents', eventType: 'location.point_recorded' },
    kind: 'continuous', threshold: { maxAgeMs: 3 * HOUR_MS }, urgent: false, liveness: 'argos-heartbeat',
  },
  {
    id: 'argos-notifications', label: '아르고스 알림 수신', owner: 'hermes', producer: 'phone:argos',
    probe: { type: 'events-type', pathKey: 'argosEvents', eventType: 'notification.received' },
    kind: 'continuous', threshold: { maxAgeMs: 24 * HOUR_MS }, urgent: false, liveness: 'argos-heartbeat',
  },
  {
    id: 'argos-calls', label: '통화 녹음 전송', owner: 'athena', producer: 'phone:argos',
    probe: { type: 'events-type', pathKey: 'argosEvents', eventType: 'media.transferred', payloadKind: 'Calls' },
    kind: 'daily-rhythm', threshold: { zeroDays: 2 }, urgent: false, liveness: 'argos-heartbeat',
  },
  {
    id: 'argos-camera', label: '카메라 사진 전송', owner: 'athena', producer: 'phone:argos',
    probe: { type: 'events-type', pathKey: 'argosEvents', eventType: 'media.transferred', payloadKind: 'Camera', lookbackDays: 14 },
    kind: 'bursty', threshold: null, urgent: false, liveness: 'argos-heartbeat',
  },
  {
    id: 'argos-kakaotalk-media', label: '카톡 사진 전송', owner: 'athena', producer: 'phone:argos',
    probe: { type: 'events-type', pathKey: 'argosEvents', eventType: 'media.transferred', payloadKind: 'KakaoTalk', lookbackDays: 14 },
    kind: 'bursty', threshold: null, urgent: false, liveness: 'argos-heartbeat',
  },
  {
    // 녹음은 아직 아르고스가 받지 않는다(2026-11-03). 받기 시작하면 probe를 events-type으로 바꾼다.
    id: 'argos-recordings', label: '녹음 전송', owner: 'athena', producer: 'phone:argos',
    probe: { type: 'not-collected' },
    kind: 'display-only', threshold: null, urgent: false, liveness: null,
  },
  {
    id: 'spending', label: '소비 알림', owner: 'hermes', producer: 'phone:kakao-notification',
    probe: { type: 'dated-jsonl', pathKey: 'spending', layout: 'year', timeField: 'postedAt' },
    kind: 'daily-rhythm', threshold: { zeroDays: 3 }, urgent: false, liveness: null,
  },
  {
    // daily-note는 23:30 초안·05:00 확정. 다음날 02:00 KST까지 전날 노트가 없으면 통로가 죽은 것이다.
    id: 'daily-note', label: '데일리 노트', owner: 'clio', producer: 'daily-note',
    probe: { type: 'dated-files', pathKey: 'dailyNotes', layout: 'year', ext: '.md' },
    kind: 'daily-rhythm', threshold: { dueHourNextDayKst: 2, lookbackDays: 3 }, urgent: true, liveness: null,
  },
  {
    // 평일 07:05 계산. 거래일 10:00 KST까지 그날 계산이 없으면 묵은 것.
    id: 'macro-indicators', label: '거시지표', owner: 'plutus', producer: 'update-macro-indicators-cache',
    probe: { type: 'frontmatter-field', pathKey: 'macroIndicatorsFile', field: 'computedAt' },
    kind: 'market-day', threshold: { graceHoursKst: 10 }, urgent: false, liveness: null,
  },
  {
    // 장 마감(15:30) 뒤 시세가 반영된다. 거래일 18:00 KST까지 그날 갱신이 하나도 없으면 묵은 것.
    // 현금성(예수금 등)은 다른 잡이 갱신하므로 뺀다.
    id: 'holding-prices', label: '보유 시세', owner: 'plutus', producer: 'update-holdings-prices',
    probe: { type: 'frontmatter-field', pathKey: 'stateHoldings', field: 'updatedAt', skipIfTrue: 'isCashLike' },
    kind: 'market-day', threshold: { graceHoursKst: 18 }, urgent: false, liveness: null,
  },
  {
    // 매일 23:50 그날 스냅샷을 쓴다. 다음날 01:00 KST까지 없으면 빈칸.
    id: 'daily-snapshots', label: '일별 자산 스냅샷', owner: 'plutus', producer: 'update-monthly-balance-snapshot',
    probe: { type: 'dated-files', pathKey: 'factsLedgerDailySnapshots', layout: 'flat', ext: '.md' },
    kind: 'daily-rhythm', threshold: { dueHourNextDayKst: 1, lookbackDays: 14 }, urgent: false, liveness: null,
  },
  {
    // Open.json에는 생성 시각 칸이 없다. 파일 수정 시각만 보인다.
    id: 'todo-open', label: '열린 할 일', owner: 'hermes', producer: 'calendar-days',
    probe: { type: 'file-mtime', pathKey: 'todoOpen' },
    kind: 'display-only', threshold: null, urgent: false, liveness: null,
  },
  {
    // 체결은 매매가 없는 날이 정상이라 건수 경보를 하지 않는다. 마지막 체결일만 보인다.
    id: 'executions', label: '체결 기록', owner: 'plutus', producer: 'reconcile-nh-executions',
    probe: { type: 'dated-files', pathKey: 'factsLedgerExecutions', layout: 'flat', ext: '.md' },
    kind: 'display-only', threshold: null, urgent: false, liveness: null,
  },
]);

// VAULT_REL 중 95_Etna/ 아래 키의 성격. 새 키를 vault-paths에 넣고 여기 분류를 빠뜨리면 data-sources.test.js가 실패한다.
// - source(원천): 밖(폰·증권사·카카오·구글)에서 들어온 기록. 끊기면 다시 만들 수 없다.
// - derived(파생): 원천에서 다시 계산할 수 있는 것.
// - state(상태): 잡·대기열·설정이 쓰는 지금 상태와 처리 기록.
export const ETNA_PATH_CLASSES = Object.freeze({
  rootFilesBackup: 'derived',
  stateHoldings: 'state',
  stateAllocation: 'derived',
  stateBaselines: 'state',
  factsLedger: 'source',
  factsLedgerDividends: 'source',
  factsLedgerExecutions: 'source',
  factsLedgerProfits: 'source',
  factsLedgerDailySnapshots: 'derived',
  logWarningEvents: 'state',
  stateDeferredWarnings: 'state',
  decisionsProposals: 'state',
  inboxIngestProcessed: 'state',
  inboxIngestPlans: 'derived',
  inboxIngestWikiCandidates: 'derived',
  calendarDays: 'source',
  zeusHeadline: 'derived',
  themisVerdicts: 'state',
  location: 'source',
  argosEvents: 'source',
  locationCandidates: 'derived',
  locationGeocodeCache: 'derived',
  locationMaps: 'derived',
  locationDays: 'derived',
  locationToday: 'derived',
  mediaArchiveIndex: 'state',
  mediaImportsIndex: 'state',
  mediaVisionIndex: 'derived',
  mediaVisionLabels: 'derived',
  mediaImportAlbums: 'state',
  mediaFaceGallery: 'derived',
  mediaFacePeople: 'state',
  mediaImportMomentsState: 'state',
  mediaTranscripts: 'derived',
  mediaSpeakers: 'derived',
  mediaTranscribeState: 'state',
  mediaRenameLog: 'state',
  mineAthenaState: 'state',
  mediaMomentsState: 'state',
  mediaNightCheckFeed: 'derived',
  mediaOrbDailyFeed: 'derived',
  mediaArgosTrashState: 'state',
  jobHealth: 'state',
  spending: 'source',
  spendingMonthly: 'derived',
  spendingPlaces: 'derived',
  todoLog: 'state',
  todoOpen: 'source',
  mouseionConceptCounts: 'derived',
  mcpLossLogFile: 'state',
  stateBreakoutPositions: 'state',
  stateBreakoutPendingEntries: 'state',
  stateTelegramSession: 'state',
  telegramGatePromises: 'state',
  stateTelegramSessionHealth: 'state',
  stateWikiQuestions: 'state',
  stateInstrumentRescoring: 'state',
  stateQuarterlyAllocationReview: 'state',
  stateMorningBriefing: 'state',
  stateIsaMaturity: 'state',
  stateRebalanceProposal: 'state',
  stateRebalanceReminder: 'state',
  stateProposalResponseReminder: 'state',
  stateMacroTiltProposal: 'state',
  factsRawNotificationsApiCovered: 'source',
  macroIndicatorsFile: 'derived',
  dataFreshness: 'state',
  holdingsLedgerRecon: 'state',
});
