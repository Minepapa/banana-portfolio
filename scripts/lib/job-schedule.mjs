// 잡 기대 실행 주기 정본 — import 없는 순수 상수(2026-10-30, health-watcher.mjs에서 분리).
// health-watcher(무인 감시)와 올림푸스 대시보드 서버가 같이 읽는다. 대시보드가 발송 모듈을 끌어오지 않게 여기에는 import를 두지 않는다.
// 등록 강제: run.sh가 디스패치하는 잡은 전부 여기 있어야 한다(health-watcher.test.js 구조적 가드).
//
// 잡별 기대 실행 주기 — 새 v2 잡이 생길 때마다 여기 추가한다(구현계획서 Phase 5+).
// 목록에 없는 새 잡 하트비트는 기본 1시간 주기로 감시한다. 폐지·중단 잡만 명시적으로 제외한다.
//
// ⚠️ 전수 재점검(2026-08-23, 오너 지시 — "지금 적용한 사항 모든 잡에 동일하게") —
// update-monthly-balance-snapshot·weekly-report 오알람을 고치면서, 등록된 launchd
// 잡 16개 전체를 실제 StartCalendarInterval/StartInterval과 대조했다. 이 표가
// "새 잡 추가 시 누락"뿐 아니라 "평일 전용 잡의 주말 간격"도 놓치고 있었다 —
// 둘 다 여기서 함께 고친다.
export const EXPECTED_INTERVALS_MS = {
  'media-archive': 60 * 60 * 1000,
  'media-moments': 60 * 60 * 1000,
  'media-audio': 24 * 60 * 60 * 1000, // 02:00 음성 블록(전사 → 화자 분리)
  'media-photo': 24 * 60 * 60 * 1000, // 03:00 사진 블록(장면 분석 → 얼굴 이름표)
  'media-video': 24 * 60 * 60 * 1000,
  'media-night-check': 24 * 60 * 60 * 1000, // 매일 05:00 밤 점검
  'media-delete-report-weekly': 7 * 24 * 60 * 60 * 1000,
  'media-faces-hold-monthly': 35 * 24 * 60 * 60 * 1000,
  'media-memory-orb': null, // 오너의 재개 기준 확정 전까지 의도적으로 중단
  'media-audio-offsite-backup': 24 * 60 * 60 * 1000,
  // 위치 수신이 12시간 없으면 폰 앱·Tailscale 점검.
  'owntracks-receiver': 12 * 60 * 60 * 1000,
  // 일정 파일 정본(2026-10-30, 15분마다). 30분으로 등록해 1시간 동안 기록이 없으면 알린다 — 조회 실패는
  // 두 번 연속이면 잡 실패 경보가 따로 나간다.
  'calendar-days': 30 * 60 * 1000,
  // 올림푸스 대시보드 상시 서버(2026-10-30). 요청과 무관하게 30분마다 상태를 남기므로 1시간 간격 —
  // 2시간 동안 기록이 없으면 서버가 죽었거나 시작에 실패한 것이다.
  'olympus-server': 60 * 60 * 1000,
  // 아르고스 수신(owntracks-receiver 프로세스의 /ingest, launchd 잡 아님). 폰 하트비트가 15분
  // 마다 오므로 1시간 간격으로 등록한다 — isStale은 간격의 2배를 넘겨야 알리므로 2시간 동안
  // 받은 이벤트가 없으면 경보(2026-10-29). 아르고스를 끄면(argos.json 삭제) 이 값을 null로 바꾼다.
  'argos-ingest': 60 * 60 * 1000,
  // ⚠️ 재수정(2026-08-28, 오너 지시) — 평일 16:00 하루 1회(StartCalendarInterval)에서
  // 상시 10분 간격(StartInterval=600)으로 변경. 아래 sync-firestore-mirror 등과 동일
  // 이유로 등록값도 실제 주기와 같이 움직여야 한다.
  'parse-notifications-to-vault': 10 * 60 * 1000,
  'ingest-spending-inbox': 10 * 60 * 1000,
  // ⚠️ 버그 수정(2026-08-14, 오너 신고 — 30분마다 알람 반복) — backup-vault는 밤 23:50
  // 하루 1회만 도는 잡인데(scripts/launchd/com.banana2.backup-vault.plist,
  // StartCalendarInterval) 여기 항목이 없어 기본값(1시간)이 적용됐다. 그 결과 정상
  // 실행 후 2시간(기대주기×2)만 지나면 매일 "조용하다"고 오판해 다음날 23:50까지
  // 22시간 동안 30분마다 계속 알림이 나갔다 — 이 잡을 처음 활성화할 때(2026-08-13)
  // backup-vault의 실제(하루 1회) 주기를 안 넣은 설정 누락. (⚠️ 이 잡은 요일 제한이
  // 없는 매일 실행이라 위 평일전용 잡들과 달리 24h를 그대로 유지 — 주말 간격 문제
  // 없음.)
  'backup-vault': 24 * 60 * 60 * 1000,
  'vault-offsite-backup': 24 * 60 * 60 * 1000,
  // question-digest(2026-10-09 신설) — 매일 09:00·19:00 비긴급 질문 묶음 발송. 최대 간격 14시간, 여유 포함 24시간.
  'question-digest': 24 * 60 * 60 * 1000,
  // daily-note(2026-10-09 신설) — 23:30 초안·05:00 확정, 최대 간격 18.5시간, 여유 포함 24시간.
  'daily-note': 24 * 60 * 60 * 1000,
  'clio-inbox-ingest': 24 * 60 * 60 * 1000,
  // hermes-briefing(D86) — 07:30·21:00 매일 두 번, 여유 포함 24시간.
  'hermes-briefing': 24 * 60 * 60 * 1000,
  // telegram-session-handoff(2026-08-29 신설) — 매일 03:55 KST 하루 1회, 요일 제한
  // 없음(텔레그램 세션 자체가 주말에도 응답하므로 restart와 동일 원칙) — backup-vault와
  // 같은 클래스.
  'telegram-session-handoff': 24 * 60 * 60 * 1000,
  // daily-asset-allocation-check도 backup-vault와 같은 이유로 하루 1회 잡 — 처음부터
  // 여기 넣어 같은 오탐이 재발하지 않게 한다(2026-08-14). ⚠️ 평일 전용이라 2026-08-23
  // 48h로 상향(위 parse-notifications-to-vault 주석과 동일 사유).
  'daily-asset-allocation-check': 48 * 60 * 60 * 1000,
  // update-holdings-from-executions(2026-08-15 신설 스케줄) — 로직 자체는 이미 있었지만
  // (퀀트 체결은 KIS API가 정본이라 skip, 그 외 자산분배 트랙 체결만 반영) 무인 스케줄이
  // 없어 watch-order-fill.mjs의 퀀트 트리거에만 의존하던 잡. 평일 16:05 KST 하루 1회
  // (parse-notifications-to-vault 16:00 직후). ⚠️ 평일 전용, 2026-08-23 48h로 상향.
  'update-holdings-from-executions': 48 * 60 * 60 * 1000,
  // new-cash-allocation은 2026-08-16 신설 다음날(08-17) 10배 부풀림 사고로 잠정
  // 중단됐다가, 예수금앵커 배선 완료 후 실잔고 기반으로 전면 재작성돼 2026-08-18
  // 재활성화됐다(오너 확인) — 상세 경위는 job-labels.mjs·new-cash-allocation.mjs
  // 헤더 주석 참고. 평일 16:13 하루 1회(update-cash-from-ledger 16:10 직후).
  // ⚠️ 평일 전용, 2026-08-23 48h로 상향.
  'new-cash-allocation': 48 * 60 * 60 * 1000,
  // reconcile-irp·update-cash-from-ledger(2026-08-18 신설 — 예수금앵커 배선 마지막
  // 조립) 둘 다 평일 16:07·16:10 하루 1회. ⚠️ 평일 전용, 2026-08-23 48h로 상향.
  // ⚠️ 2026-09-03(마이그레이션 3단계, "통일 루프 깸") — reconcile-irp는 이제
  // CashEvent가 아니라 State/Holdings를 직접 기록. update-cash-from-ledger는
  // API 없는 ISA·연금저축 2계좌만 처리(6→2계좌 범위축소). reconcile-nh-cash 신설
  // (위탁·CMA·금현물, 평일 16:08) — 같은 배치그룹이라 동일 48h 간격.
  'reconcile-irp': 48 * 60 * 60 * 1000,
  'reconcile-nh-cash': 48 * 60 * 60 * 1000,
  // reconcile-nh-fx-rp(2026-09-19 신설, 오너 지시 — "예수금·금현물처럼 외화RP도
  // 주기적으로 자동 갱신") — 평일 16:09(reconcile-nh-cash 16:08 직후), 같은 배치
  // 그룹 관례로 동일 48h.
  'reconcile-nh-fx-rp': 48 * 60 * 60 * 1000,
  'update-cash-from-ledger': 48 * 60 * 60 * 1000,
  // reconcile-irp-executions(평일 15:50)·reconcile-nh-executions(평일 15:55) —
  // 마이그레이션 2·4단계(2026-09-03 신설), update-holdings-from-executions(16:05)
  // 보다 먼저 돌아 그날 체결을 그날 안에 반영. 같은 배치그룹 관례로 48h.
  'reconcile-irp-executions': 48 * 60 * 60 * 1000,
  'reconcile-nh-executions': 48 * 60 * 60 * 1000,
  'expire-stale-nh-orders': 48 * 60 * 60 * 1000,
  // update-fund-holdings-from-purchases(평일 16:11, 2026-09-04 신설) — 위 배치그룹
  // 안전망들과 동일 원칙(intraday-portfolio-sync 10분마다 + 고정시각 안전망 1개),
  // 동일 48h 간격.
  'update-fund-holdings-from-purchases': 48 * 60 * 60 * 1000,
  // ⚠️ 버그 수정(2026-08-23, 오너 신고 — 리포트는 실제로 발행됐는데 "조용하다" 오알람) —
  // backup-vault와 완전히 같은 클래스의 재발이다: 이 두 잡을 추가할 때 기본값(1시간)
  // 이 적용된 채 여기 등록을 안 해서, 정상 실행 후 2시간만 지나면 매번 오탐이 났다.
  // update-monthly-balance-snapshot은 매일 23:50 KST 1회(com.banana2.update-monthly-
  // balance-snapshot.plist StartCalendarInterval) — 요일 제한 없이 매일이라 24h 유지.
  'update-monthly-balance-snapshot': 24 * 60 * 60 * 1000,
  // weekly-report는 매주 일요일 08:00 KST 1회(com.banana2.weekly-report.plist
  // Weekday:0, 2026-08-23 03:00→08:00 재조정). 60분 기준이면 실행 직후에도 항상
  // "조용하다"로 잘못 잡힌다.
  'weekly-report': 7 * 24 * 60 * 60 * 1000,
  // ── 2026-08-23 전수 재점검에서 새로 발견한 누락(이전엔 오탐이 아니라 "실제보다
  // 느슨하게"만 감시되고 있었다 — 60분 기본값이 각 잡의 실제 주기보다 커서, 진짜
  // 멈춰도 최대 2시간까지는 못 잡았다는 뜻. false negative 쪽 갭이라 오너 신고가
  // 없었을 뿐 같은 종류의 설정 누락) ──
  // execute-quant: com.banana2.execute-quant.plist StartInterval=300(5분마다). 퀀트
  // 트랙 실주문 집행 잡이라 감시 지연이 가장 부담스러운 축 — 5분 그대로 등록.
  'execute-quant': 5 * 60 * 1000,
  // execute-asset-allocation(2026-09-05 신설): com.banana2.execute-asset-allocation.plist
  // StartInterval=600(10분마다, 오너 지시 — 퀀트보다 느슨). 자산분배 트랙(위탁·금현물)
  // 실주문 집행 잡이라 execute-quant와 같은 이유로 실제 StartInterval과 정확히 맞춘다.
  'execute-asset-allocation': 10 * 60 * 1000,
  // sync-firestore-mirror·update-allocation-from-holdings·update-holdings-prices
  // 셋 다 StartInterval=600(10분마다, 2026-08-25 오너 지시로 30분→10분 단축) —
  // 대시보드가 읽는 미러/시세/자산분배 갱신. 세 잡이 항상 같은 주기여야 한다는 원칙은
  // 그대로(위 update-allocation-from-holdings.plist 주석 참고) — 여기 값도 실제
  // StartInterval과 같이 움직여야 한다(등록값이 실제 주기보다 느슨하면 진짜 정지를
  // 늦게 잡는다, 2026-08-24 EXPECTED_INTERVALS_MS 신설 취지와 동일).
  'sync-firestore-mirror': 10 * 60 * 1000,
  'update-allocation-from-holdings': 10 * 60 * 1000,
  // update-holdings-prices는 2026-10-29부터 StartCalendarInterval 매시 :00·:10…(간격은 그대로 10분).
  'update-holdings-prices': 10 * 60 * 1000,
  // intraday-portfolio-sync(2026-09-03 신설) — 같은 10분 패턴. 2026-10-29부터 매시 :05·:15…
  // 고정 분(시세 잡과 5분 엇갈림, scripts/lib/poll-schedule.mjs).
  // 위 세 잡과 동일 원칙: 등록값이 실제 주기와 정확히 같아야 진짜 정지를 늦게
  // 안 잡는다.
  'intraday-portfolio-sync': 10 * 60 * 1000,
  // telegram-session-health-check(2026-08-31 신설) — 상시 텔레그램 세션 MCP 연결
  // 끊김 감지·자동복구 잡 자체도 StartInterval=600(10분마다). 이 잡이 조용해지면
  // "그 조용해짐을 감지해 복구할 다른 무엇"이 없다는 게 health-watcher 자기 자신과
  // 같은 구조적 한계(바로 아래 주석 참고) — 그래도 최소한 이 등록으로 health-watcher
  // 자신이 살아있는 한은 잡힌다.
  'telegram-session-health-check': 10 * 60 * 1000,
  // 텔레그램 관문(2026-10-30 관문 1단계) — 상시 데몬이 5분마다 스스로 하트비트를 쓴다(수신 3분 넘게 실패면 FAIL).
  // 15분으로 등록해 30분 동안 기록이 없으면 알린다. 4단계 전환 전에는 JobHealth 파일이 없어 아무 경보도 나지 않는다.
  'telegram-gate': 15 * 60 * 1000,
  // 관문 바깥 감시(StartInterval=600). telegram-session-health-check와 같은 클래스.
  'telegram-gate-health-check': 10 * 60 * 1000,
  // intraday-market-move-monitor(2026-09-01 신설) — 텔레그램 메시지 2단계, 장중 시장
  // 급변 감시. 10분 주기(2026-10-29부터 매시 :03·:13… 고정 분), telegram-session-health-check와 동일 클래스.
  // ⚠️ 이 잡은 장 마감 후·주말엔 실행돼도 즉시 조용히 종료하는 게 정상 동작(isKrMarketOpen
  // ||isUsMarketOpen 게이트) — run.sh가 종료코드 0으로 하트비트를 남기므로 stale 오탐 없음.
  'intraday-market-move-monitor': 10 * 60 * 1000,
  'process-warning-actions': 10 * 60 * 1000,
  // health-watcher 자기 자신도 StartInterval=1800(30분마다)이라 등록 — 다만 여기 등록해도
  // 구조적 사각은 남는다: findStaleJobs는 health-watcher **자신이 실행될 때만** 호출된다.
  // health-watcher 프로세스 자체가(launchd unload·크래시 등으로) 아예 안 돌기 시작하면
  // 아무도 그 정지를 감지하지 못한다 — "감시자가 감시자 자신의 죽음은 못 본다"는
  // 구조적 한계, 이 등록 하나로는 못 고친다(별도 외부 워치독이 필요, 아직 없음).
  'health-watcher': 30 * 60 * 1000,

  // ── 2026-08-24 다섯 번째 재발(오너 신고 — weekly-schedule-summary 오알람) ──
  // 이 파일 자체가 "새 v2 잡이 생길 때마다 여기 추가한다"고 2026-08-14부터 프로즈로
  // 적어뒀는데도 그새 backup-vault·daily-asset-allocation-check(08-14), update-monthly-
  // balance-snapshot·weekly-report(08-23), 그리고 이번 6개(08-24)까지 같은 클래스의
  // 누락이 다섯 번째로 반복됐다 — "기억해서 채워넣기"는 구조적으로 안 지켜진다는 뜻.
  // 그래서 이번엔 프로즈 주석 추가에서 그치지 않고, health-watcher.test.js에 "run.sh가
  // 디스패치하는 모든 잡은 반드시 여기 등록돼 있어야 한다"는 걸 강제하는 테스트를
  // 추가했다(scripts/launchd/*.plist ↔ EXPECTED_INTERVALS_MS 키 대조) — 앞으로 새 잡을
  // run.sh에 추가하고 여기 등록을 빠뜨리면 npm test가 그 자리에서 실패한다. 프로즈
  // 규칙을 CI가 강제하는 불변식으로 승격한 것 — 이게 이 세션 전체가 반복해온 원칙
  // ("기억하지 말고 구조로 막을 것")과 같은 결의 수정이다.
  //
  // weekly-schedule-summary·themis-risk-review — 매주 1회(월요일 07:00·일요일 07:00
  // KST). weekly-report와 동일 패턴이라 그대로 7일.
  'weekly-schedule-summary': 7 * 24 * 60 * 60 * 1000,
  'themis-risk-review': 7 * 24 * 60 * 60 * 1000,
  // morning-briefing·proposal-execution-reminder — 평일 전용 하루 1회(각각 08:00·
  // 09:10 KST). 위 parse-notifications-to-vault 등과 동일 사유로 48h(금~월 72시간
  // 간격에 여유를 더한 값). rebalance-proposal은 2026-08-29 분기 전환으로 아래
  // quarterly-allocation-review와 같은 그룹으로 이동했다(바로 아래 참고).
  'morning-briefing': 48 * 60 * 60 * 1000,
  'proposal-execution-reminder': 48 * 60 * 60 * 1000,
  // daily-execution-report(2026-08-24 신설, 오너 명시 요청 — 장마감 이후 당일 체결내역
  // 텔레그램 보고) — 평일 16:15 KST 하루 1회. 위 평일전용 잡들과 동일 사유로 48h
  // (금~월 72시간 간격에 여유를 더한 값).
  'daily-execution-report': 48 * 60 * 60 * 1000,
  // quarterly-allocation-review — 분기 시작월(1·4·7·10월) 1~3일에 launchd가 3일 연속
  // 실행되지만(run.sh가 매번 record-heartbeat-vault를 부르므로 heartbeat 자체는 3일
  // 연속 남음), 잡 내부 dedup(shouldRunToday)으로 실제 판단·발송은 분기당 1회뿐이다.
  // 즉 실제 heartbeat 간격은 "3일 연속 찍힘 → 최대 약 92일(10/3→1/1) 공백"인 불규칙
  // 패턴 — 짧은 쪽(하루~이틀)에 맞추면 분기 사이 공백에서 매번 오알람, 긴 쪽에
  // 맞추면 그 며칠의 burst 안에서는 문제 없다. 최대 공백(약 92일)+여유를 100일로 잡고
  // ×2=200일 문턱 — 분기 burst를 두 번 연속 통째로 놓쳐야만(약 6개월 무응답) 알람이
  // 뜬다. 분기 1회짜리 순수 의견보고 잡이라 이 정도 지연 허용은 합리적(daily 배관
  // 잡처럼 즉각 감지가 필요한 성격이 아님).
  'quarterly-allocation-review': 100 * 24 * 60 * 60 * 1000,
  // rebalance-proposal — 2026-08-29 평일 매일→분기 전환(위 quarterly-allocation-review와
  // 완전히 동일한 트리거 패턴, 같은 이유로 같은 값). daily-asset-allocation-check(거시
  // 오버레이 전용으로 축소)와 혼동하지 말 것 — 그 잡은 계속 매일 돈다.
  'rebalance-proposal': 100 * 24 * 60 * 60 * 1000,
  // isa-maturity-check(2026-08-29 신설) — 매주 월 07:10, 실제 이벤트(ISA 3년 만기
  // 2028-04-06)는 ~1.5년 뒤 1회뿐이지만 heartbeat 자체는 매주 남는다 — weekly-
  // schedule-summary와 동일 클래스(7일).
  'isa-maturity-check': 7 * 24 * 60 * 60 * 1000,
  // weekly-vault-health-check(2026-09-04 신설) — 매주 일 07:30, isa-maturity-check와
  // 동일 클래스(저정보 억제라 텔레그램 발송 없는 주도 많지만 heartbeat 자체는 매주).
  'weekly-vault-health-check': 7 * 24 * 60 * 60 * 1000,
  'weekly-warning-review': 7 * 24 * 60 * 60 * 1000,
  // mine-athena-fields(2026-10-14 신설) — 매주 일 06:30 미네 노트 아테나 필드 묶음, 발송 없음.
  'mine-athena-fields': null, // 오너의 재개 기준 확정 전까지 의도적으로 중단
  // update-breakout-price-cache(2026-09-16 신설, 돌파매매 전략 개별종목 시세 캐시
  // 갱신) — 평일 07:00 하루 1회, daily-asset-allocation-check 등과 동일 클래스
  // (평일 전용이라 48h로 주말 간격 흡수).
  'update-breakout-price-cache': 48 * 60 * 60 * 1000,
  // daily-breakout-signal-scan(2026-09-18 최초 launchd 배선) — 평일 15:32 하루 1회,
  // update-breakout-price-cache와 동일 클래스(평일 전용 48h). 돌파매매 승인없는
  // 자동발주 스위치라 이 heartbeat 정지가 곧 "그날 매매판단 자체가 실행 안 됐을
  // 수 있다"는 의미 — 다른 하루1회 잡보다 무거운 신호이니 경고 뜨면 즉시 확인할 것.
  'daily-breakout-signal-scan': 48 * 60 * 60 * 1000,
  // place-breakout-fallback-entry(2026-09-18 최초 launchd 배선) — 평일 09:03 하루
  // 1회, 위 두 잡과 동일 클래스(평일 전용 48h). 대기 항목이 없는 날엔 "처리할 것
  // 없음"으로 조용히 끝나지만(정상) heartbeat 자체는 매 실행 남긴다.
  'place-breakout-fallback-entry': 48 * 60 * 60 * 1000,
  // 보호주문 조정(평일 08:35 KRX 시가단일가) — 평일 전용 일일 잡, 주말 간격 흡수.
  'reconcile-breakout-protection': 48 * 60 * 60 * 1000,
  // update-macro-indicators-cache(2026-09-18 신설) — 평일 07:05 하루 1회, 위와
  // 동일 클래스(평일 전용 48h). 이 잡이 꾸준히 도는 것 자체가 거시지표 캐시(USD/KRW
  // 환율 등)가 매일 갱신된다는 간접 보증 — 잡 자체는 실패해도 캐시가 "그대로
  // 유지"될 뿐 조용히 나빠지지 않지만, stale해지면(=이 잡이 며칠 안 돎) 캐시도
  // 그만큼 묵는다(Log/DevRequests/2026-09-18-macro-cache-데이터신선도-알람공백.md).
  'update-macro-indicators-cache': 48 * 60 * 60 * 1000,
  // update-krx-trading-calendar(2026-09-24 신설) — 평일 08:15 KIS 휴장일 API 1회
  // 조회. 주말 간격을 흡수하는 다른 평일 전용 일일 잡과 동일하게 48h.
  'update-krx-trading-calendar': 48 * 60 * 60 * 1000,
  // pension-balance-reminder(2026-09-04 신설) — 매월 22일, rebalance-proposal(분기,
  // 100일)과 동일 원칙으로 달 길이(28~31일) 편차를 흡수하는 여유(35일)를 둔다.
  'pension-balance-reminder': 35 * 24 * 60 * 60 * 1000,
  // monthly-macro-tilt-proposal(2026-09-06 신설, "자산분배 트랙 핵심 로직 설계" §4) —
  // launchd는 매월 26~31일 6일 연속 걸어두지만(달마다 실제 마지막 3일이 어디인지
  // launchd가 직접 표현 못 해 넉넉히 잡음) 잡 내부(shouldRunThisMonth) dedup으로 실제
  // 판단·발송은 월 1회뿐 — pension-balance-reminder와 동일 원칙(35일)을 그대로 적용.
  'monthly-macro-tilt-proposal': 35 * 24 * 60 * 60 * 1000,
  // annual-instrument-rescore(2026-09-06 신설, §3) — quarterly-allocation-review와
  // 완전히 같은 구조(1월 1~3일 launchd 3일 연속, 내부 dedup으로 연 1회)를 연 단위로
  // 늘린 것. 실제 최대 공백은 "올해 실행일→내년 실행일" 약 363~368일(요일 정렬에 따라
  // ±2~3일 편차) — quarterly가 실제공백(92일)에 준 여유 비율(등록값/실공백≈1.09)을
  // 그대로 적용해 400일로 등록(×2 알람 문턱=800일, 연 1회 잡이 두 해 연속 완전히
  // 죽어야만 알람 — 이 cadence 자체의 한계이지 과도한 관대함이 아님).
  'annual-instrument-rescore': 400 * 24 * 60 * 60 * 1000,
};
export const EXPECTED_INTERVAL_DEFAULT_MS = 60 * 60 * 1000;
export const RETIRED_JOBS = new Set(['media-diarize', 'media-faces-nightly', 'media-transcribe', 'media-vision']);

export function isInactiveJob(job) {
  return RETIRED_JOBS.has(job) || EXPECTED_INTERVALS_MS[job] === null;
}
