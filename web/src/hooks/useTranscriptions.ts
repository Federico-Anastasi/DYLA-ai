import { useCallback, useEffect, useRef, useState } from "react";
import { apiClient } from "../api/client";
import type { TranscriptionJob } from "../types";

// Transcribing meeting recordings: the one piece of work in the app that runs for tens of
// minutes. The backend treats it as a job, and here we follow its status.
//
// Polling rather than a WebSocket: the chat has a socket because its events are continuous
// and have to render the moment they arrive; here there is a single number creeping upwards,
// and asking every few seconds shows it just as well without a second channel to keep alive.
// When nothing is queued the polling stops: no timer should spin for the whole session if
// nothing is being transcribed.

const POLL_MS = 4000;

const IS_RUNNING = (j: TranscriptionJob) => j.status === "queued" || j.status === "running";

export function useTranscriptions(project: string, onCompleted?: () => void) {
  const [jobs, setJobs] = useState<TranscriptionJob[]>([]);
  const [model, setModel] = useState("");
  const completed = useRef<Set<string>>(new Set());
  // Held in a ref rather than in the dependencies: the caller almost always passes a fresh
  // function on every render, and putting it in the effect would restart it constantly.
  const cb = useRef(onCompleted);
  cb.current = onCompleted;

  const load = useCallback(async () => {
    try {
      const r = await apiClient.listTranscriptions(project);
      setJobs(r.jobs);
      setModel(r.model);
      // A transcription that just finished produced a file in `meetings/`: whoever sits above
      // us (the document list) has to notice without a manual reload.
      for (const j of r.jobs) {
        if (j.status === "done" && !completed.current.has(j.id)) {
          completed.current.add(j.id);
          cb.current?.();
        }
      }
      return r.jobs;
    } catch {
      return [] as TranscriptionJob[];
    }
  }, [project]);

  // Both the mount effect and start() below drive the SAME loop (through refs, not
  // component state): start() used to spin off its own independent setTimeout chain,
  // which was never tied to `alive` and never stored anywhere to clear — it kept polling
  // for the rest of the session (and every subsequent upload added yet another chain on
  // top of it), even after the component using this hook had unmounted.
  const alive = useRef(true);
  const timer = useRef<number | undefined>(undefined);
  // Guards against two overlapping fetches when start() wakes the loop up while a poll
  // triggered by the timer is still in flight: the in-flight one will reschedule on its
  // own once it resolves, so the waking call just has to be a no-op rather than firing a
  // second request.
  const inFlight = useRef(false);

  const poll = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const current = await load();
      if (!alive.current) return;
      if (timer.current !== undefined) {
        window.clearTimeout(timer.current);
        timer.current = undefined;
      }
      // Keep asking only while something is still being worked on.
      if (current.some(IS_RUNNING)) timer.current = window.setTimeout(poll, POLL_MS);
    } finally {
      inFlight.current = false;
    }
  }, [load]);

  useEffect(() => {
    completed.current.clear();
    alive.current = true;
    poll();

    return () => {
      alive.current = false;
      if (timer.current !== undefined) window.clearTimeout(timer.current);
    };
  }, [poll]);

  /** Uploads a recording and gets the polling going again. */
  const start = useCallback(
    async (audio: File, title: string, date: string) => {
      const job = await apiClient.startTranscription(project, audio, title, date);
      setJobs((v) => [job, ...v]);
      // Polling had stopped if nothing was queued: it needs waking up, and the first pass has
      // to happen right now, not in four seconds — but through the same loop, so the
      // component's unmount cleanup can still reach it.
      if (timer.current !== undefined) {
        window.clearTimeout(timer.current);
        timer.current = undefined;
      }
      poll();
      return job;
    },
    [project, poll],
  );

  const cancel = useCallback(
    (id: string) => apiClient.cancelTranscription(project, id).then(() => load()),
    [project, load],
  );

  const confirm = useCallback(
    (id: string) => apiClient.confirmTranscription(project, id).then(() => load()),
    [project, load],
  );

  const discard = useCallback(
    (id: string) => apiClient.discardTranscription(project, id).then(() => load()),
    [project, load],
  );

  return { jobs, model, start, cancel, confirm, discard, reload: load };
}
