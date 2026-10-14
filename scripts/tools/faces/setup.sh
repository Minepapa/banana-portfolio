#!/usr/bin/env bash
set -euo pipefail

ROOT="$HOME/Pantheon/Models/insightface"
VENV="$HOME/Pantheon/Models/faces-venv"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export UV_CACHE_DIR="$HOME/Pantheon/Models/.uv-cache"
export UV_PYTHON_INSTALL_DIR="$HOME/Pantheon/Models/.uv-python"
mkdir -p "$UV_CACHE_DIR" "$UV_PYTHON_INSTALL_DIR"

if [[ ! -x "$VENV/bin/python" ]]; then
  uv venv --python 3.12 "$VENV"
fi
uv pip install --python "$VENV/bin/python" -r "$SCRIPT_DIR/requirements.txt"

# Keep the download in setup, and replace an incomplete model only after validation.
MODEL_DIR="$ROOT/models/buffalo_l"
if [[ ! -s "$MODEL_DIR/det_10g.onnx" || ! -s "$MODEL_DIR/w600k_r50.onnx" ]]; then
  mkdir -p "$ROOT/models"
  STAGING="$(mktemp -d "$ROOT/models/.buffalo_l.XXXXXX")"
  trap 'rm -rf "$STAGING"' EXIT
  curl --fail --location --retry 3 --output "$STAGING/buffalo_l.zip" \
    'https://github.com/deepinsight/insightface/releases/download/v0.7/buffalo_l.zip'
  unzip -q "$STAGING/buffalo_l.zip" -d "$STAGING/unpacked"
  CANDIDATE="$STAGING/unpacked/buffalo_l"
  if [[ ! -d "$CANDIDATE" ]]; then CANDIDATE="$STAGING/unpacked"; fi
  [[ -s "$CANDIDATE/det_10g.onnx" && -s "$CANDIDATE/w600k_r50.onnx" ]] || {
    echo 'buffalo_l archive is missing detector or recognition model' >&2
    exit 1
  }
  rm -rf "$MODEL_DIR"
  mv "$CANDIDATE" "$MODEL_DIR"
fi

"$VENV/bin/python" - "$ROOT" <<'PY'
import sys
from pathlib import Path

model_dir = Path(sys.argv[1]) / "models" / "buffalo_l"
if not all((model_dir / name).is_file() for name in ("det_10g.onnx", "w600k_r50.onnx")):
    raise SystemExit(f"buffalo_l model missing: {model_dir}")
print(f"faces setup ready: {model_dir}")
PY
