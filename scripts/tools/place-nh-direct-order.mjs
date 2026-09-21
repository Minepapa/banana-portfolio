#!/usr/bin/env node
// place-nh-direct-order.mjs — 오너가 텔레그램에서 "먼저" 매수/매도를 지시했을 때(부서
// 제안을 승인하는 게 아니라 오너 본인이 발주 의도를 낸 경우) 쓰는 CLI(2026-09-21 오너
// 지시 — "제안 온 걸 내가 승인하는 것도 있고, 내가 먼저 매수/매도 주문을 내는 경우도
// 있다"). 상시 텔레그램 세션(Zeus)이 오너 발화에서 종목·수량·[가격]을 판단하고, 이미
// 정한 "1회 재확인 후 발주"(예: "삼성전자 10주 매수 접수할까요?" → "응") 절차를 거친
// 뒤에만 이 CLI를 호출한다 — 재확인 자체는 코드가 아니라 Zeus의 대화 턴이 담당한다.
//
// 새 주문실행 경로를 따로 만들지 않는다 — execute-asset-allocation-proposal.mjs가
// 이미 갖춘 안전장치(order-gate.mjs의 가격이탈·시장개장·킬스위치, executed-orders.mjs
// 중복방지, shadow-mode.mjs 체결모드)를 전부 재사용한다. 이 CLI가 하는 일은 ①자산군
// 분류(asset-allocation-instrument-router.mjs, 제안-승인 플로우와 동일 라우터) ②
// Decisions/Proposals에 상태 "승인"·decidedAt=지금인 레코드를 하나 만들고 ③그 하나를
// `--proposal-id`로 즉시 1회 실행뿐이다 — 결과 판정·체결·알림 로직은 전부 그 잡에
// 위임한다(같은 로직을 두 곳에 두면 한쪽만 고쳤을 때 조용히 갈라지는 위험이 있다는
// 이 프로젝트의 반복된 교훈).
//
// ⚠️ 카이로스(퀀트, KIS) 자동체결과 완전히 분리 — 이 CLI는 NH PLUG(위탁·금현물)만
// 다루고 execute-quant-proposal.mjs·place-breakout-entry-order.mjs는 전혀 안 건드린다.
// 킬스위치·체결모드(State/KillSwitch·State/ExecutionMode)는 기존 설계대로 카이로스와
// 전역 공유된다(의도된 기존 설계 — 별도 상태 파일을 새로 안 만든다) — "킬스위치 온"은
// 이 CLI로 내는 주문도 똑같이 막는다.
//
// ⚠️ 중복발주 가드 — execute-asset-allocation-proposal.mjs의 "같은 안건에 승인 2건"
// 방어는 --proposal-id로 특정 1건만 실행할 때는 건너뛰도록 설계돼 있다(대량 배치용
// 가드라서). 이 CLI는 프록시 제안을 만들기 *전에* findActiveProposal로 같은
// track+assetKey+side의 활성(대기·승인) 제안이 이미 있는지 직접 확인해 그 갭을 막는다.
//
// 사용법:
//   node scripts/tools/place-nh-direct-order.mjs --side=매수 --asset=삼성전자 --quantity=10
//   node scripts/tools/place-nh-direct-order.mjs --side=매도 --asset=005930 --quantity=5 --price=71000
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { VAULT_PATHS } from '../lib/vault-paths.mjs';
import { writeStateFile } from '../lib/state-writer.mjs';
import {
  buildProposalRecord, updateProposalRecord, parseProposal, findActiveProposal,
} from '../lib/proposal-vault.mjs';
import { getCodeRegistry } from '../lib/stock-registry.mjs';
import {
  INSTRUMENT_TYPE, buildHoldingsIndex, classifyAssetAllocationInstrument,
} from '../lib/asset-allocation-instrument-router.mjs';
import { extractNhPrice } from '../lib/nh-response-parse.mjs';
import { hasNhplugCredentials, loadNhplugCredentials, getNhToken } from '../lib/nhplug.mjs';
import { getKrCurrentPrice } from '../lib/nhplug-krstock.mjs';
import { getGbCurrentPrice } from '../lib/nhplug-gbstock.mjs';
import { getGoldCurrentPrice } from '../lib/nhplug-krgold.mjs';
import { ALLOWED_NH_ACCOUNTS } from './execute-asset-allocation-proposal.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const out = {};
  for (const a of argv) {
    const m = a.match(/^--([a-z-]+)=(.*)$/s);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

function loadProposals(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => ({ filename: f, ...parseProposal(readFileSync(join(dir, f), 'utf8')) }));
}

// 순수함수(테스트 가능, 2026-09-21 독립 코드리뷰 지적 — C1/H1/H2/H3가 전부 main()
// 안에 있어 테스트가 하나도 못 보던 지점이었다) — 분류 결과·매수매도·명시가격만으로
// 이 CLI가 이 주문을 받아줄지 판정한다. UNSUPPORTED·허용 계좌 밖(ISA·연금저축 등, H2)·
// 직접채권 매도(로트선택 불가)·금현물/직접채권 지정가 누락을 한 곳에서 표 형태로 검증.
export function resolveDirectOrderTarget({ classification, side, explicitPrice }) {
  if (classification.type === INSTRUMENT_TYPE.UNSUPPORTED) {
    return { ok: false, reason: `직접주문 대상 아님: ${classification.reason}` };
  }
  if (!ALLOWED_NH_ACCOUNTS.has(classification.nhAccountLabel)) {
    return { ok: false, reason: `직접주문 대상 계좌 아님(${classification.nhAccountLabel ?? '알 수 없음'}) — 위탁·금현물만 지원(ISA·연금저축 등은 이 CLI 대상 아님)` };
  }
  if (classification.type === INSTRUMENT_TYPE.KR_BOND) {
    if (side === '매도') return { ok: false, reason: '직접채권 매도는 지원 안 함(매수일자별 로트 선택이 필요해 추측 금지)' };
    if (explicitPrice == null) return { ok: false, reason: '직접채권 매수는 지정가(--price) 필수(시장가 개념 없음)' };
  }
  if (classification.type === INSTRUMENT_TYPE.GOLD && explicitPrice == null) {
    return { ok: false, reason: '금현물은 지정가(--price) 필수(시장가 개념 없음)' };
  }
  return { ok: true };
}

// 순수함수(테스트 가능) — 분류 결과에 맞는 현재가 조회 함수 선택. execute-asset-
// allocation-proposal.mjs의 resolveInstrumentContext와 동일 매핑(그쪽은 배치 조회
// 최적화가 섞여 있어 그대로 재사용하지 않고, 필요한 부분만 가볍게 복제).
export function pickCurrentPriceFetcher(instrumentType) {
  if (instrumentType === INSTRUMENT_TYPE.KR_STOCK) {
    return async ({ token, iemCd, fetchImpl }) => extractNhPrice((await getKrCurrentPrice({ token, iemCd, fetchImpl })).Output_0, 'stck_prpr');
  }
  if (instrumentType === INSTRUMENT_TYPE.OVERSEAS_STOCK) {
    return async ({ token, iemCd, fetchImpl }) => extractNhPrice((await getGbCurrentPrice({ token, iemCd, fetchImpl })).Output_0, 'trdprc');
  }
  if (instrumentType === INSTRUMENT_TYPE.GOLD) {
    return async ({ token, iemCd, fetchImpl }) => extractNhPrice((await getGoldCurrentPrice({ token, iemCd, fetchImpl })).Output_0, 'stck_prpr');
  }
  return null; // KR_BOND·UNSUPPORTED는 현재가 자동조회 없음(직접채권은 항상 --price 필수)
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const side = args.side;
  const assetKey = (args.asset ?? '').trim();
  const quantity = Number(args.quantity);
  const explicitPrice = args.price != null ? Number(args.price) : null;

  if (side !== '매수' && side !== '매도') { console.error('❌ --side는 "매수" 또는 "매도"만 허용'); process.exit(2); }
  if (!assetKey) { console.error('❌ --asset 필요(종목명 또는 코드)'); process.exit(2); }
  // nhplug-order-safety.mjs의 validateOrderInputs가 결국 Number.isInteger를 요구한다
  // (소수 수량은 NH 주문 자체가 거부) — 이 CLI 단계에서 먼저 걸러야 제안 레코드가
  // 만들어지기 전에 즉시 알린다(2026-09-21 독립 코드리뷰 MEDIUM 지적).
  if (!(Number.isInteger(quantity) && quantity > 0)) { console.error('❌ --quantity는 양의 정수여야 함'); process.exit(2); }
  if (args.price != null && !(Number.isFinite(explicitPrice) && explicitPrice > 0)) {
    console.error('❌ --price는 양수여야 함'); process.exit(2);
  }

  if (!hasNhplugCredentials()) { console.error('❌ NH PLUG 크리덴셜 미설정'); process.exit(1); }

  const holdingsIndex = buildHoldingsIndex();
  const registry = getCodeRegistry();
  const classification = classifyAssetAllocationInstrument({
    assetKey, holdingsIndex, registry, dartApiKey: process.env.DART_API_KEY,
  });

  // ⚠️ 독립 코드리뷰 지적(2026-09-21, HIGH) — 계좌 판정(ALLOWED_NH_ACCOUNTS)이 빠지면
  // ISA·연금저축 종목도 일단 "승인" 레코드가 만들어진 뒤 execute-asset-allocation-
  // proposal.mjs가 "대상 계좌 밖"으로 조용히 건너뛰기만 해서(텔레그램 알림 없음),
  // 실행 안 된 채 고아로 남은 그 승인이 같은 안건에 대한 Athena의 정상 제안까지 막는다
  // — 제안을 만들기 *전에* 여기서 판정해 즉시 stdout으로 알린다.
  const target = resolveDirectOrderTarget({ classification, side, explicitPrice });
  if (!target.ok) { console.error(`❌ ${target.reason}`); process.exit(1); }

  // proposalAssetKey — Decisions/Proposals 전체가 assetKey를 "표시명"으로 저장하는
  // 관례라(실측: "금 99.99K"·"VOO" 등, iemCd/티커 코드가 아님) 여기도 그대로 맞춘다.
  // ⚠️ 독립 코드리뷰 지적(2026-09-21, HIGH) — 첫 버전은 classification.iemCd(NH
  // 내부코드)를 assetKey로 썼다. 그러면 ①execute-asset-allocation-proposal.mjs가
  // 이 제안을 다시 classifyAssetAllocationInstrument({assetKey: proposal.assetKey, ...})
  // 로 재분류할 때 코드가 아니라 이름 기반 조회라 어긋날 위험이 있고, ②아래 중복발주
  // 가드가 Athena 쪽 이름 기반 레코드와 절대 매칭이 안 돼(코드 vs 이름) 무력화된다.
  const proposalAssetKey = classification.resolvedName ?? assetKey;

  // 중복발주 가드 — 같은 안건(track+assetKey+side)의 활성(대기·승인) 제안이 이미
  // 있으면 새로 만들지 않는다(파일 헤더 "중복발주 가드" 주석 참고). Athena 쪽 제안과
  // 같은 assetKey 관례(표시명)를 써야 실제로 매칭된다(위 주석 참고).
  const proposalsDir = VAULT_PATHS.decisions.proposals;
  const existingProposals = loadProposals(proposalsDir);
  const active = findActiveProposal(existingProposals, { track: '자산분배', assetKey: proposalAssetKey, side });
  if (active) {
    console.error(`❌ 같은 안건(${side} ${proposalAssetKey})의 활성 제안이 이미 있음 — ${active.id}(상태: ${active.status}). 새로 만들지 않음, 필요하면 기존 것을 먼저 정리할 것.`);
    process.exit(1);
  }

  const { appkey, appsecret } = loadNhplugCredentials();
  const token = await getNhToken({ appkey, appsecret });

  let proposedPrice = explicitPrice;
  if (proposedPrice == null) {
    const fetchPrice = pickCurrentPriceFetcher(classification.type);
    if (!fetchPrice) { console.error(`❌ ${classification.type}은(는) --price 없이는 주문 불가`); process.exit(1); }
    try {
      proposedPrice = await fetchPrice({ token, iemCd: classification.iemCd });
    } catch (e) {
      console.error(`❌ 현재가 조회 실패 — 주문 생성 중단: ${e.message}`);
      process.exit(1);
    }
  }

  const { id, filename, content } = buildProposalRecord({
    track: '자산분배',
    account: classification.nhAccountLabel,
    assetKey: proposalAssetKey,
    side, quantity, proposedPrice,
    reason: `오너 직접 지시(텔레그램) — ${proposalAssetKey}`,
  });
  // ⚠️ 독립 코드리뷰 지적(2026-09-21, CRITICAL) — 첫 버전은 telegramMessageId를 null로
  // 남겨뒀다. order-gate.checkApprovalMatch(proposal-execution-input.buildGateInput이
  // replyTo·expectedProposalId 둘 다 proposal.telegramMessageId에서 채움)는 이 값이
  // null이면 무조건 차단한다("텔레그램 발송된 적 없이 승인 상태에 도달한 이상 상태"를
  // 잡는 자기일관성 체크) — 즉 이 CLI로 낸 주문은 매번 검문소에서 막혀 단 한 건도
  // 실제로 체결되지 않았다(실측 재현됨). 이 체크가 실제로 비교하는 건 "Frank의 진짜
  // reply_to 위조 여부"가 아니다(그건 telegram-reply-handler.mjs가 대기→승인 전이
  // 시점에 이미 처리) — 여기서는 replyTo와 expectedProposalId가 같은 필드에서 나와
  // 항상 자기 자신과 같으므로, 사실상 "telegramMessageId가 null이 아닌가"만 본다.
  // 직접주문은 Frank의 확인이 텔레그램 메시지 왕복이 아니라 Zeus와의 대화 턴(1회
  // 재확인)으로 이미 이뤄졌으므로, 그 사실을 드러내는 고유하고 추적 가능한 값을
  // 채운다(체크섬약화 아님 — Athena 경로는 여전히 실제 발송된 telegramMessageId만
  // 통과한다, 이 CLI가 만드는 제안만 이 형식을 쓴다).
  const directOrderProvenance = `직접주문:${id}`;
  const approved = updateProposalRecord(content, {
    status: '승인', decidedAt: new Date().toISOString(), telegramMessageId: directOrderProvenance,
  });
  await writeStateFile(join(proposalsDir, filename), approved);
  console.log(`✅ 직접주문 제안 생성+즉시승인: ${id} (${classification.nhAccountLabel}, ${side} ${quantity} @${proposedPrice})`);

  // 10분 크론을 기다리지 않고 지금 즉시 1회 실행 — 실행 로직(검문소·체결·알림)은
  // execute-asset-allocation-proposal.mjs 하나에만 둔다(위 파일 헤더 주석 참고).
  // ⚠️ 독립 코드리뷰 지적(2026-09-21, MEDIUM) — 첫 버전은 timeout이 없어 NH API가
  // 멈추면 Zeus 세션 전체가 무기한 블로킹됐고, 실패 시 e.message만 찍어 자식 프로세스의
  // stdout(검문소 판정·체결/차단 사유 — Frank에게 그대로 중계돼야 할 핵심 정보)을
  // 버렸다 — 이 CLI 설계 전체가 "Zeus가 stdout을 그대로 읽어 대화로 전달"에 의존하므로
  // 실패했을 때 그 정보를 잃으면 설계 취지 자체가 무너진다.
  try {
    const out = execFileSync(
      process.execPath,
      [join(HERE, 'execute-asset-allocation-proposal.mjs'), `--proposal-id=${id}`],
      { encoding: 'utf8', cwd: join(HERE, '..', '..'), timeout: 60_000 },
    );
    console.log(out.trim());
  } catch (e) {
    const childOutput = [e.stdout, e.stderr].filter(Boolean).join('\n').trim();
    if (childOutput) console.error(childOutput);
    console.error(`⚠️ 실행 잡이 비정상 종료(위 출력 참고) — 제안 레코드(${id})는 남아있으니 다음 10분 크론이 재시도함: ${e.message}`);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error('❌ place-nh-direct-order 오류:', e.message); process.exit(1); });
}
