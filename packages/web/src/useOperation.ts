import { useEffect, useRef, useState } from "react";
import { getOperation, postChat, postUndo, RequestError, type ChatPayload } from "./api";

const STORAGE = "replenish.pending-operation.v1";
export interface PendingOperation {
  id: string; kind: "chat" | "undo" | "action"; label: string; success?: string;
  text?: string; revisionId?: number; showChat?: boolean;
}
export interface OperationState extends PendingOperation {
  phase: "pending" | "confirmed" | "rejected" | "unconfirmed";
  message?: string; result?: ChatPayload; syncing?: boolean; syncFailed?: boolean; retryAllowed?: boolean;
}
function readPending(): PendingOperation | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(STORAGE) || "null") as PendingOperation | null;
    if (!value || !/^[A-Za-z0-9_-]{1,128}$/.test(value.id) || !["chat", "undo", "action"].includes(value.kind) || typeof value.label !== "string") return null;
    if (value.kind === "chat" && typeof value.text !== "string") return null;
    return { id: value.id, kind: value.kind, label: value.label, success: typeof value.success === "string" ? value.success : undefined,
      text: typeof value.text === "string" ? value.text : undefined, revisionId: Number.isSafeInteger(value.revisionId) ? value.revisionId : undefined, showChat: value.showChat === true };
  } catch { return null; }
}
function persist(value: PendingOperation | null, expectedId?: string) {
  try {
    if (value) {
      const { id, kind, label, success, text, revisionId, showChat } = value;
      sessionStorage.setItem(STORAGE, JSON.stringify({ id, kind, label, success, text, revisionId, showChat }));
    } else if (!expectedId || readPending()?.id === expectedId) sessionStorage.removeItem(STORAGE);
  } catch { /* Private browsing may disable storage. In-memory recovery remains available. */ }
}

export function useOperation(refresh: () => Promise<unknown>) {
  const [operation, setOperation] = useState<OperationState | null>(() => {
    const pending = readPending();
    return pending ? { ...pending, phase: "unconfirmed", message: "The previous operation has no confirmation yet. Check its status before repeating it." } : null;
  });
  const current = useRef(operation), working = useRef(false), refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  function update(next: OperationState | null) { current.current = next; setOperation(next); }
  async function sync(state: OperationState) {
    update({ ...state, syncing: true });
    try { await refreshRef.current(); update({ ...state, syncing: false, syncFailed: false }); }
    catch { update({ ...state, syncing: false, syncFailed: true }); }
  }
  async function run<T>(work: (id: string) => Promise<T>, pending: PendingOperation) {
    if (working.current || current.current?.phase === "unconfirmed") return undefined;
    working.current = true; persist(pending); update({ ...pending, phase: "pending" });
    try {
      const result = await work(pending.id);
      persist(null, pending.id);
      const chat = pending.kind !== "action" ? result as ChatPayload : undefined;
      await sync({ ...pending, phase: "confirmed", result: chat, message: pending.success ?? "The operation completed. Check the latest household status." });
      return result;
    } catch (error) {
      const rejected = error instanceof RequestError && error.operationStatus === "rejected";
      if (rejected) persist(null, pending.id);
      const message = error instanceof RequestError ? error.message : "No confirmation has arrived. Check the latest status before repeating this action.";
      update({ ...pending, phase: rejected ? "rejected" : "unconfirmed", message });
      await refreshRef.current().catch(() => undefined);
      return undefined;
    } finally { working.current = false; }
  }
  async function verify() {
    const state = current.current;
    if (!state || working.current) return;
    working.current = true; update({ ...state, syncing: true });
    try {
      if (state.phase === "confirmed") { await sync(state); return; }
      if (state.kind === "action") {
        await refreshRef.current();
        update({ ...state, syncing: false, message: "The latest household status is loaded. The original operation is still unconfirmed; review it before continuing." });
        return;
      }
      const found = await getOperation(state.kind, state.id);
      if (found.status === "completed") {
        persist(null, state.id); await sync({ ...state, phase: "confirmed", result: found.result, message: "The saved result was recovered. The request was not repeated.", retryAllowed: false });
      } else update({ ...state, phase: "unconfirmed", syncing: false, retryAllowed: true, message: "No saved receipt is available yet. The original request may still be processing. You can check again or retry this same request safely." });
    } catch { update({ ...state, syncing: false, message: "Status is temporarily unavailable. The original outcome remains unconfirmed.", retryAllowed: false }); }
    finally { working.current = false; }
  }
  function retry() {
    const state = current.current;
    if (!state || !state.retryAllowed || state.kind === "action" || working.current) return;
    update({ ...state, phase: "rejected" });
    return run(id => state.kind === "chat" ? postChat(state.text!, id, state.revisionId) : postUndo(id, state.revisionId), state);
  }
  function dismiss() {
    if (working.current || current.current?.phase === "pending" || current.current?.syncFailed) return;
    persist(null, current.current?.id); update(null);
  }
  useEffect(() => { if (current.current?.phase === "unconfirmed") void verify(); }, []);
  return { operation, busy: operation?.phase === "pending" || Boolean(operation?.syncing),
    blocked: operation?.phase === "unconfirmed" || operation?.phase === "pending" || Boolean(operation?.syncing || operation?.syncFailed), run, verify, retry, dismiss };
}
