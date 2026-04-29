#!/usr/bin/env python3
"""
Deep Shadow probe.

Local experiment for native/server-side audio analysis timing. This is not wired
into the app yet. It downloads/loads one track, runs native Essentia if present,
and prints JSON so we can evaluate runtime and useful descriptors.

Usage:
  python3 deep_shadow_probe.py --video-id VIDEO_ID
  python3 deep_shadow_probe.py --file /path/to/audio.wav
"""

from __future__ import annotations

import argparse
import json
import math
import statistics
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

MODEL_DIR = Path(__file__).resolve().parent / "deep_shadow_models"
MSD_MUSICNN_URL = "https://essentia.upf.edu/models/feature-extractors/musicnn/msd-musicnn-1.pb"
MSD_CLASSIFIERS = {
    "voice_instrumental": {
        "filename": "voice_instrumental-msd-musicnn-1.pb",
        "url": "https://essentia.upf.edu/models/classification-heads/voice_instrumental/voice_instrumental-msd-musicnn-1.pb",
        "classes": ["instrumental", "voice"],
        "section_fields": {"voice": "avgVoiceProbability"},
    },
    "danceability": {
        "filename": "danceability-msd-musicnn-1.pb",
        "url": "https://essentia.upf.edu/models/classification-heads/danceability/danceability-msd-musicnn-1.pb",
        "classes": ["danceable", "not_danceable"],
        "section_fields": {"danceable": "avgDanceabilityProbability"},
    },
    "mood_party": {
        "filename": "mood_party-msd-musicnn-1.pb",
        "url": "https://essentia.upf.edu/models/classification-heads/mood_party/mood_party-msd-musicnn-1.pb",
        "classes": ["party", "non_party"],
        "section_fields": {"party": "avgPartyProbability"},
    },
    "mood_relaxed": {
        "filename": "mood_relaxed-msd-musicnn-1.pb",
        "url": "https://essentia.upf.edu/models/classification-heads/mood_relaxed/mood_relaxed-msd-musicnn-1.pb",
        "classes": ["relaxed", "non_relaxed"],
        "section_fields": {"relaxed": "avgRelaxedProbability"},
    },
    "mood_electronic": {
        "filename": "mood_electronic-msd-musicnn-1.pb",
        "url": "https://essentia.upf.edu/models/classification-heads/mood_electronic/mood_electronic-msd-musicnn-1.pb",
        "classes": ["electronic", "non_electronic"],
        "section_fields": {"electronic": "avgElectronicProbability"},
    },
    "loop_role": {
        "filename": "fs_loop_ds-msd-musicnn-1.pb",
        "url": "https://essentia.upf.edu/models/classification-heads/fs_loop_ds/fs_loop_ds-msd-musicnn-1.pb",
        "classes": ["bass", "chords", "fx", "melody", "percussion"],
        "section_fields": {
            "bass": "avgBassRoleProbability",
            "melody": "avgMelodyRoleProbability",
            "percussion": "avgPercussionRoleProbability",
        },
        "input": "serving_default_model_Placeholder",
        "output": "PartitionedCall",
    },
}
DEFAULT_EXTRA_CLASSIFIERS = ["danceability", "mood_party", "mood_relaxed", "mood_electronic", "loop_role"]


def require_essentia():
    try:
        import essentia  # noqa: F401
        import essentia.standard as es
        return es
    except Exception as exc:
        raise RuntimeError(
            "Native Essentia is not installed in this Python environment. "
            "Install/test the environment first, then rerun this probe."
        ) from exc


def download_audio(video_id: str, out_dir: Path) -> Path:
    out_template = str(out_dir / "%(id)s.%(ext)s")
    cmd = [
        "yt-dlp",
        "-f",
        "bestaudio/best",
        "--extract-audio",
        "--audio-format",
        "wav",
        "--audio-quality",
        "0",
        "-o",
        out_template,
        f"https://www.youtube.com/watch?v={video_id}",
    ]
    subprocess.run(cmd, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    matches = list(out_dir.glob(f"{video_id}.*"))
    if not matches:
        raise RuntimeError(f"yt-dlp did not produce an audio file for {video_id}")
    return matches[0]


def ensure_model(filename: str, url: str) -> Path:
    MODEL_DIR.mkdir(parents=True, exist_ok=True)
    path = MODEL_DIR / filename
    if path.exists() and path.stat().st_size > 0:
        return path
    print(f"[deep-shadow] downloading {filename}", file=sys.stderr)
    tmp_path = path.with_suffix(path.suffix + ".tmp")
    urllib.request.urlretrieve(url, tmp_path)
    tmp_path.replace(path)
    return path


def median(values):
    clean = [v for v in values if isinstance(v, (int, float)) and math.isfinite(v)]
    return statistics.median(clean) if clean else 0.0


def cosine_similarity(a, b):
    if not a or not b:
        return 0.0
    size = min(len(a), len(b))
    dot = sum(a[i] * b[i] for i in range(size))
    na = math.sqrt(sum(a[i] * a[i] for i in range(size)))
    nb = math.sqrt(sum(b[i] * b[i] for i in range(size)))
    return dot / (na * nb) if na and nb else 0.0


def normalize_vector(values):
    total = sum(abs(v) for v in values)
    if total <= 1e-12:
        return [0.0 for _ in values]
    return [float(v) / total for v in values]


def extract_section_key(es, audio, start_sec: float, end_sec: float):
    start_idx = max(0, int(start_sec * 44100))
    end_idx = min(len(audio), int(end_sec * 44100))
    section_audio = audio[start_idx:end_idx]
    if len(section_audio) < 44100:
        return None, None, 0.0
    try:
        key, scale, strength = es.KeyExtractor()(section_audio)[:3]
        return key, scale, float(strength or 0.0)
    except Exception:
        return None, None, 0.0


def timestamped_predictions(predictions, duration: float, classes):
    pred_rows = [[float(x) for x in row] for row in predictions]
    points = []
    count = len(pred_rows)
    for idx, row in enumerate(pred_rows):
        t_sec = (idx / max(1, count - 1)) * duration if count > 1 else 0.0
        point = {"t": round(t_sec, 2)}
        for class_idx, class_name in enumerate(classes):
            point[class_name] = round(row[class_idx] if class_idx < len(row) else 0.0, 4)
        points.append(point)
    return points


def summarize_points(points, classes):
    summary = {"frames": len(points)}
    for class_name in classes:
        values = [p.get(class_name, 0.0) for p in points]
        pretty = "".join(part.capitalize() for part in class_name.split("_"))
        summary[f"avg{pretty}"] = round(sum(values) / max(1, len(values)), 4)
        summary[f"max{pretty}"] = round(max(values) if values else 0.0, 4)
        summary[f"min{pretty}"] = round(min(values) if values else 0.0, 4)
    return summary


def avg_class_for_section(points, class_name: str, start: float, end: float):
    vals = [p.get(class_name, 0.0) for p in points if start <= p["t"] < end]
    if not vals and points:
        mid = (start + end) / 2
        nearest = min(points, key=lambda p: abs(p["t"] - mid))
        vals = [nearest.get(class_name, 0.0)]
    return round(sum(vals) / max(1, len(vals)), 4)


def analyze_msd_classifiers(path: Path, duration: float, classifier_names):
    es = require_essentia()
    musicnn_path = ensure_model("msd-musicnn-1.pb", MSD_MUSICNN_URL)

    t0 = time.perf_counter()
    audio_16k = es.MonoLoader(filename=str(path), sampleRate=16000, resampleQuality=4)()
    load_sec = time.perf_counter() - t0

    t = time.perf_counter()
    embedding_model = es.TensorflowPredictMusiCNN(
        graphFilename=str(musicnn_path),
        output="model/dense/BiasAdd",
    )
    embeddings = embedding_model(audio_16k)
    embeddings_sec = time.perf_counter() - t

    classifiers = {}
    classify_total = 0.0
    errors = {}
    for name in classifier_names:
        spec = MSD_CLASSIFIERS.get(name)
        if not spec:
            errors[name] = "unknown classifier"
            continue
        try:
            model_path = ensure_model(spec["filename"], spec["url"])
            t = time.perf_counter()
            classifier = es.TensorflowPredict2D(
                graphFilename=str(model_path),
                input=spec.get("input", "model/Placeholder"),
                output=spec.get("output", "model/Softmax"),
            )
            predictions = classifier(embeddings)
            elapsed = time.perf_counter() - t
            classify_total += elapsed
            points = timestamped_predictions(predictions, duration, spec["classes"])
            classifiers[name] = {
                "classes": spec["classes"],
                "points": points,
                "summary": summarize_points(points, spec["classes"]),
                "timing_sec": round(elapsed, 3),
                "section_fields": spec.get("section_fields", {}),
            }
        except Exception as exc:
            errors[name] = str(exc)

    result = {
        "classifiers": classifiers,
        "timings": {
            "ml_load_sec": round(load_sec, 3),
            "ml_embeddings_sec": round(embeddings_sec, 3),
            "ml_classifiers_sec": round(classify_total, 3),
            "ml_total_sec": round(load_sec + embeddings_sec + classify_total, 3),
        },
    }
    if errors:
        result["errors"] = errors
    return result


def analyze_file(path: Path, classifier_names=None, include_curve: bool = True, include_tonal: bool = False):
    es = require_essentia()
    timings = {}
    t0 = time.perf_counter()

    audio = es.MonoLoader(filename=str(path), sampleRate=44100, resampleQuality=4)()
    timings["load_sec"] = time.perf_counter() - t0
    duration = len(audio) / 44100.0

    t = time.perf_counter()
    rhythm = es.RhythmExtractor2013(method="multifeature")(audio)
    bpm = float(rhythm[0])
    beats = [float(x) for x in rhythm[1]]
    timings["rhythm_sec"] = time.perf_counter() - t

    t = time.perf_counter()
    key_data = es.KeyExtractor()(audio)
    timings["key_sec"] = time.perf_counter() - t

    frame_size = 2048
    hop_size = 1024
    window = es.Windowing(type="hann")
    spectrum = es.Spectrum()
    mfcc = es.MFCC()
    rms_alg = es.RMS()
    centroid_alg = es.Centroid(range=22050)
    spectral_peaks = es.SpectralPeaks(
        minFrequency=40,
        maxFrequency=5000,
        maxPeaks=80,
        orderBy="magnitude",
        sampleRate=44100,
    ) if include_tonal else None
    hpcp_alg = es.HPCP(
        size=36,
        referenceFrequency=440,
        harmonics=8,
        sampleRate=44100,
    ) if include_tonal else None

    frame_times = []
    loudness = []
    flux = []
    centroid = []
    hpcps = []
    mfccs = []
    prev_spec = None

    t = time.perf_counter()
    for idx, frame in enumerate(es.FrameGenerator(audio, frameSize=frame_size, hopSize=hop_size, startFromZero=True)):
        spec = spectrum(window(frame))
        frame_times.append((idx * hop_size) / 44100.0)
        rms = float(rms_alg(frame))
        loudness.append(20.0 * math.log10(rms + 1e-6))
        centroid.append(float(centroid_alg(spec)))
        if include_tonal:
            try:
                freqs, mags = spectral_peaks(spec)
                hpcps.append([float(x) for x in hpcp_alg(freqs, mags)])
            except Exception:
                hpcps.append([])

        if prev_spec is None:
            flux.append(0.0)
        else:
            total = 0.0
            for cur, prev in zip(spec, prev_spec):
                diff = cur - prev
                if diff > 0:
                    total += float(diff)
            flux.append(total)
        prev_spec = list(spec)

        try:
            mfcc_bands, mfcc_coeffs = mfcc(spec)
            mfccs.append([float(x) for x in mfcc_coeffs])
        except Exception:
            mfccs.append([])

    timings["frames_sec"] = time.perf_counter() - t

    t = time.perf_counter()
    tonal_by_second = []
    if include_tonal:
        bins = max(1, math.ceil(duration))
        hpcp_bins = [[] for _ in range(bins)]
        for i, ts in enumerate(frame_times):
            if i >= len(hpcps) or not hpcps[i]:
                continue
            b = min(bins - 1, int(ts))
            hpcp_bins[b].append(hpcps[i])

        for hbin in hpcp_bins:
            if not hbin:
                tonal_by_second.append({
                    "hpcp": [],
                    "clarity": 0.0,
                })
                continue
            mean_hpcp = [sum(v[i] for v in hbin) / len(hbin) for i in range(len(hbin[0]))]
            norm_hpcp = normalize_vector(mean_hpcp)
            tonal_by_second.append({
                "hpcp": norm_hpcp,
                "clarity": max(norm_hpcp) if norm_hpcp else 0.0,
            })
    if include_tonal:
        timings["tonal_sec"] = time.perf_counter() - t

    # Simple one-second aggregates, enough for first timing/quality checks.
    bins = max(1, math.ceil(duration))
    loud_bins = [[] for _ in range(bins)]
    flux_bins = [[] for _ in range(bins)]
    centroid_bins = [[] for _ in range(bins)]
    for i, ts in enumerate(frame_times):
        b = min(bins - 1, int(ts))
        loud_bins[b].append(loudness[i])
        flux_bins[b].append(flux[i])
        centroid_bins[b].append(centroid[i])

    loud_curve = [round(median(v), 3) for v in loud_bins]
    flux_curve = [round(median(v), 6) for v in flux_bins]
    centroid_curve = [round(median(v), 2) for v in centroid_bins]

    # Rough boundaries for the probe: large flux or loudness changes.
    flux_med = median(flux_curve)
    loud_med = median(loud_curve)
    boundaries = [0.0]
    last = 0
    for i in range(4, bins - 4):
        local_flux = flux_curve[i]
        loud_delta = loud_curve[i] - loud_curve[max(0, i - 3)]
        if i - last >= 8 and (local_flux > flux_med * 2.0 or abs(loud_delta) >= 4.5):
            boundaries.append(float(i))
            last = i
    if duration - boundaries[-1] > 1:
        boundaries.append(round(duration, 2))

    sections = []
    for start, end in zip(boundaries, boundaries[1:]):
        s = int(max(0, math.floor(start)))
        e = int(min(len(loud_curve), math.ceil(end)))
        sections.append({
            "start": round(start, 2),
            "end": round(end, 2),
            "avgLoudness": round(median(loud_curve[s:e]), 2),
            "avgFlux": round(median(flux_curve[s:e]), 6),
            "avgCentroid": round(median(centroid_curve[s:e]), 2),
        })

    if include_tonal and tonal_by_second:
        for section in sections:
            s = int(max(0, math.floor(section["start"])))
            e = int(min(len(tonal_by_second), math.ceil(section["end"])))
            slice_rows = [row for row in tonal_by_second[s:e] if row.get("hpcp")]
            if not slice_rows:
                section.update({
                    "sectionKey": None,
                    "sectionScale": None,
                    "harmonicStrength": 0.0,
                    "harmonicClarity": 0.0,
                    "harmonicStability": 0.0,
                })
                continue
            hpcp_size = len(slice_rows[0]["hpcp"])
            mean_hpcp = [sum(row["hpcp"][i] for row in slice_rows) / len(slice_rows) for i in range(hpcp_size)]
            norm_hpcp = normalize_vector(mean_hpcp)
            key, scale, strength = extract_section_key(es, audio, section["start"], section["end"])
            section["sectionKey"] = key
            section["sectionScale"] = scale
            section["harmonicStrength"] = round(strength, 4)
            section["harmonicClarity"] = round(max(norm_hpcp) if norm_hpcp else 0.0, 4)
            section["harmonicStability"] = round(
                sum(cosine_similarity(row["hpcp"], norm_hpcp) for row in slice_rows) / len(slice_rows),
                4,
            )

    timings["total_sec"] = time.perf_counter() - t0

    classifier_names = classifier_names or []
    ml_result = None
    if classifier_names:
        ml_result = analyze_msd_classifiers(path, duration, classifier_names)
        for classifier in ml_result.get("classifiers", {}).values():
            points = classifier["points"]
            for section in sections:
                for class_name, field_name in classifier.get("section_fields", {}).items():
                    section[field_name] = avg_class_for_section(
                        points,
                        class_name,
                        section["start"],
                        section["end"],
                    )

    result = {
        "file": str(path),
        "duration": round(duration, 2),
        "bpm": round(bpm, 2),
        "key": key_data[0],
        "scale": key_data[1],
        "beats": len(beats),
        "beatPeaks": [round(x, 3) for x in beats],
        "sections": sections,
        "timings": {k: round(v, 3) for k, v in timings.items()},
    }
    if ml_result:
        for name, classifier in ml_result.get("classifiers", {}).items():
            result[name] = classifier["summary"]
            if include_curve:
                result[f"{name}Curve"] = classifier["points"]
        if ml_result.get("errors"):
            result["classifierErrors"] = ml_result["errors"]
        result["timings"].update(ml_result["timings"])
        result["timings"]["total_with_ml_sec"] = round(
            result["timings"]["total_sec"] + ml_result["timings"]["ml_total_sec"],
            3,
        )
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--video-id", help="YouTube video id to download and analyze")
    parser.add_argument("--file", help="Local audio file to analyze")
    parser.add_argument("--voice", action="store_true", help="Run Essentia voice/instrumental classifier")
    parser.add_argument("--extras", action="store_true", help="Run extra MusiCNN classifiers: danceability, moods, loop role")
    parser.add_argument("--tonal", action="store_true", help="Run section-level HPCP/key/harmonic stability analysis")
    parser.add_argument("--classifiers", help="Comma-separated classifier names to run")
    parser.add_argument("--compact", action="store_true", help="Omit full classifier curves from JSON output")
    args = parser.parse_args()

    if not args.video_id and not args.file:
        parser.error("Provide --video-id or --file")

    with tempfile.TemporaryDirectory(prefix="deep-shadow-") as td:
        temp_dir = Path(td)
        audio_path = Path(args.file).expanduser().resolve() if args.file else download_audio(args.video_id, temp_dir)
        classifiers = []
        if args.voice:
            classifiers.append("voice_instrumental")
        if args.extras:
            classifiers.extend(DEFAULT_EXTRA_CLASSIFIERS)
        if args.classifiers:
            classifiers.extend([c.strip() for c in args.classifiers.split(",") if c.strip()])
        classifiers = list(dict.fromkeys(classifiers))
        result = analyze_file(
            audio_path,
            classifier_names=classifiers,
            include_curve=not args.compact,
            include_tonal=args.tonal,
        )
        print(json.dumps(result, indent=2))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(json.dumps({"error": str(exc), "type": exc.__class__.__name__}, indent=2), file=sys.stderr)
        sys.exit(1)
