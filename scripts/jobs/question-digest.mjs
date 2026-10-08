#!/usr/bin/env node
// 비긴급 질문 묶음 발송(D68, 2026-10-09) — 매일 09:00·19:00.
// 질문 큐(95_Etna/Questions)의 묶음대기(urgent:false) 질문을 담당별로 묶어 그 담당 이름으로 보낸다.
// 긴급 질문(기본)은 만들 때 즉시 나가므로 여기서 다루지 않는다. 발송 결과를 확인하지 못한 묶음은 발송결과불명으로
// 남기고 자동 재발송하지 않는다 — 종료 코드 1로 잡 실패 알림(제우스)이 나가게 한다.
import { fileURLToPath } from 'node:url';
import { sendQuestionDigest } from '../lib/wiki-question-queue.mjs';

async function main() {
  const result = await sendQuestionDigest();
  if (!result.chunks && !result.orphans?.length) { console.log('ℹ️ 묶음대기 질문 없음'); return; }
  for (const r of result.results) {
    console.log(`${r.sent ? '✅' : '❌'} ${r.asker} 질문 ${r.questionIds.length}개 ${r.sent ? `발송(메시지 ${r.telegramMessageId})` : `발송 결과 불명: ${r.error}`}`);
  }
  if (result.orphans?.length) console.error(`❌ 이전 묶음 발송이 중단돼 발송결과불명으로 바꾼 질문: ${result.orphans.join(', ')}`);
  if (result.failed) {
    const ids = [...(result.orphans ?? []), ...result.results.filter((r) => !r.sent).flatMap((r) => r.questionIds)];
    console.error(`❌ 발송 결과를 확인하지 못한 질문(자동 재발송 안 함): ${ids.join(', ')}. 질문마다 wiki-question-cli reconcile --id=<ID>로 확인하세요.`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => { console.error('❌ 질문 묶음 발송 실패:', e); process.exit(1); });
}
