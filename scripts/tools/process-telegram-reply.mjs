#!/usr/bin/env node
/**
 * Frank의 텔레그램 답장 처리 — Zeus(상시 세션)가 답장을 받으면 이 CLI를 호출한다.
 *
 * 결정론적 처리만 한다(reply_to 매칭 → 대기/승인/거부 상태 전이) — 승인된 제안의 실제
 * 체결(검문소 통과+섀도우/실전 체결)은 여기서 하지 않는다. 현재가·보유수량·예수금 같은
 * 실행 시점 데이터가 필요한데 그건 Phase 8·9(자산분배·퀀트 트랙 부서 로직)가 공급한다
 * — 없는 데이터로 체결을 흉내 내지 않는다(scripts/lib/telegram-reply-handler.mjs 참고).
 *
 * 사용법:
 *   node scripts/tools/process-telegram-reply.mjs --reply-to=<텔레그램메시지ID> --text="<답장원문>"
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { resolveReplyAction } from '../lib/telegram-reply-handler.mjs';
import { parseProposal, updateProposalRecord } from '../lib/proposal-vault.mjs';
import { writeStateFile } from '../lib/state-writer.mjs';
import { VAULT_PATHS } from '../lib/vault-paths.mjs';

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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const replyTo = args['reply-to'] ? Number(args['reply-to']) : null;
  const replyText = args.text ?? '';

  if (!replyTo || !args.text) {
    console.error('usage: process-telegram-reply.mjs --reply-to=<id> --text="<답장원문>"');
    process.exit(2);
  }

  const proposals = loadProposals(VAULT_PATHS.decisions.proposals);
  const result = resolveReplyAction({ replyTo, replyText, proposals });

  if (result.action === 'clarify') {
    console.log(`❓ 재확인 필요: ${result.reason}`);
    console.log('Frank에게 다시 물어보세요 — 어느 제안에 대한 승인/거부인지 명확히.');
    return;
  }

  const filepath = join(VAULT_PATHS.decisions.proposals, result.proposal.filename);
  const currentContent = readFileSync(filepath, 'utf8');
  const updatedContent = updateProposalRecord(currentContent, result.updates);
  await writeStateFile(filepath, updatedContent);

  if (result.action === 'reject') {
    console.log(`🚫 거부 처리: ${result.proposal.id}`);
  } else {
    console.log(`✅ 승인 처리: ${result.proposal.id}`);
    console.log(`   다음 단계: ${result.nextStep}`);
  }
}

main().catch((e) => { console.error('❌ 오류:', e.message); process.exit(1); });
