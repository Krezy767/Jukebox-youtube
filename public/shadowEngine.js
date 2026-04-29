// Shadow Engine — Essentia-first music information retrieval module.
// Philosophy: Essentia measures (timestamps, curves, cluster IDs).
// Gemini names (verse/chorus/drop). Never ask Gemini for timestamps.
//
// Consumers: pro_dj_lab.html (lab), player.html (prod).
// Expects CDN-loaded globals: window.EssentiaWASM, window.Essentia
//   <script src="https://cdn.jsdelivr.net/npm/essentia.js@0.1.3/dist/essentia-wasm.web.js"></script>
//   <script src="https://cdn.jsdelivr.net/npm/essentia.js@0.1.3/dist/essentia.js-core.js"></script>

(function (global) {
    'use strict';

    let essentia = null;
    const FRAME_SIZE = 2048;
    const HOP_SIZE = 1024;

    async function ensureEssentia() {
        if (essentia) return essentia;
        if (typeof global.EssentiaWASM !== 'function') throw new Error('EssentiaWASM not loaded');
        if (typeof global.Essentia !== 'function') throw new Error('Essentia not loaded');
        const wasmOptions = {};
        const explicitWasmUrl = global.__ESSENTIA_WASM_URL__;
        if (explicitWasmUrl) {
            wasmOptions.locateFile = (path) => {
                if (typeof path === 'string' && path.endsWith('.wasm')) return explicitWasmUrl;
                return path;
            };
        }
        const wasm = await global.EssentiaWASM(wasmOptions);
        essentia = new global.Essentia(wasm);
        return essentia;
    }

    // ======== SCALAR FEATURES (Shadow v2.5 — preserved from test_shadow.html) ========
    function computeScalars(e, data, sr) {
        const out = {
            bpm: null, firstBeatOffset: 0, key: null, scale: null,
            danceability: null, physicalEnergy: null, inharmonicity: null,
            valence: null, loudnessGain: null, beatPeaks: []
        };

        try {
            // BPM consensus — RhythmExtractor at 20/50/80% slices, median wins.
            const sliceLen = Math.min(10 * sr, Math.floor(data.length / 3));
            const bpms = [];
            let allTicks = [];
            for (const pos of [0.2, 0.5, 0.8]) {
                const start = Math.floor(pos * data.length);
                const slice = data.slice(start, start + sliceLen);
                if (slice.length < sr) continue;
                const vec = e.arrayToVector(slice);
                try {
                    const res = e.RhythmExtractor(vec);
                    bpms.push(res.bpm);
                    const ticks = e.vectorToArray(res.ticks).map(t => t + start / sr);
                    allTicks = allTicks.concat(ticks);
                } catch (err) { console.warn('RhythmExtractor slice failed:', err.message); }
                vec.delete();
            }
            if (bpms.length) {
                bpms.sort((a, b) => a - b);
                let bpm = bpms[Math.floor(bpms.length / 2)];
                if (bpm < 70) bpm *= 2;
                if (bpm > 165) bpm /= 2;
                out.bpm = Math.round(bpm);
            }

            // Beat peaks over the whole track — one pass, needed for phrase counting.
            try {
                const fullVec = e.arrayToVector(data);
                const fullRhythm = e.RhythmExtractor(fullVec);
                out.beatPeaks = e.vectorToArray(fullRhythm.ticks);
                fullVec.delete();
            } catch (err) {
                console.warn('Full-track RhythmExtractor failed, falling back to slice ticks:', err.message);
                out.beatPeaks = allTicks.sort((a, b) => a - b);
            }

            // First beat offset from the first 12s.
            try {
                const introSlice = data.slice(0, Math.min(12 * sr, data.length));
                const iv = e.arrayToVector(introSlice);
                const introRes = e.RhythmExtractor(iv);
                const introTicks = e.vectorToArray(introRes.ticks);
                out.firstBeatOffset = introTicks[0] || 0;
                iv.delete();
            } catch (err) { console.warn('First-beat extraction failed:', err.message); }

            // Key + danceability + RMS — single 40s deep-scan slice from mid-track.
            const scanStart = Math.min(Math.floor(30 * sr), Math.floor(data.length * 0.3));
            const scanLen = Math.min(40 * sr, data.length - scanStart);
            const deepSlice = data.slice(scanStart, scanStart + scanLen);
            const dv = e.arrayToVector(deepSlice);

            try {
                const keyData = e.KeyExtractor(dv);
                out.key = keyData.key;
                out.scale = keyData.scale;
            } catch (err) { console.warn('KeyExtractor failed:', err.message); }

            let rmsVal = 0;
            try {
                const rms = e.RMS(dv);
                rmsVal = rms.rms;
            } catch (err) { console.warn('RMS failed:', err.message); }

            let danceVal = null;
            try {
                const danceData = e.Danceability(dv);
                danceVal = danceData.danceability;
                out.danceability = Number(danceVal.toFixed(2));
            } catch (err) { console.warn('Danceability failed:', err.message); }

            // Inharmonicity — 5 frames averaged via Windowing→Spectrum→SpectralPeaks→Inharmonicity.
            let totalInharm = 0, framesDone = 0;
            for (let i = 0; i < 5; i++) {
                const off = Math.floor((deepSlice.length / 5) * i);
                const frame = deepSlice.slice(off, off + FRAME_SIZE);
                if (frame.length < FRAME_SIZE) continue;
                let fv, win, spec, pk;
                try {
                    fv = e.arrayToVector(frame);
                    win = e.Windowing(fv).frame;
                    spec = e.Spectrum(win).spectrum;
                    pk = e.SpectralPeaks(spec, -50, 5000, 50, 20, 'frequency', sr);
                    if (pk && pk.frequencies && pk.frequencies.size() >= 2) {
                        const inh = e.Inharmonicity(pk.frequencies, pk.magnitudes);
                        totalInharm += inh.inharmonicity;
                        framesDone++;
                    }
                } catch (err) {
                    // Noise floor frames routinely throw; safe to skip.
                } finally {
                    try { fv && fv.delete(); } catch (_) {}
                    try { win && win.delete(); } catch (_) {}
                    try { spec && spec.delete(); } catch (_) {}
                    try { pk && pk.frequencies && pk.frequencies.delete(); } catch (_) {}
                    try { pk && pk.magnitudes && pk.magnitudes.delete(); } catch (_) {}
                }
            }
            const avgInharm = framesDone > 0 ? totalInharm / framesDone : 0.1;
            out.inharmonicity = Number(avgInharm.toFixed(3));
            out.physicalEnergy = Number((rmsVal * 5.0 * (1.0 - avgInharm * 0.3)).toFixed(2));

            // Valence — major→0.7, minor→0.3, +0.2 if danceable.
            if (out.scale) {
                let v = out.scale === 'major' ? 0.70 : 0.30;
                if (danceVal != null && danceVal > 2.0) v += 0.20;
                out.valence = Number(Math.min(0.98, v).toFixed(2));
            }

            // Loudness gain — peak normalization target 0.7.
            let peak = 0;
            for (let i = 0; i < deepSlice.length; i++) {
                const a = Math.abs(deepSlice[i]);
                if (a > peak) peak = a;
            }
            out.loudnessGain = Number((0.7 / (peak || 0.01)).toFixed(2));

            dv.delete();
        } catch (err) {
            console.error('computeScalars fatal:', err);
        }

        return out;
    }

    // ======== FRAME-LEVEL PASS ========
    function makeBandAccumulator() {
        return {
            sub: 0, bass: 0, lowMid: 0, mid: 0, vocal: 0,
            presence: 0, high: 0, total: 0
        };
    }

    function pitchClassFromFrequency(freq) {
        if (!Number.isFinite(freq) || freq < 40) return -1;
        const midi = Math.round(69 + 12 * Math.log2(freq / 440));
        return ((midi % 12) + 12) % 12;
    }

    function cosineSim(a, b) {
        let dot = 0, na = 0, nb = 0;
        const len = Math.min(a.length, b.length);
        for (let i = 0; i < len; i++) {
            dot += a[i] * b[i];
            na += a[i] * a[i];
            nb += b[i] * b[i];
        }
        const denom = Math.sqrt(na) * Math.sqrt(nb);
        return denom > 0 ? dot / denom : 0;
    }

    // One traversal of the audio producing per-frame RMS, spectral flux, MFCC,
    // frequency-band energy, spectral centroid, and chroma. The section brain
    // aggregates these into DJ-useful cues: bass weight, vocal-range density,
    // brightness, harmonic clarity, and harmonic stability.
    // Everything else (loudness curve, novelty curve, onset rate, sections)
    // is aggregated from these frames.
    function computeFrameFeatures(e, data, sr) {
        const frameCount = Math.floor((data.length - FRAME_SIZE) / HOP_SIZE) + 1;
        const frameTimes = new Float32Array(frameCount);
        const rmsFrames = new Float32Array(frameCount);
        const fluxFrames = new Float32Array(frameCount);
        const centroidFrames = new Float32Array(frameCount);
        const bassRatioFrames = new Float32Array(frameCount);
        const lowRatioFrames = new Float32Array(frameCount);
        const midRatioFrames = new Float32Array(frameCount);
        const vocalRatioFrames = new Float32Array(frameCount);
        const presenceRatioFrames = new Float32Array(frameCount);
        const highRatioFrames = new Float32Array(frameCount);
        const chromaFrames = [];
        const mfccFrames = [];          // array of Float32Array(13) or null on failure

        let prevMag = null;
        let binHz = null;

        for (let f = 0; f < frameCount; f++) {
            const start = f * HOP_SIZE;
            frameTimes[f] = start / sr;
            const frame = data.slice(start, start + FRAME_SIZE);

            let fv, win, spec, magVec, mfccRes;
            try {
                fv = e.arrayToVector(frame);

                // RMS per frame
                try {
                    const r = e.RMS(fv);
                    rmsFrames[f] = r.rms;
                } catch (_) { rmsFrames[f] = 0; }

                // Windowing + Spectrum
                win = e.Windowing(fv).frame;
                spec = e.Spectrum(win).spectrum;
                const mag = e.vectorToArray(spec);
                if (!binHz && mag.length > 1) binHz = (sr / 2) / (mag.length - 1);

                const bands = makeBandAccumulator();
                const chroma = new Float32Array(12);
                let weightedFreq = 0;
                let weightedMag = 0;
                for (let i = 1; i < mag.length; i++) {
                    const freq = i * (binHz || 0);
                    if (!freq || freq > 16000) continue;
                    const energy = mag[i] * mag[i];
                    bands.total += energy;
                    if (freq < 60) bands.sub += energy;
                    if (freq >= 60 && freq < 250) bands.bass += energy;
                    if (freq >= 250 && freq < 500) bands.lowMid += energy;
                    if (freq >= 500 && freq < 2000) bands.mid += energy;
                    if (freq >= 300 && freq < 3400) bands.vocal += energy;
                    if (freq >= 2000 && freq < 5000) bands.presence += energy;
                    if (freq >= 5000 && freq < 12000) bands.high += energy;
                    weightedFreq += freq * mag[i];
                    weightedMag += mag[i];

                    if (freq >= 65 && freq <= 5000) {
                        const pc = pitchClassFromFrequency(freq);
                        if (pc >= 0) chroma[pc] += energy;
                    }
                }
                const total = bands.total || 1e-9;
                centroidFrames[f] = weightedMag > 0 ? weightedFreq / weightedMag : 0;
                bassRatioFrames[f] = (bands.sub + bands.bass) / total;
                lowRatioFrames[f] = (bands.sub + bands.bass + bands.lowMid) / total;
                midRatioFrames[f] = (bands.lowMid + bands.mid) / total;
                vocalRatioFrames[f] = bands.vocal / total;
                presenceRatioFrames[f] = bands.presence / total;
                highRatioFrames[f] = bands.high / total;
                chromaFrames.push(chroma);

                // Spectral flux = sum of positive mag differences vs. previous frame.
                if (prevMag && prevMag.length === mag.length) {
                    let flux = 0;
                    for (let i = 0; i < mag.length; i++) {
                        const d = mag[i] - prevMag[i];
                        if (d > 0) flux += d;
                    }
                    fluxFrames[f] = flux;
                }
                prevMag = mag;

                // MFCC per frame (13 coefficients). Skipped per-frame failures leave a null.
                try {
                    mfccRes = e.MFCC(spec);
                    mfccFrames.push(e.vectorToArray(mfccRes.mfcc));
                } catch (_) {
                    mfccFrames.push(null);
                }
            } catch (err) {
                chromaFrames.push(null);
                mfccFrames.push(null);
            } finally {
                try { fv && fv.delete(); } catch (_) {}
                try { win && win.delete(); } catch (_) {}
                try { spec && spec.delete(); } catch (_) {}
                try { mfccRes && mfccRes.mfcc && mfccRes.mfcc.delete(); } catch (_) {}
                try { mfccRes && mfccRes.bands && mfccRes.bands.delete(); } catch (_) {}
            }
        }

        return {
            frameTimes, rmsFrames, fluxFrames, mfccFrames,
            centroidFrames, bassRatioFrames, lowRatioFrames, midRatioFrames,
            vocalRatioFrames, presenceRatioFrames, highRatioFrames, chromaFrames,
            hopSec: HOP_SIZE / sr
        };
    }

    // ======== TIME-VARYING CURVES ========
    // Loudness curve — bin frame RMS into 1s windows, convert to rough "loudness" (log scale).
    function buildLoudnessCurve(frameTimes, rmsFrames, binSec = 1.0) {
        const duration = frameTimes[frameTimes.length - 1] || 0;
        const bins = Math.ceil(duration / binSec) || 1;
        const curve = new Float32Array(bins);
        const counts = new Uint32Array(bins);
        for (let f = 0; f < rmsFrames.length; f++) {
            const b = Math.min(bins - 1, Math.floor(frameTimes[f] / binSec));
            curve[b] += rmsFrames[f];
            counts[b]++;
        }
        for (let b = 0; b < bins; b++) {
            const avg = counts[b] ? curve[b] / counts[b] : 0;
            curve[b] = 20 * Math.log10(avg + 1e-6); // dBFS-ish
        }
        return { values: Array.from(curve), binSec };
    }

    // Novelty curve — smoothed spectral flux. Peaks mark section boundaries.
    function buildNoveltyCurve(fluxFrames, hopSec, smoothWindow = 11) {
        const n = fluxFrames.length;
        const smoothed = new Float32Array(n);
        const half = Math.floor(smoothWindow / 2);
        for (let i = 0; i < n; i++) {
            let sum = 0, count = 0;
            for (let j = Math.max(0, i - half); j <= Math.min(n - 1, i + half); j++) {
                sum += fluxFrames[j]; count++;
            }
            smoothed[i] = count ? sum / count : 0;
        }
        return { values: Array.from(smoothed), hopSec };
    }

    // Onset rate curve — approximate onsets as local maxima of spectral flux;
    // count them per binSec-second window.
    function buildOnsetRateCurve(fluxFrames, hopSec, binSec = 2.0) {
        const n = fluxFrames.length;
        // Adaptive threshold: mean + 0.5 * std.
        let mean = 0;
        for (let i = 0; i < n; i++) mean += fluxFrames[i];
        mean /= Math.max(1, n);
        let variance = 0;
        for (let i = 0; i < n; i++) variance += (fluxFrames[i] - mean) ** 2;
        const std = Math.sqrt(variance / Math.max(1, n));
        const thr = mean + 0.5 * std;

        const onsetTimes = [];
        for (let i = 1; i < n - 1; i++) {
            if (fluxFrames[i] > thr && fluxFrames[i] >= fluxFrames[i - 1] && fluxFrames[i] >= fluxFrames[i + 1]) {
                onsetTimes.push(i * hopSec);
            }
        }

        const duration = n * hopSec;
        const bins = Math.ceil(duration / binSec) || 1;
        const counts = new Float32Array(bins);
        for (const t of onsetTimes) {
            const b = Math.min(bins - 1, Math.floor(t / binSec));
            counts[b]++;
        }
        // Onsets per second, not per bin.
        for (let b = 0; b < bins; b++) counts[b] /= binSec;
        return { values: Array.from(counts), binSec, onsetTimes };
    }

    // ======== LOUDNESS-JUMP BOUNDARIES ========
    // NoveltyCurve is great at detecting timbral change (instruments come in/out,
    // harmony changes). But it can MISS boundaries where a quiet sustained sound
    // (solo piano) explodes into a full band — the novelty is one sharp spike
    // smoothed into the surrounding high-flux region. Loudness delta catches it:
    // wherever the dB curve rises >= minDeltaDb over a few seconds, that's a
    // section boundary regardless of timbral similarity.
    //
    // Returns boundary timestamps (seconds).
    function findLoudnessJumpBoundaries(loudnessCurve, minDeltaDb = 6.0, winSec = 3.0) {
        const { values, binSec } = loudnessCurve;
        const winBins = Math.max(1, Math.round(winSec / binSec));
        const boundaries = [];
        for (let i = winBins; i < values.length - winBins; i++) {
            let before = 0, after = 0;
            for (let j = i - winBins; j < i; j++) before += values[j];
            for (let j = i; j < i + winBins; j++) after += values[j];
            before /= winBins; after /= winBins;
            const delta = after - before;
            if (delta >= minDeltaDb) {
                // Only keep local maxima of delta (avoids multiple boundaries on a gradual rise).
                const t = i * binSec;
                if (!boundaries.length || t - boundaries[boundaries.length - 1].t >= winSec) {
                    boundaries.push({ t, delta });
                } else if (delta > boundaries[boundaries.length - 1].delta) {
                    boundaries[boundaries.length - 1] = { t, delta };
                }
            }
        }
        return boundaries.map(b => b.t);
    }

    // Merge boundary lists — dedup anything within mergeWithinSec.
    function mergeBoundaries(lists, duration, mergeWithinSec = 4.0) {
        const all = [];
        for (const list of lists) for (const t of list) all.push(t);
        all.push(0, duration);
        all.sort((a, b) => a - b);
        const out = [];
        for (const t of all) {
            if (!out.length || t - out[out.length - 1] >= mergeWithinSec) out.push(t);
        }
        return Array.from(new Set(out.map(t => Number(t.toFixed(2))))).sort((a, b) => a - b);
    }

    // ======== SECTION BOUNDARIES (peak-pick novelty) ========
    function peakPickNovelty(noveltyValues, hopSec, duration, minSegmentSec = 8.0) {
        const n = noveltyValues.length;
        if (!n) return [0, duration];

        // Adaptive threshold via rolling median + offset.
        let mean = 0;
        for (let i = 0; i < n; i++) mean += noveltyValues[i];
        mean /= n;
        let variance = 0;
        for (let i = 0; i < n; i++) variance += (noveltyValues[i] - mean) ** 2;
        const std = Math.sqrt(variance / n);
        const thr = mean + 1.2 * std;

        const minSepFrames = Math.floor(minSegmentSec / hopSec);
        const peaks = [];
        let lastPeak = -minSepFrames;
        for (let i = 2; i < n - 2; i++) {
            const v = noveltyValues[i];
            if (v < thr) continue;
            if (v >= noveltyValues[i - 1] && v >= noveltyValues[i - 2] &&
                v >= noveltyValues[i + 1] && v >= noveltyValues[i + 2] &&
                i - lastPeak >= minSepFrames) {
                peaks.push(i * hopSec);
                lastPeak = i;
            }
        }

        // Enforce tiling: start at 0, end at duration, unique sorted.
        const boundaries = [0, ...peaks.filter(t => t > 0.5 && t < duration - 0.5), duration];
        return Array.from(new Set(boundaries.map(t => Number(t.toFixed(2))))).sort((a, b) => a - b);
    }

    // ======== PER-SECTION FEATURES + CLUSTERING ========
    function buildSections(boundaries, loudnessCurve, onsetRateCurve, frameData) {
        const {
            frameTimes, fluxFrames, mfccFrames, centroidFrames, bassRatioFrames,
            lowRatioFrames, midRatioFrames, vocalRatioFrames, presenceRatioFrames,
            highRatioFrames, chromaFrames
        } = frameData;
        const sections = [];
        for (let s = 0; s < boundaries.length - 1; s++) {
            const start = boundaries[s];
            const end = boundaries[s + 1];

            // Aggregate loudness over the section.
            const loudStartIdx = Math.floor(start / loudnessCurve.binSec);
            const loudEndIdx = Math.min(loudnessCurve.values.length, Math.ceil(end / loudnessCurve.binSec));
            let loudSum = 0, loudCount = 0;
            for (let i = loudStartIdx; i < loudEndIdx; i++) { loudSum += loudnessCurve.values[i]; loudCount++; }
            const avgLoudness = loudCount ? loudSum / loudCount : 0;

            // Aggregate onset rate.
            const orStartIdx = Math.floor(start / onsetRateCurve.binSec);
            const orEndIdx = Math.min(onsetRateCurve.values.length, Math.ceil(end / onsetRateCurve.binSec));
            let orSum = 0, orCount = 0;
            for (let i = orStartIdx; i < orEndIdx; i++) { orSum += onsetRateCurve.values[i]; orCount++; }
            const avgOnsetRate = orCount ? orSum / orCount : 0;

            // Frame-derived section profile.
            let mfccSum = null, mfccCount = 0;
            const chromaSum = new Float32Array(12);
            const chromaList = [];
            let chromaCount = 0;
            let centroidSum = 0, bassSum = 0, lowSum = 0, midSum = 0, vocalSum = 0, presenceSum = 0, highSum = 0, fluxSum = 0, frameCount = 0;
            for (let f = 0; f < frameTimes.length; f++) {
                const t = frameTimes[f];
                if (t < start) continue;
                if (t >= end) break;
                centroidSum += centroidFrames[f] || 0;
                bassSum += bassRatioFrames[f] || 0;
                lowSum += lowRatioFrames[f] || 0;
                midSum += midRatioFrames[f] || 0;
                vocalSum += vocalRatioFrames[f] || 0;
                presenceSum += presenceRatioFrames[f] || 0;
                highSum += highRatioFrames[f] || 0;
                fluxSum += fluxFrames[f] || 0;
                frameCount++;

                const c = chromaFrames[f];
                if (c) {
                    let cTotal = 0;
                    for (let i = 0; i < 12; i++) cTotal += c[i];
                    if (cTotal > 1e-9) {
                        const norm = new Float32Array(12);
                        for (let i = 0; i < 12; i++) {
                            norm[i] = c[i] / cTotal;
                            chromaSum[i] += norm[i];
                        }
                        chromaList.push(norm);
                        chromaCount++;
                    }
                }

                const m = mfccFrames[f];
                if (!m) continue;
                if (!mfccSum) mfccSum = new Float32Array(m.length);
                for (let i = 0; i < m.length; i++) mfccSum[i] += m[i];
                mfccCount++;
            }
            let mfccMean = null;
            if (mfccSum && mfccCount) {
                mfccMean = new Float32Array(mfccSum.length);
                for (let i = 0; i < mfccSum.length; i++) mfccMean[i] = mfccSum[i] / mfccCount;
            }
            let chromaMean = null;
            let chromaClarity = 0;
            let chromaStability = 0;
            if (chromaCount) {
                chromaMean = new Float32Array(12);
                let peak = 0, total = 0;
                for (let i = 0; i < 12; i++) {
                    chromaMean[i] = chromaSum[i] / chromaCount;
                    total += chromaMean[i];
                    if (chromaMean[i] > peak) peak = chromaMean[i];
                }
                chromaClarity = total > 0 ? peak / total : 0;
                let stableSum = 0;
                for (const c of chromaList) stableSum += cosineSim(c, chromaMean);
                chromaStability = stableSum / chromaList.length;
            }

            const half = Math.max(1, Math.floor((loudEndIdx - loudStartIdx) / 2));
            let earlySum = 0, earlyCount = 0, lateSum = 0, lateCount = 0;
            for (let i = loudStartIdx; i < loudEndIdx; i++) {
                if (i < loudStartIdx + half) { earlySum += loudnessCurve.values[i]; earlyCount++; }
                else { lateSum += loudnessCurve.values[i]; lateCount++; }
            }
            const energyTrendDb = (earlyCount && lateCount)
                ? (lateSum / lateCount) - (earlySum / earlyCount)
                : 0;

            sections.push({
                start: Number(start.toFixed(2)),
                end: Number(end.toFixed(2)),
                avgLoudness: Number(avgLoudness.toFixed(2)),
                avgOnsetRate: Number(avgOnsetRate.toFixed(2)),
                avgFlux: Number(((frameCount ? fluxSum / frameCount : 0)).toFixed(4)),
                avgCentroid: Number(((frameCount ? centroidSum / frameCount : 0)).toFixed(0)),
                avgBassRatio: Number(((frameCount ? bassSum / frameCount : 0)).toFixed(3)),
                avgLowRatio: Number(((frameCount ? lowSum / frameCount : 0)).toFixed(3)),
                avgMidRatio: Number(((frameCount ? midSum / frameCount : 0)).toFixed(3)),
                avgVocalRatio: Number(((frameCount ? vocalSum / frameCount : 0)).toFixed(3)),
                avgPresenceRatio: Number(((frameCount ? presenceSum / frameCount : 0)).toFixed(3)),
                avgHighRatio: Number(((frameCount ? highSum / frameCount : 0)).toFixed(3)),
                chromaClarity: Number(chromaClarity.toFixed(3)),
                chromaStability: Number(chromaStability.toFixed(3)),
                energyTrendDb: Number(energyTrendDb.toFixed(2)),
                _mfcc: mfccMean,   // internal, stripped before return
                _chroma: chromaMean,
                clusterId: null,   // filled below
                label: null        // Gemini fills this later
            });
        }

        // Cluster by MFCC cosine similarity — greedy single-link at threshold 0.92.
        const SIM_THR = 0.92;
        const centroids = [];
        for (const sec of sections) {
            if (!sec._mfcc) { sec.clusterId = 'X'; continue; }
            let bestId = -1, bestSim = -1;
            for (let c = 0; c < centroids.length; c++) {
                const sim = cosineSim(sec._mfcc, centroids[c].centroid);
                if (sim > bestSim) { bestSim = sim; bestId = c; }
            }
            if (bestSim >= SIM_THR && bestId >= 0) {
                // Update centroid running mean.
                const ct = centroids[bestId];
                for (let i = 0; i < ct.centroid.length; i++) {
                    ct.centroid[i] = (ct.centroid[i] * ct.count + sec._mfcc[i]) / (ct.count + 1);
                }
                ct.count++;
                sec.clusterId = String.fromCharCode(65 + bestId); // A,B,C…
            } else {
                centroids.push({ centroid: Float32Array.from(sec._mfcc), count: 1 });
                sec.clusterId = String.fromCharCode(65 + centroids.length - 1);
            }
            delete sec._mfcc;
            delete sec._chroma;
        }

        return sections;
    }

    // ======== DROP + OUTRO DERIVATION (from section-to-section loudness deltas) ========
    // A drop is NOT "the loudest section" — it's the transition POINT where the
    // track jumps from quieter to louder. For Runaway-style songs, the first
    // drop (piano intro → drums) has the biggest Δdb in the whole track even
    // though later sections are absolutely louder.
    //
    // Returns an array of boundary timestamps sorted by time, filtered to
    // transitions where Δ = after.avgLoudness - before.avgLoudness > minDeltaDb.
    function deriveDrops(sections, minDeltaDb = 5.0) {
        if (!sections || sections.length < 2) return [];
        const drops = [];
        for (let i = 1; i < sections.length; i++) {
            const delta = sections[i].avgLoudness - sections[i - 1].avgLoudness;
            if (delta >= minDeltaDb) {
                drops.push({ t: sections[i].start, delta });
            }
        }
        // If nothing qualifies (uniformly loud track, e.g. constant EDM), fall
        // back to the single biggest positive delta even if below threshold.
        if (!drops.length) {
            let bestI = -1, bestDelta = -Infinity;
            for (let i = 1; i < sections.length; i++) {
                const d = sections[i].avgLoudness - sections[i - 1].avgLoudness;
                if (d > bestDelta) { bestDelta = d; bestI = i; }
            }
            if (bestI > 0 && bestDelta > 2.0) drops.push({ t: sections[bestI].start, delta: bestDelta });
        }
        return drops.sort((a, b) => a.t - b.t).map(d => d.t);
    }

    // Outro = last sustained energy drop in the track. Walk sections from the
    // back: first boundary where next section is ≥3 dB below the preceding
    // peak and stays below until the end.
    function deriveOutro(sections, duration, minDropDb = 3.0) {
        if (!sections || sections.length < 2) return duration * 0.9;
        // Find track-wide loudness median.
        const louds = sections.map(s => s.avgLoudness).sort((a, b) => a - b);
        const median = louds[Math.floor(louds.length / 2)];
        // Scan from back: last section whose avgLoudness is median - minDropDb
        // or lower, whose start marks the outro.
        for (let i = sections.length - 1; i >= 1; i--) {
            const s = sections[i];
            const prev = sections[i - 1];
            if (prev.avgLoudness - s.avgLoudness >= minDropDb && s.avgLoudness <= median - 1) {
                return s.start;
            }
        }
        // Fallback: start of final section if it's quieter than median; else 90%.
        const last = sections[sections.length - 1];
        if (last.avgLoudness < median) return last.start;
        return duration * 0.9;
    }

    // ======== ORCHESTRATOR ========
    async function analyzePcmData(data, sampleRate, opts = {}) {
        const e = await ensureEssentia();
        const sr = sampleRate;
        const duration = data.length / sr;

        const t0 = performance.now();
        const scalars = computeScalars(e, data, sr);
        const tScalars = performance.now();

        const frameData = computeFrameFeatures(e, data, sr);
        const tFrames = performance.now();

        const loudnessCurve = buildLoudnessCurve(frameData.frameTimes, frameData.rmsFrames, 1.0);
        const noveltyCurve = buildNoveltyCurve(frameData.fluxFrames, frameData.hopSec);
        const onsetRateCurve = buildOnsetRateCurve(frameData.fluxFrames, frameData.hopSec, 2.0);

        // Boundary detection: novelty peaks + loudness-jump peaks, merged.
        // The loudness-jump detector catches sparse→dense transitions (piano
        // intro → full band) that novelty sometimes smooths away.
        const noveltyBoundaries = peakPickNovelty(noveltyCurve.values, noveltyCurve.hopSec, duration, 8.0);
        const loudnessJumpBoundaries = findLoudnessJumpBoundaries(loudnessCurve, 6.0, 3.0);
        const sectionBoundaries = mergeBoundaries([noveltyBoundaries, loudnessJumpBoundaries], duration, 4.0);

        const sections = buildSections(sectionBoundaries, loudnessCurve, onsetRateCurve, frameData);

        // Drops + outro — derived from section-to-section loudness deltas.
        // Drop = boundary where avgLoudness jumps ≥5 dB (Δ, not absolute).
        // Outro = last major sustained loudness drop.
        const drops = deriveDrops(sections, 5.0);
        const outroStart = deriveOutro(sections, duration, 3.0);

        const tSections = performance.now();

        if (opts.log) {
            console.log(
                `🕶️  Shadow Engine: scalars ${(tScalars - t0).toFixed(0)}ms, ` +
                `frames ${(tFrames - tScalars).toFixed(0)}ms, ` +
                `sections ${(tSections - tFrames).toFixed(0)}ms, ` +
                `total ${(tSections - t0).toFixed(0)}ms — ` +
                `${sections.length} sections, ${drops.length} drops (${drops.map(t => t.toFixed(1)).join(', ') || 'none'}), outro@${outroStart.toFixed(1)}s`
            );
            console.log(`   • boundaries: novelty=${noveltyBoundaries.length} loudnessJump=${loudnessJumpBoundaries.length} merged=${sectionBoundaries.length}`);
        }

        return {
            duration,
            sampleRate: sr,
            ...scalars,
            loudnessCurve,   // { values: dB[], binSec: 1.0 }
            noveltyCurve,    // { values: flux[], hopSec }
            onsetRateCurve,  // { values: onsets-per-sec[], binSec: 2.0, onsetTimes }
            sectionBoundaries,
            sections,        // [{ start, end, avgLoudness, avgOnsetRate, clusterId, label:null }]
            drops,           // [seconds] — transition points where loudness jumps ≥5 dB
            outroStart       // seconds — last sustained energy drop
        };
    }

    async function analyzeTrack(audioBuffer, opts = {}) {
        const data = audioBuffer.getChannelData(0);
        return analyzePcmData(data, audioBuffer.sampleRate, opts);
    }

    global.shadowEngine = {
        ensureEssentia,
        analyzePcmData,
        analyzeTrack,
        // Re-exported so callers can reuse without re-importing:
        _internals: { computeScalars, computeFrameFeatures, buildLoudnessCurve, buildNoveltyCurve, buildOnsetRateCurve, peakPickNovelty, buildSections }
    };
})(typeof self !== 'undefined' ? self : window);
