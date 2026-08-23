#!/usr/bin/env node
/**
 * Frank의 텔레그램 답장 처리 — Zeus(상시 세션)가 답장을 받으면 이 CLI를 호출한다.
 *
 * 결정론적 처리만 한다(reply_to 매칭 → 대기/승인/거부 상태 전이) — 승인된 제안의 실제
 * 체결(검문소 통과+섀도우/실전 체결)은 여기서 하지 않는다. 현재가·보유수량·예수금 같은
 * 실행 시점 데이터가 필요한데 그건 Phase 8·9(자산분배·퀀트 트랙 부서 로직)가 공급한다
 * — 없는 데이터로 체결을 흉내 내지 않는다(scripts/lib/telegram-reply-handler.mjs 참고).
 *
 * ⚠️ --infer-pending: 텔레그램 플러그인이 상시세션(com.banana2.telegram-session)에
 * reply_to를 안 넘겨준다(2026-08-12 발견) — 진짜 메시지ID를 모를 때 이 플래그로
 * 대체한다. "대기" 상태 제안이 정확히 1건일 때만 그걸로 진행하고, 0건·2건 이상이면
 * clarify로 떨어진다(scripts/lib/telegram-reply-handler.mjs
 * inferReplyTargetFromPendingProposals — 예전엔 Zeus가 이 카운트를 매번 수동으로
 * 했는데 기계적 판정이라 Node로 옮김). 진짜 reply_to를 아는 경로(예: 이 CLI를 직접
 * 테스트할 때)는 그냥 --reply-to를 쓰면 된다.
 *
 * 사용법:
 *   node scripts/tools/process-telegram-reply.mjs --reply-to=<텔레그램메시지ID> --text="<답장원문>"
 *   node scripts/tools/process-telegram-reply.mjs --infer-pending --text="<답장원문>"
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { resolveReplyAction, inferReplyTargetFromPendingProposals } from '../lib/telegram-reply-handler.mjs';
import { parseProposal, updateProposalRecord } from '../lib/proposal-vault.mjs';
import { buildProposalStatusEditText } from '../lib/proposal-flow.mjs';
import { writeStateFile } from '../lib/state-writer.mjs';
import { VAULT_PATHS } from '../lib/vault-paths.mjs';
import { editTelegramMessage } from '../lib/telegram.mjs';

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
  const inferPending = process.argv.includes('--infer-pending');
  const explicitReplyTo = args['reply-to'] ? Number(args['reply-to']) : null;
  const replyText = args.text ?? '';

  if ((!explicitReplyTo && !inferPending) || !args.text) {
    console.error('usage: process-telegram-reply.mjs --reply-to=<id> --text="<답장원문>"');
    console.error('   or: process-telegram-reply.mjs --infer-pending --text="<답장원문>"  (reply_to 미노출 경로)');
    process.exit(2);
  }

  const proposals = loadProposals(VAULT_PATHS.decisions.proposals);

  let replyTo = explicitReplyTo;
  if (inferPending) {
    const inferred = inferReplyTargetFromPendingProposals(proposals);
    if (!inferred.telegramMessageId) {
      console.log(`❓ 재확인 필요: ${inferred.reason}`);
      console.log('Frank에게 다시 물어보세요 — 어느 제안에 대한 승인/거부인지 명확히.');
      return;
    }
    replyTo = inferred.telegramMessageId;
  }

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

  // 원본 제안 메시지 갱신(2026-08-23 신설, ARCHITECTURE-V2.md 설계엔 있었지만 미구현
  // 이던 부분) — 지금까지는 승인/거부해도 텔레그램 화면에 티가 안 나 나중에 어느 제안이
  // 어떻게 됐는지 스크롤해서 찾아야 했다. 부가 기능이라 실패해도(예: 원본 메시지가
  // 48시간 지나 Bot API 편집 제한에 걸림) 승인/거부 자체(위에서 이미 완료)를 막지 않는다.
  if (result.proposal.telegramMessageId != null) {
    const editText = buildProposalStatusEditText({
      proposal: { ...result.proposal, ...result.updates },
      action: result.action,
      decidedAt: result.updates.decidedAt,
    });
    try {
      await editTelegramMessage(result.proposal.telegramMessageId, editText);
    } catch (e) { console.error('원본 메시지 갱신 실패(무시):', e.message); }
  }
}

// import.meta.url 가드(2026-08-23, 독립 코드리뷰 MEDIUM 지적) — 이 파일은 실제 Vault
// 쓰기+텔레그램 편집을 하는 main()을 갖고 있다. 가드 없이 최상위에서 그냥 호출하면
// 나중에 이 파일의 parseArgs 같은 순수함수를 테스트하려고 import만 해도 main()이 실행돼
// 버린다 — morning-briefing.mjs가 실제로 이 사고를 낸 적이 있다(위 해당 파일 참고).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error('❌ 오류:', e.message); process.exit(1); });
}
