import { useCallback, useEffect, useState } from "react";
import { apiClient } from "../api/client";
import { useToastStore } from "../store/toastStore";
import { Icon } from "./icons";
import type { ModelCatalog, ModelEntry } from "../types";

// Where the local model gets chosen, downloaded, or pointed at.
//
// The suggested list is short and opinionated, because a catalogue of thirty models is
// a way of not answering the question. But it is a starting point rather than a fence:
// anything already on disk shows up on its own, and any .gguf can be added by path.
//
// Sizes are shown everywhere. A download measured in gigabytes should never start
// without the person knowing what they just agreed to.

const ACCELERATOR_LABEL: Record<string, string> = {
  cuda: "NVIDIA GPU",
  metal: "Apple Silicon",
  cpu: "CPU only",
};

function Row({
  model,
  active,
  busy,
  onChoose,
  onDownload,
  onForget,
}: {
  model: ModelEntry;
  active: boolean;
  busy: string | null;
  onChoose: () => void;
  onDownload?: () => void;
  onForget?: () => void;
}) {
  const downloading = busy === model.id;
  const installed = model.installed ?? true;
  return (
    <div className={`model-row ${active ? "active" : ""}`}>
      <div className="model-row-main">
        <span className="model-name">
          {model.label}
          {active && <span className="model-badge">in use</span>}
        </span>
        {model.note && <span className="model-note">{model.note}</span>}
        <span className="model-meta">
          {model.size_gb} GB
          {model.needs_gb ? ` · wants ${model.needs_gb} GB of memory` : ""}
          {model.quant ? ` · ${model.quant}` : ""}
        </span>
      </div>
      <div className="model-row-act">
        {!installed && onDownload && (
          <button type="button" className="mini-btn" disabled={!!busy} onClick={onDownload}>
            {downloading ? "downloading…" : `download ${model.size_gb} GB`}
          </button>
        )}
        {installed && !active && (
          <button type="button" className="mini-btn primary" disabled={!!busy} onClick={onChoose}>
            use this
          </button>
        )}
        {onForget && (
          <button type="button" className="mini-btn danger" disabled={!!busy} onClick={onForget}>
            forget
          </button>
        )}
      </div>
    </div>
  );
}

export default function SettingsPanel({ onClose }: { onClose: () => void }) {
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [path, setPath] = useState("");
  const [language, setLanguage] = useState("");
  // What the backend currently holds, so the button can tell "nothing to save" from
  // "cleared on purpose" — the two look identical in an empty field.
  const [savedLanguage, setSavedLanguage] = useState("");

  const load = useCallback(async () => {
    try {
      const [models, prefs] = await Promise.all([apiClient.listModels(), apiClient.getPreferences()]);
      setCatalog(models);
      setLanguage(prefs.language ?? "");
      setSavedLanguage(prefs.language ?? "");
    } catch (e) {
      useToastStore.getState().push(e instanceof Error ? e.message : "Could not read the settings", "error");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Only refreshes the model catalogue: this is what most callers of run() actually need
  // (a model was chosen/downloaded/forgotten, the engine got installed, the context changed).
  // It deliberately does NOT touch language/savedLanguage — see run() below for why.
  const refreshCatalog = useCallback(async () => {
    try {
      setCatalog(await apiClient.listModels());
    } catch (e) {
      useToastStore.getState().push(e instanceof Error ? e.message : "Could not read the settings", "error");
    }
  }, []);

  const run = async (id: string, fn: () => Promise<unknown>, done: string) => {
    setBusy(id);
    try {
      await fn();
      useToastStore.getState().push(done);
      // Refresh the catalogue only, not the full load(): load() also re-reads the language
      // preference from the server and would stomp on whatever the user is mid-typing in
      // the language field — e.g. typing a language, then clicking "use this" on a model
      // before pressing Enter used to wipe the typed text with no explanation.
      await refreshCatalog();
    } catch (e) {
      useToastStore.getState().push(e instanceof Error ? e.message : "That did not work", "error");
    } finally {
      setBusy(null);
    }
  };

  const languageChanged = language.trim() !== savedLanguage.trim();
  const saveLanguage = async () => {
    if (!languageChanged) return;
    const wanted = language.trim();
    setBusy("language");
    try {
      await apiClient.setLanguage(wanted);
      setSavedLanguage(wanted);
      setLanguage(wanted);
      useToastStore.getState().push(
        wanted ? `Answering in ${wanted} from now on` : "Following the conversation again",
      );
    } catch (e) {
      useToastStore.getState().push(e instanceof Error ? e.message : "That did not work", "error");
    } finally {
      setBusy(null);
    }
  };

  if (!catalog) return null;

  const engineReady = catalog.engine_installed;

  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal-box wide settings-box" onClick={(e) => e.stopPropagation()}>
        <h2>Settings</h2>

        <div className="settings-group">
          <div className="settings-title">Language</div>
          {/* Saved on a button and on Enter, not on blur: closing the dialog by clicking
              outside it unmounts the field, and a blur that races an unmount loses what
              was typed without saying so. */}
          <div className="settings-add">
            <input
              className="settings-path"
              value={language}
              placeholder="follow the conversation"
              disabled={!!busy}
              onChange={(e) => setLanguage(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") saveLanguage(); }}
            />
            <button type="button" className="mini-btn" disabled={!!busy || !languageChanged}
                    onClick={saveLanguage}>
              {language.trim() ? "set" : "clear"}
            </button>
          </div>
          {/* Free text, and empty by default. Offering a list would mean deciding which
              languages exist, and leaving it empty is not a missing setting: answering in
              the language you were written to is the behaviour most people want. */}
          <p className="modal-hint">
            Left empty, Dyla answers in whatever language you write in. Fill it to pin one —
            useful when the documents are in one language and you work in another.
          </p>
        </div>

        <div className="settings-title settings-section">Local model</div>

        <div className="settings-machine">
          <Icon name="cpu" size={13} />
          <span>
            This machine runs models on <strong>{ACCELERATOR_LABEL[catalog.accelerator] ?? catalog.accelerator}</strong>
          </span>
          {engineReady ? (
            <span className="settings-ok">engine ready</span>
          ) : (
            <button
              type="button"
              className="mini-btn primary"
              disabled={!!busy}
              onClick={() => run("engine", () => apiClient.installEngine(), "Engine installed")}
            >
              {busy === "engine" ? "installing…" : "install the engine"}
            </button>
          )}
        </div>
        {!engineReady && (
          <p className="modal-hint">
            Dyla downloads the llama.cpp build for your platform — 10-20 MB, or about 150 MB
            with CUDA. Compiling it yourself should not be the first thing you do.
          </p>
        )}

        <div className="settings-group">
          <div className="settings-title">Context</div>
          <div className="settings-context">
            <select
              className="settings-select"
              value={catalog.context ?? ""}
              disabled={!!busy}
              onChange={(e) =>
                run("context", () => apiClient.setContext(Number(e.target.value)),
                    "Context set — it applies next time the engine starts")
              }
            >
              <option value="">platform default</option>
              {catalog.context_choices.map((c) => (
                <option key={c} value={c}>{c / 1024}k tokens</option>
              ))}
            </select>
            <span className="settings-hw">
              {catalog.hardware.vram_gb > 0
                ? `${catalog.hardware.vram_gb} GB of VRAM · ${catalog.hardware.ram_gb} GB of RAM`
                : `${catalog.hardware.ram_gb} GB of RAM`}
            </span>
          </div>
          {/* The advice is deliberately a starting point rather than a promise: what
              fits depends on the quantisation and on everything else the machine is
              doing, so we say where to begin and what to fall back to. */}
          <p className="modal-hint">
            {catalog.context_advice ? (
              <>
                With {catalog.context_advice.model}, try{" "}
                <strong>{catalog.context_advice.try / 1024}k</strong>
                {catalog.context_advice.fallback
                  ? <> — if the engine will not start, drop to {catalog.context_advice.fallback / 1024}k.</>
                  : "."}
                {catalog.context_advice.tight && (
                  <> This machine is tight for this model: below{" "}
                  {catalog.recommended_context / 1024}k the conversation gets compacted
                  early, so a smaller model would serve you better than a smaller context.</>
                )}
              </>
            ) : (
              <>
                The context is held in memory the whole time and grows with its size, so it is
                what decides whether a model loads. {catalog.recommended_context / 1024}k is the
                sensible floor here — Dyla drives the model through Claude Code, whose system
                prompt alone is around 27k tokens.
              </>
            )}
          </p>
        </div>

        <div className="settings-group">
          <div className="settings-title">Suggested</div>
          {catalog.suggested.map((m) => (
            <Row
              key={m.id}
              model={m}
              active={catalog.active === m.id}
              busy={busy}
              onChoose={() => run(m.id, () => apiClient.chooseModel(m.id), `Now using ${m.label}`)}
              onDownload={() => run(m.id, () => apiClient.downloadModel(m.id), `${m.label} downloaded`)}
            />
          ))}
        </div>

        {catalog.found.length > 0 && (
          <div className="settings-group">
            <div className="settings-title">Already on this machine</div>
            {catalog.found.map((m) => (
              <Row
                key={m.id}
                model={m}
                active={catalog.active === m.id}
                busy={busy}
                onChoose={() => run(m.id, () => apiClient.chooseModel(m.id), `Now using ${m.label}`)}
              />
            ))}
          </div>
        )}

        {catalog.added.length > 0 && (
          <div className="settings-group">
            <div className="settings-title">Yours</div>
            {catalog.added.map((m) => (
              <Row
                key={m.id}
                model={m}
                active={catalog.active === m.id}
                busy={busy}
                onChoose={() => run(m.id, () => apiClient.chooseModel(m.id), `Now using ${m.label}`)}
                onForget={() => run(m.id, () => apiClient.forgetModel(m.id), "Forgotten (the file is still there)")}
              />
            ))}
          </div>
        )}

        <div className="settings-group">
          <div className="settings-title">Add your own</div>
          <div className="settings-add">
            <input
              className="settings-path"
              placeholder="path to a .gguf file"
              value={path}
              onChange={(e) => setPath(e.target.value)}
            />
            <button
              type="button"
              className="mini-btn"
              disabled={!path.trim() || !!busy}
              onClick={() =>
                run("add", () => apiClient.addModel(path.trim()), "Model added").then(() => setPath(""))
              }
            >
              add
            </button>
          </div>
          <p className="modal-hint">
            Models live in <code>{catalog.models_dir}</code>. Point <code>MODELS_DIR</code>{" "}
            somewhere else if you keep them with your other models.
          </p>
        </div>

        <div className="modal-actions">
          <button type="button" className="mini-btn" onClick={onClose}>close</button>
        </div>
      </div>
    </div>
  );
}
