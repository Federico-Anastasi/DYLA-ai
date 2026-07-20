import { useEffect, useState } from "react";
import { useChatStore } from "../store/chatStore";
import { GLOBAL_CHAT } from "../types";
import EnginePanel from "./EnginePanel";
import { Icon } from "./icons";
import NewProjectModal from "./NewProjectModal";
import SettingsPanel from "./SettingsPanel";

export default function Sidebar({
  collapsed,
  onToggleCollapsed,
  onOpenChat,
}: {
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onOpenChat: (name: string) => void;
}) {
  const projects = useChatStore((s) => s.projects);
  const activeChat = useChatStore((s) => s.activeChat);
  const projectMeta = useChatStore((s) => s.projectMeta);
  const model = useChatStore((s) => s.model);
  const refreshProjects = useChatStore((s) => s.refreshProjects);
  const refreshModel = useChatStore((s) => s.refreshModel);
  const setModel = useChatStore((s) => s.setModel);
  const selectChat = useChatStore((s) => s.selectChat);
  const [modalOpen, setModalOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [engineOpen, setEngineOpen] = useState(false);

  useEffect(() => {
    refreshProjects();
    refreshModel();
  }, [refreshProjects, refreshModel]);

  // Whether a profile is local is the backend's call: it knows which ones start an
  // engine here. Matching on a profile name would break the moment one is renamed.
  const engineStatus = model?.engine_installed
    ? model.engine_running ? "engine running" : "engine stopped"
    : "";

  return (
    <>
      <aside id="sidebar" className={collapsed ? "collapsed" : ""}>
        <div className="sidebar-top">
          <div className="brand">Dyla</div>
          <button className="sidebar-toggle" onClick={onToggleCollapsed} title={collapsed ? "expand" : "collapse"}>
            <Icon name={collapsed ? "chevrons-right" : "chevrons-left"} size={13} />
          </button>
        </div>

        <div className="side-section">
          <button
            className={`nav-item ${activeChat === GLOBAL_CHAT ? "active" : ""} ${projectMeta[GLOBAL_CHAT]?.hasNews ? "has-news" : ""}`}
            onClick={() => onOpenChat(GLOBAL_CHAT)}
            title="Quick chat"
          >
            <span className="ico"><Icon name="message-circle" size={15} /></span>
            <span className="label">Quick chat</span>
          </button>
        </div>

        <div className="side-section grow">
          <div className="side-title">Projects</div>
          <ul id="project-list">
            {projects.map((p) => (
              <li key={p.name}>
                <button
                  className={`nav-item ${activeChat === p.name ? "active" : ""} ${projectMeta[p.name]?.hasNews ? "has-news" : ""}`}
                  onClick={() => onOpenChat(p.name)}
                  title={p.name}
                >
                  <span className="ico"><Icon name="folder" size={15} /></span>
                  <span className="label">{p.name}</span>
                </button>
              </li>
            ))}
          </ul>
          <button className="new-project-btn" onClick={() => setModalOpen(true)} title="new project">
            <Icon name="plus" size={13} />
            <span className="label">new project</span>
          </button>
        </div>

        <div className="side-section" id="model-box">
          <div className="side-title">Model</div>
          <select id="model-select" value={model?.active ?? ""} onChange={(e) => setModel(e.target.value)}>
            {Object.entries(model?.profiles ?? {}).map(([key, label]) => (
              <option key={key} value={key}>{label}</option>
            ))}
          </select>
          {/* The engine panel replaces the plain status line when there is a local engine
              to report on; on the cloud profile there is nothing to show and it returns
              null, leaving the old line to say whether one is installed at all. */}
          <EnginePanel
            open={engineOpen}
            onToggle={() => setEngineOpen((v) => !v)}
            onOpenChat={(project, chatId) => { onOpenChat(project); selectChat(project, chatId); }}
          />
          {!model?.engine_running && <div id="engine-status" className="muted">{engineStatus}</div>}
          <button type="button" className="nav-item settings-link" onClick={() => setSettingsOpen(true)}>
            <span className="ico"><Icon name="settings" size={14} /></span>
            <span className="label">Settings</span>
          </button>
        </div>
      </aside>

      {settingsOpen && <SettingsPanel onClose={() => { setSettingsOpen(false); refreshModel(); }} />}

      {modalOpen && (
        <NewProjectModal
          initialName=""
          onClose={(created) => {
            setModalOpen(false);
            if (created) onOpenChat(created);
          }}
        />
      )}
    </>
  );
}
