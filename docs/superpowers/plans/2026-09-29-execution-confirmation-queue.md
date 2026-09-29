# 체결 기록 확인 대기 큐 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 자동 판정이 불완전한 체결을 Vault 확인 대기 큐와 텔레그램 명령으로 안전하게 Ledger에 반영한다.

**Architecture:** `execution-confirmation-queue.mjs`가 평평한 frontmatter 기반 대기 레코드와 상태 전이를 맡는다. 카카오 파서는 자동 기록 대신 큐를 만들고, Zeus가 호출하는 확인 CLI가 원문 지문·결정값·Ledger 중복을 다시 검증한 뒤에만 Ledger와 Firestore를 갱신한다.

**Tech Stack:** Node.js ESM, Firebase Admin Firestore, Obsidian Markdown Vault, Node test runner.

**Spec:** `docs/superpowers/specs/2026-09-29-execution-confirmation-queue-design.md`

## Global Constraints

- API 정본 체결은 카카오 확인으로 뒤집거나 중복 기록하지 않는다.
- 원본 Firestore 문서는 Ledger 기록이 성공하기 전 삭제하지 않는다.
- `vault-frontmatter.mjs`는 중첩 객체를 저장하지 못하므로 모든 대기 레코드는 평평한 값만 쓴다.
- 텔레그램에는 API 원문 오류나 실계좌번호를 노출하지 않는다.
- 기존 미커밋 1·2번 변경을 보존하고, 사용자 요청 전 커밋·푸시하지 않는다.

## Review Focus

- 같은 Firestore 문서가 반복 스캔돼도 대기 레코드·텔레그램이 하나만 생겨야 한다.
- 복수 후보 계좌가 있어도 답장에 없는 계좌를 추정하거나 기록하면 안 된다.
- 원문이 생성 후 바뀌었거나 사라졌으면 확인 답장이 Ledger 기록으로 이어지면 안 된다.
- 이미 같은 Ledger가 생긴 상태에서 늦은 확인 답장이 중복 원장을 만들면 안 된다.
- 처리 완료·기각·만료 상태의 ID에 대한 중복 답장이 어떤 파일도 바꾸면 안 된다.

---

### Task 1: 확인 대기 큐 도메인 모듈

**Files:**
- Create: `scripts/lib/execution-confirmation-queue.mjs`
- Create: `scripts/lib/execution-confirmation-queue.test.js`
- Modify: `scripts/lib/vault-paths.mjs`

**Interfaces:**
- Produces: `buildExecutionConfirmation`, `findPendingConfirmation`, `resolveExecutionConfirmation`, `parseExecutionConfirmation`, `buildExecutionFingerprint`.
- Consumes: `buildFrontmatter`, `parseFrontmatter`, `VAULT_PATHS.state.executionConfirmations`.

- [ ] **Step 1: Write failing queue tests**

```js
const confirmation = buildExecutionConfirmation({
  firestoreDocId: 'doc-1', event: { broker: 'NH투자증권', stockName: 'TIGER 리츠', quantity: 10, price: 4037 },
  allowedAccounts: ['ISA', '위탁'], now: new Date('2026-09-29T00:00:00Z'), random: () => 'ABC123',
});
assert.equal(confirmation.record.status, '대기');
assert.deepEqual(confirmation.record.allowedAccounts, ['ISA', '위탁']);
assert.equal(resolveExecutionConfirmation(confirmation.record, 'ISA').status, '확인됨');
assert.throws(() => resolveExecutionConfirmation(confirmation.record, '연금저축'), /허용 계좌/);
```

Add tests for same event fingerprint lookup, non-pending status rejection, and flat frontmatter round trip.

- [ ] **Step 2: Run the queue test and verify it fails**

Run: `node --test scripts/lib/execution-confirmation-queue.test.js`
Expected: failure because the module and exports do not exist.

- [ ] **Step 3: Add the Vault path and minimal queue module**

```js
executionConfirmations: join(VAULT_ROOT, 'State', 'ExecutionConfirmations'),
```

Use `JSON.stringify` only for `allowedAccounts`; parse it with a guarded array parser. Build the fingerprint from the immutable parsed event fields and source document ID. Keep the record body human-readable and all mutable state in frontmatter.

- [ ] **Step 4: Run the queue test and verify it passes**

Run: `node --test scripts/lib/execution-confirmation-queue.test.js`
Expected: all queue transitions and flat-frontmatter round trips pass.

### Task 2: 카카오 체결 보류를 큐·텔레그램으로 배선

**Files:**
- Modify: `scripts/jobs/parse-notifications-to-vault.mjs`
- Modify: `scripts/jobs/parse-notifications-to-vault.test.js`
- Modify: `scripts/lib/job-labels.mjs` only if the existing job label cannot describe the confirmation warning accurately.

**Interfaces:**
- Consumes: `buildExecutionConfirmation`, `findPendingConfirmation`, `formatDepartmentMessage`, `sendTelegram`, `collectWarning`.
- Produces: one pending confirmation file and one standard-format Telegram request for each unresolved parsed execution.

- [ ] **Step 1: Write failing parser integration tests**

```js
const result = prepareExecutionConfirmation({ id: 'doc-1', ts, body, event, holdings });
assert.equal(result.kind, 'account-assignment');
assert.match(result.telegramBody, /■ 체결/);
assert.match(result.telegramBody, /체결확인 EC-/);
assert.equal(result.shouldDeleteFirestore, false);
```

Add a second call with the same source event and assert `shouldSendTelegram === false` and that it returns the original confirmation ID.

- [ ] **Step 2: Run the parser test and verify it fails**

Run: `node --test scripts/jobs/parse-notifications-to-vault.test.js`
Expected: failure because the preparation function does not exist.

- [ ] **Step 3: Implement only account-assignment queue creation**

Extract a pure `prepareExecutionConfirmation` helper from the unresolved stock path. It must list candidate accounts derived from Holdings, create the State file atomically before sending Telegram, leave the Firestore document out of `processedIds`, and use `formatDepartmentMessage` with `■ 체결`, `■ 확인 필요 사유`, `■ 답장 형식`.

Do not add duplicate-review or field-correction production routing in this task; the common queue schema supports them but their existing conflict detectors must be separately identified before activation.

- [ ] **Step 4: Run focused tests and format guard**

Run: `node --test scripts/jobs/parse-notifications-to-vault.test.js scripts/lib/telegram-format-compliance.test.js`
Expected: parser routing and Telegram structural guard pass.

### Task 3: 확인 답장 처리 CLI

**Files:**
- Create: `scripts/tools/resolve-execution-confirmation.mjs`
- Create: `scripts/tools/resolve-execution-confirmation.test.js`
- Modify: `.claude/agents/zeus.md`

**Interfaces:**
- Consumes: a confirmation ID, account decision, queue record, Firestore source document, `buildExecutionRecord`, `writeAtomic`, `deleteKakaoInboxDocs`.
- Produces: an `확인됨` queue record only after Ledger write and source deletion; otherwise retains source and marks `처리실패` or rejects the command.

- [ ] **Step 1: Write failing decision tests**

```js
const decision = validateConfirmationDecision({
  confirmation: { status: '대기', kind: 'account-assignment', allowedAccounts: ['ISA'] },
  answer: 'ISA',
});
assert.deepEqual(decision, { ok: true, account: 'ISA' });
assert.equal(validateConfirmationDecision({ confirmation, answer: '위탁' }).ok, false);
```

Add cases for malformed command, already-confirmed records, source fingerprint mismatch, and Ledger duplicate.

- [ ] **Step 2: Run CLI tests and verify they fail**

Run: `node --test scripts/tools/resolve-execution-confirmation.test.js`
Expected: failure because the CLI validation functions do not exist.

- [ ] **Step 3: Implement the CLI with write ordering fixed**

Implement `node scripts/tools/resolve-execution-confirmation.mjs --id=EC-... --account=ISA`.

1. Load exactly one confirmation file by ID and validate it is `대기`.
2. Validate the selected account is allowed.
3. Read the Firestore document by ID and recompute its fingerprint.
4. Build the Ledger record with selected account and `sourceEventId`.
5. Refuse if its target file already exists.
6. Write Ledger atomically, then delete Firestore, then atomically change the confirmation to `확인됨` with `ledgerFile`.
7. If steps 3–6 fail, retain the source; mark only deterministic validation failures as `처리실패`.

The CLI emits safe stdout for Zeus; it does not send Telegram itself.

- [ ] **Step 4: Document the exact Zeus invocation**

Add a Hermes operation item to `.claude/agents/zeus.md` requiring the explicit owner command:

```text
체결확인 EC-20260929-ABC123 ISA
```

Zeus must invoke the CLI synchronously and report its safe stdout. It must not infer an ID or account from free text.

- [ ] **Step 5: Run focused tests and syntax checks**

Run: `node --check scripts/tools/resolve-execution-confirmation.mjs && node --test scripts/tools/resolve-execution-confirmation.test.js scripts/lib/execution-confirmation-queue.test.js`
Expected: all confirmation validation and write-order tests pass.

### Task 4: Integration verification and operational records

**Files:**
- Modify: `scripts/jobs/parse-notifications-to-vault.test.js`
- Create: `~/banana-vault/Log/Implementation/2026-09-29-체결기록-확인대기큐-구현.md`
- Modify: relevant open DevRequest or create none if this remains a chat-originated implementation.

**Interfaces:**
- Consumes: all prior queue, parser, and CLI interfaces.
- Produces: test evidence and an Implementation record; no commit or push.

- [ ] **Step 1: Add end-to-end stubbed integration test**

Use temporary Vault directories and stub Firestore documents to prove this sequence:

```text
unresolved source → one pending queue file → valid ISA confirmation → one Ledger file → source delete → confirmation status 확인됨
```

Assert that re-running the same confirmation produces no second Ledger file.

- [ ] **Step 2: Run all required verification**

Run: `npm run lint && npm test && git diff --check`
Expected: lint and diff checks pass; if full test has a pre-existing Vault integrity failure, record its exact file and status separately from this change.

- [ ] **Step 3: Independent review**

Request a separate reviewer to inspect write ordering, fingerprint construction, source deletion timing, duplicate behavior, and Telegram exposure. Fix every CRITICAL/HIGH finding before completion.

- [ ] **Step 4: Write the Vault Implementation record**

Record the queue schema, command form, write ordering, explicit non-goals, test evidence, and any unrelated full-suite failure. Do not mark a DevRequest because this feature originated in this chat.

## Plan Self-Review

- Spec coverage: Tasks 1–3 implement State queue, Telegram request, explicit answer command, validation, source preservation, and Ledger re-entry. Task 2 intentionally activates only account assignment; Task 4 preserves the documented future extension for duplicate-review and field-correction until dedicated conflict detectors exist.
- Placeholder scan: no TODO/TBD or unspecified validation steps remain.
- Type consistency: Task 1 exports the exact queue functions consumed by Tasks 2–3. Task 3 owns account-decision validation and all irreversible I/O.
- Review focus coverage: Task 1 covers queue duplication and terminal states; Task 2 covers duplicate notification; Task 3 covers invalid account, changed source, and duplicate Ledger; Task 4 covers the whole write sequence.
