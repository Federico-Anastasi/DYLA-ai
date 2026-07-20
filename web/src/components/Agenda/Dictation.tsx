import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { apiClient, ApiError } from "../../api/client";
import { Icon } from "../icons";
import type { DictationResult, ProposedAgendaItem } from "../../types";

type Phase =
  | "idle"
  | "recording"
  | "transcribing"
  // Interpreting typed text (the "interpret" button on the quick-add bar): same preview as voice
  // dictation, but without going through the microphone.
  | "interpreting"
  | "preview"
  | "permission_denied";

// A proposed item in the preview, with a local "excluded" flag so the user can drop one before
// confirming without losing the others.
type EditableProposal = ProposedAgendaItem & { excluded?: boolean };

export type DictationHandle = { interpretText: (text: string) => void };

/**
 * Voice dictation: records with MediaRecorder (push-to-talk Ctrl+Space, or click), sends the audio
 * off to be transcribed, and shows an editable preview of the proposed items before actually saving
 * them — the model PROPOSES, the user confirms.
 *
 * It also exposes `interpretText` through a ref: that is how AgendaPanel wires the quick-add
 * "interpret" button into this same preview instead of duplicating the UI.
 */
const Dictation = forwardRef<
  DictationHandle,
  { transcriptionReady: boolean; onConfirm: (items: ProposedAgendaItem[]) => Promise<void> }
>(function Dictation({ transcriptionReady, onConfirm }, ref) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [duration, setDuration] = useState(0);
  const [result, setResult] = useState<DictationResult | null>(null);
  const [proposals, setProposals] = useState<EditableProposal[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Tells a held key (push-to-talk) apart from the keyboard's auto-repeat: without this guard every
  // repeated "keydown" would restart the recording.
  const ctrlSpaceHeld = useRef(false);

  const stopStream = () => {
    // Do not leave the microphone indicator on after the recording ends.
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  };

  const stopTimer = () => {
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
  };

  const send = useCallback(async () => {
    const blob = new Blob(chunksRef.current, { type: "audio/webm" });
    chunksRef.current = [];
    if (blob.size === 0) {
      setPhase("idle");
      return;
    }
    setPhase("transcribing");
    setError(null);
    try {
      const r = await apiClient.dictate(blob);
      setResult(r);
      setProposals(r.items.map((v) => ({ ...v })));
      setPhase("preview");
    } catch (e) {
      if (e instanceof ApiError && e.status === 503) {
        setError(
          "Transcription model unavailable: run 'pip install -r requirements.txt' on the backend.",
        );
      } else {
        setError(e instanceof Error ? e.message : "Transcription error");
      }
      setPhase("idle");
    }
  }, []);

  const start = useCallback(async () => {
    if (phase !== "idle" && phase !== "permission_denied") return;
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      chunksRef.current = [];
      const rec = new MediaRecorder(stream, { mimeType: "audio/webm" });
      rec.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      rec.onstop = () => {
        send();
      };
      recorderRef.current = rec;
      rec.start();
      setPhase("recording");
      setDuration(0);
      timerRef.current = setInterval(() => setDuration((d) => d + 1), 1000);
    } catch (e) {
      stopStream();
      setPhase("permission_denied");
      setError(
        e instanceof Error && e.name === "NotAllowedError"
          ? "Microphone permission denied: enable it in your browser settings to dictate."
          : "No microphone available on this device.",
      );
    }
  }, [phase, send]);

  const stop = useCallback(() => {
    stopTimer();
    if (recorderRef.current && recorderRef.current.state !== "inactive") {
      recorderRef.current.stop(); // onstop calls send()
    }
    stopStream();
  }, []);

  // Push-to-talk: Ctrl+Space HELD down — never Space on its own, which would clash with typing in
  // the agenda's text fields and elsewhere.
  useEffect(() => {
    const inTextField = (el: EventTarget | null) =>
      el instanceof HTMLElement &&
      (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code !== "Space" || !e.ctrlKey) return;
      if (inTextField(e.target)) return;
      if (ctrlSpaceHeld.current) return; // key repeat: already recording
      ctrlSpaceHeld.current = true;
      e.preventDefault();
      start();
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code !== "Space") return;
      if (!ctrlSpaceHeld.current) return;
      ctrlSpaceHeld.current = false;
      stop();
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [start, stop]);

  // Clean up if the component unmounts mid-recording. The recorder itself has to be
  // stopped explicitly, and BEFORE the stream: MediaRecorder.onstop fires send(), which
  // uploads whatever audio was captured so far and then calls setState — on a component
  // that is no longer there. Stopping the stream's tracks first (as this used to do) also
  // triggers that same onstop handler, just without ever silencing it.
  useEffect(
    () => () => {
      stopTimer();
      if (recorderRef.current && recorderRef.current.state !== "inactive") {
        recorderRef.current.onstop = null;
        recorderRef.current.stop();
      }
      stopStream();
    },
    [],
  );

  const clickMic = () => {
    if (phase === "recording") stop();
    else if (phase === "idle" || phase === "permission_denied") start();
  };

  const interpretText = useCallback(async (text: string) => {
    const t = text.trim();
    if (!t) return;
    setError(null);
    setPhase("interpreting");
    try {
      const r = await apiClient.dictateText(t);
      setResult(r);
      setProposals(r.items.map((v) => ({ ...v })));
      setPhase("preview");
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not interpret that");
      setPhase("idle");
    }
  }, []);

  useImperativeHandle(ref, () => ({ interpretText }), [interpretText]);

  const toggleExcluded = (i: number) =>
    setProposals((cur) => cur.map((v, idx) => (idx === i ? { ...v, excluded: !v.excluded } : v)));

  const editProposal = (i: number, patch: Partial<ProposedAgendaItem>) =>
    setProposals((cur) => cur.map((v, idx) => (idx === i ? { ...v, ...patch } : v)));

  const closePreview = () => {
    setPhase("idle");
    setResult(null);
    setProposals([]);
  };

  const confirmProposals = async () => {
    const toAdd = proposals.filter((v) => !v.excluded).map(({ excluded: _excluded, ...v }) => v);
    if (!toAdd.length) {
      closePreview();
      return;
    }
    setConfirming(true);
    try {
      await onConfirm(toAdd);
      closePreview();
    } finally {
      setConfirming(false);
    }
  };

  const included = proposals.filter((v) => !v.excluded).length;

  return (
    <div className="agenda-dictation">
      <div className="agenda-dictation-controls">
        <button
          type="button"
          className={`agenda-mic-btn ${phase === "recording" ? "agenda-mic-active" : ""}`}
          onClick={clickMic}
          disabled={phase === "transcribing" || phase === "interpreting" || phase === "preview"}
          title="Record: click to start/stop, or hold Ctrl+Space"
        >
          {/* There is no "microphone" icon in the shared set (icons.tsx), so we reuse play/stop-circle
              rather than introducing a new one. */}
          <Icon name={phase === "recording" ? "stop-circle" : "mic"} size={16} />
        </button>

        {phase === "recording" && (
          <span className="agenda-dictation-duration">
            {Math.floor(duration / 60)}:{String(duration % 60).padStart(2, "0")}
          </span>
        )}

        {phase === "transcribing" && (
          <span className="agenda-dictation-waiting">
            <span className="spinner" />
            transcribing…
            {!transcriptionReady && " (first time: this can take ten seconds or so)"}
          </span>
        )}

        {phase === "interpreting" && (
          <span className="agenda-dictation-waiting">
            <span className="spinner" />
            interpreting…
          </span>
        )}

        {phase === "idle" && <span className="muted agenda-dictation-hint">hold Ctrl+Space to dictate</span>}
      </div>

      {error && <div className="agenda-dictation-error">{error}</div>}

      {phase === "preview" && result && (
        <div className="agenda-dictation-preview">
          <p className="agenda-dictation-transcript">"{result.text}"</p>

          {!proposals.length ? (
            <p className="muted">{result.reason ?? "I could not find any activity in that."}</p>
          ) : (
            <>
              <ul className="agenda-dictation-proposals">
                {proposals.map((v, i) => (
                  <li key={i} className={`agenda-proposal ${v.excluded ? "agenda-proposal-excluded" : ""}`}>
                    <input
                      type="checkbox"
                      checked={!v.excluded}
                      onChange={() => toggleExcluded(i)}
                      title={v.excluded ? "excluded" : "included"}
                    />
                    <input
                      className="agenda-proposal-text"
                      value={v.text}
                      onChange={(e) => editProposal(i, { text: e.target.value })}
                    />
                    <input
                      className="agenda-proposal-date"
                      type="date"
                      value={v.due ?? ""}
                      onChange={(e) => editProposal(i, { due: e.target.value || undefined })}
                    />
                    {/* The model proposes the time from context ("tomorrow morning" ->
                        09:30): it is a guess, so it gets corrected here before landing in
                        the agenda. Without a date it means nothing, hence the disabled state. */}
                    <input
                      className="agenda-proposal-time"
                      type="time"
                      value={v.time ?? ""}
                      disabled={!v.due}
                      title={v.due ? "Suggested time" : "Pick a date first"}
                      onChange={(e) => editProposal(i, { time: e.target.value || undefined })}
                    />
                    <input
                      className="agenda-proposal-projects"
                      placeholder="projects (comma separated)"
                      value={(v.projects ?? []).join(", ")}
                      onChange={(e) =>
                        editProposal(i, {
                          projects: e.target.value
                            .split(",")
                            .map((s) => s.trim())
                            .filter(Boolean),
                        })
                      }
                    />
                  </li>
                ))}
              </ul>
              <div className="agenda-dictation-actions">
                <button type="button" className="mini-btn" onClick={closePreview}>
                  cancel
                </button>
                <button
                  type="button"
                  className="mini-btn primary"
                  disabled={confirming || !included}
                  onClick={confirmProposals}
                >
                  {confirming ? "adding…" : included === 1 ? "Add the activity" : `Add the ${included} activities`}
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
});

export default Dictation;
