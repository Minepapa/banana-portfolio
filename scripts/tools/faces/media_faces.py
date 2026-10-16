#!/usr/bin/env python3
"""Read one batch of original photos and write only local face embeddings."""

import json
import os
import re
import sys
import time
from contextlib import redirect_stdout
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageOps
from pillow_heif import register_heif_opener
from insightface.app import FaceAnalysis

register_heif_opener()


def analyze_image(app, image):
    started = time.monotonic()
    image_id = image["id"]
    with Image.open(image["path"]) as source:
        rgb = np.asarray(ImageOps.exif_transpose(source).convert("RGB"))
    bgr = cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)
    height, width = bgr.shape[:2]
    faces = []
    embeddings = []
    for face in app.get(bgr):
        embedding = np.asarray(face.normed_embedding, dtype=np.float32)
        if embedding.shape != (512,) or not np.isfinite(embedding).all():
            raise ValueError("invalid 512-dimensional face embedding")
        x1, y1, x2, y2 = [float(value) for value in face.bbox]
        left, top = max(0, int(x1)), max(0, int(y1))
        right, bottom = min(width, int(x2)), min(height, int(y2))
        crop = cv2.cvtColor(bgr[top:bottom, left:right], cv2.COLOR_BGR2GRAY)
        blur = float(cv2.Laplacian(crop, cv2.CV_64F).var()) if crop.size else 0.0
        faces.append({
            "i": len(faces),
            "bbox": [x1, y1, x2, y2],
            "kps": np.asarray(face.kps, dtype=np.float32).tolist(),
            "det": float(face.det_score),
            "size": max(0, min(right - left, bottom - top)),
            "blur": blur,
        })
        embeddings.append(embedding)
    vectors = np.stack(embeddings) if embeddings else np.empty((0, 512), dtype=np.float32)
    return {"id": image_id, "faces": faces, "ms": round((time.monotonic() - started) * 1000, 1)}, vectors


def main():
    batch = json.loads(sys.stdin.readline())
    out = Path(batch["out"])
    embedding_dir = out / "embeddings"
    embedding_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    embedding_dir.chmod(0o700)
    model_root = Path.home() / "Pantheon" / "Models" / "insightface"
    model_dir = model_root / "models" / "buffalo_l"
    # Processing must never initiate a model download. setup.sh owns all networking.
    if not all((model_dir / name).is_file() for name in ("det_10g.onnx", "w600k_r50.onnx")):
        raise SystemExit(f"buffalo_l model missing; run setup.sh: {model_dir}")
    # InsightFace prints provider/model diagnostics to stdout; reserve stdout for JSONL.
    with redirect_stdout(sys.stderr):
        app = FaceAnalysis(name="buffalo_l", root=str(model_root), providers=["CPUExecutionProvider"])
        app.prepare(ctx_id=-1, det_size=(640, 640))
    for image in batch["images"]:
        image_id = image.get("id", "")
        try:
            if not isinstance(image_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]+(?:@[0-9]+)?", image_id):
                raise ValueError("invalid image id")
            with redirect_stdout(sys.stderr):
                metadata, vectors = analyze_image(app, image)
            destination = embedding_dir / f"{image_id}.npy"
            temporary = embedding_dir / f".{image_id}.{os.getpid()}.npy"
            try:
                np.save(temporary, vectors.astype(np.float32, copy=False))
                temporary.chmod(0o600)
                os.replace(temporary, destination)
            finally:
                temporary.unlink(missing_ok=True)
            print(json.dumps(metadata, ensure_ascii=False), flush=True)
        except Exception as error:
            print(json.dumps({"id": image_id, "error": str(error)}, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
