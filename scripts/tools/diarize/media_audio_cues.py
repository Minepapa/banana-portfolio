#!/usr/bin/env python3
"""Local audio cue worker (laughter, crying, singing, pitch, loudness). JSON in, one JSON result per item out; no downloads."""
import json
import os
import sys
from pathlib import Path

# 결과 전용 fd를 따로 두고 fd 1 자체를 stderr로 돌린다. C 확장(onnxruntime·torch)이 stdout에 찍어도 결과 줄에 섞이지 않게.
result_output = os.fdopen(os.dup(1), "w", encoding="utf-8", buffering=1)
os.dup2(2, 1)
sys.stdout = sys.stderr

import numpy as np
import soundfile as sf

MODEL_DIR = Path.home() / "Pantheon" / "Models" / "audio-tagging" / "sherpa-onnx-ced-mini-audio-tagging-2024-04-19"

# 감정 근거로 쓰는 AudioSet 레이블 묶음. 모델 레이블 이름(class_labels_indices.csv)을 그대로 쓴다.
# 결정 문서 대상이 아니라 모델 출력의 기술적 매핑이다(감정 판단은 LLM이 결정 문서 기준으로 한다).
GROUPS = {
    "laughter": ["Laughter", "Baby laughter", "Giggle", "Snicker", "Belly laugh", "Chuckle, chortle"],
    "crying": ["Crying, sobbing", "Baby cry, infant cry", "Whimper", "Wail, moan"],
    "shouting": ["Screaming", "Shout", "Yell", "Children shouting"],
    "singing": ["Child singing", "Singing", "Humming"],
    "sigh": ["Sigh"],
    "whisper": ["Whispering"],
    "speech": ["Speech", "Child speech, kid speaking"],
}


def load_tagger():
    import sherpa_onnx
    config = sherpa_onnx.AudioTaggingConfig(
        model=sherpa_onnx.AudioTaggingModelConfig(ced=str(MODEL_DIR / "model.int8.onnx"), num_threads=2),
        labels=str(MODEL_DIR / "class_labels_indices.csv"), top_k=20)
    if not config.validate():
        raise RuntimeError("audio tagging model missing")
    return sherpa_onnx.AudioTagging(config)


def pitch_hz(segment, sample_rate):
    # 높이 계산 실패(라이브러리 변경 등)는 그 창의 pitch만 비우고 태그 결과는 살린다.
    try:
        import torch
        import torchaudio
        if np.sqrt(np.mean(segment ** 2)) < 0.005:
            return None
        value = torchaudio.functional.detect_pitch_frequency(torch.from_numpy(segment)[None], sample_rate).median().item()
        return round(value, 1) if 60 <= value <= 1200 else None
    except Exception:
        return None


def analyze(tagger, audio, sample_rate, window_sec, hop_sec):
    windows = []
    window = int(window_sec * sample_rate)
    hop = int(hop_sec * sample_rate)
    for start in range(0, max(1, len(audio) - sample_rate + 1), hop):
        segment = audio[start:start + window]
        if len(segment) < sample_rate:
            break
        stream = tagger.create_stream()
        stream.accept_waveform(sample_rate, segment)
        events = {event.name: float(event.prob) for event in tagger.compute(stream)}
        tags = {group: round(max((events.get(name, 0.0) for name in names), default=0.0), 3)
                for group, names in GROUPS.items()}
        windows.append({
            "start": round(start / sample_rate, 2),
            "end": round((start + len(segment)) / sample_rate, 2),
            "tags": tags,
            "pitch": pitch_hz(segment, sample_rate),
            "rms": round(float(np.sqrt(np.mean(segment ** 2))), 4),
        })
    return windows


def main():
    request = json.loads(sys.stdin.readline())
    window_sec = float(request.get("windowSec", 4))
    hop_sec = float(request.get("hopSec", 2))
    if not (1 <= window_sec <= 10 and 0.5 <= hop_sec <= window_sec):
        raise ValueError("window or hop invalid")
    tagger = load_tagger()
    for item in request["items"]:
        try:
            audio, sample_rate = sf.read(item["wav"], dtype="float32")
            if sample_rate != 16000 or audio.ndim != 1:
                raise ValueError("expected mono 16kHz wav")
            result = {"id": item["id"], "durationSec": round(len(audio) / sample_rate, 2),
                      "windowSec": window_sec, "hopSec": hop_sec,
                      "windows": analyze(tagger, audio, sample_rate, window_sec, hop_sec)}
        except Exception as error:
            result = {"id": item.get("id"), "error": str(error)}
        print(json.dumps(result, ensure_ascii=False), file=result_output, flush=True)


if __name__ == "__main__":
    main()
