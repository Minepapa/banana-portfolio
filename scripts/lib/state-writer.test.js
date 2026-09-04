// state-writer.mjs 테스트 — 락파일 동시성 방지 + 원자적 쓰기.
// 핵심 회귀 대상: 여러 프로세스(잡)가 같은 State 파일을 거의 동시에 쓰면 한쪽 갱신이
// 유실될 수 있다는 문제(docs/ARCHITECTURE-V2.md "동시성·시크릿 보관" 절) — withLock이
// 이걸 실제로 막는지 race 시뮬레이션으로 검증한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync, utimesSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withLock, writeAtomic, writeStateFile, patchFrontmatterFileSafely } from './state-writer.mjs';

function makeTmpDir() {
  return mkdtempSync(join(tmpdir(), 'state-writer-test-'));
}

test('writeAtomic: 파일에 내용이 그대로 쓰이고 임시 파일은 남지 않는다', () => {
  const dir = makeTmpDir();
  const file = join(dir, 'state.json');
  writeAtomic(file, '{"a":1}');
  assert.equal(readFileSync(file, 'utf8'), '{"a":1}');
  const leftovers = readdirSync(dir).filter((f) => f.includes('.tmp-'));
  assert.deepEqual(leftovers, []);
  rmSync(dir, { recursive: true, force: true });
});

test('writeAtomic: 기존 파일을 덮어써도 원자적 교체(내용이 섞이지 않음)', () => {
  const dir = makeTmpDir();
  const file = join(dir, 'state.json');
  writeAtomic(file, 'first');
  writeAtomic(file, 'second');
  assert.equal(readFileSync(file, 'utf8'), 'second');
  rmSync(dir, { recursive: true, force: true });
});

test('withLock: 락을 정상 해제한다(작업 후 .lock 파일이 남지 않음)', async () => {
  const dir = makeTmpDir();
  const file = join(dir, 'state.json');
  writeFileSync(file, '0');
  await withLock(file, async () => {
    writeAtomic(file, '1');
  });
  assert.equal(existsSync(`${file}.lock`), false);
  rmSync(dir, { recursive: true, force: true });
});

test('withLock: fn이 던져도 락은 반드시 해제된다', async () => {
  const dir = makeTmpDir();
  const file = join(dir, 'state.json');
  await assert.rejects(
    withLock(file, async () => {
      throw new Error('작업 실패');
    }),
    /작업 실패/,
  );
  assert.equal(existsSync(`${file}.lock`), false);
  rmSync(dir, { recursive: true, force: true });
});

test('[핵심] withLock: 동시 호출이 직렬화되어 read-modify-write 경합에도 갱신이 유실되지 않는다', async () => {
  // 락이 없으면: 여러 호출이 동시에 파일을 읽고(같은 값) → 각자 +1 계산 → 마지막에 쓴
  // 값만 남아 나머지 증가분이 유실된다(전형적 lost-update race). 락이 있으면 N번 호출
  // 후 파일 값이 정확히 N이어야 한다.
  const dir = makeTmpDir();
  const file = join(dir, 'counter.txt');
  writeFileSync(file, '0');
  const N = 20;
  // retries를 넉넉히 준다 — 이 테스트는 "직렬화되면 유실이 없다"를 확인하는 것이지
  // "포기 없이 무한정 기다려야 한다"를 확인하는 게 아니다(그건 별도 테스트).
  // N개가 한 줄로 대기할 수 있는 최악의 경우(마지막 호출자)까지 커버해야 함.
  await Promise.all(
    Array.from({ length: N }, () =>
      withLock(
        file,
        async () => {
          const cur = Number(readFileSync(file, 'utf8'));
          await new Promise((r) => setTimeout(r, 5)); // 경합을 실제로 유발하기 위한 인위적 지연
          writeAtomic(file, String(cur + 1));
        },
        { retryDelayMs: 5, retries: N * 5 },
      ),
    ),
  );
  assert.equal(Number(readFileSync(file, 'utf8')), N);
  rmSync(dir, { recursive: true, force: true });
});

test('withLock: 락이 이미 점유 중이면 재시도 소진 후 명시적으로 포기(무한 대기 금지)', async () => {
  const dir = makeTmpDir();
  const file = join(dir, 'state.json');
  writeFileSync(`${file}.lock`, '99999'); // 다른 프로세스가 쥐고 있는 것처럼 시뮬레이션(신선한 락)
  await assert.rejects(
    withLock(file, async () => {}, { retries: 2, retryDelayMs: 5 }),
    /락 획득 실패\(포기\)/,
  );
  rmSync(dir, { recursive: true, force: true });
});

test('withLock: 오래된(stale) 락은 죽은 프로세스의 잔재로 보고 정리 후 획득 성공', async () => {
  const dir = makeTmpDir();
  const file = join(dir, 'state.json');
  const lockFile = `${file}.lock`;
  writeFileSync(lockFile, '12345');
  const old = new Date(Date.now() - 60_000); // 60초 전 — staleLockMs(작게 설정)를 넘김
  utimesSync(lockFile, old, old);

  let ran = false;
  await withLock(
    file,
    async () => {
      ran = true;
    },
    { staleLockMs: 1000, retries: 5, retryDelayMs: 5 },
  );
  assert.equal(ran, true);
  assert.equal(existsSync(lockFile), false);
  rmSync(dir, { recursive: true, force: true });
});

test('writeStateFile: 락+원자적쓰기를 한 번에 수행', async () => {
  const dir = makeTmpDir();
  const file = join(dir, 'state.json');
  await writeStateFile(file, '{"holdings":[]}');
  assert.equal(readFileSync(file, 'utf8'), '{"holdings":[]}');
  assert.equal(existsSync(`${file}.lock`), false);
  rmSync(dir, { recursive: true, force: true });
});

// ── patchFrontmatterFileSafely(2026-09-04 신설) ──────────────────────────────
// State/Holdings 동시쓰기 경합 방지 — VIP펀드 매수누적 작업 코드리뷰에서 발견된
// 잔여 리스크(Log/Implementation/2026-09-04-VIP펀드매수누적반영.md "남은 것" 참고)
// 를 이번에 마저 해소.

test('patchFrontmatterFileSafely: patch 필드만 갱신, 나머지 필드는 보존', async () => {
  const dir = makeTmpDir();
  const file = join(dir, 'holding.md');
  writeFileSync(file, '---\naccount: "위탁"\nname: "삼성전자"\nqty: 100\ncurPrice: 70000\n---\n');
  await patchFrontmatterFileSafely(file, { curPrice: 71000 });
  const content = readFileSync(file, 'utf8');
  assert.match(content, /curPrice: 71000/);
  assert.match(content, /qty: 100/, 'patch에 없는 필드(qty)는 그대로 보존돼야 함');
  assert.match(content, /account: "위탁"/);
  rmSync(dir, { recursive: true, force: true });
});

test('[실사고 재현/막아야 함] patchFrontmatterFileSafely: 호출 시점에 파일을 다시 읽어서 patch — 호출 전에 다른 프로세스가 써놓은 필드를 안 지움', async () => {
  const dir = makeTmpDir();
  const file = join(dir, 'holding.md');
  // "예전에 읽어둔" 내용(stale) — qty:100 시절.
  const staleContent = '---\naccount: "위탁"\nname: "삼성전자"\nqty: 100\ncurPrice: 70000\n---\n';
  writeFileSync(file, staleContent);
  // 그 사이 다른 프로세스(예: update-holdings-from-executions.mjs)가 qty를 120으로 갱신.
  writeFileSync(file, '---\naccount: "위탁"\nname: "삼성전자"\nqty: 120\ncurPrice: 70000\n---\n');
  // 이제 가격갱신 잡이 patch를 쓴다 — staleContent를 참고하지 않고 파일을 다시 읽어야
  // qty:120이 살아남는다.
  await patchFrontmatterFileSafely(file, { curPrice: 71500 });
  const content = readFileSync(file, 'utf8');
  assert.match(content, /qty: 120/, '다른 프로세스가 갱신한 qty가 지워지면 안 됨(경합 방지의 핵심)');
  assert.match(content, /curPrice: 71500/);
  rmSync(dir, { recursive: true, force: true });
});

test('patchFrontmatterFileSafely: 락 파일이 끝나고 정리됨', async () => {
  const dir = makeTmpDir();
  const file = join(dir, 'holding.md');
  writeFileSync(file, '---\nqty: 1\n---\n');
  await patchFrontmatterFileSafely(file, { qty: 2 });
  assert.equal(existsSync(`${file}.lock`), false);
  rmSync(dir, { recursive: true, force: true });
});

test('[코드리뷰 MEDIUM 지적] patchFrontmatterFileSafely: 파일이 없으면(동시 전량청산 등으로 삭제) throw 대신 false 반환', async () => {
  const dir = makeTmpDir();
  const file = join(dir, 'gone.md');
  // 파일을 아예 만들지 않음 — 배치로 목록을 미리 읽어둔 뒤 한참 뒤 patch를 시도하는데
  // 그 사이 다른 잡이 전량청산으로 파일 자체를 지운 상황을 재현.
  const result = await patchFrontmatterFileSafely(file, { qty: 2 });
  assert.equal(result, false);
  assert.equal(existsSync(`${file}.lock`), false, '실패해도 락파일은 남지 않아야 함');
  rmSync(dir, { recursive: true, force: true });
});
