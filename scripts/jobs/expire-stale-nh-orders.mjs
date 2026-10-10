#!/usr/bin/env node
// 장 마감 뒤 NH 당일유효 주문의 제안 상태만 정리한다. 체결 장부는 기존 reconcile 잡의 소관이다.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseProposal, updateProposalRecord } from '../lib/proposal-vault.mjs';
import { withLock, writeAtomic } from '../lib/state-writer.mjs';
import { buildHoldingsIndex, classifyAssetAllocationInstrument, INSTRUMENT_TYPE } from '../lib/asset-allocation-instrument-router.mjs';
import { getCodeRegistry } from '../lib/stock-registry.mjs';
import { loadNhplugCredentials, getNhToken, listNhAccounts } from '../lib/nhplug.mjs';
import { resolveNhAccountsByLabel } from '../lib/nh-accounts.mjs';
import { getKrDailyOrderExecution } from '../lib/nhplug-krstock.mjs';
import { getGoldExecution } from '../lib/nhplug-krgold.mjs';
import { classifyNhTimeoutOrder } from '../tools/watch-nh-order-fill.mjs';
import { parseNhExecutionRows, isTerminalNhExecution } from './reconcile-nh-executions.mjs';
import { recordProposalExecutionStatus } from '../lib/proposal-execution-status.mjs';
import { sendAgentMessage } from '../lib/pantheon-send.mjs';
import { escapeHtml } from '../lib/telegram.mjs';
import { VAULT_PATHS } from '../lib/vault-paths.mjs';

const SENDER_AGENT = 'plutus';
const OPEN_STATUSES = new Set(['주문접수', '부분체결']);
const KST_DATE = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' });
const KST_TIME = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

function quantity(value) {
  if (value == null || String(value).trim() === '') return null;
  const parsed = Number(String(value).replaceAll(',', ''));
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

export function eligibleOrderDate(proposal, now = new Date()) {
  if (proposal.track !== '자산분배' || !OPEN_STATUSES.has(proposal.status)) return null;
  if (!proposal.brokerOrderId || !proposal.submittedAt || !Number.isFinite(Date.parse(proposal.submittedAt))) return null;
  const orderDate = KST_DATE.format(new Date(proposal.submittedAt));
  const today = KST_DATE.format(now);
  if (orderDate > today || (orderDate === today && KST_TIME.format(now) < '15:30')) return null;
  return orderDate.replaceAll('-', '');
}

// watcher의 타임아웃 판정과 reconcile의 종결 판정을 함께 쓴다. 수량 보존이
// 확인되지 않은 행은 장 마감이라는 이유만으로 소멸했다고 추정하지 않는다.
export function classifyExpiryRow(rawRow, proposal, expectedCode) {
  if (!rawRow || String(rawRow.itg_orr_no ?? '').trim() !== String(proposal.brokerOrderId)) return { result: '확인 필요' };
  if (String(rawRow.iem_cd ?? '').trim() !== String(expectedCode)) return { result: '확인 필요' };
  const direction = String(rawRow.sby_dit_cd_nm ?? '');
  const side = direction.includes('매수') ? '매수' : direction.includes('매도') ? '매도' : null;
  if (side !== proposal.side) return { result: '확인 필요' };
  const ordered = quantity(rawRow.orr_qty);
  const filled = quantity(rawRow.tot_cns_qty);
  const unfilled = quantity(rawRow.ny_cns_qty);
  const canceled = quantity(rawRow.can_qty);
  const proposed = quantity(proposal.quantity);
  if (ordered == null || ordered === 0 || proposed == null || ordered !== proposed ||
      filled == null || unfilled == null || canceled == null || filled + unfilled + canceled !== ordered) {
    return { result: '확인 필요' };
  }
  const state = classifyNhTimeoutOrder(rawRow);
  if (state.kind === 'rejected') return { result: '확인 필요' };
  if (filled === 0 && unfilled === 0 && canceled === ordered && state.kind === 'canceled') return { result: '만료' };
  const parsed = parseNhExecutionRows([rawRow])[0];
  if (!parsed || parsed.stockCode !== String(expectedCode) || parsed.tradeType !== proposal.side) return { result: '확인 필요' };
  if (filled === ordered && unfilled === 0 && canceled === 0 && isTerminalNhExecution(parsed)) {
    return { result: '체결', execution: parsed };
  }
  if (filled > 0 && unfilled === 0 && canceled > 0 && isTerminalNhExecution(parsed)) {
    return { result: '부분종결', execution: parsed };
  }
  return { result: '확인 필요' };
}

// 정정 방어(2026-10-10 리뷰 HIGH): NH 앱에서 직접 정정하면 새 주문번호가 생기지만 제안에는 옛 번호가 남는다.
// 옛 번호 행은 정정분이 can_qty로 잡혀 '만료'처럼 보일 수 있다. 같은 날 같은 종목·같은 방향의 다른 주문이 있으면
// 닫지 않는다(만료·부분종결 → 확인 필요). 오너가 같은 종목을 따로 여러 번 주문한 날도 확인 필요가 되지만, 이중 주문보다 안전하다.
export function hasSiblingOrder(rows, proposal, expectedCode) {
  return rows.some((row) => {
    if (String(row?.itg_orr_no ?? '').trim() === String(proposal.brokerOrderId)) return false;
    if (String(row?.iem_cd ?? '').trim() !== String(expectedCode)) return false;
    const direction = String(row?.sby_dit_cd_nm ?? '');
    const side = direction.includes('매수') ? '매수' : direction.includes('매도') ? '매도' : null;
    return side === proposal.side;
  });
}

export async function expireProposalRecord({ proposalsDir, proposal, now = new Date() }) {
  if (!proposal.id || !/^[\p{L}\p{N}_.-]+$/u.test(proposal.id)) return false;
  const filepath = join(proposalsDir, `${proposal.id}.md`);
  return withLock(filepath, () => {
    let content;
    try { content = readFileSync(filepath, 'utf8'); } catch (error) {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
    const latest = parseProposal(content);
    if (latest.status !== proposal.status || latest.track !== proposal.track ||
        String(latest.brokerOrderId) !== String(proposal.brokerOrderId) ||
        latest.submittedAt !== proposal.submittedAt || !eligibleOrderDate(latest, now)) return false;
    writeAtomic(filepath, updateProposalRecord(content, {
      status: '만료', rejectReason: `장 마감 미체결 소멸 — 주문번호 ${proposal.brokerOrderId}, NH 조회 확인`,
    }));
    return true;
  });
}

export function formatExpiryMessage(items) {
  const line = ({ proposal, result, reason }) => `- ${escapeHtml(String(proposal.assetKey))} · ${escapeHtml(String(proposal.quantity))}주 · `
    + `주문번호 …${escapeHtml(String(proposal.brokerOrderId).slice(-4))} · ${result}${reason ? ` (${escapeHtml(reason)})` : ''}`;
  const closed = items.filter((item) => item.result !== '확인 필요');
  const pending = items.filter((item) => item.result === '확인 필요');
  const parts = ['<b>NH 장 마감 주문 제안 정리</b>'];
  if (closed.length) {
    parts.push(`■ 정리됨\n${closed.map(line).join('\n')}`);
    if (closed.some((item) => item.result !== '체결')) parts.push('만료·부분종결 건은 필요하면 다시 제안·주문해 주세요.');
  }
  if (pending.length) parts.push(`■ 확인 필요(자동으로 닫지 않음)\n${pending.map(line).join('\n')}\nNH 앱에서 주문 상태를 확인해 알려 주세요.`);
  return parts.join('\n\n');
}

export async function runExpiry({ proposalsDir = VAULT_PATHS.decisions.proposals, now = new Date(),
  dryRun = false, noSend = false, classify, query, accounts, send = sendAgentMessage, log = console.warn,
  beforeWrite = async () => {},
} = {}) {
  const summary = { eligible: 0, expired: 0, filled: 0, partialClosed: 0, unknown: 0, raced: 0, items: [], sendFailed: false };
  const today = KST_DATE.format(now).replaceAll('-', '');
  const rowCache = new Map(); // (계좌, 날짜)별 조회 결과 — 같은 날 여러 제안이 있어도 한 번만 조회한다
  const filenames = existsSync(proposalsDir) ? readdirSync(proposalsDir).filter((name) => name.endsWith('.md')) : [];
  for (const filename of filenames) {
    let proposal;
    try { proposal = parseProposal(readFileSync(join(proposalsDir, filename), 'utf8')); }
    catch (error) { log(`[확인 필요] ${filename}: ${error.message}`); summary.unknown++; continue; }
    if (`${proposal.id}.md` !== filename) { log(`[확인 필요] 제안 파일명·ID 불일치: ${filename}`); summary.unknown++; continue; }
    const orderDate = eligibleOrderDate(proposal, now);
    if (!orderDate) continue;
    summary.eligible++;
    let decision = { result: '확인 필요' };
    let reason = '';
    try {
      const instrument = await classify(proposal);
      const supported = (instrument.type === INSTRUMENT_TYPE.KR_STOCK && instrument.nhAccountLabel === '위탁') ||
        (instrument.type === INSTRUMENT_TYPE.GOLD && instrument.nhAccountLabel === '금현물');
      // 제안의 account 필드는 실물금 제안도 '위탁'으로 찍혀 신뢰할 수 없다(라우터 헤더 주석·execute-asset-allocation-proposal과 같은 판단).
      // 계좌는 라우터 판정만 쓰고, 주문번호·종목·방향·수량 4중 일치로 오판을 막는다.
      if (supported && accounts.get(instrument.nhAccountLabel) && query[instrument.type]) {
        const cacheKey = `${instrument.nhAccountLabel}|${instrument.type}|${orderDate}`;
        if (!rowCache.has(cacheKey)) {
          const body = await query[instrument.type]({ actNo: accounts.get(instrument.nhAccountLabel), orrDt: orderDate, ostCnsDit: '0' });
          rowCache.set(cacheKey, Array.isArray(body?.Output_0) ? body.Output_0 : []);
        }
        const rows = rowCache.get(cacheKey);
        const matches = rows.filter((row) => String(row?.itg_orr_no ?? '').trim() === String(proposal.brokerOrderId));
        if (matches.length === 1) decision = classifyExpiryRow(matches[0], proposal, instrument.iemCd);
        if (decision.result !== '확인 필요' && decision.result !== '체결' && hasSiblingOrder(rows, proposal, instrument.iemCd)) {
          decision = { result: '확인 필요' };
          reason = '같은 날 같은 종목 다른 주문 있음(정정 가능성)';
        }
      }
    } catch (error) { log(`[확인 필요] ${proposal.id}: ${error.message}`); }
    if (decision.result === '확인 필요') {
      summary.unknown++;
      log(`[확인 필요] ${proposal.id} · 주문번호 …${String(proposal.brokerOrderId).slice(-4)}: ${reason || '조회 행·수량·자산군 확인 필요'}`);
      // 오늘 주문은 다음 실행에서 풀릴 수 있어 알리지 않고, 하루 이상 지난 건만 알린다(평일 1회 실행 = 하루 1회 알림).
      if (orderDate < today) summary.items.push({ proposal, result: '확인 필요', reason });
      continue;
    }
    if (!dryRun) {
      try {
        await beforeWrite(proposal);
        const updated = decision.result === '만료'
          ? await expireProposalRecord({ proposalsDir, proposal, now })
          : await recordProposalExecutionStatus({ proposalsDir, proposalId: proposal.id,
            brokerOrderId: proposal.brokerOrderId, status: decision.result === '체결' ? '체결' : '취소',
            filledQty: decision.execution.quantity, avgFillPrice: decision.execution.price, now });
        if (!updated) { summary.raced++; log(`[이미 정리됨·건너뜀] ${proposal.id}`); continue; }
      } catch (error) {
        // 쓰기 실패 하나가 나머지 제안 처리와 알림을 막지 않게 한다(리뷰 MEDIUM).
        summary.unknown++;
        log(`[쓰기 실패] ${proposal.id}: ${error.message}`);
        continue;
      }
    }
    if (decision.result === '만료') summary.expired++;
    else if (decision.result === '체결') summary.filled++;
    else summary.partialClosed++;
    summary.items.push({ proposal, result: decision.result });
  }
  if (!dryRun && !noSend && summary.items.length) {
    try {
      await send({ agent: SENDER_AGENT, kind: '정보', topic: '자산분배', body: formatExpiryMessage(summary.items) });
    } catch (error) {
      // 상태는 이미 바뀌어 다음 실행에서 다시 알릴 수 없다 — 정리한 건을 로그로 남기고 실패를 드러낸다(리뷰 MEDIUM).
      summary.sendFailed = true;
      log(`[알림 실패] ${error.message} — 정리한 건: ${summary.items.map((item) => `${item.proposal.id}=${item.result}`).join(', ')}`);
    }
  }
  return summary;
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const noSend = process.argv.includes('--no-send');
  const holdingsIndex = buildHoldingsIndex();
  const registry = getCodeRegistry();
  const { appkey, appsecret } = loadNhplugCredentials();
  const token = await getNhToken({ appkey, appsecret });
  const accounts = resolveNhAccountsByLabel(await listNhAccounts({ token }), new Set(['위탁', '금현물']));
  const summary = await runExpiry({ dryRun, noSend, accounts,
    classify: (proposal) => classifyAssetAllocationInstrument({ assetKey: proposal.assetKey,
      holdingsIndex, registry, dartApiKey: process.env.DART_API_KEY }),
    query: {
      [INSTRUMENT_TYPE.KR_STOCK]: (args) => getKrDailyOrderExecution({ ...args, token }),
      [INSTRUMENT_TYPE.GOLD]: (args) => getGoldExecution({ ...args, token }),
    },
  });
  console.log('[NH 주문 제안 정리]', JSON.stringify({ ...summary, items: undefined }));
  if (summary.sendFailed) process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => { console.error('❌ NH 주문 제안 정리 실패:', error); process.exitCode = 1; });
}
