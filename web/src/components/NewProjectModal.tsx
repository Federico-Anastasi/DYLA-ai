import { useState } from "react";
import { apiClient, ApiError } from "../api/client";
import { useChatStore } from "../store/chatStore";
import { useToastStore } from "../store/toastStore";
import type { ProjectSource } from "../types";

const NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;

export default function NewProjectModal({ initialName, onClose }: { initialName: string; onClose: (created?: string) => void }) {
  const [name, setName] = useState(initialName);
  const [client, setClient] = useState("");
  const [desc, setDesc] = useState("");
  // Where the project starts from. Not a detail: it decides whether the brief is a document we
  // receive or a deliverable we write ourselves out of the meetings.
  const [source, setSource] = useState<ProjectSource>("brief");
  const [brief, setBrief] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const refreshProjects = useChatStore((s) => s.refreshProjects);

  const create = async () => {
    const trimmed = name.trim();
    if (!trimmed) { setError("The name is required."); return; }
    if (!NAME_RE.test(trimmed)) { setError("Invalid name: lowercase letters, digits, - and _ (must start with a letter or a digit)."); return; }
    if (!client.trim()) { setError("The client is required."); return; }
    setBusy(true);
    setError(null);
    try {
      await apiClient.createProject(trimmed, client.trim(), desc.trim() || null, source);
      if (brief && source === "brief") await apiClient.uploadDocuments(trimmed, [brief], "brief");
      await refreshProjects();
      useToastStore.getState().push(`Project "${trimmed}" created`);
      onClose(trimmed);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not create the project.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal-box">
        <h2>New project</h2>
        <label>
          Name
          <input
            autoFocus
            autoComplete="off"
            placeholder="e.g. acme-warranties"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") create(); }}
          />
        </label>
        <label>
          Client
          <input
            autoComplete="off"
            placeholder="e.g. Acme Corp"
            value={client}
            onChange={(e) => setClient(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") create(); }}
          />
        </label>
        <label>
          Where you start from
          <select value={source} onChange={(e) => setSource(e.target.value as ProjectSource)}>
            <option value="brief">Brief already available (input document)</option>
            <option value="discovery">Discovery to do (brief written by us from the meetings)</option>
          </select>
        </label>
        <p className="modal-hint">
          {source === "brief"
            ? "The brief is an external document: we upload it and read it, we never edit it."
            : "The brief becomes a deliverable: it is built meeting after meeting with /meeting, and exports to Word."}
        </p>
        <label>
          Activity (optional — left empty, it is derived from the brief)
          <textarea
            rows={2}
            placeholder="e.g. estimate development of the new warranty management app"
            value={desc}
            onChange={(e) => setDesc(e.target.value)}
          />
        </label>
        {source === "brief" && (
          <label className="mini-btn" style={{ width: "fit-content" }}>
            {brief ? `Brief: ${brief.name}` : "upload brief (optional)"}
            <input type="file" onChange={(e) => setBrief(e.target.files?.[0] ?? null)} />
          </label>
        )}
        {error && <div className="error-text">{error}</div>}
        <div className="modal-actions">
          <button className="mini-btn" onClick={() => onClose()} disabled={busy}>cancel</button>
          <button className="mini-btn primary" onClick={create} disabled={busy}>
            {busy ? "creating…" : "create project"}
          </button>
        </div>
      </div>
    </div>
  );
}
