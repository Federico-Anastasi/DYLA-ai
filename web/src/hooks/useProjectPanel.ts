import { useCallback, useEffect, useRef, useState } from "react";
import { apiClient } from "../api/client";
import type { DocKind, ProjectDetail, ProjectSource, Workflow } from "../types";
import { OUTPUT_DOCS, statusFromMeta, type DocStatus } from "../lib/documentTabs";
import { useToastStore } from "../store/toastStore";

export type VersionsMap = Record<string, { v: number; file: string; ts: number }[]>;
export type DocStatusMap = Partial<Record<DocKind, DocStatus | undefined>>;

export function useProjectPanel(name: string, tick: number, enabled = true) {
  const [files, setFiles] = useState<string[]>([]);
  const [versions, setVersions] = useState<VersionsMap>({});
  const [workflow, setWorkflow] = useState<Workflow | null>(null);
  // Decides which tabs make sense: with source "discovery" the brief is one of our own
  // deliverables, with "brief" it is an input document. See lib/documentTabs.ts.
  const [source, setSource] = useState<ProjectSource>("brief");
  const [docStatuses, setDocStatuses] = useState<DocStatusMap>({});
  const [costUsd, setCostUsd] = useState<number | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  // Guards against an out-of-order response: refresh() runs both automatically (project/tick
  // change) and on demand (onSaved, onRefresh from children) — switch projects quickly, or
  // trigger two of these in a row, and an earlier call's Promise.all can resolve AFTER a
  // later one, painting a stale project's files/workflow/statuses over the current one.
  // Only the latest call is allowed to commit its results.
  const requestId = useRef(0);

  const refresh = useCallback(async () => {
    if (!enabled || !name) return;
    const id = ++requestId.current;
    setLoading(true);
    try {
      const [f, v, p] = await Promise.all([
        apiClient.listFiles(name),
        apiClient.listVersions(name),
        apiClient.getProject(name) as Promise<ProjectDetail>,
      ]);
      if (id !== requestId.current) return;
      setFiles(f);
      setVersions(v);
      setWorkflow(p.workflow);
      setSource(p.source ?? "brief");
      setCostUsd(p.cost_usd);

      // meta.status ("draft"|"confirmed") is optional and lives inside the doc's JSON: to show
      // the badge on the tab bar we only read it for the docs that are already generated.
      const present = OUTPUT_DOCS.filter((d) => p.workflow[d.workflowKey]);
      const statusEntries = await Promise.all(
        present.map(async (d) => {
          try {
            const doc = await apiClient.getDoc(name, d.doc);
            return [d.doc, statusFromMeta((doc as { meta?: unknown }).meta)] as const;
          } catch {
            return [d.doc, undefined] as const;
          }
        }),
      );
      if (id !== requestId.current) return;
      setDocStatuses(Object.fromEntries(statusEntries));
    } catch (e) {
      if (id === requestId.current) {
        useToastStore.getState().push(e instanceof Error ? e.message : "Could not load the project", "error");
      }
    } finally {
      if (id === requestId.current) setLoading(false);
    }
  }, [name, enabled]);

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name, tick, enabled]);

  return { files, versions, workflow, source, docStatuses, costUsd, loading, refresh };
}
