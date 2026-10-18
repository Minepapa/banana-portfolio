#!/usr/bin/env node
// 03:00 사진 블록(2026-10-18 오너 결정: 영상 블록과 같은 구조) — 장면 분석(media-vision) → 얼굴 이름표(media-faces-nightly)를
// 한 잡에서 순서대로 돌린다. 장면 분석이 실패해도 얼굴 이름표는 이어서 돌리고, 어느 하나라도 실패하면 종료코드 1.
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PHOTO_STEPS = Object.freeze([
  { name: '장면 분석', script: 'media-vision.mjs', timeoutMs: 25 * 60_000 },
  { name: '얼굴 이름표', script: 'media-faces-nightly.mjs', timeoutMs: 25 * 60_000 },
]);

export function runPhotoNightly({ run = (script, timeoutMs) => spawnSync(process.execPath,
  [join(dirname(fileURLToPath(import.meta.url)), script)], { stdio: 'inherit', timeout: timeoutMs }),
output = console } = {}) {
  const results = PHOTO_STEPS.map((step) => {
    const result = run(step.script, step.timeoutMs);
    const ok = result.status === 0 && !result.error;
    output.log(`[media-photo] ${step.name} ${ok ? '완료' : `실패(${result.error?.message ?? `종료코드 ${result.status}`})`}`);
    return { ...step, ok };
  });
  return { failed: results.filter((r) => !r.ok).length, results };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { failed } = runPhotoNightly();
  if (failed) process.exitCode = 1;
}
