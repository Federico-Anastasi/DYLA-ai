import { apiClient } from "../../api/client";
import { fileUrl } from "../../api/client";
import { useToastStore } from "../../store/toastStore";
import type { VersionsMap } from "../../hooks/useProjectPanel";

export default function VersionsModal({
  project,
  file,
  versions,
  onOpenFile,
  onRestored,
  onClose,
}: {
  project: string;
  file: string;
  versions: VersionsMap;
  onOpenFile: (file: string) => void;
  onRestored: () => void;
  onClose: () => void;
}) {
  const list = (versions[file] || []).slice().reverse();

  const restore = async (v: number) => {
    try {
      await apiClient.restore(project, file, v);
      useToastStore.getState().push(`Restored version v${v} of ${file}`);
      onRestored();
      onClose();
    } catch (e) {
      useToastStore.getState().push(e instanceof Error ? e.message : "Restore failed", "error");
    }
  };

  return (
    <div className="overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal-box wide">
        <h2>History — {file}</h2>
        {list.length === 0 ? (
          <div className="muted">no previous versions</div>
        ) : (
          <ul className="version-list">
            {list.map((v) => {
              const when = new Date(v.ts * 1000).toLocaleString("en-GB", {
                day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
              });
              return (
                <li key={v.v}>
                  <strong>v{v.v}</strong>
                  <span className="vdate">{when}</span>
                  <a className="mini-btn" onClick={() => onOpenFile(v.file)}>open</a>
                  <a className="mini-btn" href={fileUrl(project, v.file, true)}>download</a>
                  <button className="mini-btn primary" onClick={() => restore(v.v)}>restore</button>
                </li>
              );
            })}
          </ul>
        )}
        <div className="modal-actions">
          <button className="mini-btn" onClick={onClose}>close</button>
        </div>
      </div>
    </div>
  );
}
