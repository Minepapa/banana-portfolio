// 제안 생성→텔레그램 발송 오케스트레이션 — docs/ARCHITECTURE-V2.md "실행 흐름(주문)" 절
// 3단계("Zeus가 승인하면 텔레그램에 상세 사유와 함께 제안 발송")의 구현. 트랙 무관 공용
// (Athena·Kairos 둘 다 이 함수를 쓴다 — 제안 생성·검문소·발송 로직은 트랙에 따라 다를
// 이유가 없다, 다른 건 "무엇을 제안할지" 판단(부서 LLM)뿐).
//
// 실제 fs·네트워크 I/O는 전부 호출부가 주입한다(existingProposals·writeProposalFile·
// sendMessage) — 이 모듈 자체는 파일도 텔레그램도 직접 만지지 않는다(테스트 용이성,
// kis.mjs의 fetchImpl 주입과 같은 관례).
import { resolveProposalIntake } from './order-gate.mjs';
import { buildProposalRecord, updateProposalRecord } from './proposal-vault.mjs';
import { formatFactsMessage } from './telegram-messages.mjs';

// track → 원본 발송 부서 라벨. proposal 레코드 자체는 departmentLabel을 저장하지 않는다
// (createAndSendProposal 호출부가 매번 넘겨줄 뿐) — 승인/거부 후 원본 메시지를 편집할 때는
// 그 호출부 컨텍스트가 이미 사라진 뒤(process-telegram-reply.mjs가 나중에 별도 실행)라
// track에서 결정론적으로 되짚는다. 트랙이 늘어나면(예: 새 트랙) 이 매핑도 같이 늘려야 함.
const TRACK_DEPARTMENT_LABEL = { 퀀트: '퀀트전략실 Kairos', 자산분배: '투자전략실 Athena' };

const won = (n) => Math.round(n).toLocaleString('ko-KR');
// decidedAt(UTC ISO)을 KST 표기로 — sheets-api.mjs nowKST()와 같은 +9h 오프셋 방식이지만
// "지금"이 아니라 임의 시각을 변환해야 해서 그 함수를 그대로 재사용할 수 없다. 값이
// 없거나 파싱 불가면(Invalid Date) throw 대신 안전한 문구로 폴백 — 편집 텍스트 조립
// 전체가 죽어 승인/거부 자체가 막히면 안 된다(위 상태 전이는 이 함수 호출 전에 이미 끝남).
const formatKstDateTime = (iso) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '(시각 불명)';
  return new Date(d.getTime() + 9 * 3600_000).toISOString().replace('T', ' ').slice(0, 16);
};

// 텔레그램 메시지 본문(주문 상세 + 사유, 한 줄 요약형) — DRY-RUN 미리보기 등 사람이
// 짧게 훑어볼 용도로 계속 보존. 실제 발송 텔레그램 메시지는 아래 buildProposalFacts+
// formatFactsMessage(사실 개조식+해석 서술형 표준 구조, 2026-08-17 오너 확정)를 쓴다.
//
// ⚠️ quantity가 null(가격 미확인 신규종목 등)이면 amount를 계산하지 않는다(2026-08-23
// 코드리뷰 지적) — `null * price`는 JS에서 0으로 강제변환돼 "개산금액 ≈ 0원"이라는
// 틀린 값이 조용히 나갔던 버그. amountWon이 주어지면(Athena가 판단한 금액, 가격 조회
// 실패로 quantity·수량 환산은 못했지만 목표 배분액 자체는 있는 경우) 그걸 그대로
// 대신 보여준다 — 신규종목 제안이 오너에게 "얼마인지도 모르는 매수"로 도착하는 걸 막는다.
export function buildProposalMessageBody({ side, name, assetKey, quantity, proposedPrice, reason, amountWon = null }) {
  const amount = quantity != null && proposedPrice != null ? quantity * proposedPrice : null;
  let priceLine;
  if (amount != null) {
    priceLine = `${side} ${name}(${assetKey}) ${quantity}주 @${won(proposedPrice)}원 ≈ ${won(amount)}원`;
  } else if (amountWon != null) {
    priceLine = `${side} ${name}(${assetKey}) 약 ${won(amountWon)}원어치(수량은 체결 시 확정)`;
  } else {
    priceLine = `${side} ${name}(${assetKey}) ${quantity}주`;
  }
  return reason ? `${priceLine}\n사유: ${reason}` : priceLine;
}

// 제안의 결정론적 사실(Node가 계산한 값) — 개조식 텔레그램 메시지의 facts 배열로
// 쓰인다. reason(부서 LLM의 판단 서술)은 여기 안 넣는다 — 사실과 해석을 구조로
// 분리하는 게 표준 구조의 핵심이라 섞으면 안 된다. amountWon 폴백 배경은
// buildProposalMessageBody 주석과 동일.
export function buildProposalFacts({ side, name, assetKey, quantity, proposedPrice, amountWon = null }) {
  const amount = quantity != null && proposedPrice != null ? quantity * proposedPrice : null;
  const facts = [`${side} ${name}(${assetKey})`];
  if (quantity != null) facts.push(`수량 ${quantity}주`);
  if (proposedPrice != null) facts.push(`제안가 ${won(proposedPrice)}원`);
  if (amount != null) facts.push(`개산금액 ≈ ${won(amount)}원`);
  else if (amountWon != null) facts.push(`목표 배분액 ≈ ${won(amountWon)}원(수량은 체결 시 확정)`);
  return facts;
}

// 승인/거부 처리 후 원본 텔레그램 메시지를 갱신할 전체 텍스트 — 순수함수(테스트 가능).
// editMessageText는 append가 아니라 전체 교체라 원본과 같은 사실(facts)·사유(reason)를
// 다시 조립하고 태그만 [제안]→[승인]/[거부]로 바꾼다. proposal은 Vault 파일에서 다시
// 읽은 것(parseProposal 결과)이라 name(표시용 종목명)이 없다 — assetKey로 대체(발송 시
// buildProposalFacts와 같은 name??assetKey 폴백 원칙).
export function buildProposalStatusEditText({ proposal, action, decidedAt }) {
  const tag = action === 'reject' ? '거부' : '승인';
  // 매핑에 없는 track이면(새 트랙 추가 후 이 표 갱신을 깜빡한 경우) 조용히 raw track
  // 문자열로 넘어가지 않고 경고를 남긴다(조용한 폴백 금지 원칙) — 편집 자체는 계속
  // 진행한다(승인/거부 상태 전이를 막을 정도의 문제는 아님, 표시만 어색해질 뿐).
  if (!(proposal.track in TRACK_DEPARTMENT_LABEL)) {
    console.error(`⚠️ TRACK_DEPARTMENT_LABEL에 없는 track — 부서 라벨 대신 원본 표기: ${proposal.track}`);
  }
  const departmentLabel = TRACK_DEPARTMENT_LABEL[proposal.track] ?? proposal.track;
  const facts = buildProposalFacts({
    side: proposal.side, name: proposal.assetKey, assetKey: proposal.assetKey,
    quantity: proposal.quantity, proposedPrice: proposal.proposedPrice,
  });
  const decidedLine = `${tag}됨 (${formatKstDateTime(decidedAt)} KST)`;
  const interpretationParts = [proposal.reason || null];
  if (action === 'reject' && proposal.rejectReason) interpretationParts.push(`거부 사유: ${proposal.rejectReason}`);
  const interpretation = [decidedLine, ...interpretationParts.filter(Boolean)].join('\n\n');
  return formatFactsMessage({ departmentLabel, facts, interpretation, tag });
}

// existingProposals: [{filename, content, ...parseProposal() 결과}] — 호출부가 Decisions/
// Proposals 디렉토리를 이미 다 읽어서 넘긴다.
// writeProposalFile(filename, content): 파일 하나 쓰기(state-writer.writeStateFile 등 주입).
// sendMessage(text): 텔레그램 발송, { message_id } 반환 형태를 기대(telegram.mjs sendTelegram
// 의 원본 응답에서 result.message_id로 뽑아 호출부가 넘겨줘도 되고, 이 함수 안에서 처리해도
// 됨 — 아래 CLI는 후자를 택함).
//
// 반환: { action: 'blocked', reason } | { action: 'created', id, filename, telegramMessageId,
// supersededId }. 발송 자체가 실패하면(sendMessage throw) 제안 파일은 이미 쓰여진 상태로
// 남는다 — 텔레그램 실패가 "제안이 아예 없던 일"이 되면 안 되므로(재시도 시 중복 생성
// 방지를 위해 단일활성제안 원칙이 이미 다음 실행에서 자연히 막아준다) 예외를 그대로 던진다.
export async function createAndSendProposal({
  track, account = null, assetKey, name, side, quantity, proposedPrice, reason = '',
  departmentLabel, zeusComment = null,
  conditionsChanged = false,
  now = new Date(),
  existingProposals,
  writeProposalFile,
  sendMessage,
  amountWon = null,
}) {
  const intake = resolveProposalIntake({ track, assetKey, side, existingProposals, conditionsChanged, now });
  if (intake.action === 'blocked') {
    return { action: 'blocked', reason: intake.reason };
  }

  const { id, filename, content } = buildProposalRecord({ track, account, assetKey, side, quantity, proposedPrice, reason, now });

  let supersededId = null;
  if (intake.action === 'supersede') {
    const old = existingProposals.find((p) => p.id === intake.supersedeId);
    if (!old) throw new Error(`대체 대상 제안(${intake.supersedeId})을 existingProposals에서 찾을 수 없음 — 내부 일관성 오류`);
    const updatedOldContent = updateProposalRecord(old.content, { status: '대체됨', supersededBy: id });
    await writeProposalFile(old.filename, updatedOldContent);
    supersededId = old.id;
  }

  await writeProposalFile(filename, content);

  // 표준 구조(2026-08-17 오너 확정): 사실(Node 계산값)은 개조식, 부서 LLM의 판단
  // 서술(reason)은 그 뒤에 문단으로 — buildProposalMessageBody(한 줄 요약형)는 이제
  // DRY-RUN 미리보기 전용, 실제 발송은 여기서 조립한다.
  const facts = buildProposalFacts({ side, name: name ?? assetKey, assetKey, quantity, proposedPrice, amountWon });
  const messageText = formatFactsMessage({ departmentLabel, facts, interpretation: reason || null, zeusComment, tag: '제안' });
  const sendResult = await sendMessage(messageText);
  const telegramMessageId = sendResult?.message_id ?? null;

  let finalContent = content;
  if (telegramMessageId != null) {
    finalContent = updateProposalRecord(content, { telegramMessageId });
    await writeProposalFile(filename, finalContent);
  }

  return { action: 'created', id, filename, telegramMessageId, supersededId };
}
