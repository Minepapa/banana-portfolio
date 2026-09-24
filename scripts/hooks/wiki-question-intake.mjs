#!/usr/bin/env node
// 텔레그램 세션의 UserPromptSubmit 훅. 새 Telegram 수신 폴러 없이 제출된 메시지만 분류한다.
import { readFileSync } from 'node:fs';
import { listPendingWikiQuestions, parseExplicitWikiAnswer, resolveWikiQuestion, applyWikiQuestion } from '../lib/wiki-question-queue.mjs';

function emit(context) {
  if (context) process.stdout.write(`${JSON.stringify({
    hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: context },
  })}\n`);
}

async function main() {
  if (!process.env.CLAUDE_TELEGRAM_SESSION) return;
  let input;
  try { input = JSON.parse(readFileSync(0, 'utf8')); } catch { return; }
  const prompt = String(input?.prompt ?? '').trim();
  if (!prompt) return;

  const explicit = parseExplicitWikiAnswer(prompt);
  if (explicit) {
    const result = await resolveWikiQuestion(explicit.questionId, explicit.answer, { rawText: explicit.rawText });
    if (result.action === 'approve' && result.kind === 'keyword-registration') {
      try {
        const applied = await applyWikiQuestion(explicit.questionId);
        emit(`[므네모시네 질문 ${explicit.questionId}] 오너가 등록을 승인했고, 미리 제시한 색인·정본 aliases·역링크 변경을 반영 완료했다. 처리 결과: ${JSON.stringify(applied.applied)}. 이것은 위키 변경 승인일 뿐 투자 제안·주문 승인이 아니다. 결과를 간단히 회신하라.`);
      } catch (error) {
        emit(`[므네모시네 질문 ${explicit.questionId}] 등록 승인은 기록했으나 자동 반영이 실패했다: ${error.message}. 변경 내용을 임의로 넓히지 말고 원인을 점검한 뒤 안전하게 반영하거나 오너에게 재확인하라.`);
      }
      return;
    }
    if (result.action === 'clarify') {
      emit(`[므네모시네 질문 ${explicit.questionId}] 답변 선택이 명확하지 않아 상태를 바꾸지 않았다. 질문의 등록/승인, 보류, 제외/거절 중 하나로 재확인하라.`);
      return;
    }
    if (result.action === 'approve' && result.kind === 'manual-change') {
      emit(`[므네모시네 질문 ${explicit.questionId}] 오너 승인을 기록했다. 상태는 반영대기다. 제안된 문서 변경만 수행하고 완료 후 node scripts/tools/wiki-question-cli.mjs complete --id=${explicit.questionId} --summary="반영한 변경"을 호출하라. 투자 승인으로 해석하지 마라.`);
      return;
    }
    emit(`[므네모시네 질문 ${explicit.questionId}] 답변을 ${result.status ?? result.action} 상태로 기록했다. 투자 제안·주문 승인과 무관하다. 결과를 회신하라.`);
    return;
  }

  const pending = await listPendingWikiQuestions();
  if (pending.length) {
    const compact = pending.map((item) => `${item.questionId} [${item.status}] ${item.question}`).join('\n');
    emit(`[므네모시네 질문 대기열]\n${compact}\n메시지에 정확한 질문 ID와 등록/보류/제외 선택이 있으면 이미 자동 처리됐다. ID가 없으면 현재 대화에서 어떤 질문에 대한 답인지 명백할 때만 ` +
      `node scripts/tools/wiki-question-cli.mjs resolve --id=<정확한 ID> --text="등록|보류|제외"로 기록하라. 재시작 뒤 대화 맥락이 없거나 복수 후보면 ID를 되물어라. 승인 처리 후 keyword-registration은 apply 명령으로 반영하고, manual-change는 승인받은 변경만 수행한 뒤 complete로 마감하라. 이 승인은 투자 제안·주문과 분리된다.`);
  }
}

main().catch((error) => {
  // 훅 실패가 Telegram 메시지 처리를 막지 않게, 모델 쪽에서 안전한 재확인이 가능하도록 오류를 컨텍스트로 돌린다.
  emit(`[므네모시네 질문 큐 점검 실패] ${error.message}. 답변을 임의로 승인·처리하지 말고 질문 ID를 다시 확인하라.`);
});
