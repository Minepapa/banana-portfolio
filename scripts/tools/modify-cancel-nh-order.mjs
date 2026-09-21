#!/usr/bin/env node
// modify-cancel-nh-order.mjs — NH PLUG(위탁·금현물) 주문 정정/취소 CLI(2026-09-21,
// 오너 지시 — Log/DevRequests/2026-09-21-NH-주문-정정취소-CLI.md). place-nh-direct-
// order.mjs 후속 — place-nh-direct-order.mjs로(또는 부서 제안 승인으로) 낸 주문을
// 텔레그램 지시("현재 건 9,450원으로 정정주문 해줘")로 정정·취소한다.
//
// ⚠️ 임시 스크립트로 라이브러리 함수(modifyKrOrder·cancelKrOrder 등)를 직접 호출하면
// 안전장치를 우회한다는 게 이 DevRequest의 명시적 경고였다 — 이 CLI는 새 안전장치를
// 만들지 않고 order-gate.mjs(킬스위치·가격이탈)를 그대로 재사용한다. 정정은 "가격을
// 새로 정하는" 행위라 신규 주문과 동일한 가격이탈 검사(±1%)를 받는다.
//
// ⚠️ 취소도 킬스위치를 똑같이 통과해야 한다 — place-breakout-fallback-entry.mjs의
// confirmPriorOrderVoided가 겪은 CRITICAL 사고(2026-09-19 코드리뷰)가 정확히 이
// 클래스였다: 취소 시도가 킬스위치 체크보다 먼저 실행돼, 오너가 킬스위치를 켜놔도
// 실제 취소주문이 나가버렸다. "취소는 위험을 줄이는 행위니 예외로 허용"하지 않는다
// — 이 프로젝트가 이미 겪은 실사고로 확립된 원칙: 모든 브로커 행위는 킬스위치
// 통제 아래 있다, 예외 없음.
//
// ⚠️ 정정/취소는 새 주문번호를 받는다(원 주문번호와 다름) — 이 CLI가 Decisions/
// Proposals 레코드를 best-effort로 찾아 갱신하고(구조화된 필드가 아니라
// executionLog 자유텍스트에서 주문번호를 찾는 방식이라 완전하진 않음, 아래
// findProposalByOrderNo 참고), 정정 성공 시 watch-nh-order-fill.mjs를 새 주문번호로
// 재기동한다(기존 감시는 옛 번호를 못 찾아 타임아웃될 뿐 — 죽이지 않음, 아래 참고).
// DevRequest가 요구한 "brokerOrderId 정합"은 애초에 execute-proposal.mjs가
// brokerOrderId를 frontmatter에 영속하지 않아(2026-09-21 독립 코드리뷰 확인) 이
// CLI가 executionLog grep으로 대신하는 것이고, executed-orders.mjs는 주문번호가
// 아니라 proposalId로 키잉하므로 주문번호가 바뀌어도 영향 없음(같은 리뷰에서 확인,
// 무해).
//
// ⚠️ 알려진 한계(2026-09-21 독립 코드리뷰) — 아래 2건은 판단이 필요해 이번 구현
// 범위에서 의도적으로 남겨둔다:
//   1) --order-no를 NH에 그대로 보내기 전 "그 번호가 실제로 --account/--code/--side와
//      일치하는 미체결 주문인지" 사전 대조를 안 한다. Zeus가 자연어에서 주문번호를
//      잘못 읽으면(같은 종목에 미체결이 2건 이상일 때 특히) 엉뚱한 주문을 정정·
//      취소할 수 있다 — NH가 종목코드 불일치를 거부해 주는지는 미검증.
//   2) 정정 경로가 order-gate.mjs의 6종 검문소 중 킬스위치·가격이탈 2종만 쓴다
//      (checkMarketOpen 등 나머지는 place-nh-direct-order.mjs 경로만 받음) — 장
//      마감 후 정정 시도가 전일 종가 대비 ±1%만 보고 통과할 수 있다.
// 옛 주문에 걸려 있던 watch-nh-order-fill.mjs 감시는 정정 후에도 안 죽는다 — 타임
// 아웃되면 실제로 텔레그램 경고(체결 확인 시간 초과)를 보낸다(주석뿐인 게 아님).
// 정정 1회마다 옛 번호 타임아웃 경고 + 새 번호 체결 확인, 이렇게 모순돼 보이는 2건
// 알림이 같이 올 수 있다는 뜻 — Zeus가 회신할 때 이 점을 함께 안내할 것.
//
// 사용법:
//   node scripts/tools/modify-cancel-nh-order.mjs --action=정정 --order-no=847026 \
//     --account=위탁 --code=0086B0 --name="TIGER 리츠부동산인프라TOP10액티브" \
//     --side=매도 --price=9450
//   node scripts/tools/modify-cancel-nh-order.mjs --action=취소 --order-no=847026 \
//     --account=위탁 --code=0086B0 --name="TIGER 리츠부동산인프라TOP10액티브" --side=매도
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VAULT_PATHS } from '../lib/vault-paths.mjs';
import { writeStateFile } from '../lib/state-writer.mjs';
import { parseProposal, updateProposalRecord } from '../lib/proposal-vault.mjs';
import { checkKillSwitch, checkPriceDeviation } from '../lib/order-gate.mjs';
import { getExecutionMode, MODE_LIVE } from '../lib/shadow-mode.mjs';
import { hasNhplugCredentials, loadNhplugCredentials, getNhToken, listNhAccounts } from '../lib/nhplug.mjs';
import { resolveNhAccountsByLabel } from '../lib/nh-accounts.mjs';
import { getKrCurrentPrice, modifyKrOrder, cancelKrOrder } from '../lib/nhplug-krstock.mjs';
import { getGoldCurrentPrice, modifyGoldOrder, cancelGoldOrder } from '../lib/nhplug-krgold.mjs';
import { extractNhPrice } from '../lib/nh-response-parse.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
// execute-asset-allocation-proposal.mjs·place-nh-direct-order.mjs와 동일 집합.
const ALLOWED_ACCOUNTS = new Set(['위탁', '금현물']);
const ACTIONS = new Set(['정정', '취소']);

function parseArgs(argv) {
  const out = {};
  for (const a of argv) {
    const m = a.match(/^--([a-z-]+)=(.*)$/s);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

function readStateFileOrNull(filepath) {
  try { return readFileSync(filepath, 'utf8'); } catch { return null; }
}

// ⚠️ watch-nh-order-fill.mjs의 alertAndExit(텔레그램도 같이 보냄)과 달리 여기선
// console만 쓴다 — 그 파일은 detached+stdio:'ignore'로 백그라운드에 떠서 실패가
// 아무 데도 안 남는 게 문제였지만, 이 CLI는 place-nh-direct-order.mjs·
// kill-switch-cli.mjs와 같은 실행 환경(Zeus가 동기 호출해 stdout을 그 자리에서
// 직접 읽고, Zeus의 대화 응답이 곧 확인 채널)이라 자체 텔레그램이 오히려 중복
// 알림만 된다(2026-09-21 자체 발견 — 인자검증 스모크테스트 중 실제로 텔레그램에
// 불필요한 경고 4건이 나가는 걸 확인하고 제거).
function alertAndExit(message, exitCode = 2) {
  console.error(`❌ ${message}`);
  process.exit(exitCode);
}

function loadProposals(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => {
      // ⚠️ content를 반드시 같이 담는다(2026-09-21 독립 코드리뷰 CRITICAL 지적 —
      // place-nh-direct-order.mjs의 loadProposals를 그대로 복사해 왔는데, 그쪽은
      // findActiveProposal만 써서 content가 필요 없었다. 이 파일은 뒤에서
      // updateProposalRecord(proposal.content, updates)를 호출하므로 content가
      // undefined면 parseFrontmatter(undefined)가 {}를 반환해 갱신 결과가 updates
      // 필드만 남고 id·track·assetKey 등 기존 필드가 전부 소실된다(실행으로 재현
      // 확인됨 — execute-asset-allocation-proposal.mjs·execute-quant-proposal.mjs가
      // 쓰는 패턴과 동일하게 맞춘다).
      const content = readFileSync(join(dir, f), 'utf8');
      return { filename: f, content, ...parseProposal(content) };
    });
}

// 순수함수(테스트 가능) — Vault 제안 레코드 갱신 payload 조립만 담당, NH API·
// 파일시스템과 완전히 분리(2026-09-21 독립 코드리뷰 MEDIUM 지적 — 이 로직이
// main() 안에 있었을 때는 위 CRITICAL이 테스트로 안 잡혔다).
export function buildProposalUpdates({ action, proposal, newOrderNo, newPrice, now }) {
  // ⚠️ executionLog는 이 프로젝트 전역에서 한 줄짜리 자유텍스트다(vault-
  // frontmatter.mjs가 "평평한 key: value" 전용 라이트 파서라 개행을 왕복 못 시킴 —
  // 2026-09-21 독립 코드리뷰 HIGH 지적, 실행으로 재현: 개행을 넣으면 다음 읽기에서
  // 둘째 줄부터 조용히 소실됨). 새 줄 대신 ` | ` 구분자로 이어 붙인다.
  const sep = proposal.executionLog ? `${proposal.executionLog} | ` : '';
  if (action === '정정') {
    return {
      proposedPrice: newPrice,
      executionLog: `${sep}정정 — 새 주문번호 ${newOrderNo}, 새 가격 ${newPrice}(${now})`,
    };
  }
  return {
    status: '취소',
    rejectReason: `오너 직접 취소(텔레그램) — 취소주문번호 ${newOrderNo}`,
    executionLog: `${sep}취소 — 취소주문번호 ${newOrderNo}(${now})`,
  };
}

// 순수함수(테스트 가능) — orderNo(문자열)를 executionLog에 담고 있는 제안을 찾는다.
// Decisions/Proposals는 "현재 이 계좌·이 주문번호로 뭐가 나가 있는지"를 구조화된
// 필드로 안 갖고 있다(executionLog는 자유텍스트) — 완전한 인덱스가 아니라 best-
// effort 조회다. 0건·2건 이상(같은 번호가 두 레코드에 우연히 다 나오는 경우 등)은
// 추정하지 않고 null — 이 CLI의 핵심 동작(NH API 호출)은 이 조회 결과와 무관하게
// 계속 진행하고, 찾았을 때만 Vault 레코드를 같이 갱신한다.
export function findProposalByOrderNo(proposals, orderNo) {
  // ⚠️ 단순 .includes()는 숫자 접두어 오탐이 난다("주문번호 84702"가 "주문번호
  // 847026" 문자열에 포함된 것으로 잘못 매칭됨) — 매칭 뒤에 숫자가 더 이어지지
  // 않는지 경계까지 확인한다(음성 lookahead, 자체 발견 후 수정). 왼쪽 경계도
  // 막는다(?<![가-힣]) — 이 파일 스스로 "취소주문번호 N"을 executionLog에 남기므로
  // ("주문번호"가 "취소주문번호" 안에 그대로 포함됨) 왼쪽을 안 막으면 같은 번호를
  // "주문번호"·"취소주문번호"로 각각 가진 두 레코드가 둘 다 매칭돼(2건) null로
  // 빠지며 Vault 갱신이 조용히 스킵된다(2026-09-21 독립 코드리뷰 LOW 지적, 실행으로
  // 재현 확인).
  const re = new RegExp(`(?<![가-힣])주문번호 ${orderNo}(?!\\d)`);
  const matches = proposals.filter((p) => re.test(p.executionLog || ''));
  return matches.length === 1 ? matches[0] : null;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const action = args.action;
  const orderNo = Number(args['order-no']);
  const account = args.account;
  const code = args.code || '';
  const name = args.name || code;
  const side = args.side;
  const explicitPrice = args.price != null ? Number(args.price) : null;

  if (!ACTIONS.has(action)) { alertAndExit(`--action은 "정정" 또는 "취소"만 허용(받은 값: ${action})`); return; }
  if (!(Number.isInteger(orderNo) && orderNo > 0)) { alertAndExit('--order-no는 양의 정수여야 함(NH 원주문번호)'); return; }
  if (!ALLOWED_ACCOUNTS.has(account)) { alertAndExit(`--account는 위탁 또는 금현물만(받은 값: ${account})`); return; }
  if (!code.trim()) { alertAndExit('--code(종목코드) 필수'); return; }
  if (!['매수', '매도'].includes(side)) { alertAndExit(`--side는 매수 또는 매도만(받은 값: ${side})`); return; }
  if (action === '정정' && !(Number.isFinite(explicitPrice) && explicitPrice > 0)) {
    alertAndExit('정정은 --price(새 정정가격, 양수) 필수'); return;
  }

  // 킬스위치 — 모든 것보다 먼저, NH 호출 전 확인(위 파일 헤더 "취소도 킬스위치를
  // 똑같이 통과해야 한다" 참고 — 이 순서 자체가 안전장치다).
  const killCheck = checkKillSwitch({ killSwitchContent: readStateFileOrNull(VAULT_PATHS.state.killSwitch) });
  if (!killCheck.pass) { alertAndExit(`킬스위치 활성 — ${action} 실행 안 함(${killCheck.reason})`, 1); return; }

  if (!hasNhplugCredentials()) { alertAndExit('NH PLUG 크리덴셜 미설정', 1); return; }

  const { appkey, appsecret } = loadNhplugCredentials();
  const token = await getNhToken({ appkey, appsecret });
  const accounts = await listNhAccounts({ token });
  const actNoByLabel = resolveNhAccountsByLabel(accounts, ALLOWED_ACCOUNTS);
  const actNo = actNoByLabel.get(account);
  if (!actNo) { alertAndExit(`NH 계좌(${account}) 조회 실패(미등록 가능성)`, 1); return; }

  // 정정은 신규 주문과 동일하게 가격이탈 검문소(±1%)를 받는다 — 현재가와 너무
  // 동떨어진 정정가를 그대로 내보내지 않는다(place-nh-direct-order.mjs와 동일 원칙).
  if (action === '정정') {
    let currentPrice;
    try {
      currentPrice = account === '금현물'
        ? extractNhPrice((await getGoldCurrentPrice({ token, iemCd: code })).Output_0, 'stck_prpr')
        : extractNhPrice((await getKrCurrentPrice({ token, iemCd: code })).Output_0, 'stck_prpr');
    } catch (e) {
      console.error('현재가 조회 실패 —', e.message);
      alertAndExit('현재가 조회 실패 — 정정 중단(로그 확인 필요)', 1); return;
    }
    const deviation = checkPriceDeviation({ proposedPrice: explicitPrice, currentPrice });
    if (!deviation.pass) { alertAndExit(`가격이탈 검문소 차단 — ${deviation.reason}`, 1); return; }
  }

  const mode = getExecutionMode(readStateFileOrNull(VAULT_PATHS.state.executionMode));
  if (mode !== MODE_LIVE) {
    console.log(`[섀도우] 실제 NH ${action} 없이 로그만 — 주문번호 ${orderNo}(${account} ${name})${action === '정정' ? ` → ${explicitPrice}원` : ''}`);
    return;
  }

  let result;
  try {
    if (action === '정정') {
      const modifyFn = account === '금현물' ? modifyGoldOrder : modifyKrOrder;
      result = await modifyFn({ token, actNo, orgMktOrrNo: orderNo, iemCd: code, corPr: explicitPrice });
    } else {
      const cancelFn = account === '금현물' ? cancelGoldOrder : cancelKrOrder;
      result = await cancelFn({ token, actNo, orgMktOrrNo: orderNo, iemCd: code });
    }
  } catch (e) {
    // confirmedNotSent=true(사전검증 실패·NH 명시적 업무거부)면 확실히 안 나감,
    // 그 외(네트워크 예외 등)는 실제로 처리됐을 수 있어 불명 — nhplug-order-
    // safety.mjs 계약과 동일 원칙으로 문구를 구분한다.
    console.error(`NH ${action} 실패 —`, e.message);
    const uncertain = e.confirmedNotSent !== true;
    alertAndExit(
      `NH ${action} 실패(주문번호 ${orderNo}, ${account} ${name})${uncertain ? ' — 실제로는 처리됐을 수 있음, NH 앱에서 직접 확인 필요' : ' — 확실히 처리 안 됨'}(상세: 로그 참고)`,
      1,
    );
    return;
  }

  // 텔레그램은 이 CLI 자신이 안 보낸다 — place-nh-direct-order.mjs·kill-switch-
  // cli.mjs와 동일 설계(위 alertAndExit 주석 참고, Zeus의 대화 응답이 확인 채널).
  console.log(`✅ ${action} 접수 — 새 주문번호 ${result.orderNo}(원주문 ${orderNo}, ${account} ${name})${action === '정정' ? `, 새 가격 ${explicitPrice}원` : ''}`);

  // Vault 제안 레코드 갱신(best-effort — 못 찾아도 위 NH 처리 자체는 이미 끝난 뒤라
  // 이 CLI의 핵심 목적은 달성됨, 여기부터는 부가 기록).
  const proposalsDir = VAULT_PATHS.decisions.proposals;
  const proposal = findProposalByOrderNo(loadProposals(proposalsDir), String(orderNo));
  if (!proposal) {
    console.log(`ℹ️ Vault 제안 레코드를 못 찾음(주문번호 ${orderNo}) — NH ${action}은 이미 완료됐으니 기록만 누락, 필요시 수동 확인`);
  } else {
    const updates = buildProposalUpdates({
      action, proposal, newOrderNo: result.orderNo, newPrice: explicitPrice, now: new Date().toISOString(),
    });
    await writeStateFile(join(proposalsDir, proposal.filename), updateProposalRecord(proposal.content, updates));
    console.log(`[Vault] 제안 레코드 갱신 — ${proposal.filename}`);
  }

  // 정정 성공 시 새 주문번호로 체결감시를 다시 띄운다 — 옛 번호를 감시하던 이전
  // watch-nh-order-fill.mjs 인스턴스(있었다면)는 새 번호를 모르니 그대로 두면
  // 타임아웃까지 못 찾고 끝난다(죽이려 해도 PID를 추적 안 해서 방법이 없음) —
  // 대신 새 번호로 새 감시를 띄워 실제 체결은 놓치지 않는다. KR_STOCK·GOLD만
  // 이 감시를 지원한다(execute-asset-allocation-proposal.mjs와 동일 이유).
  if (action === '정정') {
    const child = spawn('node', [
      join(HERE, 'watch-nh-order-fill.mjs'),
      `--order-no=${result.orderNo}`,
      `--account=${account}`,
      `--code=${code}`,
      `--name=${name}`,
      `--side=${side}`,
    ], { detached: true, stdio: 'ignore' });
    child.on('error', (e) => console.error(`  ⚠️ 체결감시 기동 실패(정정 자체는 이미 접수됨): ${e.message}`));
    child.unref();
    console.log(`  👁️ 체결감시 재시작(백그라운드) — 새 주문번호 ${result.orderNo}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error('\n❌ 오류:', e.message); process.exit(1); });
}
