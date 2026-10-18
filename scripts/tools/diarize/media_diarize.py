#!/usr/bin/env python3
"""Local diarization worker. JSON in, one JSON result per item out; no downloads."""
import json
import os
import sys
import time
from pathlib import Path

os.umask(0o077)  # 목소리 특징값(.npy)과 폴더를 처음부터 본인만 읽게 만든다.
result_output = os.fdopen(os.dup(sys.stdout.fileno()), "w", encoding="utf-8", buffering=1)
sys.stdout = sys.stderr

os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["TRANSFORMERS_OFFLINE"] = "1"
os.environ["PYANNOTE_METRICS_ENABLED"] = "0"

import numpy as np
import soundfile as sf

HOME = Path.home()
MODEL_ROOT = HOME / "Pantheon" / "Models" / "diarize"
SEGMENT_MODEL = MODEL_ROOT / "sherpa" / "sherpa-onnx-pyannote-segmentation-3-0" / "model.onnx"
EMBED_MODEL = MODEL_ROOT / "sherpa" / "3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx"
PYANNOTE_MODEL = MODEL_ROOT / "pyannote" / "speaker-diarization-community-1"


def init_sherpa(num_speakers):
    import sherpa_onnx
    config = sherpa_onnx.OfflineSpeakerDiarizationConfig(
        segmentation=sherpa_onnx.OfflineSpeakerSegmentationModelConfig(
            pyannote=sherpa_onnx.OfflineSpeakerSegmentationPyannoteModelConfig(
                model=str(SEGMENT_MODEL), window_shift_ratio=0.1)),
        embedding=sherpa_onnx.SpeakerEmbeddingExtractorConfig(model=str(EMBED_MODEL)),
        clustering=sherpa_onnx.FastClusteringConfig(num_clusters=num_speakers),
        min_duration_on=0.3, min_duration_off=0.5,
    )
    if not config.validate():
        raise RuntimeError("sherpa model missing; run setup.sh")
    diarizer = sherpa_onnx.OfflineSpeakerDiarization(config)
    extractor = sherpa_onnx.SpeakerEmbeddingExtractor(
        sherpa_onnx.SpeakerEmbeddingExtractorConfig(model=str(EMBED_MODEL)))
    return diarizer, extractor


def sherpa_result(models, samples):
    diarizer, extractor = models
    raw = diarizer.process(samples).sort_by_start_time()
    speakers = sorted({turn.speaker for turn in raw})
    if len(speakers) != 2:
        raise RuntimeError(f"expected two speakers, found {len(speakers)}")
    labels = {speaker: f"S{index}" for index, speaker in enumerate(speakers)}
    turns = [{"start": round(turn.start * 1000), "end": round(turn.end * 1000),
              "speaker": labels[turn.speaker]} for turn in raw]
    vectors = []
    for speaker in speakers:
        chunks = []
        for turn in raw:
            if turn.speaker != speaker:
                continue
            clip = samples[max(0, round(turn.start * 16000)):round(turn.end * 16000)]
            if len(clip) < 16000:
                continue
            stream = extractor.create_stream()
            stream.accept_waveform(16000, clip)
            stream.input_finished()
            if extractor.is_ready(stream):
                chunks.append(np.asarray(extractor.compute(stream), dtype=np.float32))
        if not chunks:
            raise RuntimeError(f"speaker {speaker} has no usable embedding")
        vectors.append(np.mean(chunks, axis=0))
    return turns, np.stack(vectors)


def init_pyannote(_num_speakers):
    if not (PYANNOTE_MODEL / "config.yaml").is_file():
        raise RuntimeError("pyannote model missing; run setup.sh with HF token")
    from pyannote.audio import Pipeline
    import torch
    pipeline = Pipeline.from_pretrained(str(PYANNOTE_MODEL))
    requested = os.environ.get("MEDIA_DIARIZE_DEVICE", "auto").lower()
    if requested not in ("auto", "cpu", "mps"):
        raise ValueError("MEDIA_DIARIZE_DEVICE must be auto, cpu, or mps")
    if requested == "cpu":
        return pipeline, "cpu"
    if not torch.backends.mps.is_available():
        if requested == "mps":
            raise RuntimeError("MPS requested but unavailable")
        return pipeline, "cpu"
    try:
        pipeline.to(torch.device("mps"))
    except Exception as error:
        if requested == "mps":
            raise
        message = " ".join(str(error).splitlines())
        print(f"MPS initialization failed; using CPU: {message}", file=sys.stderr)
        return Pipeline.from_pretrained(str(PYANNOTE_MODEL)), "cpu"
    return pipeline, "mps"


def pyannote_result(pipeline, audio, speaker_options):
    import torch
    stages = {}

    def on_stage(name, _value, **_progress):
        if name in ("speaker_counting", "embeddings"):
            stages[name] = time.monotonic()

    result = pipeline({"waveform": torch.from_numpy(audio)[None], "sample_rate": 16000},
                      hook=on_stage, **speaker_options)
    annotation = result.exclusive_speaker_diarization
    speakers = annotation.labels()
    minimum = speaker_options.get("min_speakers", speaker_options.get("num_speakers"))
    maximum = speaker_options.get("max_speakers", speaker_options.get("num_speakers"))
    if not minimum <= len(speakers) <= maximum or result.speaker_embeddings is None:
        raise RuntimeError(f"expected {minimum}..{maximum} speakers with embeddings, found {len(speakers)}")
    labels = {speaker: f"S{index}" for index, speaker in enumerate(speakers)}
    turns = [{"start": round(segment.start * 1000), "end": round(segment.end * 1000),
              "speaker": labels[speaker]}
             for segment, _, speaker in annotation.itertracks(yield_label=True)]
    source_labels = result.speaker_diarization.labels()
    vectors = np.stack([result.speaker_embeddings[source_labels.index(s)] for s in speakers])
    feature_ms = round((stages["embeddings"] - stages["speaker_counting"]) * 1000)
    return turns, vectors, feature_ms


def pyannote_single_result(pipeline, audio):
    """Use the same embedding space as diarization, without running segmentation."""
    import torch
    started = time.monotonic()
    waveform = torch.from_numpy(audio)[None, None]
    vectors = np.asarray(pipeline._embedding(waveform), dtype=np.float32)
    if vectors.shape[0] != 1 or not np.isfinite(vectors).all():
        raise RuntimeError("single-speaker embedding invalid")
    return [{"start": 0, "end": round(len(audio) / 16), "speaker": "S0"}], vectors, round((time.monotonic() - started) * 1000)


def process_request(request, model_cache):
    backend = request["backend"]
    fixed = request.get("numSpeakers") == 2 and "minSpeakers" not in request and "maxSpeakers" not in request
    ranged = (backend in ("pyannote", "pyannote-single") and request.get("minSpeakers") == 1
              and request.get("maxSpeakers") == 3 and "numSpeakers" not in request)
    if backend not in ("sherpa", "pyannote", "pyannote-single") or not (fixed or ranged):
        raise ValueError("backend or numSpeakers invalid")
    voices_dir = Path(request["voicesDir"])
    if backend == "sherpa":
        if "sherpa" not in model_cache:
            model_cache["sherpa"] = (init_sherpa(2), "cpu")
        models, device = model_cache["sherpa"]
    else:
        if "pyannote" not in model_cache:
            model_cache["pyannote"] = init_pyannote(2)
        models, device = model_cache["pyannote"]
    speaker_options = {"num_speakers": 2} if fixed else {"min_speakers": 1, "max_speakers": 3}
    for item in request["items"]:
        started = time.monotonic()
        try:
            audio, sample_rate = sf.read(item["wav"], dtype="float32")
            if sample_rate != 16000 or audio.ndim != 1:
                raise ValueError("expected mono 16kHz wav")
            if backend == "sherpa":
                turns, vectors = sherpa_result(models, audio)
                feature_ms = 0
            elif backend == "pyannote":
                turns, vectors, feature_ms = pyannote_result(models, audio, speaker_options)
            else:
                turns, vectors, feature_ms = pyannote_single_result(models, audio)
            path = voices_dir / ("pyannote-rec" if ranged else backend) / f"{item['id']}.npy"
            path.parent.mkdir(parents=True, exist_ok=True)
            np.save(path, vectors)
            path.chmod(0o600)
            result = {"id": item["id"], "backend": backend, "device": device, "turns": turns,
                      "ms": round((time.monotonic() - started) * 1000),
                      "featureMs": feature_ms,
                      "audioSec": round(len(audio) / sample_rate, 3)}
        except Exception as error:
            result = {"id": item.get("id"), "error": str(error)}
        print(json.dumps(result, ensure_ascii=False), file=result_output, flush=True)


def main():
    model_cache = {}
    for line in sys.stdin:
        if line.strip():
            process_request(json.loads(line), model_cache)


if __name__ == "__main__":
    main()
