#!/usr/bin/env bash
set -euo pipefail
if ! command -v uv >/dev/null 2>&1; then
  echo 'uv가 필요합니다. uv를 설치한 뒤 다시 실행하세요.' >&2
  exit 1
fi

ROOT="$HOME/Pantheon/Models/diarize"
VENV="$HOME/Pantheon/Models/diarize-venv"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export UV_CACHE_DIR="$HOME/Pantheon/Models/.uv-cache"
export UV_PYTHON_INSTALL_DIR="$HOME/Pantheon/Models/.uv-python"
mkdir -p "$ROOT/sherpa" "$ROOT/pyannote" "$UV_CACHE_DIR" "$UV_PYTHON_INSTALL_DIR"
if [[ ! -x "$VENV/bin/python" ]]; then uv venv --python 3.12 "$VENV"; fi
uv pip install --python "$VENV/bin/python" -r "$SCRIPT_DIR/requirements.txt"

SEGMENT="$ROOT/sherpa/sherpa-onnx-pyannote-segmentation-3-0/model.onnx"
SEGMENT_SHA=220ad67ca923bef2fa91f2390c786097bf305bceb5e261d4af67b38e938e1079
EMBED_SHA=1a331345f04805badbb495c775a6ddffcdd1a732567d5ec8b3d5749e3c7a5e4b
check_hash() {
  [[ -f "$2" ]] && printf '%s  %s\n' "$1" "$2" | shasum -a 256 -c >/dev/null 2>&1
}
STAGING=''
EMBED_PART=''
cleanup() { [[ -z "$STAGING" ]] || rm -rf "$STAGING"; [[ -z "$EMBED_PART" ]] || rm -f "$EMBED_PART"; }
trap cleanup EXIT
if ! check_hash "$SEGMENT_SHA" "$SEGMENT"; then
  STAGING="$(mktemp -d "$ROOT/sherpa/.segment.XXXXXX")"
  curl --fail --location --retry 3 --proto '=https' --tlsv1.2 --output "$STAGING/model.tar.bz2" \
    'https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2'
  tar -xjf "$STAGING/model.tar.bz2" -C "$STAGING"
  check_hash "$SEGMENT_SHA" "$STAGING/sherpa-onnx-pyannote-segmentation-3-0/model.onnx"
  rm -rf "$ROOT/sherpa/sherpa-onnx-pyannote-segmentation-3-0"
  mv "$STAGING/sherpa-onnx-pyannote-segmentation-3-0" "$ROOT/sherpa/"
  rm -rf "$STAGING"
  STAGING=''
fi
EMBED="$ROOT/sherpa/3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx"
if ! check_hash "$EMBED_SHA" "$EMBED"; then
  EMBED_PART="$EMBED.part"
  curl --fail --location --retry 3 --proto '=https' --tlsv1.2 --output "$EMBED_PART" \
    'https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx'
  check_hash "$EMBED_SHA" "$EMBED_PART"
  mv "$EMBED_PART" "$EMBED"
  EMBED_PART=''
fi
printf 'sherpa ready: %s\n' "$ROOT/sherpa"

TOKEN_FILE="$HOME/.config/banana-portfolio-v2/hf-token"
if [[ ! -s "$TOKEN_FILE" ]]; then
  echo '토큰 없음 — pyannote 건너뜀'
  exit 0
fi
if [[ "$(stat -f '%Lp' "$TOKEN_FILE")" != '600' ]]; then
  echo 'HF 토큰 파일 권한이 600이 아닙니다.' >&2
fi
# 토큰은 자식 프로세스 내부 메모리로만 읽는다. 명령행·환경·출력에 싣지 않는다.
"$VENV/bin/python" - "$TOKEN_FILE" "$ROOT/pyannote" <<'PY'
import sys
from pathlib import Path
from huggingface_hub import snapshot_download

model_id = "pyannote/speaker-diarization-community-1"
token = Path(sys.argv[1]).read_text(encoding="utf-8").strip()
destination = Path(sys.argv[2]) / "speaker-diarization-community-1"
snapshot_download(repo_id=model_id, token=token, local_dir=destination)
print(f"pyannote ready: {model_id} -> {destination}")
PY
