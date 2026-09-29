#!/usr/bin/env node
// 카카오 체결 알림의 계좌·필드 정합을 자동으로 확정할 수 없을 때, 오너가 명시적으로
// 답한 계좌만 Ledger에 반영하는 수동 확인 CLI. Zeus가 `체결확인 EC-... ISA`를 받은
// 같은 대화 턴에서 동기 호출하며, 이 파일은 텔레그램을 직접 보내지 않고 안전한 stdout만
// 반환한다. 원문 Firestore 문서는 Ledger 기록이 성공한 뒤에만 삭제한다.

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getFirestoreAdmin } from '../lib/firestore-admin.mjs';
import { deleteKakaoInboxDocs } from '../lib/kakao-inbox.mjs';
import { parseExecution } from '../lib/notification-parsers.mjs';
import { buildKakaoExecutionRecordCandidates } from '../lib/ledger-vault-writer.mjs';
import { withLock, writeAtomic, writeStateFile } from '../lib/state-writer.mjs';
import { VAULT_PATHS } from '../lib/vault-paths.mjs';
import { classifyConfirmedKakaoExecution } from '../lib/execution-source-policy.mjs';
import { buildApiCoveredExecutionArchive } from '../jobs/parse-notifications-to-vault.mjs';
import {
  buildExecutionFingerprint, buildSourceBodyHash, executionConfirmationLockKey, markExecutionConfirmationArtifactWritten,
  markExecutionConfirmationLedgerWritten,
  parseExecutionConfirmation, rejectExecutionConfirmation, resolveExecutionConfirmation,
  serializeExecutionConfirmation,
} from '../lib/execution-confirmation-queue.mjs';

function parseArgs(argv) {
  const args = {};
  for (const arg of argv) {
    const match = arg.match(/^--([a-z-]+)=(.*)$/s);
    if (match) args[match[1]] = match[2];
  }
  return args;
}

function confirmationPath(id, dir = VAULT_PATHS.state.executionConfirmations) {
  if (!/^EC-\d{8}-[A-F0-9]+$/.test(id)) throw new Error('체결 확인 ID 형식이 올바르지 않습니다');
  return join(dir, `${id}.md`);
}

function sourceLockPath(firestoreDocId) {
  return join(VAULT_PATHS.state.executionConfirmations, executionConfirmationLockKey(firestoreDocId));
}

function safeFailure(message) {
  const error = new Error(message);
  error.safeForOwner = true;
  return error;
}

export function validateConfirmationDecision({ confirmation, answer }) {
  const account = String(answer ?? '').trim();
  if (!account) return { ok: false, reason: '확인할 계좌를 함께 지정해야 합니다' };
  try {
    resolveExecutionConfirmation(confirmation, account);
    return { ok: true, account };
  } catch (error) {
    return { ok: false, reason: error.message };
  }
}

export function validateConfirmationSource({ confirmation, firestoreDocId, event, sourceBody }) {
  if (String(firestoreDocId ?? '') !== String(confirmation?.firestoreDocId ?? '')) {
    return { ok: false, reason: '원본 체결 문서가 확인 대기 건과 다릅니다' };
  }
  const fingerprint = buildExecutionFingerprint({ firestoreDocId, event });
  if (fingerprint !== confirmation?.eventFingerprint) {
    return { ok: false, reason: '원본 체결 내용이 대기 건 생성 후 달라졌습니다' };
  }
  if (buildSourceBodyHash(sourceBody) !== confirmation?.sourceBodyHash) {
    return { ok: false, reason: '원본 체결 문구가 대기 건 생성 후 달라졌습니다' };
  }
  return { ok: true };
}

// write 순서는 불변식이다: Ledger → "기록됨" 대기건 저장 → 원문 Firestore 삭제 → 완료.
// 중간 상태가 내구적으로 남아 마지막 단계가 실패해도 다음 실행이 삭제·완료를 재개한다.
export async function applyExecutionConfirmation({
  confirmation, account, firestoreDocId, event, existsLedger = existsSync,
  sourceBody, writeLedger, deleteSource, writeConfirmation, now = new Date(),
}) {
  const decision = validateConfirmationDecision({ confirmation, answer: account });
  if (!decision.ok) throw safeFailure(decision.reason);
  const source = validateConfirmationSource({ confirmation, firestoreDocId, event, sourceBody });
  if (!source.ok) throw safeFailure(source.reason);

  const records = buildKakaoExecutionRecordCandidates(event, decision.account, confirmation.firestoreDocId);
  const canonicalPath = join(records.canonical.dir, records.canonical.filename);
  const legacyPath = join(records.legacy.dir, records.legacy.filename);
  const canonicalExists = existsLedger(canonicalPath);
  const legacyExists = existsLedger(legacyPath);
  if (canonicalExists && legacyExists) {
    throw safeFailure('같은 카카오 체결의 기존·신규 Ledger가 함께 있어 자동 처리하지 않습니다');
  }
  const ledger = legacyExists ? records.legacy : records.canonical;
  const ledgerPath = join(ledger.dir, ledger.filename);
  let checkpoint = confirmation;
  if (confirmation.status === '대기') {
    if (!canonicalExists && !legacyExists) await writeLedger({ ...ledger, filepath: ledgerPath });
    checkpoint = markExecutionConfirmationLedgerWritten(confirmation, decision.account, ledger.filename, now);
    await writeConfirmation(checkpoint);
  } else if (confirmation.ledgerFile !== ledger.filename) {
    throw safeFailure('Ledger 기록 중인 대기 건의 대상 파일이 현재 원문과 다릅니다');
  }
  await deleteSource();
  const resolved = {
    ...resolveExecutionConfirmation(checkpoint, decision.account, now),
    ledgerFile: ledger.filename,
  };
  await writeConfirmation(resolved);
  return { confirmation: resolved, ledger };
}

async function loadKakaoSource(db, id) {
  const snapshot = await db.collection('kakaoInbox').doc(id).get();
  if (!snapshot.exists) return null;
  const data = snapshot.data() ?? {};
  return { id, ts: String(data.ts ?? ''), body: String(data.body ?? '') };
}

async function markProcessingFailed(filepath) {
  return withLock(filepath, () => {
    const current = parseExecutionConfirmation(readFileSync(filepath, 'utf8'));
    if (current.status !== '대기') return false;
    const updated = {
      ...current,
      status: '처리실패',
      updatedAt: new Date().toISOString(),
    };
    writeAtomic(filepath, serializeExecutionConfirmation(updated));
    return true;
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const id = String(args.id ?? '').trim();
  const account = String(args.account ?? '').trim();
  let filepath;
  try {
    filepath = confirmationPath(id);
  } catch (error) {
    console.error(`처리하지 않음: ${error.message}`);
    process.exitCode = 2;
    return;
  }
  if (!existsSync(filepath)) {
    console.error('처리하지 않음: 해당 체결 확인 대기 건을 찾지 못했습니다');
    process.exitCode = 2;
    return;
  }

  const confirmation = parseExecutionConfirmation(readFileSync(filepath, 'utf8'));
  if (account === '무시') {
    try {
      const rejected = await withLock(sourceLockPath(confirmation.firestoreDocId), async () => {
        const current = parseExecutionConfirmation(readFileSync(filepath, 'utf8'));
        const updated = rejectExecutionConfirmation(current, new Date());
        await writeStateFile(filepath, serializeExecutionConfirmation(updated));
        return updated;
      });
      console.log(`처리 완료: ${rejected.id}를 무시로 표시했고 원문 체결 문서는 보존했습니다`);
    } catch {
      console.error('처리하지 않음: 대기 건 상태를 갱신하지 못했습니다');
      process.exitCode = 2;
    }
    return;
  }
  const decision = validateConfirmationDecision({ confirmation, answer: account });
  if (!decision.ok) {
    console.error(`처리하지 않음: ${decision.reason}`);
    process.exitCode = 2;
    return;
  }

  let source;
  try {
    source = await loadKakaoSource(getFirestoreAdmin(), confirmation.firestoreDocId);
  } catch {
    console.error('처리 실패: 원본 체결 문서를 조회하지 못했습니다. 대기 건과 원문은 보존했습니다');
    process.exitCode = 1;
    return;
  }
  if (!source) {
    const outcome = await withLock(sourceLockPath(confirmation.firestoreDocId), async () => {
      const current = parseExecutionConfirmation(readFileSync(filepath, 'utf8'));
      if (current.status === '기록됨' && current.decision) {
        const completed = resolveExecutionConfirmation(current, current.decision, new Date());
        await writeStateFile(filepath, serializeExecutionConfirmation(completed));
        return { kind: 'recovered', confirmation: completed };
      }
      if (current.status === '확인됨' || current.status === '기각') return { kind: 'terminal', confirmation: current };
      await markProcessingFailed(filepath);
      return { kind: 'failed', confirmation: current };
    });
    if (outcome.kind === 'recovered') {
      console.log(`처리 완료: ${outcome.confirmation.id} ${outcome.confirmation.decision} 귀속 결과를 복구했습니다`);
    } else if (outcome.kind === 'terminal') {
      console.log(`처리하지 않음: ${outcome.confirmation.id}는 이미 종결된 확인 건입니다`);
    } else {
      console.error('처리 실패: 원본 체결 문서가 없어 대기 건을 처리실패로 표시했습니다');
      process.exitCode = 1;
    }
    return;
  }

  const event = parseExecution(source.body, source.ts);
  if (!event) {
    await markProcessingFailed(filepath);
    console.error('처리 실패: 원본 문서를 체결로 다시 해석하지 못해 대기 건을 처리실패로 표시했습니다');
    process.exitCode = 1;
    return;
  }
  const sourceCheck = validateConfirmationSource({ confirmation, firestoreDocId: source.id, event, sourceBody: source.body });
  if (!sourceCheck.ok) {
    await markProcessingFailed(filepath);
    console.error(`처리 실패: ${sourceCheck.reason}. 원문은 보존했습니다`);
    process.exitCode = 1;
    return;
  }

  const sourcePolicy = classifyConfirmedKakaoExecution({ event, account: decision.account });
  if (sourcePolicy.action === 'exclude-api') {
    try {
      const completed = await withLock(sourceLockPath(confirmation.firestoreDocId), async () => {
        const current = parseExecutionConfirmation(readFileSync(filepath, 'utf8'));
        const currentDecision = validateConfirmationDecision({ confirmation: current, answer: account });
        if (!currentDecision.ok) throw safeFailure(currentDecision.reason);
        const archive = buildApiCoveredExecutionArchive({
          id: source.id, ts: source.ts, body: source.body, event, account: sourcePolicy.account,
        });
        mkdirSync(dirname(archive.filepath), { recursive: true });
        writeAtomic(archive.filepath, archive.content);
        const checkpoint = markExecutionConfirmationArtifactWritten(
          current, currentDecision.account, { archiveFile: archive.filepath.split('/').pop() }, new Date(),
        );
        await writeStateFile(filepath, serializeExecutionConfirmation(checkpoint));
        await deleteKakaoInboxDocs(getFirestoreAdmin(), [source.id]);
        const resolved = resolveExecutionConfirmation(checkpoint, currentDecision.account, new Date());
        await writeStateFile(filepath, serializeExecutionConfirmation(resolved));
        return resolved;
      });
      console.log(`처리 완료: ${completed.id} ${decision.account}은 API 정본이라 카카오 원문만 보관했습니다`);
    } catch {
      console.error('처리 실패: API 정본 원문 보관 처리 중 오류가 발생했습니다. 대기 건과 원문은 보존했습니다');
      process.exitCode = 1;
    }
    return;
  }

  try {
    const result = await withLock(sourceLockPath(confirmation.firestoreDocId), async () => {
      const current = parseExecutionConfirmation(readFileSync(filepath, 'utf8'));
      return applyExecutionConfirmation({
        confirmation: current,
        account: decision.account,
        firestoreDocId: source.id,
        event,
        sourceBody: source.body,
        writeLedger: async (ledger) => {
          mkdirSync(ledger.dir, { recursive: true });
          writeAtomic(ledger.filepath, ledger.content);
        },
        deleteSource: async () => deleteKakaoInboxDocs(getFirestoreAdmin(), [source.id]),
        writeConfirmation: async (updated) => writeStateFile(filepath, serializeExecutionConfirmation(updated)),
      });
    });
    console.log(`처리 완료: ${result.confirmation.id} ${decision.account} 귀속으로 Ledger 기록 후 원문을 정리했습니다`);
  } catch (error) {
    console.error(error.safeForOwner
      ? `처리 실패: ${error.message}`
      : '처리 실패: 체결 확인 처리 중 오류가 발생했습니다. 대기 건과 원문은 보존했습니다');
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(() => {
    console.error('처리 실패: 체결 확인 처리 중 예기치 않은 오류가 발생했습니다. 대기 건과 원문은 보존했습니다');
    process.exitCode = 1;
  });
}
