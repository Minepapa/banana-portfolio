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
import { formatDepartmentMessage } from './telegram-messages.mjs';

const won = (n) => Math.round(n).toLocaleString('ko-KR');

// 텔레그램 메시지 본문(주문 상세 + 사유) — 순수 함수, 테스트 가능.
export function buildProposalMessageBody({ side, name, assetKey, quantity, proposedPrice, reason }) {
  const amount = proposedPrice != null ? quantity * proposedPrice : null;
  const priceLine = proposedPrice != null
    ? `${side} ${name}(${assetKey}) ${quantity}주 @${won(proposedPrice)}원 ≈ ${won(amount)}원`
    : `${side} ${name}(${assetKey}) ${quantity}주`;
  return reason ? `${priceLine}\n사유: ${reason}` : priceLine;
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

  const body = buildProposalMessageBody({ side, name: name ?? assetKey, assetKey, quantity, proposedPrice, reason });
  const messageText = formatDepartmentMessage({ departmentLabel, body, zeusComment });
  const sendResult = await sendMessage(messageText);
  const telegramMessageId = sendResult?.message_id ?? null;

  let finalContent = content;
  if (telegramMessageId != null) {
    finalContent = updateProposalRecord(content, { telegramMessageId });
    await writeProposalFile(filename, finalContent);
  }

  return { action: 'created', id, filename, telegramMessageId, supersededId };
}
