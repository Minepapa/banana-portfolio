#!/usr/bin/env node
// watch-order-fill.mjs — 방금 접수된 주문의 실제 체결 여부를 KIS 체결내역조회 API로
// 직접 확인해 텔레그램으로 알려주는 1회성 감시 도구(오너 지시, 2026-08-12 — 카카오
// 알림 파싱 파이프라인이 v2/퀀트 트랙에 배선돼 있지 않아 체결을 아무도 모르는 갭을
// 발견해 대응). execute-quant-proposal.mjs가 주문 접수 성공 직후 이 스크립트를 백그라운드
// 로 띄운다(오너가 직접 실행할 수도 있음).
//
// ⚠️ Facts/Ledger 기록(2026-08-13, 오너 확정) — 퀀트 트랙은 카카오 알림 파싱이 아니라
// KIS API로 직접 체결을 확인하므로(자산분배 트랙과 달리 알림 스크레이핑이 필요 없음),
// 전량체결 확인 시 이 스크립트가 ledger-vault-writer.mjs의 buildExecutionRecord()를 직접
// 호출해 Facts/Ledger에 기록한다 — 자산분배 트랙의 parse-notifications-to-vault.mjs와
// 같은 빌더·같은 dedup 방식(파일명 자체가 dedup 키)을 재사용, 계좌만 그 자리에서 바로
// '퀀트'로 채운다(카카오 경로는 파싱 시점에 계좌를 몰라 null로 미루지만, 여기는 애초에
// 퀀트 전용 계좌 하나뿐이라 미룰 이유가 없다).
//
// 사용법:
//   node scripts/tools/watch-order-fill.mjs --order-no=6693100 --code=017670 --name=SK텔레콤 --side=매수
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadKisCredentials, loadQuantAccount, getKisToken, checkOrderFill } from '../lib/kis.mjs';
import { sendTelegram } from '../lib/telegram.mjs';
import { formatDepartmentMessage } from '../lib/telegram-messages.mjs';
import { buildExecutionRecord } from '../lib/ledger-vault-writer.mjs';
import { writeAtomic } from '../lib/state-writer.mjs';
import { VAULT_PATHS } from '../lib/vault-paths.mjs';
import { QUANT_TRACK_LABEL } from '../lib/account-resolver.mjs';

const BROKER = '한국투자증권';
const ACCOUNT_LABEL = QUANT_TRACK_LABEL; // account-resolver.mjs·update-holdings-from-executions.mjs와 동일 라벨(단일 진실 소스)
// 이 잡의 체결확인 알림도 부서 라벨 없이 나가고 있었다(2026-08-17 지적) — 퀀트 트랙
// 소관이라 execute-quant-proposal.mjs와 동일하게 Kairos로 통일.
const DEPARTMENT_LABEL = '퀀트전략실 Kairos';

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

// 체결 확정 시 보낼 메시지 — avgFillPrice가 없으면(코드리뷰 지적, 2026-08-12 — 이론상
// KIS가 완전체결인데 평균단가를 안 줄 수도 있는 경우) "0원"/"NaN원"처럼 잘못된 숫자를
// 보여주지 않고 "확인 필요"로 명시한다.
function buildFilledMessage({ name, code, orderNo, filledQty, avgFillPrice }) {
  const amount = avgFillPrice != null ? won(filledQty * avgFillPrice) : '확인 필요';
  return `✅ <b>체결 확인</b>\n${name}(${code}) 주문번호 ${orderNo}\n${filledQty}주 전량 체결 @${won(avgFillPrice)} ≈ ${amount}`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const orderNo = args['order-no'];
  const code = args.code || '';
  const name = args.name || code;
  const side = args.side;
  // --timeout이 숫자가 아니면(오타 등) NaN이 아니라 기본값 30분으로 안전하게 폴백
  // (코드리뷰 지적, 2026-08-12 — NaN이면 deadline 비교가 항상 false가 돼 즉시 타임아웃).
  const timeoutArg = Number(args.timeout);
  const timeoutMin = Number.isFinite(timeoutArg) && timeoutArg > 0 ? timeoutArg : 30;

  if (!orderNo) { console.error('❌ --order-no 필요'); process.exit(2); }
  if (!['매수', '매도'].includes(side)) { console.error('❌ --side 는 매수 또는 매도(Ledger 기록에 필요)'); process.exit(2); }

  mkdirSync(VAULT_PATHS.facts.ledger.executions, { recursive: true });

  const quant = loadQuantAccount();
  if (!quant) { console.error('❌ 퀀트 계좌정보(quantAccount) 미설정'); process.exit(1); }
  const { appkey, appsecret } = loadKisCredentials();

  // 폴링 한 번(조회+판정)을 함수로 뽑아 루프 안에서도, 타임아웃 직전 마지막 확인에서도
  // 재사용한다(코드리뷰 지적, 2026-08-12 — 원래는 루프가 끝나자마자 "확인 안 됨"으로
  // 단정해, 마지막 폴링~타임아웃 사이(최대 60초)에 실제로 체결됐어도 놓치고 "미체결일
  // 수 있음" 알림을 보내는 거짓음성 창이 있었다 — 실거래에서 이게 오인 재주문으로
  // 이어지면 위험하므로 타임아웃 직전 반드시 한 번 더 확인).
  async function pollOnce() {
    const token = await getKisToken({ appkey, appsecret });
    return checkOrderFill({
      token, appkey, appsecret, cano: quant.cano, acntPrdtCd: quant.acntPrdtCd, odno: orderNo,
    });
  }

  // 확정 상태(취소·전량체결)면 텔레그램 발송 후 true, 아니면(미체결·부분체결·조회실패) false.
  async function checkAndReportIfDone() {
    let result;
    try {
      result = await pollOnce();
    } catch (e) {
      console.error(`[조회 실패] ${e.message}`);
      return false;
    }
    if (result?.canceled) {
      console.log('[취소 확인] 주문이 취소됨');
      await sendTelegram(formatDepartmentMessage({
        departmentLabel: DEPARTMENT_LABEL,
        body: `❌ <b>주문 취소 확인</b>\n${name}(${code}) 주문번호 ${orderNo} — 취소되었습니다.`,
      }));
      return true;
    }
    if (result?.fullyFilled) {
      console.log(`[체결 확인] 전량 체결 — 평균단가 ${result.avgFillPrice}원`);
      await sendTelegram(formatDepartmentMessage({
        departmentLabel: DEPARTMENT_LABEL,
        body: buildFilledMessage({ name, code, orderNo, filledQty: result.filledQty, avgFillPrice: result.avgFillPrice }),
      }));
      // avgFillPrice가 없으면(알려진 한계, 위 buildFilledMessage 주석 참고) Ledger에 가격
      // 없는 체결을 기록하지 않는다 — 알림은 이미 나갔으니 "확인 필요" 상태가 조용히
      // 묻히지 않고, 오너가 KIS와 대조해 수동 기록해야 함이 로그에 남는다.
      if (result.avgFillPrice != null) {
        const { filename, content, dir } = buildExecutionRecord({
          tradeDate: new Date().toISOString(),
          tradeType: side,
          stockCode: code,
          stockName: name,
          quantity: result.filledQty,
          price: result.avgFillPrice,
          currency: 'KRW',
          broker: BROKER,
          account: ACCOUNT_LABEL,
        });
        const filepath = join(dir, filename);
        if (existsSync(filepath)) {
          console.log(`[Ledger] 이미 기록됨(중복 아님) — ${filepath}`);
        } else {
          writeAtomic(filepath, content);
          console.log(`[Ledger] Facts/Ledger 기록 — ${filepath}`);
        }
      } else {
        console.error('[Ledger] avgFillPrice 없음 — 자동 기록 스킵, 수동 확인 필요');
      }
      return true;
    }
    if (result && result.filledQty > 0) {
      console.log(`[부분체결] ${result.filledQty}/${result.orderQty}주 — 계속 감시`);
    } else {
      console.log('[미체결] 계속 감시');
    }
    return false;
  }

  console.log(`[감시 시작] 주문번호 ${orderNo}(${name}) 체결 확인 — 최대 ${timeoutMin}분`);
  const deadline = Date.now() + timeoutMin * 60 * 1000;

  while (Date.now() < deadline) {
    if (await checkAndReportIfDone()) return;
    await sleep(60 * 1000); // 1분 간격 폴링
  }

  // 타임아웃 직전 마지막 확인 — 위 주석 참고.
  if (await checkAndReportIfDone()) return;

  console.log('[타임아웃] 확인 시간 내 전량체결 미확인 — 알림 발송');
  await sendTelegram(formatDepartmentMessage({
    departmentLabel: DEPARTMENT_LABEL,
    body: `⚠️ <b>체결 확인 시간 초과</b>\n${name}(${code}) 주문번호 ${orderNo} — ${timeoutMin}분 동안 전량체결 확인 안 됨. ` +
      `KIS 앱에서 직접 확인해 주세요(미체결로 남아있거나 부분체결됐을 수 있음).`,
  }));
}

main().catch((e) => { console.error('\n❌ 오류:', e.message); process.exit(1); });
