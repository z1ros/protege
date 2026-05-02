use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use std::io::{self, BufRead, BufReader, Read, Write};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tract_onnx::prelude::*;

/// Output WAV format: 16kHz mono 16-bit PCM (Whisper-friendly).
const OUT_RATE: u32 = 16_000;
const OUT_CHANNELS: u16 = 1;

/// VAD thresholds
/// 1400ms silence — forgiving conversational pace. Natural mid-sentence
/// pauses while thinking ("so, um, like…") can easily blow past 700ms and
/// get cut off mid-thought; 1400ms covers those without making the tail
/// feel sluggish. Still faster than Siri's ~2s. The "filler ack" plays
/// right after VAD fires, so perceived latency = silence + filler.
///
/// SPEECH_RMS bumped 2026-04-23 from 0.015 → 0.022. At 0.015, laptop-fan
/// hum, keyboard clicks, and background HVAC kept tripping the threshold
/// every second or so — so last_speech_ms kept refreshing and the 1400ms
/// silence window never accumulated. User saw "Listening" stuck for 15s+
/// because recording never auto-stopped. 0.022 clears typical room tone
/// while still catching normal speech (conversational RMS runs 0.05+).
const SPEECH_RMS: f32 = 0.022;
const SILENCE_TIMEOUT_MS: u64 = 1400;
const SPEECH_MIN_MS: u64 = 300;

/// OpenWakeWord pipeline constants
const MEL_BUF_SIZE: usize = 16;
const EMB_BUF_SIZE: usize = 16;
const SAMPLES_PER_FRAME: usize = 1280; // 80ms @ 16kHz

type TractPlan = SimplePlan<TypedFact, Box<dyn TypedOp>, Graph<TypedFact, Box<dyn TypedOp>>>;

/// Full OpenWakeWord 3-stage inference pipeline. Stateful — holds mel and
/// embedding circular buffers so streaming chunks produce continuous scores.
struct OwwPipeline {
    mel: TractPlan,
    emb: TractPlan,
    ww: TractPlan,
    mel_buffer: Vec<Vec<f32>>,
    emb_buffer: Vec<Tensor>,
}

impl OwwPipeline {
    fn load(model_path: &str) -> Self {
        let model_dir = Path::new(model_path).parent().unwrap();

        eprintln!("protege-mic: loading melspectrogram model...");
        let mel_path = model_dir.join("melspectrogram.onnx");
        let mel = tract_onnx::onnx()
            .model_for_read(&mut BufReader::new(std::fs::File::open(&mel_path).expect("melspectrogram.onnx not found")))
            .unwrap()
            .with_input_fact(0, f32::fact([1, 1280]).into()).unwrap()
            .into_optimized().unwrap()
            .into_runnable().unwrap();

        eprintln!("protege-mic: loading embedding model...");
        let emb_path = model_dir.join("embedding_model.onnx");
        let emb = tract_onnx::onnx()
            .model_for_read(&mut BufReader::new(std::fs::File::open(&emb_path).expect("embedding_model.onnx not found")))
            .unwrap()
            .with_input_fact(0, f32::fact([1, 76, 32, 1]).into()).unwrap()
            .into_optimized().unwrap()
            .into_runnable().unwrap();

        eprintln!("protege-mic: loading wake word model from {model_path}");
        let ww = tract_onnx::onnx()
            .model_for_read(&mut BufReader::new(std::fs::File::open(model_path).unwrap()))
            .unwrap()
            .into_optimized().unwrap()
            .into_runnable().unwrap();

        Self {
            mel, emb, ww,
            mel_buffer: vec![vec![0.0; 5 * 32]; MEL_BUF_SIZE],
            emb_buffer: vec![Tensor::from_shape(&[1, 1, 1, 96], &[0f32; 96]).unwrap(); EMB_BUF_SIZE],
        }
    }

    /// Run one 1280-sample chunk through mel → embedding → wake-word. Returns
    /// the raw probability (0.0–1.0), or None if the mel buffer has not yet
    /// accumulated enough history.
    fn score(&mut self, chunk: Vec<f32>) -> Option<f32> {
        let mel_input = Tensor::from_shape(&[1, 1280], &chunk).ok()?;
        let mel_out = self.mel.run(tvec!(mel_input.into())).ok()?;
        let mel_tensor = mel_out[0].clone().into_tensor();
        let mel_reshaped = mel_tensor.into_shape(&[5, 32]).ok()?;
        let mel_array = mel_reshaped.into_array::<f32>().ok()?.into_owned();
        let mel_transformed: Vec<f32> = mel_array.iter().map(|v| (v / 10.0) + 2.0).collect();

        self.mel_buffer.push(mel_transformed);
        if self.mel_buffer.len() > MEL_BUF_SIZE { self.mel_buffer.remove(0); }

        let mut stacked: Vec<f32> = Vec::with_capacity(80 * 32);
        for chunk in &self.mel_buffer { stacked.extend_from_slice(chunk); }
        if stacked.len() < 80 * 32 { return None; }
        let sliced = &stacked[4 * 32..];

        let emb_input = Tensor::from_shape(&[1, 76, 32, 1], sliced).ok()?;
        let emb_out = self.emb.run(tvec!(emb_input.into())).ok()?;
        let emb_tensor = emb_out[0].clone().into_tensor();

        self.emb_buffer.push(emb_tensor);
        if self.emb_buffer.len() > EMB_BUF_SIZE { self.emb_buffer.remove(0); }
        if self.emb_buffer.len() < EMB_BUF_SIZE { return None; }

        let stacked_emb = Tensor::stack_tensors(0, &self.emb_buffer).ok()?;
        let reshaped = stacked_emb.into_shape(&[1, EMB_BUF_SIZE, 96]).ok()?;
        let ww_out = self.ww.run(tvec!(reshaped.into())).ok()?;
        let prob = ww_out[0].clone().into_tensor()
            .cast_to::<f32>().ok()?.into_owned()
            .as_slice::<f32>().ok()?[0];
        Some(prob)
    }
}

/// Wrapper around `OwwPipeline` that adds wake-word trigger detection state:
/// rolling detections buffer, 2-frame minimum, cooldown.
struct OwwDetector {
    pipeline: OwwPipeline,
    threshold: f32,
    detections: Vec<f32>,
    cooldown_until: Instant,
}

impl OwwDetector {
    fn new(pipeline: OwwPipeline, threshold: f32) -> Self {
        Self { pipeline, threshold, detections: Vec::new(), cooldown_until: Instant::now() }
    }

    fn process(&mut self, chunk: Vec<f32>) -> bool {
        if Instant::now() < self.cooldown_until { return false; }
        let prob = match self.pipeline.score(chunk) { Some(p) => p, None => return false };

        if prob > 0.02 { eprintln!("protege-mic: prob={prob:.3}"); }

        self.detections.push(prob);
        if self.detections.len() > 12 { self.detections.remove(0); }

        let positive: Vec<f32> = self.detections.iter().copied().filter(|&p| p > self.threshold).collect();
        if positive.len() >= 2 {
            let avg = positive.iter().sum::<f32>() / positive.len() as f32;
            if avg > self.threshold {
                eprintln!("protege-mic: WAKE WORD DETECTED! avg={avg:.3} count={}", positive.len());
                self.detections.clear();
                self.cooldown_until = Instant::now() + Duration::from_secs(4);
                return true;
            }
        }
        false
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let wake_word_mode = args.iter().any(|a| a == "--wake-word");
    let model_path = args.iter()
        .position(|a| a == "--model")
        .and_then(|i| args.get(i + 1))
        .map(|s| s.to_string());
    let threshold_override = args.iter()
        .position(|a| a == "--threshold")
        .and_then(|i| args.get(i + 1))
        .and_then(|s| s.parse::<f32>().ok());
    let calibrate_path = args.iter()
        .position(|a| a == "--calibrate")
        .and_then(|i| args.get(i + 1))
        .map(|s| s.to_string());

    if let Some(wav_path) = calibrate_path {
        run_calibrate_mode(model_path, wav_path);
    } else if wake_word_mode {
        run_wake_word_mode(model_path, threshold_override);
    } else {
        run_record_mode();
    }
}

/* ================================================================
   Record mode — capture audio with VAD auto-stop (existing behavior)
   ================================================================ */

fn run_record_mode() {
    let running = Arc::new(AtomicBool::new(true));
    let r = running.clone();

    std::thread::spawn(move || {
        let mut buf = [0u8; 1];
        let _ = io::stdin().read(&mut buf);
        r.store(false, Ordering::Relaxed);
    });

    let (device, config, in_rate, in_channels) = open_mic();

    let stdout = io::stdout();
    let header_written = Arc::new(AtomicBool::new(false));
    let hw = header_written.clone();
    let running2 = running.clone();

    let ratio = OUT_RATE as f64 / in_rate as f64;
    let mut resample_pos: f64 = 0.0;

    let speech_detected = Arc::new(AtomicBool::new(false));
    let last_speech_ms = Arc::new(AtomicU64::new(0));
    let sd = speech_detected.clone();
    let lsm = last_speech_ms.clone();
    let start = Instant::now();

    let stream = device
        .build_input_stream(
            &config,
            move |data: &[f32], _: &cpal::InputCallbackInfo| {
                if !running2.load(Ordering::Relaxed) { return; }
                let mut out = stdout.lock();

                if !hw.swap(true, Ordering::Relaxed) {
                    let _ = write_wav_header(&mut out, OUT_RATE, OUT_CHANNELS);
                }

                let frames = downmix(data, in_channels);
                let rms = compute_rms(&frames);
                let now_ms = start.elapsed().as_millis() as u64;

                if rms > SPEECH_RMS {
                    sd.store(true, Ordering::Relaxed);
                    lsm.store(now_ms, Ordering::Relaxed);
                }

                resample_and_write(&frames, &mut resample_pos, ratio, &mut out);
                let _ = out.flush();
            },
            |err| { eprintln!("audio error: {err}"); std::process::exit(1); },
            None,
        )
        .expect("failed to build input stream");

    stream.play().expect("failed to start stream");

    loop {
        if !running.load(Ordering::Relaxed) { break; }
        let now_ms = start.elapsed().as_millis() as u64;
        let has_speech = speech_detected.load(Ordering::Relaxed);
        let last = last_speech_ms.load(Ordering::Relaxed);

        if has_speech && last > 0 && last >= SPEECH_MIN_MS {
            let silence = now_ms.saturating_sub(last);
            if silence >= SILENCE_TIMEOUT_MS {
                eprintln!("protege-mic: silence detected ({silence}ms), auto-stopping");
                break;
            }
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    drop(stream);
}

/* ================================================================
   Wake word mode — listen for "Protege", then record one utterance
   ================================================================ */

fn run_wake_word_mode(model_path: Option<String>, threshold_override: Option<f32>) {
    let model = model_path.unwrap_or_else(|| {
        eprintln!("protege-mic: --wake-word requires --model <path>");
        std::process::exit(1);
    });

    let running = Arc::new(AtomicBool::new(true));
    let r = running.clone();
    // Stdin control thread.
    //   EOF / empty line → shutdown (parent closed stdin).
    //   "FOLLOW_UP\n"    → manually trigger wake_detected so the extension
    //                      can auto-open the mic for a voice-dialogue
    //                      follow-up without the user saying "protege"
    //                      again. Set after the wake_detected Arc below so
    //                      we need to wire it in after its creation; for
    //                      now the Arc is captured into this thread via
    //                      the controller below (see wake_ctrl).
    let wake_ctrl = Arc::new(AtomicBool::new(false));
    let wake_ctrl_thread = wake_ctrl.clone();
    std::thread::spawn(move || {
        let stdin = io::stdin();
        let reader = BufReader::new(stdin);
        for line in reader.lines() {
            match line {
                Ok(ref s) if s.trim() == "FOLLOW_UP" => {
                    wake_ctrl_thread.store(true, Ordering::Relaxed);
                }
                Ok(_) => {}
                Err(_) => break, // read error → shutdown
            }
        }
        r.store(false, Ordering::Relaxed);
    });

    let pipeline = OwwPipeline::load(&model);

    // Default calibrated on LiveKit model 2026-04-18. Per-user calibration
    // passes `--threshold <val>` to override based on onboarding samples.
    // 0.13 is aggressive — prioritizes recall (catch quiet/tired utterances)
    // at the cost of ~1-2 false triggers/hour.
    let threshold = threshold_override.unwrap_or(0.135_f32);
    eprintln!("protege-mic: threshold={threshold:.3}");

    let detector = Arc::new(Mutex::new(OwwDetector::new(pipeline, threshold)));

    let samples_per_frame: usize = SAMPLES_PER_FRAME;

    eprintln!("protege-mic: wake word mode, listening for 'Protege'...");
    eprintln!("WAKE:ready");

    let (device, dev_config, in_rate, in_channels) = open_mic();

    let recording = Arc::new(AtomicBool::new(false));
    let wake_detected = Arc::new(AtomicBool::new(false));

    let oww_buffer: Arc<Mutex<Vec<f32>>> = Arc::new(Mutex::new(Vec::new()));

    let speech_detected = Arc::new(AtomicBool::new(false));
    let last_speech_ms = Arc::new(AtomicU64::new(0));
    let rec_start = Arc::new(Mutex::new(Instant::now()));

    let stdout = io::stdout();
    let header_written = Arc::new(AtomicBool::new(false));

    let ratio = OUT_RATE as f64 / in_rate as f64;
    let mut resample_pos: f64 = 0.0;

    let recording2 = recording.clone();
    let wake2 = wake_detected.clone();
    let oww_buf2 = oww_buffer.clone();
    let det2 = detector.clone();
    let hw2 = header_written.clone();
    let sd2 = speech_detected.clone();
    let lsm2 = last_speech_ms.clone();
    let rs2 = rec_start.clone();
    let running2 = running.clone();

    let stream = device
        .build_input_stream(
            &dev_config,
            move |data: &[f32], _: &cpal::InputCallbackInfo| {
                if !running2.load(Ordering::Relaxed) { return; }

                let frames = downmix(data, in_channels);
                let rms = compute_rms(&frames);

                if recording2.load(Ordering::Relaxed) {
                    // === Recording mode: write audio + VAD ===
                    let mut out = stdout.lock();
                    if !hw2.swap(true, Ordering::Relaxed) {
                        let _ = write_wav_header(&mut out, OUT_RATE, OUT_CHANNELS);
                    }
                    resample_and_write(&frames, &mut resample_pos, ratio, &mut out);
                    let _ = out.flush();

                    let elapsed = rs2.lock().unwrap().elapsed().as_millis() as u64;
                    if rms > SPEECH_RMS {
                        sd2.store(true, Ordering::Relaxed);
                        lsm2.store(elapsed, Ordering::Relaxed);
                    }
                } else {
                    // === Idle mode: feed resampled f32 samples to OpenWakeWord ===
                    let mut resampled = Vec::new();
                    let frame_count = frames.len();
                    while resample_pos < frame_count as f64 {
                        let idx = resample_pos as usize;
                        let frac = resample_pos - idx as f64;
                        let a = frames[idx];
                        let b = if idx + 1 < frame_count { frames[idx + 1] } else { a };
                        let sample = a + (b - a) * frac as f32;
                        resampled.push(sample);
                        resample_pos += 1.0 / ratio;
                    }
                    resample_pos -= frame_count as f64;

                    let mut buf = oww_buf2.lock().unwrap();
                    buf.extend_from_slice(&resampled);

                    let spf = samples_per_frame;
                    while buf.len() >= spf {
                        let chunk: Vec<f32> = buf.drain(..spf).collect();
                        if let Ok(mut det) = det2.try_lock() {
                            if det.process(chunk) {
                                wake2.store(true, Ordering::Relaxed);
                            }
                        }
                    }
                }
            },
            |err| { eprintln!("audio error: {err}"); std::process::exit(1); },
            None,
        )
        .expect("failed to build input stream");

    stream.play().expect("failed to start stream");

    // Main loop: manage wake word → recording → auto-stop cycle
    loop {
        if !running.load(Ordering::Relaxed) { break; }

        // Conversational follow-up: parent wrote "FOLLOW_UP\n" to stdin.
        // Fold it into the wake_detected flag so the recording path below
        // handles it identically to a real wake-word trigger. Emits
        // "FOLLOW_UP:detected" (distinct from WAKE:detected) so the host
        // can tell them apart and, say, skip the filler-ack audio.
        if wake_ctrl.load(Ordering::Relaxed) && !recording.load(Ordering::Relaxed) {
            wake_ctrl.store(false, Ordering::Relaxed);
            eprintln!("FOLLOW_UP:detected");
            speech_detected.store(false, Ordering::Relaxed);
            last_speech_ms.store(0, Ordering::Relaxed);
            header_written.store(false, Ordering::Relaxed);
            *rec_start.lock().unwrap() = Instant::now();
            recording.store(true, Ordering::Relaxed);
        }

        if wake_detected.load(Ordering::Relaxed) && !recording.load(Ordering::Relaxed) {
            // Wake word detected — switch to recording
            eprintln!("WAKE:detected");
            wake_detected.store(false, Ordering::Relaxed);
            speech_detected.store(false, Ordering::Relaxed);
            last_speech_ms.store(0, Ordering::Relaxed);
            header_written.store(false, Ordering::Relaxed);
            *rec_start.lock().unwrap() = Instant::now();
            recording.store(true, Ordering::Relaxed);
        }

        if recording.load(Ordering::Relaxed) {
            let elapsed = rec_start.lock().unwrap().elapsed().as_millis() as u64;
            let has_speech = speech_detected.load(Ordering::Relaxed);
            let last = last_speech_ms.load(Ordering::Relaxed);

            if has_speech && last > 0 && last >= SPEECH_MIN_MS {
                let silence = elapsed.saturating_sub(last);
                if silence >= SILENCE_TIMEOUT_MS {
                    eprintln!("RECORDING:stopped");
                    recording.store(false, Ordering::Relaxed);
                    // Don't break — go back to wake word listening
                }
            }

            // Safety timeout: 12s max recording. Lowered from 30s because
            // even with SPEECH_RMS raised, a very noisy room (open window,
            // loud HVAC) can still keep VAD hot indefinitely. 12s is longer
            // than any sane single voice prompt; if the user genuinely
            // needs more, they'll re-wake and continue.
            if elapsed > 12_000 {
                eprintln!("RECORDING:stopped (safety cap 12s)");
                recording.store(false, Ordering::Relaxed);
            }
        }

        std::thread::sleep(Duration::from_millis(50));
    }
    drop(stream);
}

/* ================================================================
   Shared helpers
   ================================================================ */

fn open_mic() -> (cpal::Device, cpal::StreamConfig, u32, u32) {
    let host = cpal::default_host();
    let device = host.default_input_device().expect("no input device available");
    let default_config = device.default_input_config().expect("no default input config");
    let in_rate = default_config.sample_rate().0;
    let in_channels = default_config.channels() as u32;
    eprintln!(
        "protege-mic: device={} in_rate={in_rate} in_ch={in_channels} → out_rate={OUT_RATE} out_ch={OUT_CHANNELS}",
        device.name().unwrap_or_default()
    );
    let config: cpal::StreamConfig = default_config.into();
    (device, config, in_rate, in_channels)
}

fn downmix(data: &[f32], channels: u32) -> Vec<f32> {
    data.chunks(channels as usize)
        .map(|frame| {
            let sum: f32 = frame.iter().sum();
            sum / channels as f32
        })
        .collect()
}

fn compute_rms(frames: &[f32]) -> f32 {
    if frames.is_empty() { return 0.0; }
    let sum_sq: f32 = frames.iter().map(|s| s * s).sum();
    (sum_sq / frames.len() as f32).sqrt()
}

fn resample_and_write(frames: &[f32], pos: &mut f64, ratio: f64, out: &mut impl Write) {
    let frame_count = frames.len();
    while *pos < frame_count as f64 {
        let idx = *pos as usize;
        let frac = *pos - idx as f64;
        let a = frames[idx];
        let b = if idx + 1 < frame_count { frames[idx + 1] } else { a };
        let sample = a + (b - a) * frac as f32;
        let s16 = (sample * 32767.0).clamp(-32768.0, 32767.0) as i16;
        let _ = out.write_all(&s16.to_le_bytes());
        *pos += 1.0 / ratio;
    }
    *pos -= frame_count as f64;
}

/// Minimal 16-bit PCM WAV reader. Returns f32 samples in [-1.0, 1.0].
/// Expects mono 16kHz 16-bit PCM (we control the format in record mode and in
/// the ffmpeg conversion step).
fn read_wav_pcm16(path: &str) -> Result<Vec<f32>, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("read failed: {e}"))?;
    if bytes.len() < 44 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return Err("not a RIFF/WAVE file".into());
    }
    let mut i = 12;
    while i + 8 <= bytes.len() {
        let id = &bytes[i..i + 4];
        let size = u32::from_le_bytes([bytes[i + 4], bytes[i + 5], bytes[i + 6], bytes[i + 7]]) as usize;
        if id == b"data" {
            let end = (i + 8 + size).min(bytes.len());
            let data = &bytes[i + 8..end];
            return Ok(data.chunks_exact(2)
                .map(|c| i16::from_le_bytes([c[0], c[1]]) as f32 / 32768.0)
                .collect());
        }
        i += 8 + size;
    }
    Err("no data chunk in WAV".into())
}

/// Calibrate mode: read a WAV file, stream it through the wake-word pipeline,
/// print `CALIBRATE_PEAK=<f32>` (the highest probability across all frames).
/// Used by the extension's onboarding flow to pick a per-user threshold.
fn run_calibrate_mode(model_path: Option<String>, wav_path: String) {
    let model = model_path.unwrap_or_else(|| {
        eprintln!("protege-mic: --calibrate requires --model <path>");
        std::process::exit(1);
    });

    let samples = match read_wav_pcm16(&wav_path) {
        Ok(s) => s,
        Err(e) => { eprintln!("protege-mic: WAV read error: {e}"); std::process::exit(1); }
    };

    let mut pipeline = OwwPipeline::load(&model);
    let mut peak: f32 = 0.0;
    let mut frames_scored = 0usize;

    for chunk in samples.chunks(SAMPLES_PER_FRAME) {
        if chunk.len() < SAMPLES_PER_FRAME { break; }
        if let Some(prob) = pipeline.score(chunk.to_vec()) {
            frames_scored += 1;
            if prob > peak { peak = prob; }
        }
    }

    eprintln!("protege-mic: calibrate scored {frames_scored} frames, peak={peak:.4}");
    println!("CALIBRATE_PEAK={peak:.4}");
}

fn write_wav_header(w: &mut impl Write, sample_rate: u32, channels: u16) -> io::Result<()> {
    let bits_per_sample: u16 = 16;
    let byte_rate = sample_rate * (channels as u32) * (bits_per_sample as u32 / 8);
    let block_align = channels * (bits_per_sample / 8);
    let data_size: u32 = u32::MAX - 36;

    w.write_all(b"RIFF")?;
    w.write_all(&(data_size + 36).to_le_bytes())?;
    w.write_all(b"WAVE")?;
    w.write_all(b"fmt ")?;
    w.write_all(&16u32.to_le_bytes())?;
    w.write_all(&1u16.to_le_bytes())?;
    w.write_all(&channels.to_le_bytes())?;
    w.write_all(&sample_rate.to_le_bytes())?;
    w.write_all(&byte_rate.to_le_bytes())?;
    w.write_all(&block_align.to_le_bytes())?;
    w.write_all(&bits_per_sample.to_le_bytes())?;
    w.write_all(b"data")?;
    w.write_all(&data_size.to_le_bytes())?;
    Ok(())
}
