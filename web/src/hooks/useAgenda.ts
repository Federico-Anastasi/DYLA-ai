import { useCallback, useEffect, useState } from "react";
import { apiClient, ApiError } from "../api/client";
import { useToastStore } from "../store/toastStore";
import type { AgendaDoc, AgendaItem, ProposedAgendaItem } from "../types";

/**
 * State of the personal agenda: it loads the document (which cuts across projects) and
 * exposes the mutations the panel and its rows need. Every mutation calls the API and then
 * reloads: the buckets (today/tomorrow/thisWeek/...) are recomputed by the backend against
 * the current date, so there is no point keeping them up to date by hand on the client — the
 * document is small and the call is local, the round trip is instant.
 */
export function useAgenda() {
  const [doc, setDoc] = useState<AgendaDoc | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const d = await apiClient.getAgenda();
      setDoc(d);
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not load the agenda");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const reportError = (e: unknown, fallback: string) => {
    useToastStore.getState().push(e instanceof ApiError ? e.message : fallback, "error");
  };

  const patch = useCallback(
    async (id: string, patchObj: Partial<AgendaItem> | Record<string, unknown>) => {
      try {
        await apiClient.patchAgendaItem(id, patchObj);
        await refresh();
      } catch (e) {
        reportError(e, "Could not update the item");
      }
    },
    [refresh],
  );

  const setDone = useCallback(
    (id: string, done: boolean) => patch(id, { status: done ? "done" : "open" }),
    [patch],
  );

  // Moves to tomorrow relative to today (not +1 day relative to the item's current date):
  // this is a quick deferral, not a relative shift.
  const moveToTomorrow = useCallback(
    (id: string) => {
      const d = new Date();
      d.setDate(d.getDate() + 1);
      const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      return patch(id, { due: iso });
    },
    [patch],
  );

  const remove = useCallback(
    async (id: string) => {
      try {
        await apiClient.deleteAgendaItem(id);
        await refresh();
      } catch (e) {
        reportError(e, "Could not delete the item");
      }
    },
    [refresh],
  );

  const addQuick = useCallback(
    async (text: string) => {
      const t = text.trim();
      if (!t) return;
      try {
        await apiClient.addAgendaItems([{ text: t }], "manual");
        await refresh();
      } catch (e) {
        reportError(e, "Could not create the item");
      }
    },
    [refresh],
  );

  const addProposed = useCallback(
    async (items: ProposedAgendaItem[]) => {
      try {
        await apiClient.addAgendaItems(items, "voice");
        await refresh();
      } catch (e) {
        reportError(e, "Could not add the tasks");
        throw e;
      }
    },
    [refresh],
  );

  return {
    doc,
    loading,
    error,
    refresh,
    patch,
    setDone,
    moveToTomorrow,
    remove,
    addQuick,
    addProposed,
  };
}
