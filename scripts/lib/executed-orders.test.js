// executed-orders.mjs 테스트 — Phase 11(2026-08-09) 실전 전환 전 필수로 명시돼 있던
// "영속 idempotency 저장소 없음" 갭을 메우는 모듈. 핵심 회귀 대상: 크래시 후 재실행돼도
// 같은 제안이 다시 체결되지 않아야 한다(order-gate.checkIdempotency가 이 목록을 본다).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseExecutedOrderIds, loadExecutedOrderIds, recordExecutedOrder, unrecordExecutedOrder } from './executed-orders.mjs';

function makeTmpFile() {
  const dir = mkdtempSync(join(tmpdir(), 'executed-orders-test-'));
  return join(dir, 'ExecutedOrders.md');
}

test('parseExecutedOrderIds: content 없으면(파일 미존재) 빈 배열', () => {
  assert.deepEqual(parseExecutedOrderIds(null), []);
  assert.deepEqual(parseExecutedOrderIds(''), []);
});

test('parseExecutedOrderIds: ids 필드 콤마join 문자열을 배열로 복원(공백 트림)', () => {
  const content = '---\nids: "퀀트-매수-005930-20260809T010000Z, 퀀트-매도-000660-20260809T020000Z"\n---\n';
  assert.deepEqual(parseExecutedOrderIds(content), [
    '퀀트-매수-005930-20260809T010000Z', '퀀트-매도-000660-20260809T020000Z',
  ]);
});

test('parseExecutedOrderIds: ids 필드가 없거나 손상돼도 크래시 없이 빈 배열', () => {
  assert.deepEqual(parseExecutedOrderIds('---\nmode: "실전"\n---\n'), []);
  assert.deepEqual(parseExecutedOrderIds('완전히 손상된 내용'), []);
});

// [핵심 안전장치] 코드리뷰 지적(2026-08-09, LOW) — 파일 없음(최초 실행)과 파일이 있는데
// 못 읽음(권한·손상)을 구분 못 하면, 손상된 목록이 조용히 "빈 목록"으로 읽혀 멱등체크
// 전체가 무음으로 꺼진다. ENOENT가 아닌 오류(디렉토리를 파일처럼 읽으려는 EISDIR로 재현)는
// 반드시 throw돼야 한다.
test('[핵심 안전장치] loadExecutedOrderIds: 파일이 있는데 못 읽으면(손상·권한 등) 빈 배열로 조용히 넘어가지 않고 throw', () => {
  const dir = mkdtempSync(join(tmpdir(), 'executed-orders-test-'));
  const fakeFile = join(dir, 'ExecutedOrders.md');
  mkdirSync(fakeFile); // 파일 경로에 디렉토리를 만들어 EISDIR 재현(ENOENT 아님)
  assert.throws(() => loadExecutedOrderIds(fakeFile));
  rmSync(dir, { recursive: true, force: true });
});

test('loadExecutedOrderIds: 파일이 아직 없으면 빈 배열(첫 실행 정상 상태)', () => {
  const file = makeTmpFile(); // mkdtempSync만 하고 파일 자체는 안 씀
  assert.deepEqual(loadExecutedOrderIds(file), []);
  rmSync(join(file, '..'), { recursive: true, force: true });
});

test('[핵심] recordExecutedOrder → loadExecutedOrderIds 왕복: 기록한 ID가 다음 조회에 보인다', async () => {
  const file = makeTmpFile();
  const added = await recordExecutedOrder(file, '퀀트-매수-005930-20260809T010000Z');
  assert.equal(added, true);
  assert.deepEqual(loadExecutedOrderIds(file), ['퀀트-매수-005930-20260809T010000Z']);
  rmSync(join(file, '..'), { recursive: true, force: true });
});

test('recordExecutedOrder: 같은 ID를 두 번 기록해도 목록엔 한 번만(멱등) — 두 번째 호출은 false 반환', async () => {
  const file = makeTmpFile();
  await recordExecutedOrder(file, 'A');
  const second = await recordExecutedOrder(file, 'A');
  assert.equal(second, false);
  assert.deepEqual(loadExecutedOrderIds(file), ['A']);
  rmSync(join(file, '..'), { recursive: true, force: true });
});

test('recordExecutedOrder: 여러 ID를 순차 기록하면 전부 누적(기존 목록 안 날아감)', async () => {
  const file = makeTmpFile();
  await recordExecutedOrder(file, 'A');
  await recordExecutedOrder(file, 'B');
  await recordExecutedOrder(file, 'C');
  assert.deepEqual(loadExecutedOrderIds(file), ['A', 'B', 'C']);
  rmSync(join(file, '..'), { recursive: true, force: true });
});

test('recordExecutedOrder: 제안 ID에 콤마가 섞이면 목록 포맷 충돌을 막기 위해 즉시 throw', async () => {
  const file = makeTmpFile();
  await assert.rejects(() => recordExecutedOrder(file, 'A,B'), /콤마/);
  rmSync(join(file, '..'), { recursive: true, force: true });
});

// [핵심] 동시성 — 여러 잡이 거의 동시에 서로 다른 제안을 체결 기록해도 유실 없음
// (state-writer.test.js의 withLock 동시성 검증과 동일 패턴, 이 모듈에 특화해 재현).
test('[핵심] recordExecutedOrder: 동시 호출(N개 서로 다른 ID)이 전부 유실 없이 누적된다', async () => {
  const file = makeTmpFile();
  const N = 20;
  await Promise.all(
    Array.from({ length: N }, (_, i) => recordExecutedOrder(file, `제안-${i}`)),
  );
  const ids = loadExecutedOrderIds(file);
  assert.equal(ids.length, N);
  assert.deepEqual(new Set(ids), new Set(Array.from({ length: N }, (_, i) => `제안-${i}`)));
  rmSync(join(file, '..'), { recursive: true, force: true });
});

// unrecordExecutedOrder — 보안리뷰 지적(2026-08-09, Medium#1) 반영: "선점 먼저, 주문 나중"
// 패턴에서 주문 자체가 실패하면 선점을 풀어야 다음 실행에서 재시도 가능해진다.
test('[핵심] unrecordExecutedOrder: 선점(claim) 후 주문 실패 롤백 시나리오 — 풀면 재선점 가능', async () => {
  const file = makeTmpFile();
  const claimed = await recordExecutedOrder(file, 'A');
  assert.equal(claimed, true);
  const removed = await unrecordExecutedOrder(file, 'A');
  assert.equal(removed, true);
  assert.deepEqual(loadExecutedOrderIds(file), []);
  // 롤백 후 같은 ID를 다시 선점할 수 있어야(재시도 가능) — true로 다시 성공
  const reclaimed = await recordExecutedOrder(file, 'A');
  assert.equal(reclaimed, true);
  rmSync(join(file, '..'), { recursive: true, force: true });
});

test('unrecordExecutedOrder: 목록에 없는 ID를 풀려 하면 false(조용히 무시, 크래시 없음)', async () => {
  const file = makeTmpFile();
  const removed = await unrecordExecutedOrder(file, '없는ID');
  assert.equal(removed, false);
  rmSync(join(file, '..'), { recursive: true, force: true });
});

test('unrecordExecutedOrder: 다른 ID들은 그대로 두고 지정한 ID만 제거', async () => {
  const file = makeTmpFile();
  await recordExecutedOrder(file, 'A');
  await recordExecutedOrder(file, 'B');
  await recordExecutedOrder(file, 'C');
  await unrecordExecutedOrder(file, 'B');
  assert.deepEqual(loadExecutedOrderIds(file), ['A', 'C']);
  rmSync(join(file, '..'), { recursive: true, force: true });
});

test('[핵심 안전장치] 크래시 후 재실행 시나리오: 이미 체결된 제안 ID가 checkIdempotency에 그대로 잡힌다', async () => {
  const file = makeTmpFile();
  await recordExecutedOrder(file, '퀀트-매수-005930-20260809T010000Z');
  // execute-quant-proposal.mjs가 재실행되면 이 목록을 buildGateInput의 alreadyExecutedIds로
  // 넘긴다 — 파일이 존재하는 한 재시작해도 이 ID는 계속 "이미 체결됨"으로 남아야 한다.
  const reloaded = loadExecutedOrderIds(file);
  assert.ok(reloaded.includes('퀀트-매수-005930-20260809T010000Z'));
  rmSync(join(file, '..'), { recursive: true, force: true });
});
