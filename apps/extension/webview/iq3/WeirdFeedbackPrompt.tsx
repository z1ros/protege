import React, { useState } from "react";
import { vscode } from "../vscode.js";

/**
 * Anonymous "found something weird?" feedback prompt for Code IQ
 * scoring. Lives at the bottom of the dashboard so users have a
 * persistent low-friction way to flag bad scores.
 *
 * The host forwards the text to `POST /iq/feedback`. Auth is enforced
 * server-side so spam is harder, but the persisted row stores ONLY the
 * text + timestamp — no userId. Users see a confirmation pill briefly
 * after submit, then the form collapses back to its link state.
 *
 * Capped at 1000 chars to match the backend `Iq3FeedbackSchema`. We
 * mirror the cap client-side so the textarea hits its `maxLength` and
 * the user notices before round-tripping; backend still validates.
 */

const FEEDBACK_TEXT_MAX = 1000;
const CONFIRMATION_MS = 2400;

export function WeirdFeedbackPrompt() {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [status, setStatus] = useState<"idle" | "submitting" | "sent">("idle");

  const trimmed = text.trim();
  const canSubmit = trimmed.length > 0 && status !== "submitting";

  const submit = () => {
    if (!canSubmit) return;
    setStatus("submitting");
    try {
      vscode.postMessage({ type: "iq/feedback", payload: { text: trimmed } });
    } catch {
      // Bridge unavailable (preview shell). Still treat as sent so the
      // user gets feedback rather than a dead button.
    }
    setStatus("sent");
    setText("");
    setTimeout(() => {
      setStatus("idle");
      setOpen(false);
    }, CONFIRMATION_MS);
  };

  if (!open && status !== "sent") {
    return (
      <button
        type="button"
        className="iq3-weirdfb-link"
        onClick={() => setOpen(true)}
      >
        Found something weird? Let us know
      </button>
    );
  }

  if (status === "sent") {
    return (
      <div className="iq3-weirdfb-sent" role="status">
        Thanks — feedback received.
      </div>
    );
  }

  return (
    <div className="iq3-weirdfb">
      <label className="iq3-weirdfb-label" htmlFor="iq3-weirdfb-text">
        What feels off about your score?
      </label>
      <textarea
        id="iq3-weirdfb-text"
        className="iq3-weirdfb-textarea"
        placeholder="e.g. ranked junior but I've been writing TS for years"
        value={text}
        onChange={(e) => setText(e.target.value)}
        maxLength={FEEDBACK_TEXT_MAX}
        rows={3}
      />
      <div className="iq3-weirdfb-actions">
        <button
          type="button"
          className="iq3-weirdfb-submit"
          onClick={submit}
          disabled={!canSubmit}
        >
          Send
        </button>
        <button
          type="button"
          className="iq3-weirdfb-cancel"
          onClick={() => {
            setText("");
            setOpen(false);
          }}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
