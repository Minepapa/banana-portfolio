// 모든 Node 텍스트 발송은 여기서 담당과 형식을 확인한 뒤 Telegram transport로 보낸다.
import { sendTelegram, editTelegramMessage } from './telegram.mjs';
import { formatDepartmentMessage, formatFactsMessage } from './telegram-messages.mjs';

export const AGENT_HEADERS = Object.freeze({
  zeus: '제우스 Zeus',
  plutus: '플루토스 Plutus',
  themis: '테미스 Themis',
  clio: '클리오 Clio',
  hermes: '헤르메스 Hermes',
  athena: '아테나 Athena',
});

export function renderAgentMessage({ agent, topic = null, kind, body, facts,
  conclusion, context, decisions, zeusComment } = {}) {
  const departmentLabel = AGENT_HEADERS[agent];
  if (!departmentLabel) throw new Error(`미등록 발신자: ${agent}`);
  if (kind === '정보') {
    if (body === undefined) throw new Error('정보 메시지 본문 누락');
    return formatDepartmentMessage({ departmentLabel, tag: topic, body, zeusComment });
  }
  if (kind === '판단') {
    if (!Array.isArray(facts) || !facts.length) throw new Error('판단 메시지 사실 누락');
    return formatFactsMessage({ departmentLabel, tag: topic, facts,
      conclusion, context, decisions, zeusComment });
  }
  throw new Error(`메시지 kind 누락 또는 미등록: ${kind}`);
}

// 렌더(로컬 검증) 실패는 네트워크를 타기 전이라 "확실히 안 나감"이다. 전달 결과 불명과 구분되게
// confirmedNotSent를 붙여 다시 던진다(경고 원장이 'rejected'로 기록, 4-4 리뷰 MEDIUM).
function renderOrReject(message) {
  try {
    return renderAgentMessage(message);
  } catch (error) {
    error.confirmedNotSent = true;
    throw error;
  }
}

export async function sendAgentMessage(message, chatId, options) {
  return sendTelegram(renderOrReject(message), chatId, options);
}

export async function editAgentMessage(messageId, message, chatId, options) {
  return editTelegramMessage(messageId, renderOrReject(message), chatId, options);
}
