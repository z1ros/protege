import React, { useEffect, useRef, useState } from "react";
import { IconPersonFemale, IconPersonMale } from "./icons.js";
import { vscode, onHostMessage } from "./vscode.js";

interface Props {
  onSend: (text: string) => void;
  latestReply: string;
  loading: boolean;
  error: string | null;
  /** When true, render a compact footer variant meant to live below a
   *  scrollable chat message list (Phase 3 unified layout). Default false
   *  keeps the original full-screen "take over the chat tab" behavior. */
  inline?: boolean;
  /** Callback to flip the chat modality back to text. Only used in inline
   *  variant (where the text/voice toggle lives inside this component). */
  onSwitchToText?: () => void;
}

type Voice = "female" | "male";
type MicState = "unknown" | "blocked" | "ok";
type Phase = "idle" | "listening" | "thinking" | "speaking" | "warming";
type TtsStatus = "unknown" | "warming" | "ready" | "error";

const BACKEND_URL = "http://localhost:8787";
const BAR_COUNT = 24;

function formatMB(bytes: number): string {
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

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

export function VoiceMode({
  onSend,
  latestReply,
  loading,
  error,
  inline = false,
  onSwitchToText,
}: Props) {
  const SR =
    typeof window !== "undefined"
      ? window.SpeechRecognition || window.webkitSpeechRecognition
      : undefined;

  const [micState, setMicState] = useState<MicState>("unknown");
  // Voice preference persists across reloads. Reads from localStorage on
  // first render so the user's last pick (Bella / Michael) survives
  // window reloads, panel switches, and VS Code restarts.
  const [voice, setVoiceRaw] = useState<Voice>(() => {
    try {
      const saved = localStorage.getItem("protege:voice");
      return saved === "male" || saved === "female" ? saved : "female";
    } catch {
      return "female";
    }
  });
  const setVoice = (v: Voice) => {
    setVoiceRaw(v);
    try {
      localStorage.setItem("protege:voice", v);
    } catch {}
  };
  const [phase, setPhase] = useState<Phase>("idle");
  const [ttsStatus, setTtsStatus] = useState<TtsStatus>("unknown");
  const [ttsWarmupError, setTtsWarmupError] = useState<string | null>(null);
  const [isDownloading, setIsDownloading] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState(0);
  const [downloadLoaded, setDownloadLoaded] = useState(0);
  const [downloadTotal, setDownloadTotal] = useState(0);
  const [conversation, setConversation] = useState(false); // continuous mode on/off
  const [liveTranscript, setLiveTranscript] = useState("");
  const [statusDetail, setStatusDetail] = useState("");
  const [typedInput, setTypedInput] = useState("");
  const [wakeWordActive, setWakeWordActive] = useState(false);
  const [wakeWordStatus, setWakeWordStatus] = useState<string>("");
  const [levels, setLevels] = useState<number[]>(() =>
    new Array(BAR_COUNT).fill(4)
  );

  // Audio + mic refs
  const streamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const rafRef = useRef<number | null>(null);
  const recRef = useRef<SpeechRecognitionLike | null>(null);
  const audioUnlockedRef = useRef(false);

  // VAD state
  const lastSpeechTsRef = useRef<number>(0);
  const speechStartTsRef = useRef<number>(0);
  const userSpeakingRef = useRef<boolean>(false);
  const utteranceFinalRef = useRef<string>("");
  const utteranceInterimRef = useRef<string>("");
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Audio playback
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // Pre-cached "Mm-hmm" filler blob URL. Re-fetched whenever `voice`
  // changes so Bella's and Michael's ack stay in their own timbre.
  const fillerUrlRef = useRef<string | null>(null);
  const fillerAudioRef = useRef<HTMLAudioElement | null>(null);
  // Seed with the reply that exists at mount time so we don't re-speak
  // whatever's already in chat state when the voice tab first opens.
  const lastSpokenRef = useRef<string>(latestReply ?? "");
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
          stage?: "idle" | "downloading" | "loading" | "ready" | "error";
          progress?: number;
          loadedBytes?: number;
          totalBytes?: number;
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
        if (data.stage === "downloading") {
          setDownloadProgress(data.progress ?? 0);
          setDownloadLoaded(data.loadedBytes ?? 0);
          setDownloadTotal(data.totalBytes ?? 0);
          setIsDownloading(true);
        } else {
          setIsDownloading(false);
        }
        // Poll faster while downloading so the bar moves smoothly.
        timer = setTimeout(poll, data.stage === "downloading" ? 500 : 1500);
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
  // Mic capture now runs in the extension host via a native binary.
  // The webview never calls getUserMedia — it just sends voice/start
  // and voice/stop messages. So mic is always considered "ok".
  useEffect(() => {
    setMicState("ok");
  }, []);

  /* ============ TTS playback ============ */
  useEffect(() => {
    if (!latestReply || latestReply === lastSpokenRef.current) return;
    lastSpokenRef.current = latestReply;
    speak(latestReply).catch((err) => {
      // No robotic SpeechSynthesis fallback — if Kokoro failed or is
      // warming up, stay silent. The UI already shows "Warming up…".
      console.warn("[protege] tts failed", err);
      setPhase(conversationRef.current ? "listening" : "idle");
    });
  }, [latestReply, voice]);

  const speak = async (text: string) => {
    // Stay in "thinking" until the audio actually starts playing —
    // otherwise the UI says "Speaking…" for the 1-3s Kokoro takes to
    // generate, which reads as a stutter.
    setPhase("thinking");
    setStatusDetail("");
    const t0 = performance.now();
    const res = await fetch(`${BACKEND_URL}/tts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, voice }),
    });
    const tFetch = performance.now();
    console.log(
      `[protege-tts] Kokoro generate: ${Math.round(tFetch - t0)}ms (chars=${text.length})`
    );
    if (res.status === 503) {
      setTtsStatus("warming");
      setPhase("warming");
      setStatusDetail("Warming up voice engine…");
      throw new Error("kokoro-warming-up");
    }
    if (!res.ok) throw new Error(`tts HTTP ${res.status}`);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    stopAudio();

    // Reuse a single persistent Audio element — creating new Audio()
    // each time fails autoplay policy because only the first one was
    // "blessed" by the user gesture. Reusing the same element preserves
    // the browser's autoplay grant across multiple play() calls.
    let audio = audioRef.current;
    if (!audio) {
      audio = new Audio();
      audioRef.current = audio;
    }
    const prevUrl = audio.src;
    audio.src = url;
    // Unlock primed the element at 0.01 — bump it back to full for real speech
    audio.volume = 1.0;
    // Fire the SPEAKING state transition on `onplaying` (actual output has
    // started), not on `onplay` (which fires when .play() is called but
    // before codec decode + buffer. Using onplay caused the UI to say
    // SPEAKING for 200-500ms of silence before the user heard anything.)
    audio.onplaying = () => {
      const tPlay = performance.now();
      console.log(
        `[protege-tts] audio start: +${Math.round(tPlay - tFetch)}ms after fetch (total ${Math.round(tPlay - t0)}ms)`
      );
      setPhase("speaking");
      vscode.postMessage({ type: "voice/speaking", active: true });
    };
    audio.onended = () => {
      vscode.postMessage({ type: "voice/speaking", active: false });
      URL.revokeObjectURL(url);
      if (conversationRef.current) {
        setPhase("listening");
      } else {
        setPhase("idle");
      }
    };
    audio.onerror = () => {
      vscode.postMessage({ type: "voice/speaking", active: false });
      setPhase(conversationRef.current ? "listening" : "idle");
    };
    await audio.play();
    // Clean up previous blob URL
    if (prevUrl && prevUrl.startsWith("blob:")) {
      URL.revokeObjectURL(prevUrl);
    }
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
        // Don't clear src or null out — keep the element alive for reuse
      } catch {}
    }
    if ("speechSynthesis" in window) window.speechSynthesis.cancel();
  };

  /**
   * Unlock audio playback on the first user gesture (orb tap).
   * Browsers block audio.play() unless it's tied to a user interaction.
   * We play a silent buffer to "prime" the AudioContext, after which
   * all programmatic play() calls succeed.
   */
  const unlockAudio = () => {
    if (audioUnlockedRef.current) return;
    audioUnlockedRef.current = true;
    try {
      // Create a persistent AudioContext — keeps the audio pipeline warm
      const ctx = new AudioContext();
      audioCtxRef.current = ctx;
      const buf = ctx.createBuffer(1, 1, 22050);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(ctx.destination);
      src.start(0);
      // Resume if suspended (Chrome policy)
      if (ctx.state === "suspended") ctx.resume().catch(() => {});
      // Create the persistent Audio element during user gesture — this
      // "blesses" it so all future play() calls work without autoplay block.
      const persistent = new Audio("data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA=");
      persistent.volume = 0.01;
      // Assign immediately — must be done inside the user gesture so the
      // element stays "blessed" even if the silent play() promise rejects.
      audioRef.current = persistent;
      persistent.play().catch(() => {});
    } catch {}
  };

  /* ============ Host-side voice messages ============ */
  useEffect(() => {
    return onHostMessage((msg) => {
      if (msg.type === "voice/recording") {
        if (msg.active) {
          // Barge-in: if the bot was mid-sentence, cut it off so the user
          // isn't talking over themselves. Also tell the host to drop
          // strict mode since we're no longer speaking.
          stopAudio();
          vscode.postMessage({ type: "voice/speaking", active: false });
          setPhase("listening");
          setConversation(true);
          setStatusDetail("");
        }
      } else if (msg.type === "voice/transcript") {
        setLiveTranscript(msg.text);
        setPhase("thinking");
      } else if (msg.type === "wake/state") {
        setWakeWordActive(msg.active);
        setWakeWordStatus(msg.status ?? "");
        if (msg.status === "listening") {
          setPhase("idle");
          setConversation(false);
        }
      } else if (msg.type === "voice/error") {
        setStatusDetail(msg.error);
        setPhase("idle");
        setConversation(false);
      } else if (msg.type === "voice/fillerPlay") {
        // Instant acknowledgment right after VAD detects end-of-speech.
        // Uses a pre-cached "Mm-hmm" clip so there's no fetch latency
        // here — sound starts within ~50ms of the user finishing.
        const url = fillerUrlRef.current;
        if (!url) return;
        try {
          let fa = fillerAudioRef.current;
          if (!fa) {
            fa = new Audio();
            fa.volume = 0.75;
            fillerAudioRef.current = fa;
          }
          fa.src = url;
          fa.currentTime = 0;
          fa.play().catch(() => {
            // Autoplay block — silent failure, the main reply will play
            // through the (user-gesture-unlocked) audioRef anyway.
          });
        } catch {}
      }
    });
  }, []);

  /* ============ Pre-cache the "Mm-hmm" filler per voice ============
     Fetch /tts once on mount and whenever the user swaps Bella ↔ Michael,
     so the clip is instantly playable when VAD fires. Revoked on voice
     change to avoid leaking blob URLs. */
  useEffect(() => {
    let cancelled = false;
    const oldUrl = fillerUrlRef.current;
    (async () => {
      try {
        const res = await fetch(`${BACKEND_URL}/tts`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: "Mm-hmm.", voice }),
        });
        if (!res.ok) return;
        const blob = await res.blob();
        if (cancelled) return;
        const url = URL.createObjectURL(blob);
        fillerUrlRef.current = url;
      } catch {}
    })();
    return () => {
      cancelled = true;
      if (oldUrl) URL.revokeObjectURL(oldUrl);
    };
  }, [voice]);

  /* ============ Conversation mode (host-side recording) ============ */

  const startConversation = async () => {
    if (conversation) return;
    setConversation(true);
    setPhase("listening");
    setLiveTranscript("");
    setStatusDetail("");
    vscode.postMessage({ type: "voice/start" });
  };

  const stopConversation = () => {
    setConversation(false);
    setPhase("thinking");
    setStatusDetail("Transcribing…");
    vscode.postMessage({ type: "voice/stop" });

    stopAudio();
    setLiveTranscript("");
    utteranceFinalRef.current = "";
    utteranceInterimRef.current = "";
    userSpeakingRef.current = false;
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
    // Block interaction until Kokoro is ready — otherwise we'd record
    // the user, get a transcript, and have nothing to speak back.
    if (ttsStatus !== "ready") return;
    // Also block if the wake word listener is still loading its models
    // — the user might tap intending to barge in before the listener is
    // ready, which would leave wake detection offline mid-conversation.
    if (wakeWordStatus === "loading") return;
    unlockAudio();
    if (conversation) {
      stopConversation();
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

  // Derive the visible phase the state chip should report. Matches the
  // logic further down in the fullscreen render path so both variants
  // agree on what color the pill shows.
  const chipPhase: string =
    ttsStatus === "warming" || ttsStatus === "unknown" ? "warming" : phase;

  const statusLabel = () => {
    if (statusDetail) return statusDetail;
    if (ttsStatus === "error") return "Voice engine failed to load";
    if (ttsStatus === "warming" || ttsStatus === "unknown")
      return "Preparing voice engine";
    if (phase === "warming") return "Warming up voice engine";
    if (phase === "listening") return "Listening";
    if (phase === "thinking") return "Thinking";
    if (phase === "speaking") return "Speaking";
    if (showTypeUI) return "Type your question · I'll reply aloud";
    if (conversation) return "Conversation";
    return "Tap to talk";
  };

  const animated =
    phase !== "idle" || ttsStatus === "warming" || ttsStatus === "error";

  /* ============ Inline variant (Phase 3 unified layout) ============
     Replaces the composer footer while voice is active. Messages live
     ABOVE this component in App.tsx, so we show only: state chip,
     small orb, wake toggle, voice picker, "switch to text" button.
     ================================================================ */
  if (inline) {
    return (
      <div className="voice voice-inline">
        {/* Grid layout: orb is the hero, chip/voices sit below it, wake
            toggle + text switch pin to the bottom corners. Order in the
            DOM matches source order; CSS grid-area rules place them. */}

        <button
          className={`wake-word-toggle compact ${wakeWordActive ? "active" : ""} ${
            wakeWordStatus === "loading" ? "loading" : ""
          }`}
          onClick={() => {
            unlockAudio();
            vscode.postMessage({ type: "wake/toggle" });
          }}
          disabled={wakeWordStatus === "loading"}
          title={wakeWordActive ? 'Wake word ON — say "Protege"' : "Enable wake word"}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <rect x="9" y="3" width="6" height="12" rx="3" />
            <path d="M5 11a7 7 0 0014 0" />
            <path d="M12 18v3" />
          </svg>
          {wakeWordStatus === "loading"
            ? "Loading…"
            : wakeWordActive
            ? '"Protege" ON'
            : "Wake"}
        </button>

        <div
          className={`voice-orb-wrap voice-orb-wrap-inline ${
            phase === "listening" || phase === "speaking" ? "active" : ""
          } ${phase === "speaking" ? "speaking" : ""} ${
            conversation ? "conversation" : ""
          }`}
        >
          <div className="ring ring-1" />
          <div className="ring ring-2" />
          <button
            className={`voice-orb ${phase === "listening" ? "listening" : ""} ${
              phase === "speaking" ? "speaking" : ""
            } ${
              ttsStatus !== "ready" || wakeWordStatus === "loading"
                ? "warming"
                : ""
            }`}
            onClick={toggleOrb}
            disabled={ttsStatus !== "ready" || wakeWordStatus === "loading"}
            aria-label={conversation ? "End conversation" : "Start conversation"}
          />
        </div>

        {onSwitchToText ? (
          <button
            className="voice-inline-switch"
            onClick={onSwitchToText}
            title="Switch back to text input"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 11.5a8.38 8.38 0 01-.9 3.8 8.5 8.5 0 01-7.6 4.7 8.38 8.38 0 01-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 01-.9-3.8 8.5 8.5 0 014.7-7.6 8.38 8.38 0 013.8-.9h.5a8.48 8.48 0 018 8v.5z" />
            </svg>
            Text
          </button>
        ) : (
          <span />
        )}

        <div className="voice-status" data-phase={chipPhase}>
          <span className="voice-status-dot" />
          <span className="voice-status-label">{statusLabel()}</span>
        </div>

        <div className="voice-inline-voices" role="tablist" aria-label="Voice">
          <button
            role="tab"
            aria-selected={voice === "female"}
            className={`voice-pill ${voice === "female" ? "active" : ""}`}
            onClick={() => setVoice("female")}
            title="Bella — warm American female"
          >
            <IconPersonFemale size={11} strokeWidth={2.2} />
            <span>Bella</span>
          </button>
          <button
            role="tab"
            aria-selected={voice === "male"}
            className={`voice-pill ${voice === "male" ? "active" : ""}`}
            onClick={() => setVoice("male")}
            title="Michael — American male"
          >
            <IconPersonMale size={11} strokeWidth={2.2} />
            <span>Michael</span>
          </button>
        </div>

        {liveTranscript && (
          <div className="voice-transcript voice-transcript-inline">
            {liveTranscript}
          </div>
        )}
        {error && <div className="error">{error}</div>}
      </div>
    );
  }

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
          } ${
            ttsStatus !== "ready" || wakeWordStatus === "loading"
              ? "warming"
              : ""
          }`}
          onClick={toggleOrb}
          disabled={ttsStatus !== "ready" || wakeWordStatus === "loading"}
          aria-label={
            conversation ? "End conversation" : "Start conversation"
          }
        />
      </div>

      {isDownloading && ttsStatus !== "ready" && ttsStatus !== "error" && (
        <div className="voice-warmup-card">
          <div className="voice-warmup-spinner" />
          <div className="voice-warmup-title">Downloading voice model</div>
          <div className="voice-warmup-sub">
            One-time setup. Downloads ~80MB from HuggingFace.
            {downloadTotal > 0 && (
              <>
                {" · "}
                {formatMB(downloadLoaded)} / {formatMB(downloadTotal)}
              </>
            )}
          </div>
          <div className="voice-warmup-bar">
            <div
              className="voice-warmup-bar-fill"
              style={{ width: `${Math.round((downloadProgress || 0) * 100)}%` }}
            />
          </div>
        </div>
      )}

      {/* Loud state chip — color-coded so the user can glance-read
          whether the system is listening, thinking, speaking, or idle.
          Animated dot pulses during active states. */}
      <div
        className="voice-status"
        data-phase={
          ttsStatus === "warming" || ttsStatus === "unknown"
            ? "warming"
            : phase
        }
      >
        <span className="voice-status-dot" />
        <span className="voice-status-label">{statusLabel()}</span>
      </div>

      {phase === "speaking" && wakeWordActive && (
        <div className="voice-barge-hint">
          Say <strong>"Protege"</strong> to interrupt
        </div>
      )}

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
              Voice mode runs in your browser
            </div>
            <div className="voice-mic-hint-body">
              Cursor's webview can't access the microphone — it's blocked by
              the editor's sandbox, not macOS. Open voice mode in your system
              browser instead, where the mic works normally.
            </div>
            <div className="voice-mic-hint-actions">
              <button
                className="mic-action-btn primary"
                onClick={() => {
                  vscode.postMessage({ type: "voice/openInBrowser" });
                }}
              >
                Open in Browser
              </button>
              <button
                className="mic-action-btn"
                onClick={() => {
                  vscode.postMessage({ type: "mic/openSettings" });
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
                      "Still blocked. Try Reset + Relaunch below, then quit Cursor with ⌘Q."
                    );
                  }
                }}
              >
                Re-check
              </button>
            </div>
            <div className="voice-mic-hint-stuck">
              <div className="voice-mic-hint-stuck-label">
                Still blocked even though Settings shows Cursor enabled?
              </div>
              <button
                className="mic-action-btn danger"
                onClick={() => {
                  vscode.postMessage({ type: "mic/reset" });
                }}
              >
                Reset TCC + Relaunch
              </button>
              <div className="voice-mic-hint-stuck-why">
                macOS caches the first "deny" from before you granted access.
                This wipes the cache so the next first-use prompt goes
                through clean.
              </div>
            </div>
          </div>
        </>
      )}

      {error && <div className="error">{error}</div>}
      {!conversation && !showTypeUI && (
        <div className="voice-hint">
          {wakeWordActive
            ? wakeWordStatus === "loading"
              ? "Warming up wake word…"
              : wakeWordStatus === "recording"
              ? "Heard you! Listening..."
              : 'Say "Protege" or tap the orb'
            : "Tap the orb to start a real conversation"
          }
        </div>
      )}

      <button
        className={`wake-word-toggle ${wakeWordActive ? "active" : ""} ${
          wakeWordStatus === "loading" ? "loading" : ""
        }`}
        onClick={() => {
          unlockAudio();
          vscode.postMessage({ type: "wake/toggle" });
        }}
        disabled={wakeWordStatus === "loading"}
        title={
          wakeWordStatus === "loading"
            ? "Loading wake word models…"
            : wakeWordActive
            ? 'Wake word ON — say "Protege" to activate'
            : "Enable wake word detection"
        }
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <rect x="9" y="3" width="6" height="12" rx="3" />
          <path d="M5 11a7 7 0 0014 0" />
          <path d="M12 18v3" />
        </svg>
        {wakeWordStatus === "loading"
          ? "Loading…"
          : wakeWordActive
          ? '"Protege" ON'
          : "Wake word"}
      </button>
    </div>
  );
}
