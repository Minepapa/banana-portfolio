#!/usr/bin/env python3
"""Encode local face crops for the portable review sheet without image metadata."""

import base64
import io
import json
import sys

from PIL import Image


def main():
    paths = json.loads(sys.stdin.readline())
    result = []
    for path in paths:
        with Image.open(path) as source:
            image = source.convert("RGB")
            image.thumbnail((160, 160), Image.Resampling.LANCZOS)
            buffer = io.BytesIO()
            # A new RGB image and empty EXIF avoid forwarding source metadata.
            image.save(buffer, "JPEG", quality=55, optimize=True, exif=b"")
            result.append(base64.b64encode(buffer.getvalue()).decode("ascii"))
    print(json.dumps(result))


if __name__ == "__main__":
    main()
