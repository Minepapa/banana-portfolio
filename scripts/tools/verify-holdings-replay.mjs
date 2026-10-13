#!/usr/bin/env node
// 원장과 현재 보유의 수량·적용 키를 읽기 전용으로 대조한다. 기초 잔고는 사용자가 제공한다.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseFrontmatter } from '../lib/vault-frontmatter.mjs';
import { parseAppliedDedupKeys } from '../lib/holdings-vault-writer.mjs';
import { VAULT_PATHS } from '../lib/vault-paths.mjs';

function readRecords(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => name.endsWith('.md')).map((name) => ({
    ...parseFrontmatter(readFileSync(join(dir, name), 'utf8')), filename: name,
  }));
}

export function compareHoldingsReplay(executions, holdings, opening = {}) {
  const replay = new Map();
  const unassigned = [];
  const current = new Map(holdings.filter((holding) => holding.account && holding.name && !holding.isCashLike)
    .map((holding) => [`${holding.account}|${holding.name}`, holding]));
  const appliedRetryWitness = (record) => record.holdingsApplied === 'duplicate-skipped'
    && record.dedupKey && parseAppliedDedupKeys(current.get(`${record.account}|${record.stockName}`) ?? {})
      .includes(record.dedupKey);
  const candidates = executions.filter((record) => !record.legacy && (!record.duplicateOf || appliedRetryWitness(record))
    // 파일 플래그 쓰기 전 중단된 재시도는 보유 파일의 적용 키가 실제 반영을 증명한다.
    && (record.holdingsApplied !== 'duplicate-skipped' || appliedRetryWitness(record)));
  // 아직 적용하지 못한 체결은 State 수량에 없으므로 차이 계산에 섞지 않고 별도 보고한다.
  const pending = candidates.filter((record) => record.holdingsApplied !== true && !appliedRetryWitness(record));
  const eligible = candidates.filter((record) => record.holdingsApplied === true || appliedRetryWitness(record))
    .sort((a, b) => String(a.tradeDate).localeCompare(String(b.tradeDate))
      || String(a.recordedAt ?? '').localeCompare(String(b.recordedAt ?? '')));

  for (const execution of eligible) {
    if (!execution.account || !execution.stockName || !Number.isFinite(Number(execution.quantity))) {
      unassigned.push(execution.filename);
      continue;
    }
    const key = `${execution.account}|${execution.stockName}`;
    const state = replay.get(key) ?? { quantity: Number(opening[key] ?? 0), keys: new Set(), count: 0 };
    state.quantity += (execution.tradeType === '매도' ? -1 : 1) * Number(execution.quantity);
    if (execution.dedupKey) state.keys.add(execution.dedupKey);
    state.count += 1;
    replay.set(key, state);
  }

  const rows = [...new Set([...replay.keys(), ...current.keys(), ...Object.keys(opening)])].sort().map((key) => {
    const ledger = replay.get(key) ?? { quantity: Number(opening[key] ?? 0), keys: new Set(), count: 0 };
    const holding = current.get(key);
    const actualKeys = new Set(parseAppliedDedupKeys(holding ?? {}));
    // IRP·퀀트는 API 잔고가 정본이다. 해당 동기화가 appliedDedupKeys를 재설정하므로
    // 이 원장과 키를 일대일 대조하면 정상 상태도 누락으로 오인한다.
    const externallyManaged = key.startsWith('IRP|') || key.startsWith('퀀트|');
    return {
      key,
      opening: Number(opening[key] ?? 0),
      ledgerCount: ledger.count,
      replayQuantity: ledger.quantity,
      holdingQuantity: holding ? Number(holding.qty) : 0,
      difference: (holding ? Number(holding.qty) : 0) - ledger.quantity,
      // 전량 매도한 종목의 Holding 파일은 삭제되고 키 이력도 함께 사라진다.
      // 현재 보유 파일이 없는 경우 과거 체결 키를 누락으로 보고하지 않는다.
      missingKeys: holding && !externallyManaged ? [...ledger.keys].filter((item) => !actualKeys.has(item)) : [],
      extraKeys: externallyManaged ? [] : [...actualKeys].filter((item) => !ledger.keys.has(item)),
      externallyManaged,
    };
  });
  return { rows, unassigned, pending, eligibleCount: eligible.length };
}

export function verifyHoldingsReplay({ opening = {}, log = console.log } = {}) {
  const result = compareHoldingsReplay(
    readRecords(VAULT_PATHS.facts.ledger.executions),
    readRecords(VAULT_PATHS.state.holdings),
    opening,
  );
  log('계좌|종목 | 기초 | 원장건수 | 재생수량 | 보유수량 | 차이 | 키 누락/초과 | 해석');
  for (const row of result.rows.filter((item) => item.difference || item.missingKeys.length || item.extraKeys.length)) {
    const interpretation = row.externallyManaged ? '외부정본'
      : row.difference > 0 && !Object.hasOwn(opening, row.key) ? '기초잔고 가능'
        : row.difference < 0 && !Object.hasOwn(opening, row.key) ? '기초잔고만으론 설명 불가'
          : '-';
    log(`${row.key} | ${row.opening} | ${row.ledgerCount} | ${row.replayQuantity} | ${row.holdingQuantity} | ${row.difference} | ${row.missingKeys.length}/${row.extraKeys.length} | ${interpretation}`);
  }
  log(`대조 ${result.rows.length}종목, 수량 차이 ${result.rows.filter((item) => item.difference).length}종목, 키 차이 ${result.rows.filter((item) => item.missingKeys.length || item.extraKeys.length).length}종목, 미적용 ${result.pending.length}건, 계좌 미확정 ${result.unassigned.length}건`);
  if (!Object.keys(opening).length) log('기초 잔고 미입력: 수량 차이에는 원장 밖 기초 잔고가 포함될 수 있음');
  log('duplicateOf 표시를 아직 적용하지 않은 쌍은 재생에 포함됨; 표시 도구 dry-run 결과와 함께 해석할 것');
  log('IRP·퀀트 수량은 외부 API 잔고와 별도로 동기화되므로 원장 재생 차이는 직접 대사 대상 아님');
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args.length > 1 || args.some((arg) => !arg.startsWith('--opening='))) {
    throw new Error('사용법: node scripts/tools/verify-holdings-replay.mjs [--opening=<json 파일>]');
  }
  const opening = args[0] ? JSON.parse(readFileSync(args[0].slice('--opening='.length), 'utf8')) : {};
  verifyHoldingsReplay({ opening });
}
