// 직접 발송 경고의 전달 결과를 원장에 기록한다. 기존 호출부의 메시지 구성·
// 자체 재시도/중복 억제는 건드리지 않는다. send는 필수 주입: 테스트에서 실채널로
// 빠지는 기본 경로를 두지 않는다. 일반 제안·정상 보고는 이 함수를 호출하지 않는다.
import { createHash, randomUUID } from 'node:crypto';
import { appendWarningEvent, sanitizeWarningDetail } from './warning-event-journal.mjs';

export function warningSubjectKey(prefix, value) {
  const hash = createHash('sha256').update(String(value)).digest('hex').slice(0, 20)
    .replace(/[0-9a-f]/g, (digit) => 'abcdefghijklmnop'[parseInt(digit, 16)]);
  return `${prefix}:${hash}`;
}

export function createDirectWarningSender(send, defaults) {
  if (typeof send !== 'function') throw new Error('직접 경고 전송 함수 필요');
  return (message, details = {}) => sendDirectWarning({ ...defaults, ...details, message, send });
}

export async function sendDirectWarning({
  message, send, jobName, warningCode, subjectKey, kind, severity,
  journalRoot, clock = Date.now, logger = console, targetJob, detail,
}) {
  if (typeof send !== 'function') throw new Error('직접 경고 전송 함수 필요');
  const attemptId = randomUUID();
  const incidentId = `direct-${createHash('sha256')
    .update(`${jobName}\0${warningCode}\0${subjectKey}`).digest('hex').slice(0, 32)}`;
  const base = { incidentId, jobName, warningCode, subjectKey, kind, severity,
    ...(targetJob ? { targetJob } : {}), ...(detail ? { detail: sanitizeWarningDetail(detail) } : {}) };
  const record = async (event) => {
    try {
      await appendWarningEvent({
        ...base, eventId: randomUUID(), occurredAt: new Date(clock()).toISOString(), ...event,
      }, journalRoot ? { rootDir: journalRoot } : undefined);
    } catch {
      // 원장 장애를 다시 Telegram으로 보고하면 재귀가 된다. 원래 발송은 계속한다.
      logger.error('직접 경고 원장 기록 실패 — 원래 경고 발송은 계속 진행');
    }
  };

  await record({ eventType: 'detected' });
  await record({ eventType: 'delivery', deliveryStatus: 'sending', deliveryAttemptId: attemptId });
  let response;
  try {
    response = await send(message);
  } catch (error) {
    await record({
      eventType: 'delivery', deliveryAttemptId: attemptId,
      deliveryStatus: error.telegramExplicitRejection || error.confirmedNotSent ? 'rejected' : 'unknown',
    });
    throw error;
  }
  if (response?.ok === true && Number.isSafeInteger(response.result?.message_id)
    && response.result.message_id > 0) {
    await record({
      eventType: 'delivery', deliveryStatus: 'sent', deliveryAttemptId: attemptId,
      telegramMessageId: response.result.message_id,
    });
    return response;
  }
  const rejected = response?.ok === false;
  await record({
    eventType: 'delivery', deliveryStatus: rejected ? 'rejected' : 'unknown',
    deliveryAttemptId: attemptId,
  });
  throw new Error(rejected ? 'Telegram이 직접 경고를 거부함' : 'Telegram 직접 경고 전달 결과 확인 불가');
}
