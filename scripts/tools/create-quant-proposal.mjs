#!/usr/bin/env node
// create-quant-proposal.mjs — 퀀트 트랙(Kairos) 주문 제안을 Vault에 쓰고 텔레그램으로
// 발송한다. docs/ARCHITECTURE-V2.md "실행 흐름(주문)" 3단계("Zeus가 승인하면 텔레그램에
// 상세 사유와 함께 제안 발송")의 구현 — 이 도구는 투자실행협의체(Hermes→Kairos→Themis→
// Zeus)가 이미 결론을 낸 **이후**, Zeus(상시 세션)가 호출하는 마지막 단계다. "무엇을
// 얼마에 살지"는 이 스크립트가 정하지 않는다(입력으로 받을 뿐) — Node는 검문소·기록·
// 발송만 결정론으로 수행.
//
// 사용법:
//   node scripts/tools/create-quant-proposal.mjs --side=매수 --code=005930 --name=삼성전자 \
//     --quantity=10 --price=71000 --reason="OCF/P 1위, 신규진입(랭킹 2026-08 리컨스티튜션)" \
//     [--zeus-comment="..."] [--conditions-changed] [--dry-run]
import { existsSync, readdirSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createAndSendProposal, buildProposalMessageBody } from '../lib/proposal-flow.mjs';
import { parseProposal } from '../lib/proposal-vault.mjs';
import { writeStateFile } from '../lib/state-writer.mjs';
import { VAULT_PATHS } from '../lib/vault-paths.mjs';
import { sendTelegram } from '../lib/telegram.mjs';

function parseArgs(argv) {
  const out = { flags: new Set() };
  for (const a of argv) {
    const m = a.match(/^--([a-z-]+)=(.*)$/s);
    if (m) { out[m[1]] = m[2]; continue; }
    const f = a.match(/^--([a-z-]+)$/);
    if (f) out.flags.add(f[1]);
  }
  return out;
}

// process-telegram-reply.mjs의 loadProposals()와 같은 디렉토리 읽기이지만, 대체(supersede)
// 시 기존 파일을 다시 써야 해서 raw content도 같이 들고 있어야 한다(parseProposal은 파싱된
// 필드만 반환) — 그래서 여기서 별도로 content까지 합쳐 반환한다.
function loadExistingProposals(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => {
      const content = readFileSync(join(dir, f), 'utf8');
      return { filename: f, content, ...parseProposal(content) };
    });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const DRY_RUN = args.flags.has('dry-run');

  const side = args.side;
  const assetKey = args.code;
  const name = args.name || assetKey;
  const quantity = Number(args.quantity);
  const proposedPrice = args.price != null ? Number(args.price) : null;
  const reason = args.reason || '';
  const zeusComment = args['zeus-comment'] || null;
  const conditionsChanged = args.flags.has('conditions-changed');

  if (!['매수', '매도'].includes(side)) { console.error('❌ --side 는 매수 또는 매도'); process.exit(2); }
  if (!assetKey) { console.error('❌ --code(종목코드) 필요'); process.exit(2); }
  if (!(Number.isInteger(quantity) && quantity > 0)) { console.error('❌ --quantity 는 양의 정수'); process.exit(2); }
  if (args.price != null && !(proposedPrice > 0)) { console.error('❌ --price 는 양수'); process.exit(2); }

  const proposalsDir = VAULT_PATHS.decisions.proposals;
  const existingProposals = loadExistingProposals(proposalsDir);

  if (DRY_RUN) {
    console.log('(드라이런 — Vault 쓰기·텔레그램 발송 없음)');
    console.log(buildProposalMessageBody({ side, name, assetKey, quantity, proposedPrice, reason }));
    return;
  }

  mkdirSync(proposalsDir, { recursive: true });
  const writeProposalFile = (filename, content) => writeStateFile(join(proposalsDir, filename), content);
  const sendMessage = async (text) => sendTelegram(text).then((r) => r?.result ?? r);

  const result = await createAndSendProposal({
    track: '퀀트', assetKey, name, side, quantity, proposedPrice, reason,
    departmentLabel: '카이로스', zeusComment, conditionsChanged,
    existingProposals, writeProposalFile, sendMessage,
  });

  if (result.action === 'blocked') {
    console.log(`⛔ 제안 생성 차단: ${result.reason}`);
    process.exit(1);
  }

  console.log(`✅ 제안 생성: ${result.id}`);
  if (result.supersededId) console.log(`   기존 제안 대체됨: ${result.supersededId}`);
  console.log(`   텔레그램 발송 완료(message_id=${result.telegramMessageId ?? '없음'}) — Frank의 승인/거부 답장 대기`);
}

main().catch((e) => { console.error('\n❌ 오류:', e.message); process.exit(1); });
