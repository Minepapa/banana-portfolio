#!/usr/bin/env node
// watch-nh-order-fill.mjs — NH PLUG(위탁·금현물) 주문 접수 직후 체결 여부를 API로
// 직접 확인해 텔레그램으로 알리는 1회성 감시 도구(2026-09-21, 오너 지시 —
// Log/DevRequests/2026-09-21-NH-주문체결-API확인-배선.md). watch-order-fill.mjs
// (KIS·카이로스 전용)와 동일 철학·동일 패턴을 NH에 적용 — execute-asset-allocation-
// proposal.mjs가 실주문 접수 성공 직후 이 스크립트를 백그라운드로 띄운다.
//
// 왜 카카오 알림 대신 API인가(오너 질문, 2026-09-21 — "실제 체결을 왜 api로
// 확인하지 않고 카카오 알림 파싱으로 확인하는거지?") — API는 이미 있었다
// (reconcile-nh-executions.mjs가 매일 15:55 한 번씩 당일 체결을 전부 훑음). 다만
// "이 주문이 지금 막 체결됐는지" 즉시 확인하는 감시가 없어, 그 즉시성만은 카카오
// 알림에 의존하고 있었다 — 이 스크립트가 그 갭을 메운다.
//
// ⚠️ 이중기록 방지 — reconcile-nh-executions.mjs와 완전히 동일한 dedup 키
// (tradeDate·tradeType·stockName·quantity·orderNo, ledger-vault-writer.buildExecutionRecord)
// 를 써서, 나중에 그 일일 잡이 같은 체결을 다시 봐도(15:55 정기 실행) 파일명이
// 같아 조용히 스킵된다 — 두 경로가 서로 몰라도 자연히 dedup된다.
//
// ⚠️ 취소 감지는 안 한다 — 정정(2026-09-21 독립 코드리뷰 지적, MEDIUM) — 최초
// 주석은 "NH 체결조회 API 응답에 취소상태 필드가 없다"고 썼는데 틀렸다. 실측
// 확인 결과 응답엔 can_qty(취소수량)·ny_cns_qty(미체결수량)·orr_rjt_rsn_cd_nm
// (주문거부사유명) 필드가 다 있다 — 다만 이 잡이 쓰는 ostCnsDit:'1'(체결만) 조회
// 조건이 취소·미체결 행 자체를 애초에 안 돌려줄 뿐이다(원인은 "API 응답"이 아니라
// "이 조회조건"). 지금은 취소 감지를 범위 밖으로 남겨둔다(ostCnsDit:'0'으로
// 바꾸면 가능 — 다음에 필요해지면 이 주석부터 볼 것). 타임아웃까지 전량체결이
// 안 잡히면 "체결 안 됨"으로 단정하지 않고 "미체결·부분체결로 남아있거나 취소됐을
// 수 있음 — 이 조회조건으로는 구분 안 됨"으로 정직하게 말한다(watch-order-
// fill.mjs·place-breakout-fallback-entry.mjs의 기존 "확실한 것과 불명확한 것을
// 구분" 원칙과 동일 — 추정 금지). nhplug-krstock.mjs의 ostCnsDit 1·2 반전 주석이
// 실사고를 낸 전례가 있어(그 파일 241행 근처), 이 파일의 주석도 근거를 실측과
// 정확히 맞춰 적어둔다 — 나중 세션이 주석을 그대로 믿고 판단하는 구조이기 때문.
//
// ⚠️ mkt_orr_no(주문 접수 응답의 필드명) ≡ itg_orr_no(체결조회 응답의 필드명)라는
// 전제 — NH API 문서에 명시적으로 확인된 등식이 아니라, krstock 현금매도 1건
// (오늘 실측, 위탁 계좌 주문 847026)으로 확인한 정황 증거다. 금현물(krgold)은
// 아직 실측으로 검증된 적 없다(2026-09-21 독립 코드리뷰 지적, MEDIUM — nhplug-
// krgold.mjs도 주문 응답 필드명은 mkt_orr_no를 쓰지만, 체결조회 응답의 필드가
// krstock과 동일한 itg_orr_no인지는 별도 확인 필요). 금현물 실주문이 나가면 이
// 가정이 맞는지 로그로 재확인할 것.
//
// 계좌 범위 — 이 잡 자체는 위탁·금현물만 받는다(CMA는 체결 자체가 없는 계좌,
// ISA는 NH가 이 앱키로 미지원 — 둘 다 Log/Strategy/2026-09-02-NH-API-우선-KIS-
// 카카오파싱-역할축소-결정.md 그대로, execute-asset-allocation-proposal.mjs의
// ALLOWED_NH_ACCOUNTS와 동일 집합). ⚠️ 계좌 하나로는 부족하다 — 위탁 계좌는
// 국내주식·해외주식·장내직접채권을 전부 담는데 이 잡은 krstock/krgold 체결조회
// 엔드포인트만 안다(해외주식은 nhplug-gbstock.mjs의 별도 엔드포인트가 필요, 채권은
// 체결조회 자체가 미구현). 그래서 호출부(execute-asset-allocation-proposal.mjs)가
// classification.type이 KR_STOCK·GOLD일 때만 이 잡을 띄우도록 좁혀뒀다(2026-09-21
// 독립 코드리뷰 지적, HIGH — 안 좁히면 해외주식 주문마다 이 잡이 엉뚱한
// 엔드포인트를 조회하다 못 찾고 "체결 확인 시간 초과"라는 거짓 경고만 30분 뒤
// 발송했다).
//
// 사용법:
//   node scripts/tools/watch-nh-order-fill.mjs --order-no=847026 --account=위탁 \
//     --code=005930 --name=삼성전자 --side=매수
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { hasNhplugCredentials, loadNhplugCredentials, getNhToken, listNhAccounts } from '../lib/nhplug.mjs';
import { getKrDailyOrderExecution } from '../lib/nhplug-krstock.mjs';
import { getGoldExecution } from '../lib/nhplug-krgold.mjs';
import { resolveNhAccountsByLabel } from '../lib/nh-accounts.mjs';
import { parseNhExecutionRows, buildNhFillLedgerInput } from '../jobs/reconcile-nh-executions.mjs';
import { buildExecutionRecord } from '../lib/ledger-vault-writer.mjs';
import { parseFrontmatter } from '../lib/vault-frontmatter.mjs';
import { writeAtomic } from '../lib/state-writer.mjs';
import { sendTelegram } from '../lib/telegram.mjs';
import { formatDepartmentMessage } from '../lib/telegram-messages.mjs';
import { VAULT_PATHS } from '../lib/vault-paths.mjs';

// 순수 API 조회 결과를 그대로 전달하는 통보라 부서 판단이 없다 — watch-order-
// fill.mjs·execute-quant-proposal.mjs와 동일 이유로 운영실 Hermes로 통일.
const DEPARTMENT_LABEL = '운영실 Hermes';
// execute-asset-allocation-proposal.mjs의 ALLOWED_NH_ACCOUNTS와 동일 집합(CMA·ISA
// 제외 근거는 파일 헤더 주석 참고) — 이 파일이 독립 실행돼도 같은 계좌 판정을
// 쓰도록 여기서도 명시(교차 임포트 대신 값만 복제 — execute-asset-allocation-
// proposal.mjs를 감시 스크립트가 끌어오면 그쪽 main() 가드에 얽힐 이유가 없다).
const ALLOWED_ACCOUNTS = new Set(['위탁', '금현물']);

function parseArgs(argv) {
  const out = {};
  for (const a of argv) {
    const m = a.match(/^--([a-z-]+)=(.*)$/s);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const won = (n) => (n == null ? '확인 필요' : Math.round(n).toLocaleString('ko-KR') + '원');

// 이 잡은 execute-asset-allocation-proposal.mjs가 detached+stdio:'ignore'로 띄운다
// (그래야 부모가 끝나도 감시가 계속됨) — 그 말은 console.error가 아무 데도 안
// 남는다는 뜻이다(2026-09-21 독립 코드리뷰 지적, LOW — 인자검증 실패가 완전히
// 안 보임. classification.type을 KR_STOCK/GOLD로 좁혀 가장 흔한 실패는 막았지만,
// 남은 검증 실패 경로도 조용히 사라지면 안 된다). 인자검증·계좌조회 실패 시엔
// 텔레그램으로도 알린 뒤 종료 — place-breakout-entry-order.mjs의 alertAndExit과
// 동일 원칙.
async function alertAndExit(message, exitCode = 2) {
  console.error(`❌ ${message}`);
  try {
    await sendTelegram(formatDepartmentMessage({
      departmentLabel: DEPARTMENT_LABEL, tag: '경고',
      body: `<b>NH 체결감시 시작 실패</b>\n${message}`,
    }));
  } catch (e) { console.error('텔레그램 알림 실패(무시):', e.message); }
  process.exit(exitCode);
}

function kstTodayParts() {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).formatToParts(new Date());
  const get = (type) => parts.find((p) => p.type === type).value;
  return { dashed: `${get('year')}-${get('month')}-${get('day')}`, compact: `${get('year')}${get('month')}${get('day')}` };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const orderNo = args['order-no'];
  const account = args.account;
  const code = args.code || '';
  const name = args.name || code;
  const side = args.side;
  const timeoutArg = Number(args.timeout);
  const timeoutMin = Number.isFinite(timeoutArg) && timeoutArg > 0 ? timeoutArg : 30;

  if (!orderNo) { await alertAndExit(`--order-no 필요(호출 인자: account=${account} code=${code} name=${name} side=${side})`); return; }
  if (!ALLOWED_ACCOUNTS.has(account)) { await alertAndExit(`--account는 위탁 또는 금현물만(받은 값: ${account}) — 주문번호 ${orderNo}(${name}) 체결감시 시작 못 함`); return; }
  if (!['매수', '매도'].includes(side)) { await alertAndExit(`--side는 매수 또는 매도만(받은 값: ${side}) — 주문번호 ${orderNo}(${name}) 체결감시 시작 못 함`); return; }

  if (!hasNhplugCredentials()) { await alertAndExit(`NH PLUG 크리덴셜 미설정 — 주문번호 ${orderNo}(${name}) 체결감시 시작 못 함`, 1); return; }
  mkdirSync(VAULT_PATHS.facts.ledger.executions, { recursive: true });

  const { appkey, appsecret } = loadNhplugCredentials();
  const token = await getNhToken({ appkey, appsecret });
  const accounts = await listNhAccounts({ token });
  const actNoByLabel = resolveNhAccountsByLabel(accounts, ALLOWED_ACCOUNTS);
  const actNo = actNoByLabel.get(account);
  if (!actNo) { await alertAndExit(`NH 계좌(${account}) 조회 실패(미등록 가능성) — 주문번호 ${orderNo}(${name}) 체결감시 시작 못 함, NH 앱에서 직접 확인 필요`, 1); return; }

  const { dashed: today, compact: orrDt } = kstTodayParts();

  // 폴링 한 번(조회+판정)을 함수로 뽑아 루프 안·타임아웃 직전 마지막 확인에서도
  // 재사용(watch-order-fill.mjs와 동일 이유 — 마지막 폴링~타임아웃 사이 거짓음성
  // 창 방지).
  //
  // ⚠️ itgOrrNo 서버필터는 안 쓴다(2026-09-21 실측으로 발견) — getKrDailyOrderExecution/
  // getGoldExecution 둘 다 파라미터 자체는 받지만, 문자열로 넘기면
  // "HTTP 400 itg_orr_no 길이나 data type을 확인하세요"로 거부된다(실계좌 라이브
  // 호출로 재현). 숫자로 넘기면 통과했을 가능성이 높다 — nhplug-krstock.test.js가
  // 이미 `itgOrrNo: 42`(숫자)로 넘기는 테스트를 갖고 있고, 실측 응답의 itg_orr_no도
  // 숫자형(847026)으로 온다(독립 코드리뷰 확인, 2026-09-21 — 이전엔 "추정"이라고
  // 적었으나 이 테스트가 근거이므로 확정으로 정정). 그래도 서버필터를 되살리지
  // 않고 reconcile-nh-executions.mjs가 이미 라이브 검증까지 끝낸 방식(필터 없이
  // 전량 조회 후 클라이언트에서 orderNo로 매칭)을 그대로 재사용한다 — 이 잡은
  // 하루 1회가 아니라 1분마다 도는 감시라 매 폴링마다 그날 전체 체결을 다시
  // 받아오는 비용이 있지만, 위탁·금현물 계좌의 실제 하루 거래 빈도상(실측: 오늘
  // 위탁 전체 주문 1건) 그 비용은 사실상 0이라 재방문할 가치가 없다(독립 코드리뷰
  // 확인).
  async function pollOnce() {
    let body;
    try {
      body = account === '금현물'
        ? await getGoldExecution({ token, actNo, orrDt, ostCnsDit: '1' })
        : await getKrDailyOrderExecution({ token, actNo, orrDt, ostCnsDit: '1' });
    } catch (e) {
      // NH는 "당일 체결 없음"을 성공+빈배열이 아니라 업무거부(rsp_cd 11512)로
      // 응답한다(reconcile-nh-executions.mjs와 동일 패턴) — 아직 미체결로 취급.
      if (e.businessRejection === true && e.code === '11512') return null;
      throw e;
    }
    const rows = parseNhExecutionRows(body?.Output_0);
    return rows.find((r) => r.orderNo === String(orderNo)) ?? null;
  }

  async function checkAndReportIfDone() {
    let row;
    try {
      row = await pollOnce();
    } catch (e) {
      console.error(`[조회 실패] ${e.message}`);
      return false;
    }
    if (!row) { console.log('[미체결] 계속 감시'); return false; }
    if (!row.fullyFilled) { console.log(`[부분체결] ${row.quantity}/${row.orderQty}주 — 계속 감시`); return false; }

    console.log(`[체결 확인] 전량 체결 — ${row.quantity}주 @${row.price}원`);
    await sendTelegram(formatDepartmentMessage({
      departmentLabel: DEPARTMENT_LABEL,
      tag: '완료',
      body: `<b>체결 확인</b>\n${name}(${code}) 주문번호 ${orderNo}(${account})\n${row.quantity}주 전량 체결 @${won(row.price)} ≈ ${won(row.quantity * row.price)}`,
    }));

    // ⚠️ 독립 코드리뷰 지적(2026-09-21, CRITICAL) — 첫 버전은 stockName·tradeType·
    // stockCode·orderNo를 CLI 인자(--name/--side/--code/--order-no,
    // execute-asset-allocation-proposal.mjs가 classification.resolvedName 등에서
    // 넘긴 값)로 채웠다. reconcile-nh-executions.mjs는 이 필드들을 전부 NH API
    // 응답 행(iem_nm·sby_dit_cd_nm·iem_cd·itg_orr_no)에서 뽑는다 — 두 소스가
    // 우연히 같은 문자열을 쓸 뿐(오늘 실측: "TIGER 리츠부동산인프라TOP10액티브"
    // 일치) 구조적으로 같다는 보장이 전혀 없다(특히 미보유 신규매수는 resolvedName
    // 이 레지스트리 별칭에서 오므로 NH의 iem_nm과 표기가 다를 수 있음). 하나라도
    // 어긋나면 dedup 파일명이 갈려 같은 체결이 두 파일로 중복 기록되고,
    // update-holdings-from-executions.mjs의 findMatchingKnownExecution(같은 필드
    // 조합으로 매칭)도 같이 뚫려 2026-09-03에 실제로 겪은 "두 소스가 각자
    // applyBuy/applySell 적용" 사고가 재현된다. buildNhFillLedgerInput(reconcile-
    // nh-executions.mjs와 공유하는 순수함수)을 그대로 써서 dedupKey 일치를 "우연히
    // 같은 문자열"이 아니라 "같은 함수 호출"로 구조적으로 보장한다 — CLI 인자
    // (side/code/name)는 텔레그램 문구용으로만 남기고, row와 다르면 경고로
    // 노출한다(교차검증).
    if (row.tradeType !== side) {
      console.error(`[불일치] --side=${side}인데 NH 응답 매매구분은 "${row.tradeType}" — row 쪽 값을 Ledger에 씀(원인 확인 필요)`);
    }
    if (row.stockName !== name) {
      console.error(`[불일치] --name="${name}"인데 NH 응답 종목명은 "${row.stockName}" — row 쪽 값을 Ledger에 씀(reconcile-nh-executions.mjs와 dedup 어긋남 방지)`);
    }

    const { filename, content, dir, dedupKey } = buildExecutionRecord(
      buildNhFillLedgerInput(row, { today, account, actNo }),
    );
    const filepath = join(dir, filename);
    if (existsSync(filepath)) {
      const existing = parseFrontmatter(readFileSync(filepath, 'utf8'));
      if (existing.dedupKey !== dedupKey) {
        console.error(`[Ledger] 파일명 충돌(내용 다름) — ${filepath} 기존 dedupKey="${existing.dedupKey}" vs 신규="${dedupKey}"`);
      } else {
        console.log(`[Ledger] 이미 기록됨(중복 아님) — ${filepath}`);
      }
    } else {
      writeAtomic(filepath, content);
      console.log(`[Ledger] Facts/Ledger 기록 — ${filepath}`);
    }
    return true;
  }

  console.log(`[감시 시작] 주문번호 ${orderNo}(${account} ${name}) 체결 확인 — 최대 ${timeoutMin}분`);
  const deadline = Date.now() + timeoutMin * 60 * 1000;

  while (Date.now() < deadline) {
    if (await checkAndReportIfDone()) return;
    await sleep(60 * 1000); // 1분 간격 폴링(watch-order-fill.mjs와 동일)
  }

  // 타임아웃 직전 마지막 확인.
  if (await checkAndReportIfDone()) return;

  console.log('[타임아웃] 확인 시간 내 전량체결 미확인 — 알림 발송');
  await sendTelegram(formatDepartmentMessage({
    departmentLabel: DEPARTMENT_LABEL,
    tag: '경고',
    body: `<b>체결 확인 시간 초과</b>\n${name}(${code}) 주문번호 ${orderNo}(${account})\n` +
      `${timeoutMin}분 동안 전량체결 확인 안 됨 — NH 앱에서 직접 확인해 주세요.\n` +
      `(미체결·부분체결로 남아있거나 취소됐을 수 있음 — 이 조회조건으로는 구분 안 됨)`,
  }));
}

// import.meta.url 가드(watch-order-fill.mjs·execute-quant-proposal.mjs와 동일 이유).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error('\n❌ 오류:', e.message); process.exit(1); });
}
