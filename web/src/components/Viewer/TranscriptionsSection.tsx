import { useRef, useState } from "react";
import { useToastStore } from "../../store/toastStore";
import { useTranscriptions } from "../../hooks/useTranscriptions";
import { toISO } from "../../lib/calendar";
import { titleFromFile } from "../../lib/transcriptions";
import { Icon } from "../icons";
import type { TranscriptionJob } from "../../types";

// From recording to transcript, inside the documents dropdown: that's where you upload
// files and that's where the finished transcript shows up as a meeting document, so
// there's no reason to send the user somewhere else to do it.
//
// The wait is long by design (half an hour of audio = tens of minutes of CPU, with the
// big model picked precisely because nobody is sitting there watching). That's why the
// panel can be closed: the job lives in the backend, not in this component.

const TODAY = () => toISO(new Date());

const STATUS_LABEL: Record<TranscriptionJob["status"], string> = {
  queued: "queued",
  running: "transcribing",
  done: "ready",
  error: "error",
  cancelled: "cancelled",
};

export default function TranscriptionsSection({
  project,
  onOpen,
  onRefresh,
}: {
  project: string;
  onOpen: (file: string) => void;
  onRefresh: () => void;
}) {
  const { jobs, model, start, cancel, confirm: confirmJob, discard } = useTranscriptions(project, onRefresh);
  const [picked, setPicked] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [date, setDate] = useState(TODAY);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const pick = (f: File | null) => {
    if (!f) return;
    setPicked(f);
    setTitle(titleFromFile(f.name));
    setDate(TODAY());
  };

  const clearPick = () => {
    setPicked(null);
    if (input.current) input.current.value = "";
  };

  const submit = async () => {
    if (!picked) return;
    setBusy(true);
    try {
      await start(picked, title.trim(), date);
      useToastStore.getState().push("Transcription started: it takes a while, you can close this");
      clearPick();
    } catch (e) {
      useToastStore.getState().push(
        e instanceof Error ? e.message : "Could not start the transcription", "error");
    } finally {
      setBusy(false);
    }
  };

  const askDiscard = async (j: TranscriptionJob) => {
    const what = j.file ? "the transcript and the recording" : "the recording";
    if (!confirm(`Throw away ${what} for "${j.title}"?`)) return;
    await discard(j.id);
    onRefresh();
  };

  return (
    <div className="transcr">
      <div className="transcr-head">
        <span className="transcr-title">
          <Icon name="mic" size={12} />
          Recordings
        </span>
        <span className="transcr-note">
          {model ? `transcribed locally with ${model}` : "transcribed locally"}
        </span>
        <label className={`mini-btn ${busy ? "disabled" : ""}`}>
          <Icon name="upload" size={12} />
          audio
          <input
            ref={input}
            type="file"
            accept="audio/*,video/mp4,video/x-matroska,.m4a,.opus,.amr"
            onChange={(e) => pick(e.target.files?.[0] ?? null)}
          />
        </label>
      </div>

      {picked && (
        <div className="transcr-form">
          <div className="transcr-file">{picked.name}</div>
          <input
            className="transcr-field"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Meeting title"
          />
          <input
            className="transcr-field transcr-date"
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
          <button type="button" className="mini-btn primary" disabled={busy} onClick={submit}>
            {busy ? "starting…" : "transcribe"}
          </button>
          <button type="button" className="mini-btn" onClick={clearPick}>
            cancel
          </button>
        </div>
      )}

      {jobs.map((j) => {
        const active = j.status === "queued" || j.status === "running";
        return (
          <div key={j.id} className={`transcr-job status-${j.status}`}>
            <div className="transcr-job-main">
              <span className="transcr-job-title">{j.title}</span>
              <span className="transcr-job-status">
                {STATUS_LABEL[j.status]}
                {j.status === "running" && ` ${Math.round(j.progress * 100)}%`}
              </span>
            </div>

            {active && (
              <div className="transcr-bar">
                {/* While queued the progress is zero and the bar would just sit there
                    empty: an indeterminate bar at least says "about to start". */}
                <div
                  className={`transcr-bar-fill ${j.status === "queued" ? "waiting" : ""}`}
                  style={j.status === "running" ? { width: `${j.progress * 100}%` } : undefined}
                />
              </div>
            )}

            {j.error && <div className="transcr-job-error">{j.error}</div>}

            <div className="transcr-job-actions">
              {active && (
                <button type="button" className="mini-btn" onClick={() => cancel(j.id)}>
                  stop
                </button>
              )}
              {j.status === "done" && j.file && (
                <>
                  <button type="button" className="mini-btn" onClick={() => onOpen(j.file!)}>
                    open
                  </button>
                  {/* Confirming means throwing the audio away: until you do, you can
                      listen again to any spot in the transcript you're unsure about. */}
                  {j.audio && (
                    <button type="button" className="mini-btn primary" onClick={() => confirmJob(j.id)}>
                      proofread
                    </button>
                  )}
                </>
              )}
              {!active && (
                <button type="button" className="mini-btn danger" onClick={() => askDiscard(j)}>
                  discard
                </button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
