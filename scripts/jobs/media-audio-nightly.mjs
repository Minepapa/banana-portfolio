#!/usr/bin/env node
// 02:00 음성 블록(2026-10-18 오너 결정: 사진·영상 블록과 같은 구조) — 통화·녹음 전사(media-transcribe) →
// 화자 분리(media-diarize)를 한 잡에서 순서대로 돌린다. 새로 쌓이는 양(하루 통화 3건 안팎) 기준으로 03:00 사진 블록 전에
// 끝나도록 전사는 새 파일 시작을 15분까지, 화자 분리는 자체 회차 상한(새 통화 시작 45분)까지. 전사가 실패해도 화자 분리는
// 이미 전사된 파일로 이어서 돌고, 어느 하나라도 실패하면 종료코드 1. 밀린 것은 다음 날 같은 블록이 이어서 처리한다.
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const AUDIO_STEPS = Object.freeze([
  { name: '통화·녹음 전사', script: 'media-transcribe.mjs', args: ['--max-minutes=15'], timeoutMs: 25 * 60_000 },
  // 화자 분리는 인자 없이 불러야 정기 실행 옵션(밤 실행 허용·회차 상한)을 쓴다.
  { name: '화자 분리', script: 'media-diarize.mjs', args: [], timeoutMs: 55 * 60_000 },
]);

export function runAudioNightly({ run = (step) => spawnSync(process.execPath,
  [join(dirname(fileURLToPath(import.meta.url)), step.script), ...step.args], { stdio: 'inherit', timeout: step.timeoutMs }),
output = console } = {}) {
  const results = AUDIO_STEPS.map((step) => {
    const result = run(step);
    const ok = result.status === 0 && !result.error;
    output.log(`[media-audio] ${step.name} ${ok ? '완료' : `실패(${result.error?.message ?? `종료코드 ${result.status}`})`}`);
    return { ...step, ok };
  });
  return { failed: results.filter((r) => !r.ok).length, results };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { failed } = runAudioNightly();
  if (failed) process.exitCode = 1;
}
