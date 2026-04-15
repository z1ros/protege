import React, { useEffect, useRef, useState } from "react";
import { IconPersonFemale, IconPersonMale } from "./icons.js";
import { vscode } from "./vscode.js";

interface Props {
  onSend: (text: string) => void;
  latestReply: string;
  loading: boolean;
  error: string | null;
}

type Voice = "female" | "male";
type MicState = "unknown" | "blocked" | "ok";
type Phase = "idle" | "listening" | "thinking" | "speaking" | "warming";
type TtsStatus = "unknown" | "warming" | "ready" | "error";

const BACKEND_URL = "http://localhost:8787";
const BAR_COUNT = 24;

// VAD thresholds — tuned for 8000Hz analyser on typical mic levels
const SPEECH_RMS = 0.03;        // start-of-speech threshold (normalized 0..1)
const SILENCE_RMS = 0.018;      // below this = silence
const SILENCE_HANGOVER_MS = 1400; // how long to wait after last speech before flushing utterance
const SPEECH_ACTIVATION_MS = 120; // need N ms of sustained speech to count as "speaking"
const MIN_UTTERANCE_CHARS = 2;  // ignore micro-noise utterances

interface SpeechRecognitionLike extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  abort(): void;
  onresult:
    | ((e: {
        resultIndex: number;
        results: ArrayLike<unknown> & {
          [i: number]: { isFinal?: boolean; 0: { transcript: string } };
        };
      }) => void)
    | null;
  onend: (() => void) | null;
  onstart: (() => void) | null;
  onerror: ((e: { error: string }) => void) | null;
}

declare global {
  interface Window {
    SpeechRecognition?: { new (): SpeechRecognitionLike };
    webkitSpeechRecognition?: { new (): SpeechRecognitionLike };
  }
}

export function VoiceMode({ onSend, latestReply, loading, error }: Props) {
  const SR =
    typeof window !== "undefined"
      ? window.SpeechRecognition || window.webkitSpeechRecognition
      : undefined;

  const [micState, setMicState] = useState<MicState>("unknown");
  const [voice, setVoice] = useState<Voice>("female");
  const [phase, setPhase] = useState<Phase>("idle");
  const [ttsStatus, setTtsStatus] = useState<TtsStatus>("unknown");
  const [ttsWarmupError, setTtsWarmupError] = useState<string | null>(null);
  const [conversation, setConversation] = useState(false); // continuous mode on/off
  const [liveTranscript, setLiveTranscript] = useState("");
  const [statusDetail, setStatusDetail] = useState("");
  const [typedInput, setTypedInput] = useState("");
  const [levels, setLevels] = useState<number[]>(() =>
    new Array(BAR_COUNT).fill(4)
  );

  // Audio + mic refs
  const streamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const rafRef = useRef<number | null>(null);
  const recRef = useRef<SpeechRecognitionLike | null>(null);

  // VAD state
  const lastSpeechTsRef = useRef<number>(0);
  const speechStartTsRef = useRef<number>(0);
  const userSpeakingRef = useRef<boolean>(false);
  const utteranceFinalRef = useRef<string>("");
  const utteranceInterimRef = useRef<string>("");
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Audio playback
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const lastSpokenRef = useRef<string>("");
  const typeInputRef = useRef<HTMLInputElement | null>(null);

  // Keep a ref-copy of conversation state so async callbacks see fresh value
  const conversationRef = useRef(conversation);
  useEffect(() => {
    conversationRef.current = conversation;
  }, [conversation]);

  const phaseRef = useRef(phase);
  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);

  /* ============ Kokoro warmup poller ============ */
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const poll = async () => {
      try {
        const res = await fetch(`${BACKEND_URL}/tts/status`);
        if (!res.ok) throw new Error(`status HTTP ${res.status}`);
        const data = (await res.json()) as {
          ready: boolean;
          warmupError: string | null;
        };
        if (cancelled) return;
        if (data.warmupError) {
          setTtsStatus("error");
          setTtsWarmupError(data.warmupError);
          return; // stop polling — nothing will fix itself
        }
        if (data.ready) {
          setTtsStatus("ready");
          setTtsWarmupError(null);
          return;
        }
        setTtsStatus("warming");
        timer = setTimeout(poll, 1500);
      } catch (err) {
        if (cancelled) return;
        // Backend not reachable yet — keep trying, slower
        setTtsStatus("warming");
        timer = setTimeout(poll, 2500);
      }
    };

    poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, []);

  /* ============ Mic probe ============ */
  useEffect(() => {
    (async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        setMicState("blocked");
        return;
      }
      try {
        const probe = await navigator.mediaDevices.getUserMedia({ audio: true });
        probe.getTracks().forEach((t) => t.stop());
        setMicState("ok");
      } catch {
        setMicState("blocked");
        setTimeout(() => typeInputRef.current?.focus(), 80);
      }
    })();
  }, []);

  /* ============ TTS playback ============ */
  useEffect(() => {
    if (!latestReply || latestReply === lastSpokenRef.current) return;
    lastSpokenRef.current = latestReply;
    speak(latestReply).catch((err) => {
      console.warn("[protege] tts failed", err);
      fallbackSpeak(latestReply);
    });
  }, [latestReply, voice]);

  const speak = async (text: string) => {
    setPhase("speaking");
    setStatusDetail("");
    const res = await fetch(`${BACKEND_URL}/tts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, voice }),
    });
    if (res.status === 503) {
      // Kokoro still warming up — drop into warming phase, user can retry
      setTtsStatus("warming");
      setPhase("warming");
      setStatusDetail("Warming up voice engine…");
      throw new Error("kokoro-warming-up");
    }
    if (!res.ok) throw new Error(`tts HTTP ${res.status}`);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    stopAudio();
    const audio = new Audio(url);
    audioRef.current = audio;
    audio.onended = () => {
      URL.revokeObjectURL(url);
      audioRef.current = null;
      if (conversationRef.current) {
        setPhase("listening");
      } else {
        setPhase("idle");
      }
    };
    audio.onerror = () => {
      audioRef.current = null;
      setPhase(conversationRef.current ? "listening" : "idle");
    };
    await audio.play();
  };

  const fallbackSpeak = (text: string) => {
    if (!("speechSynthesis" in window)) return;
    const utter = new SpeechSynthesisUtterance(text);
    utter.rate = 1.05;
    utter.onstart = () => setPhase("speaking");
    utter.onend = () =>
      setPhase(conversationRef.current ? "listening" : "idle");
    window.speechSynthesis.speak(utter);
  };

  const stopAudio = () => {
    if (audioRef.current) {
      try {
        audioRef.current.pause();
        audioRef.current.src = "";
      } catch {}
      audioRef.current = null;
    }
    if ("speechSynthesis" in window) window.speechSynthesis.cancel();
  };

  /* ============ Conversation mode: mic + VAD + recognition ============ */

  const startConversation = async () => {
    if (conversation) return;
    setLiveTranscript("");
    utteranceFinalRef.current = "";
    utteranceInterimRef.current = "";

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      console.warn("[protege] mic blocked on startConversation", err);
      setMicState("blocked");
      return;
    }
    setMicState("ok");
    streamRef.current = stream;

    // AudioContext analyser
    try {
      const ctx = new AudioContext();
      audioCtxRef.current = ctx;
      const src = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.4;
      src.connect(analyser);
      analyserRef.current = analyser;
    } catch (err) {
      console.warn("[protege] AudioContext failed", err);
    }

    // Speech recognition (continuous)
    if (SR) {
      try {
        const rec = new SR();
        rec.continuous = true;
        rec.interimResults = true;
        rec.lang = "en-US";
        rec.onresult = (e) => {
          let finalText = "";
          let interim = "";
          for (let i = e.resultIndex; i < (e.results as ArrayLike<unknown>).length; i++) {
            const r = (e.results as Record<number, { isFinal?: boolean; 0: { transcript: string } }>)[i];
            const chunk = r[0].transcript;
            if (r.isFinal) finalText += chunk;
            else interim += chunk;
          }
          if (finalText) {
            utteranceFinalRef.current += finalText;
          }
          utteranceInterimRef.current = interim;
          setLiveTranscript(
            (utteranceFinalRef.current + " " + utteranceInterimRef.current).trim()
          );
        };
        rec.onend = () => {
          // Auto-restart in conversation mode if recognition drops
          if (conversationRef.current) {
            setTimeout(() => {
              try {
                rec.start();
              } catch {}
            }, 100);
          }
        };
        rec.onerror = (e) => {
          console.warn("[protege] SR error", e.error);
        };
        recRef.current = rec;
        rec.start();
      } catch (err) {
        console.warn("[protege] SR start failed", err);
      }
    }

    setConversation(true);
    setPhase("listening");
    setStatusDetail("");

    // Kick off the VAD + visualizer loop
    tickVad();
  };

  const stopConversation = () => {
    setConversation(false);
    setPhase("idle");
    setStatusDetail("");

    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }

    if (recRef.current) {
      try {
        recRef.current.abort();
      } catch {}
      recRef.current = null;
    }

    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }

    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    if (audioCtxRef.current && audioCtxRef.current.state !== "closed") {
      audioCtxRef.current.close().catch(() => {});
    }
    audioCtxRef.current = null;
    analyserRef.current = null;
    setLevels(new Array(BAR_COUNT).fill(4));

    stopAudio();
    setLiveTranscript("");
    utteranceFinalRef.current = "";
    utteranceInterimRef.current = "";
    userSpeakingRef.current = false;
  };

  const flushUtterance = () => {
    const text = (
      utteranceFinalRef.current +
      " " +
      utteranceInterimRef.current
    )
      .trim()
      .replace(/\s+/g, " ");

    utteranceFinalRef.current = "";
    utteranceInterimRef.current = "";
    userSpeakingRef.current = false;
    setLiveTranscript("");

    if (text.length < MIN_UTTERANCE_CHARS) return;

    setPhase("thinking");
    onSend(text);
  };

  const tickVad = () => {
    const analyser = analyserRef.current;
    if (!analyser || !conversationRef.current) return;

    const timeData = new Uint8Array(analyser.fftSize);
    analyser.getByteTimeDomainData(timeData);

    // RMS (root-mean-square) of signal around 128 midpoint, normalized 0..1
    let sumSquares = 0;
    for (let i = 0; i < timeData.length; i++) {
      const v = (timeData[i] - 128) / 128; // -1..1
      sumSquares += v * v;
    }
    const rms = Math.sqrt(sumSquares / timeData.length);

    // Update visualizer bars
    const freqData = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(freqData);
    const step = Math.floor(freqData.length / BAR_COUNT);
    const nextBars: number[] = [];
    for (let i = 0; i < BAR_COUNT; i++) {
      const v = freqData[i * step] ?? 0;
      nextBars.push(4 + (v / 255) * 54);
    }
    setLevels(nextBars);

    const now = performance.now();

    // === State machine ===
    if (rms > SPEECH_RMS) {
      // Sound present
      if (!userSpeakingRef.current) {
        if (speechStartTsRef.current === 0) {
          speechStartTsRef.current = now;
        }
        if (now - speechStartTsRef.current >= SPEECH_ACTIVATION_MS) {
          userSpeakingRef.current = true;

          // BARGE-IN: user started speaking while Protege was speaking
          if (phaseRef.current === "speaking") {
            stopAudio();
            setPhase("listening");
          } else if (phaseRef.current === "thinking") {
            // User barged in during thinking — cancel the interim transcript build
            // (can't cancel the LLM call, but we reset our state)
            setPhase("listening");
          } else {
            setPhase("listening");
          }
        }
      }
      lastSpeechTsRef.current = now;
      // Clear any pending flush — user is still talking
      if (silenceTimerRef.current) {
        clearTimeout(silenceTimerRef.current);
        silenceTimerRef.current = null;
      }
    } else if (rms < SILENCE_RMS) {
      // Silence
      speechStartTsRef.current = 0;
      if (userSpeakingRef.current && !silenceTimerRef.current) {
        // Start silence hangover timer — if user doesn't speak again for 1.4s, flush
        silenceTimerRef.current = setTimeout(() => {
          silenceTimerRef.current = null;
          if (conversationRef.current && userSpeakingRef.current) {
            flushUtterance();
          }
        }, SILENCE_HANGOVER_MS);
      }
    }

    rafRef.current = requestAnimationFrame(tickVad);
  };

  /* ============ Cleanup ============ */
  useEffect(() => {
    return () => {
      stopConversation();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ============ Type fallback ============ */
  const handleTypedSend = () => {
    const t = typedInput.trim();
    if (!t) return;
    onSend(t);
    setTypedInput("");
    setPhase("thinking");
  };

  const toggleOrb = () => {
    if (conversation) {
      stopConversation();
      return;
    }
    if (micState === "blocked") {
      setTimeout(() => typeInputRef.current?.focus(), 50);
      return;
    }
    if (ttsStatus !== "ready") {
      // Kokoro not ready yet — no point starting a conversation we can't reply to
      setStatusDetail(
        ttsStatus === "error"
          ? `Voice engine failed: ${ttsWarmupError ?? "unknown error"}`
          : "Warming up voice engine… hang on a few seconds"
      );
      return;
    }
    startConversation();
  };

  // Sync phase with loading prop — while outer chat is loading, we're thinking
  useEffect(() => {
    if (loading) {
      setPhase("thinking");
    } else if (conversationRef.current && phaseRef.current === "thinking") {
      // Loading stopped but TTS will take over via latestReply effect
      // Stay in thinking until the audio.onended triggers a phase change
    }
  }, [loading]);

  /* ============ UI ============ */
  const showTypeUI = micState === "blocked";

  const statusLabel = () => {
    if (statusDetail) return statusDetail;
    if (ttsStatus === "error") return "Voice engine failed to load";
    if (phase === "warming" || (ttsStatus === "warming" && phase === "idle"))
      return "Warming up voice engine";
    if (phase === "listening") return "Listening";
    if (phase === "thinking") return "Thinking";
    if (phase === "speaking") return "Speaking";
    if (showTypeUI) return "Type your question · I'll reply aloud";
    if (conversation) return "Conversation";
    return "Tap to talk";
  };

  const animated =
    phase !== "idle" || ttsStatus === "warming" || ttsStatus === "error";

  return (
    <div className={`voice ${showTypeUI ? "voice-type-mode" : ""}`}>
      <div className="voice-headline">
        Ask me <span className="accent">anything</span>
        <br />
        <em style={{ fontStyle: "italic" }}>
          {showTypeUI ? "by text or voice" : "by voice"}
        </em>
      </div>

      <div className="voice-controls">
        <button
          className={`voice-pill ${voice === "female" ? "active" : ""}`}
          onClick={() => setVoice("female")}
          title="Bella — warm American female (Kokoro)"
        >
          <IconPersonFemale size={12} strokeWidth={2.2} />
          <span>Bella</span>
        </button>
        <button
          className={`voice-pill ${voice === "male" ? "active" : ""}`}
          onClick={() => setVoice("male")}
          title="Michael — American male (Kokoro)"
        >
          <IconPersonMale size={12} strokeWidth={2.2} />
          <span>Michael</span>
        </button>
      </div>

      <div
        className={`voice-orb-wrap ${showTypeUI ? "small" : ""} ${
          phase === "listening" || phase === "speaking" ? "active" : ""
        } ${phase === "speaking" ? "speaking" : ""} ${
          conversation ? "conversation" : ""
        }`}
      >
        <div className="ring ring-1" />
        <div className="ring ring-2" />
        {phase === "listening" && (
          <div className="voice-bars" aria-hidden>
            {levels.map((h, i) => {
              const angle = (i / BAR_COUNT) * Math.PI * 2 - Math.PI / 2;
              const radius = 85;
              const x = Math.cos(angle) * radius;
              const y = Math.sin(angle) * radius;
              return (
                <div
                  key={i}
                  className="voice-bar"
                  style={{
                    height: `${h}px`,
                    transform: `translate(${x}px, ${y}px) rotate(${
                      (angle * 180) / Math.PI + 90
                    }deg)`,
                  }}
                />
              );
            })}
          </div>
        )}
        <button
          className={`voice-orb ${phase === "listening" ? "listening" : ""} ${
            phase === "speaking" ? "speaking" : ""
          }`}
          onClick={toggleOrb}
          aria-label={
            conversation ? "End conversation" : "Start conversation"
          }
        />
      </div>

      <div className="voice-status">
        {animated ? (
          <span className="pulse">{statusLabel()}…</span>
        ) : (
          statusLabel()
        )}
      </div>

      {liveTranscript && (
        <div className="voice-transcript">{liveTranscript}</div>
      )}

      {conversation && (
        <div className="voice-hint-live">
          <span className="live-dot" /> Interrupt anytime · pause to think · tap orb to end
        </div>
      )}

      {showTypeUI && (
        <>
          <div className="voice-type-fallback">
            <input
              ref={typeInputRef}
              className="voice-type-input"
              value={typedInput}
              onChange={(e) => setTypedInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleTypedSend();
              }}
              placeholder="Type your question, I'll reply aloud…"
              autoFocus
            />
            <button
              className="send-btn"
              onClick={handleTypedSend}
              disabled={!typedInput.trim() || loading}
              aria-label="Send"
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M7 17L17 7" />
                <path d="M9 7h8v8" />
              </svg>
            </button>
          </div>
          <div className="voice-mic-hint">
            <div className="voice-mic-hint-title">
              Microphone blocked
            </div>
            <div className="voice-mic-hint-body">
              Cursor doesn't have microphone permission yet. Grant it in
              System Settings → Privacy → Microphone → <strong>Cursor</strong>,
              then re-check below.
            </div>
            <div className="voice-mic-hint-actions">
              <button
                className="mic-action-btn primary"
                onClick={() => {
                  vscode.postMessage({
                    type: "openExternal",
                    url: "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
                  });
                }}
              >
                Open Settings
              </button>
              <button
                className="mic-action-btn"
                onClick={async () => {
                  // Re-probe mic access — if the user just toggled it on,
                  // this will transition us out of blocked state.
                  try {
                    const probe = await navigator.mediaDevices.getUserMedia({
                      audio: true,
                    });
                    probe.getTracks().forEach((t) => t.stop());
                    setMicState("ok");
                    setStatusDetail("");
                  } catch {
                    // Still blocked. Tell the user to fully relaunch Cursor
                    // because TCC decisions require an app restart.
                    setStatusDetail(
                      "Still blocked. Quit Cursor (⌘Q) and reopen after toggling."
                    );
                  }
                }}
              >
                Re-check
              </button>
            </div>
          </div>
        </>
      )}

      {error && <div className="error">{error}</div>}
      {!conversation && !showTypeUI && (
        <div className="voice-hint">
          Tap the orb to start a real conversation
        </div>
      )}
    </div>
  );
}
