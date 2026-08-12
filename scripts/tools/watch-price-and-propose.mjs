#!/usr/bin/env node
// watch-price-and-propose.mjs — 지정 종목이 목표가에 도달(터치)하면 그 즉시 주문 제안을
// 생성해 텔레그램으로 발송하는 1회성 감시 도구(오너 지시, 2026-08-11 파이프라인 재검증
// 연장선). 장이 열릴 때까지 대기 → 장중에만 폴링 → 조건 충족 시 1회만 발송하고 종료 →
// 장마감까지 못 만나면 발송 없이 종료. create-quant-proposal.mjs와 동일하게
// createAndSendProposal(proposal-flow.mjs)을 재사용 — 검문소·발송 로직 중복 없음.
//
// 사용법:
//   node scripts/tools/watch-price-and-propose.mjs --code=017670 --name=SK텔레콤 \
//     --target=86200 --side=매수 --quantity=1 --reason="목표가 터치 자동 제안"
import { existsSync, readdirSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createAndSendProposal, buildProposalMessageBody } from '../lib/proposal-flow.mjs';
import { parseProposal } from '../lib/proposal-vault.mjs';
import { writeStateFile } from '../lib/state-writer.mjs';
import { VAULT_PATHS } from '../lib/vault-paths.mjs';
import { sendTelegram } from '../lib/telegram.mjs';
import { hasKisCredentials, loadKisCredentials, getKisToken, getKrQuote, isKrMarketOpen } from '../lib/kis.mjs';

function parseArgs(argv) {
  const out = {};
  for (const a of argv) {
    const m = a.match(/^--([a-z-]+)=(.*)$/s);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

function loadExistingProposals(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => {
      const content = readFileSync(join(dir, f), 'utf8');
      return { filename: f, content, ...parseProposal(content) };
    });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const code = args.code;
  const name = args.name || code;
  const target = Number(args.target);
  const side = args.side || '매수';
  const quantity = Number(args.quantity);
  const reason = args.reason || `목표가 ${target}원 터치 자동 제안`;
  // 장마감(15:30 KST) 이후엔 더 기다려도 오늘은 의미 없음 — 이 시각을 넘기면 미발송 종료.
  const deadlineHHMM = Number(args.deadline || 1530);

  if (!code) { console.error('❌ --code(종목코드) 필요'); process.exit(2); }
  if (!(target > 0)) { console.error('❌ --target(목표가)은 양수'); process.exit(2); }
  if (!(Number.isInteger(quantity) && quantity > 0)) { console.error('❌ --quantity는 양의 정수'); process.exit(2); }
  if (!hasKisCredentials()) { console.error('❌ KIS 크리덴셜 미설정'); process.exit(1); }

  const { appkey, appsecret } = loadKisCredentials();
  console.log(`[감시 시작] ${name}(${code}) 목표가 ${target.toLocaleString()}원 터치 대기 — 장마감(KST ${deadlineHHMM}) 전까지`);

  while (true) {
    const now = new Date();
    const kstParts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(now);
    const hhmm = Number(kstParts.find((p) => p.type === 'hour').value) * 100
      + Number(kstParts.find((p) => p.type === 'minute').value);

    if (!isKrMarketOpen(now)) {
      if (hhmm >= deadlineHHMM) {
        console.log(`[종료] 장마감 시각(KST ${deadlineHHMM}) 경과 — 오늘은 목표가 미도달, 제안 발송 안 함`);
        return;
      }
      await sleep(5 * 60 * 1000); // 장 시작 전이면 5분 간격으로 느긋하게 대기
      continue;
    }

    let price;
    try {
      const token = await getKisToken({ appkey, appsecret });
      ({ price } = await getKrQuote({ token, appkey, appsecret, code }));
    } catch (e) {
      console.error(`[조회 실패] ${e.message} — 다음 폴링에서 재시도`);
      await sleep(60 * 1000);
      continue;
    }

    console.log(`[폴링] 현재가 ${price.toLocaleString()}원 (목표 ${target.toLocaleString()}원)`);
    if (price >= target) {
      console.log(`[터치 확인] ${price.toLocaleString()}원 ≥ ${target.toLocaleString()}원 — 제안 생성`);
      const proposalsDir = VAULT_PATHS.decisions.proposals;
      mkdirSync(proposalsDir, { recursive: true });
      const existingProposals = loadExistingProposals(proposalsDir);
      const writeProposalFile = (filename, content) => writeStateFile(join(proposalsDir, filename), content);
      const sendMessage = async (text) => sendTelegram(text).then((r) => r?.result ?? r);

      const result = await createAndSendProposal({
        track: '퀀트', assetKey: code, name, side, quantity, proposedPrice: target, reason,
        departmentLabel: '카이로스', existingProposals, writeProposalFile, sendMessage,
      });

      if (result.action === 'blocked') {
        console.log(`⛔ 제안 생성 차단: ${result.reason}`);
      } else {
        console.log(`✅ 제안 생성·발송 완료: ${result.id} (message_id=${result.telegramMessageId ?? '없음'})`);
      }
      return;
    }

    await sleep(30 * 1000); // 장중 30초 간격 폴링
  }
}

main().catch((e) => { console.error('\n❌ 오류:', e.message); process.exit(1); });
