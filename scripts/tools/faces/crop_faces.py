#!/usr/bin/env python3
"""Create local review crops from read-only original photos; no face model is loaded."""

import json
import math
import os
import sys
from pathlib import Path

from PIL import Image, ImageOps
from pillow_heif import register_heif_opener

register_heif_opener()


def main():
    request = json.loads(sys.stdin.readline())
    for item in request["images"]:
        try:
            bbox = item["bbox"]
            if (not isinstance(bbox, list) or len(bbox) != 4
                    or any(type(value) not in (int, float) or not math.isfinite(value)
                           for value in bbox)):
                raise ValueError("invalid face bbox")
            with Image.open(item["path"]) as source:
                photo = ImageOps.exif_transpose(source).convert("RGB")
                x1, y1, x2, y2 = bbox
                x1, x2 = max(0, min(x1, photo.width)), max(0, min(x2, photo.width))
                y1, y2 = max(0, min(y1, photo.height)), max(0, min(y2, photo.height))
                if x2 <= x1 or y2 <= y1:
                    raise ValueError("invalid face bbox")
                width, height = x2 - x1, y2 - y1
                left = max(0, math.floor(x1 - width * 0.1))
                top = max(0, math.floor(y1 - height * 0.1))
                right = min(photo.width, math.ceil(x2 + width * 0.1))
                bottom = min(photo.height, math.ceil(y2 + height * 0.1))
                if right <= left or bottom <= top:
                    raise ValueError("invalid face bbox")
                crop = photo.crop((left, top, right, bottom))
                crop.thumbnail((160, 160), Image.Resampling.LANCZOS)
                destination = Path(item["out"])
                destination.parent.mkdir(parents=True, exist_ok=True)
                temporary = destination.with_name(f".{destination.stem}.{os.getpid()}.jpg")
                try:
                    crop.save(temporary, "JPEG", quality=88)
                    os.replace(temporary, destination)
                finally:
                    temporary.unlink(missing_ok=True)
            print(json.dumps(item["out"]), flush=True)
        except Exception as error:
            print(f"[crop_faces] {item.get('id')}/{item.get('i')}: {error}", file=sys.stderr)


if __name__ == "__main__":
    main()
