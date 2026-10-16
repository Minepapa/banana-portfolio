#!/usr/bin/env node
// 5-5f 밤 잡(매일 06:30, media-vision 05:30 뒤): 새 사진 얼굴 찾기 → 판정 → 사진 이름표(face-people.json)
// → 순간 노트 people·201/202 갱신. 맥 안에서만(InsightFace 로컬), 텔레그램 발신 없음.
// 얼굴 찾기·판정은 이미 처리한 사진을 건너뛰는 증분 처리라 평소에는 새 사진만 다룬다.
import { fileURLToPath } from 'node:url';
import { runFacePipeline } from './media-faces.mjs';
import { refreshMomentPeople } from './media-moments.mjs';

export async function runFacesNightly({ pipeline = runFacePipeline, refresh = refreshMomentPeople,
  limit = 500, output = console } = {}) {
  const labeled = await pipeline({ limit });
  const notes = await refresh({ output });
  const photoCount = Object.keys(labeled?.photos ?? {}).length;
  output.log(`[media-faces-nightly] 사진 이름표 ${photoCount}, 순간 노트 갱신 ${notes.changed}, 실패 ${notes.failed}`);
  return { photoCount, notes };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runFacesNightly().then(({ notes }) => {
    if (notes.failed) process.exitCode = 1;
  }).catch((error) => {
    console.error(`[media-faces-nightly] ${error.stack}`);
    process.exitCode = 1;
  });
}
