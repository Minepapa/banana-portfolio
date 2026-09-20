#!/usr/bin/env node
// place-breakout-entry-order.mjs — 돌파매매 전략(퀀트 트랙) 신규 진입 매수를 장후시간외
// (ORD_DVSN=06)로 우선 시도한다(오너 확정, 2026-09-13 — "장후시간외 우선+실패 시
// 다음날시가 폴백". 체결 여부에 관계없이 매번 승인 없이 자동 발주 + 사후 텔레그램
// 통보, 오너 확정 — 3R부분익절/손절 보호주문과 동일 원칙). 폴백(다음날 시가) 큐잉·
// 감시는 watch-breakout-entry-fill.mjs가 --fallback=nextDayOpen으로 이어서 담당한다.
//
// 이 스크립트는 "어느 종목을 오늘 살지"는 판단하지 않는다 — 그건 아직 없는 별도
// 일별 신호스캔 잡의 몫이고, 이 스크립트는 그 잡이 넘겨준 code/name/투입예산 하나를
// 받아 "장후시간외 우선체결"이라는 기계적 실행만 담당한다(관심사 분리).
//
// 사용법(15:40~16:00 KRX 장후시간외 세션 안에 실행돼야 함):
//   node scripts/tools/place-breakout-entry-order.mjs --code=005930 --name=삼성전자 --entry-date=2026-09-13 --invested-won=10000000
//   node scripts/tools/place-breakout-entry-order.mjs --code=005930 --entry-date=2026-09-13 --quantity=140  # 수량 직접 지정(테스트용)
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadQuantAccount, getKisToken, getKrQuote, placeKrOrder,
} from '../lib/kis.mjs';
import { isKillSwitchActive } from '../lib/kill-switch.mjs';
import { STOP_LOSS_PCT } from '../lib/breakout-risk.mjs';
import { VAULT_PATHS } from '../lib/vault-paths.mjs';
import { sendTelegram } from '../lib/telegram.mjs';
import { formatDepartmentMessage } from '../lib/telegram-messages.mjs';

const DEPARTMENT_LABEL = '운영실 Hermes'; // watch-breakout-entry-fill.mjs와 동일 원칙 — 순수 API조회+발주 결과 전달, 부서 판단 없음
const won = (n) => (n == null ? '확인 필요' : Math.round(n).toLocaleString('ko-KR') + '원');

// execute-quant-proposal.mjs·execute-asset-allocation-proposal.mjs의 readStateFileOrNull과
// 달리 ENOENT(파일 없음 = 킬스위치 한 번도 안 켜짐, 정상 기본 상태)만 "꺼짐"으로
// 처리한다(2026-09-18 코드리뷰 MEDIUM 지적) — 그 두 실행부는 오너 승인이 선행하는
// 경로라 fail-open(모든 읽기 오류를 꺼짐으로)이 받아들일 만한 위험이었지만, 이
// 스크립트는 승인 없는 완전자동 실거래 경로라 같은 기본값을 물려받을 이유가 약하다.
// EACCES·EIO·볼트 볼륨 언마운트 등 ENOENT 외 오류는 "킬스위치가 켜져 있는데 못
// 읽는 것"일 수도 있으므로 안전한 쪽(발주 중단)으로 처리한다.
function readKillSwitchState(filepath) {
  try {
    return { content: readFileSync(filepath, 'utf8'), readFailed: false };
  } catch (e) {
    if (e.code === 'ENOENT') return { content: null, readFailed: false };
    return { content: null, readFailed: true, error: e };
  }
}

function parseArgs(argv) {
  const out = {};
  for (const a of argv) {
    const m = a.match(/^--([a-z-]+)=(.*)$/s);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

// watch-breakout-entry-fill.mjs 자식 프로세스에 넘길 CLI 인자 — 순수함수로 분리해
// 테스트 가능하게(2026-09-19 코드리뷰 MEDIUM 지적: order.orgNo → --org-no 플러밍이
// 지금까지 아무 테스트도 없어, place-breakout-fallback-entry.mjs의 취소시도 기능이
// 영구적으로 조용히 무력화돼도(예: KIS 응답에 KRX_FWDG_ORD_ORGNO가 없어 orgNo가
// 빈 문자열인 경우) npm test는 계속 초록이었을 것).
export function buildWatchArgs({ order, code, name, entryDate, budgetForFallback, stopLossPct = STOP_LOSS_PCT }) {
  return [
    `--order-no=${order.orderNo}`, `--org-no=${order.orgNo}`, `--code=${code}`, `--name=${name}`, `--entry-date=${entryDate}`,
    '--fallback=nextDayOpen', `--invested-won=${Math.round(budgetForFallback)}`, `--stop-loss-pct=${stopLossPct}`,
  ];
}

// 순수함수 — KST 15:00~16:00 안인지(코드리뷰 MEDIUM 지적, 2026-09-13: ORD_DVSN=06
// 장후시간외는 15:40~16:00에만 유효하고 16:00 이후엔 시간외단일가(07)로 넘어가
// 더 이상 맞는 구분이 아니다 — 15:40보다 조금 일찍 여유를 둔 이유는 daily-breakout-
// signal-scan.mjs가 15:32 시작+수백 종목 조회로 15:37경 이 스크립트를 부르기
// 때문). 이 시각 밖에서 호출되면(오작동·수동 오용) 실제로 주문이 어떻게 처리될지
// 불명확하니 KIS에 던지지 않고 여기서 먼저 막는다.
export function isWithinAfterHoursSubmitWindow(date) {
  const kst = new Date(date.getTime() + 9 * 3600_000);
  const minutesOfDay = kst.getUTCHours() * 60 + kst.getUTCMinutes();
  return minutesOfDay >= 15 * 60 && minutesOfDay < 16 * 60; // 15:00~16:00 KST
}

// ⚠️ 코드리뷰 HIGH 지적(2026-09-13) — 이 스크립트는 daily-breakout-signal-scan.mjs가
// stdio:'ignore'로 스폰한다(감시 프로세스가 끝나도 부모 콘솔에 매여있지 않게). 즉
// console.error만으로 끝나는 실패 경로는 실제로는 "어디에도 남지 않는" 실패다 —
// 실주문이 이미 나간 뒤의 실패(특히 체결감시 스폰 실패)라면 텔레그램 없이는 아무도
// 모르는 무방비 포지션이 생긴다. 그래서 이 파일의 모든 조기종료 경로는 반드시
// 텔레그램도 함께 보낸다(콘솔 로그만 남기고 끝나는 경로를 만들지 않는다).
async function alertAndExit(body, code = 1) {
  console.error(`❌ ${body.replace(/<[^>]+>/g, '')}`);
  try {
    await sendTelegram(formatDepartmentMessage({ departmentLabel: DEPARTMENT_LABEL, tag: '경고', body }));
  } catch (e) { console.error(`  ⚠️ 텔레그램 발송 자체도 실패(무시): ${e.message}`); }
  process.exit(code);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const code = args.code || '';
  const name = args.name || code;
  const entryDate = args['entry-date'];
  const investedWonArg = Number(args['invested-won']);
  const investedWon = Number.isFinite(investedWonArg) && investedWonArg > 0 ? investedWonArg : null;
  const quantityArg = Number(args.quantity);
  const fixedQuantity = Number.isInteger(quantityArg) && quantityArg > 0 ? quantityArg : null;
  // ATR 가변손절(2026-09-19 실전배선) — daily-breakout-signal-scan.mjs가 신호
  // 시점에 확정한 값을 그대로 물려받아 watch-breakout-entry-fill.mjs로 전달만
  // 한다(이 스크립트 자체는 손절가를 계산하지 않음). 없으면(수동 --quantity
  // 테스트 등) 기존 고정값으로 안전 폴백 — 단, --invested-won(자동호출 경로,
  // 신호스캔이 이미 특정 stopLossPct 기준으로 사이징해 보낸 금액)이 있는데
  // --stop-loss-pct가 빠졌다면 그건 "수동 테스트"가 아니라 상류 배선이 깨진
  // 것이므로 조용히 8%로 폴백하지 않는다(코드리뷰 MEDIUM 지적 — "조용한 폴백
  // 금지" 원칙, feedback-no-silent-fallback과 동일). investedWon은 이미 4%
  // 기준(2배)으로 사이징돼 있을 수 있는데 손절만 조용히 8%로 나가면 실제
  // 리스크가 규정의 2배가 되는 CRITICAL 사고 재현 경로라 아래에서 별도 검증.
  // 타당범위 검사(코드리뷰 LOW 지적) — >0만 보면 퍼센트/비율 단위 실수(예: 4를
  // 0.04 대신 넘김)가 그대로 통과해 stopPrice=entry×(1-4)=음수로 실주문이 나갈
  // 수 있다. 이 값은 항상 비율(0.04/0.08류)이라 0.5(50% 손절)를 넘길 일이
  // 현실적으로 없음 — 그보다 크면 형식 오류로 간주해 거부.
  const stopLossPctArg = Number(args['stop-loss-pct']);
  const stopLossPctValid = Number.isFinite(stopLossPctArg) && stopLossPctArg > 0 && stopLossPctArg < 0.5;
  const stopLossPct = stopLossPctValid ? stopLossPctArg : STOP_LOSS_PCT;

  if (!code) return alertAndExit('<b>돌파매매 진입 스크립트 호출 오류</b>\n--code 누락 — 호출측(신호스캔 잡) 버그 의심.', 2);
  if (!entryDate) return alertAndExit(`<b>돌파매매 진입 스크립트 호출 오류</b>\n${name}(${code}) --entry-date 누락 — 호출측(신호스캔 잡) 버그 의심.`, 2);
  if (!args['skip-time-check'] && !isWithinAfterHoursSubmitWindow(new Date())) {
    return alertAndExit(`<b>돌파매매 진입 실패 — 시간대 밖 호출</b>\n${name}(${code}) 장후시간외(ORD_DVSN=06) 유효 시간(15:00~16:00 KST) 밖에서 호출돼 발주하지 않았습니다. 의도된 수동 테스트라면 --skip-time-check를 넘겨주세요.`, 2);
  }
  if (!fixedQuantity && !investedWon) return alertAndExit(`<b>돌파매매 진입 스크립트 호출 오류</b>\n${name}(${code}) --quantity/--invested-won 둘 다 없음 — 호출측(신호스캔 잡) 버그 의심.`, 2);
  if (investedWon && !stopLossPctValid) {
    return alertAndExit(`<b>돌파매매 진입 스크립트 호출 오류</b>\n${name}(${code}) --invested-won은 있는데 --stop-loss-pct가 없거나 형식이 이상함 — 자동호출(신호스캔) 경로 배선 버그 의심. 이 투입예산은 특정 손절폭 기준으로 이미 사이징됐을 수 있어, 다른 손절폭으로 조용히 진행하면 실제 리스크가 의도와 달라질 수 있음 — 발주하지 않음.`, 2);
  }

  const quant = loadQuantAccount();
  if (!quant) return alertAndExit(`<b>돌파매매 진입 실패</b>\n${name}(${code}) 퀀트 계좌정보(quantAccount) 미설정 — 발주 못 함.`);
  const { appkey, appsecret, cano, acntPrdtCd } = quant;
  const token = await getKisToken({ appkey, appsecret });

  let currentPrice;
  try {
    ({ price: currentPrice } = await getKrQuote({ token, appkey, appsecret, code }));
  } catch (e) {
    console.error('현재가 조회 실패 —', e.message);
    return alertAndExit(`<b>돌파매매 진입 실패 — 현재가 조회 불가</b>\n${name}(${code}) 장후시간외 진입을 시도했으나 현재가를 못 가져와 발주하지 못했습니다. 수동 확인 바랍니다.`);
  }
  // getKrQuote(parseQuoteResponse)는 이미 price<=0이면 throw하므로 여기 도달하는
  // currentPrice는 항상 양수다(불필요한 재검증 아님 — 방금 위 try/catch가 그 경로를
  // 이미 덮었다는 점을 명시해 다음 사람이 "이 줄이 왜 없지"라고 헷갈리지 않게 함).

  const quantity = fixedQuantity ?? Math.floor(investedWon / currentPrice);
  if (!(quantity > 0)) {
    // 조용히 버려지면 안 됨(코드리뷰 HIGH 지적) — 소액 예산 계좌에서 대형주 신호가
    // 뜨면 일상적으로 이 경로를 탄다. 오류는 아니지만 "신호를 인지했고 예산이 부족해
    // 건너뛰었다"는 사실 자체는 텔레그램으로 알려야 나중에 "왜 그날 신호가 있었는데
    // 안 샀지"라는 혼란을 막는다.
    console.log(`ℹ️ 산정 수량이 0(투입예산 ${won(investedWon)} < 현재가 ${won(currentPrice)}) — 발주 스킵`);
    await sendTelegram(formatDepartmentMessage({
      departmentLabel: DEPARTMENT_LABEL, tag: '스킵',
      body: `<b>돌파매매 신호 확인, 예산부족으로 매수 건너뜀</b>\n${name}(${code}) 현재가 ${won(currentPrice)} — 투입예산 ${won(investedWon)}으로는 1주도 못 삽니다.`,
    }));
    return;
  }
  const budgetForFallback = investedWon ?? currentPrice * quantity; // --quantity로 직접 지정된 경우 폴백용 예산은 현재가 기준으로 역산

  // 킬스위치 — 브로커 호출 직전(order-gate.mjs checkKillSwitch와 동일 원칙·동일
  // State 파일, execute-quant-proposal.mjs·execute-asset-allocation-proposal.mjs가
  // 이미 쓰는 것과 같은 전역 스위치를 여기서도 재사용한다. 오너 지시(2026-09-18) —
  // "카이로스 자동거래를 앞으로 승인하되, on/off 스위치를 만들어 쓴다"에 대응.
  // 신호판정(daily-breakout-signal-scan.mjs)이 아니라 여기서 막는 이유는 order-gate의
  // 기존 2단계 설계("제안 생성 시점"엔 안 막고 "실행 시점"에만 막음)와 동일 — 신호
  // 자체는 계속 계산·기록되게 두고, 실제 돈이 나가는 지점만 잠근다. 텔레그램/CLI로
  // 언제든 껐다 켤 수 있게 매 호출마다 새로 읽는다(장시간 실행 중 스위치가 바뀔 수
  // 있는 daily-breakout-signal-scan.mjs의 반복 발주와 달리 이 스크립트는 단발성
  // 호출이라 실질적 차이는 없지만, 나머지 두 실행부와 코드 형태를 통일해둔다).
  const killSwitchState = readKillSwitchState(VAULT_PATHS.state.killSwitch);
  if (killSwitchState.readFailed) {
    console.error('킬스위치 파일 읽기 실패 —', killSwitchState.error.message);
    return alertAndExit(`<b>돌파매매 진입 보류 — 킬스위치 상태 확인 불가</b>\n${name}(${code}) 신호 통과(${quantity}주, 예산 ${won(investedWon)})했지만 킬스위치 파일을 읽을 수 없어 안전하게 발주를 보류했습니다. 볼트 접근 상태를 확인해 주세요.`);
  }
  if (isKillSwitchActive(killSwitchState.content)) {
    console.log(`ℹ️ 킬스위치 활성 — ${name}(${code}) ${quantity}주 매수 발주 안 함(신호는 정상 통과했음)`);
    await sendTelegram(formatDepartmentMessage({
      departmentLabel: DEPARTMENT_LABEL, tag: '스킵',
      body: `<b>돌파매매 진입 보류 — 킬스위치 활성</b>\n${name}(${code}) 신호 통과(${quantity}주, 예산 ${won(investedWon)})했지만 킬스위치가 켜져 있어 발주하지 않았습니다. "킬스위치 오프" 명령으로 해제해야 다음 신호부터 다시 발주됩니다.`,
    }));
    return;
  }

  let order;
  try {
    order = await placeKrOrder({
      token, appkey, appsecret, cano, acntPrdtCd, code, side: '매수', quantity, afterHoursClose: true,
    });
  } catch (e) {
    console.error('장후시간외 매수 거부 —', e.message);
    return alertAndExit(`<b>돌파매매 진입 실패 — 장후시간외 주문 거부</b>\n${name}(${code}) ${quantity}주 장후시간외 매수가 거부됐습니다. 자동 폴백 없이 수동 확인이 필요합니다.`);
  }

  console.log(`[발주 완료] 장후시간외 매수 ${name}(${code}) ${quantity}주 — 주문번호 ${order.orderNo}`);
  await sendTelegram(formatDepartmentMessage({
    departmentLabel: DEPARTMENT_LABEL, tag: '접수',
    body: `<b>돌파매매 진입 — 장후시간외 매수 접수</b>\n${name}(${code}) ${quantity}주 @약${won(currentPrice)} (주문번호 ${order.orderNo})\n체결 확인 후 자동으로 보호주문(손절 -${(stopLossPct * 100).toFixed(0)}%/3R부분익절)을 겁니다. 세션 안에 미체결이면 다음날 시가로 자동 전환됩니다.`,
  }));

  // 체결감시+보호주문(전량체결 시)·폴백큐잉(미체결 시)은 watch-breakout-entry-fill.mjs가
  // 이어서 담당 — execute-quant-proposal.mjs가 watch-order-fill.mjs를 분리 프로세스로
  // 띄우는 것과 동일 패턴(detached+unref, 이 스크립트가 끝나도 감시는 계속).
  const here = dirname(fileURLToPath(import.meta.url));
  const child = spawn('node', [
    join(here, 'watch-breakout-entry-fill.mjs'),
    ...buildWatchArgs({ order, code, name, entryDate, budgetForFallback, stopLossPct }),
  ], { detached: true, stdio: 'ignore' });
  // ⚠️ 코드리뷰 HIGH 지적(2026-09-13, 가장 위험한 경로) — 이 시점에 매수 주문은 이미
  // 접수돼 있다. 감시 스폰이 실패하면 체결여부 확인·포지션기록·보호주문(손절/3R익절)
  // 이 전부 안 걸리는데, 이 콜백이 console.error만 남기면(부모가 stdio:'ignore'로
  // 스폰됐을 수 있어) 아무도 모르는 무방비 실거래 포지션이 생긴다 — 반드시 텔레그램.
  child.on('error', (e) => {
    console.error(`  ⚠️ 체결감시 기동 실패(주문 자체는 이미 접수됨): ${e.message}`);
    sendTelegram(formatDepartmentMessage({
      departmentLabel: DEPARTMENT_LABEL, tag: '경고',
      body: `<b>체결감시 기동 실패 — 무방비 포지션 위험</b>\n${name}(${code}) ${quantity}주 장후시간외 매수 주문(번호 ${order.orderNo})은 이미 접수됐지만, 체결감시 프로세스를 못 띄워 체결확인·보호주문(손절/3R익절)이 걸리지 않습니다. 즉시 KIS 앱에서 체결 여부를 확인하고 필요하면 수동으로 보호주문을 걸어주세요.`,
    })).catch((telegramErr) => console.error(`  ⚠️ 텔레그램 발송도 실패: ${telegramErr.message}`));
  });
  child.unref();
  console.log('  👁️ 체결감시 시작(백그라운드)');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(async (e) => {
    console.error('\n❌ 오류:', e.message);
    // stdio:'ignore'로 스폰됐을 수 있어 콘솔만으론 아무도 못 봄 — 예상 못 한 예외도
    // 반드시 텔레그램으로 표면화(위 alertAndExit이 못 잡는 경로들의 최종 안전망).
    try {
      await sendTelegram(formatDepartmentMessage({
        departmentLabel: DEPARTMENT_LABEL, tag: '경고',
        body: '<b>돌파매매 진입 스크립트 예외 종료</b>\n예상 못 한 오류로 중단됐습니다. 주문이 실제로 나갔는지 KIS 앱에서 확인 바랍니다(상세 원인은 로그 참고).',
      }));
    } catch (telegramErr) { console.error(`  ⚠️ 텔레그램 발송도 실패: ${telegramErr.message}`); }
    process.exit(1);
  });
}
