#!/usr/bin/env node
// 므네모시네 Wiki 질문 큐 관리 CLI. 질문 발신·답변 기록은 Claude Telegram 세션이 호출한다.
import { readFileSync } from 'node:fs';
import {
  applyWikiQuestion, completeManualWikiQuestion, createWikiQuestion,
  listPendingWikiQuestions, reconcileWikiQuestion, resolveWikiQuestion,
  resendWikiQuestion,
} from '../lib/wiki-question-queue.mjs';

function parseArgs(argv) {
  const result = {};
  for (const arg of argv) {
    const match = arg.match(/^--([a-z-]+)=(.*)$/s);
    if (match) result[match[1]] = match[2];
  }
  return result;
}
function readStdin() { return readFileSync(0, 'utf8'); }
function output(value) { process.stdout.write(`${JSON.stringify(value)}\n`); }

async function main() {
  const [command, ...argv] = process.argv.slice(2);
  const args = parseArgs(argv);
  if (command === 'create') {
    const input = readStdin();
    if (!input.trim()) throw new Error('stdin으로 질문 JSON을 전달하세요.');
    output(await createWikiQuestion(JSON.parse(input)));
    return;
  }
  if (command === 'pending') {
    output(await listPendingWikiQuestions());
    return;
  }
  if (command === 'resolve') {
    if (!args.id || args.text === undefined) throw new Error('사용법: resolve --id=WQ-... --text="등록|보류|제외"');
    output(await resolveWikiQuestion(args.id, args.text));
    return;
  }
  if (command === 'apply') {
    if (!args.id) throw new Error('사용법: apply --id=WQ-...');
    output(await applyWikiQuestion(args.id));
    return;
  }
  if (command === 'complete') {
    if (!args.id || !args.summary) throw new Error('사용법: complete --id=WQ-... --summary="반영한 변경"');
    output(await completeManualWikiQuestion(args.id, args.summary));
    return;
  }
  if (command === 'reconcile') {
    if (!args.id || !['delivered', 'not-delivered'].includes(args.result)) {
      throw new Error('사용법: reconcile --id=WQ-... --result=delivered --message-id=123 또는 --result=not-delivered');
    }
    output(await reconcileWikiQuestion(args.id, { delivered: args.result === 'delivered', messageId: args['message-id'] }));
    return;
  }
  if (command === 'resend') {
    if (!args.id) throw new Error('사용법: resend --id=WQ-...');
    output(await resendWikiQuestion(args.id));
    return;
  }
  throw new Error('명령: create | pending | resolve | apply | complete | reconcile | resend');
}

main().catch((error) => {
  console.error(`wiki-question-cli 오류: ${error.message}`);
  process.exitCode = 1;
});
