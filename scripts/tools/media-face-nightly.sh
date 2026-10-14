#!/bin/sh
# 5-5f 배선 초안: media-vision 완료 후에만 호출한다. launchd 등록 전용이 아니다.
set -eu
repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$repo_root"
node scripts/jobs/media-faces.mjs --detect
node scripts/jobs/media-faces.mjs --match
node scripts/jobs/media-faces.mjs --label
node scripts/jobs/media-moments.mjs --refresh-people
