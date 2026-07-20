import { useMemo, useState } from "react";
import { useChatStore } from "../store/chatStore";
import { OUTPUT_DOCS } from "../lib/documentTabs";
import type { ProjectSummary } from "../types";
import AgendaPanel from "./Agenda/AgendaPanel";
import { Icon } from "./icons";
import NewProjectModal from "./NewProjectModal";

// The first screen is not a welcome sign: it is the place you enter the work from. Each project
// shows at a glance who the client is, where it started, how far along the deliverables are, and
// when it was last touched — sorted by recent activity, which is how you actually think about it
// ("where was I?").

function formatWhen(epochSeconds?: number): string {
  if (!epochSeconds) return "";
  const days = Math.floor((Date.now() / 1000 - epochSeconds) / 86400);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days} days ago`;
  return new Date(epochSeconds * 1000).toLocaleDateString("en-GB", {
    day: "2-digit", month: "2-digit", year: "2-digit",
  });
}

// The deliverables worth previewing: the ones on the main path. Questions and people are working
// files — inside a card they would just be noise.
const IN_CARD = OUTPUT_DOCS.filter((d) => d.group === "output");

function ProjectCard({ p, onOpen }: { p: ProjectSummary; onOpen: (name: string) => void }) {
  const meta = useChatStore((s) => s.projectMeta[p.name]);
  const docs = IN_CARD.filter((d) => !d.source || d.source === (p.source ?? "brief"));
  const done = docs.filter((d) => p.workflow?.[d.workflowKey]).length;

  return (
    <button type="button" className="proj-card" onClick={() => onOpen(p.name)}>
      <div className="proj-card-head">
        <span className="proj-card-name">{p.name}</span>
        {p.client && <span className="proj-card-client">{p.client}</span>}
      </div>

      <div className="proj-card-meta">
        {/* Class names here (and elsewhere in the app) still match web/src/styles/app.css, which
            has not been renamed: changing them would silently drop the styling. */}
        <span className={`proj-source ${p.source ?? "brief"}`}>
          {p.source === "discovery" ? "from discovery" : "brief provided"}
        </span>
        {p.modified && <span className="proj-when">{formatWhen(p.modified)}</span>}
      </div>

      <div className="proj-card-docs">
        {docs.map((d) => (
          <span
            key={d.doc}
            className={`proj-doc ${p.workflow?.[d.workflowKey] ? "done" : ""}`}
            title={p.workflow?.[d.workflowKey] ? `${d.label}: ready` : `${d.label}: to do`}
          >
            {d.label}
          </span>
        ))}
      </div>

      <div className="proj-card-foot">
        <span>{done} of {docs.length} deliverables</span>
        {!!meta?.costUsd && <span>${meta.costUsd.toFixed(2)}</span>}
      </div>
    </button>
  );
}

export default function Home({ onOpenChat }: { onOpenChat: (name: string) => void }) {
  const projects = useChatStore((s) => s.projects);
  const [filter, setFilter] = useState("");
  const [modalOpen, setModalOpen] = useState(false);

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return projects
      .filter((p) => !q || p.name.toLowerCase().includes(q) || (p.client ?? "").toLowerCase().includes(q))
      .slice()
      .sort((a, b) => (b.modified ?? 0) - (a.modified ?? 0));
  }, [projects, filter]);

  return (
    <div id="home">
      <div className="home-head">
        <div>
          <h1>Dyla</h1>
          {/* The name is an acronym and nobody guesses it: it says so once, here, where
              someone opening the app for the first time is already looking. */}
          <p className="home-tagline">Develop Your Local Assistant</p>
          <p className="home-sub">
            From discovery to delivery: briefs, estimates, dev tasks, mockups, tests and project decks.
          </p>
        </div>
        <button type="button" className="mini-btn primary" onClick={() => setModalOpen(true)}>
          <Icon name="plus" size={13} /> new project
        </button>
      </div>

      <AgendaPanel onOpenChat={onOpenChat} />

      {projects.length > 4 && (
        <input
          className="home-filter"
          placeholder="Search a project…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      )}

      {projects.length === 0 ? (
        <div className="home-empty">
          <div className="big-icon"><Icon name="compass" size={36} /></div>
          <p>No projects yet.</p>
          <p className="muted">
            Create one: choose whether you start from a brief you already have, or from meetings with the client.
          </p>
        </div>
      ) : (
        <div className="proj-grid">
          {visible.map((p) => <ProjectCard key={p.name} p={p} onOpen={onOpenChat} />)}
          {!visible.length && (
            <div className="home-empty">No project matches "{filter}".</div>
          )}
        </div>
      )}

      <button type="button" className="home-quickchat" onClick={() => onOpenChat("_global")}>
        <Icon name="message-circle" size={14} />
        Quick chat, no project
      </button>

      {modalOpen && (
        <NewProjectModal
          initialName=""
          onClose={(created) => {
            setModalOpen(false);
            if (created) onOpenChat(created);
          }}
        />
      )}
    </div>
  );
}
