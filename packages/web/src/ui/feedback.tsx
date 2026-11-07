import type { OperationState } from "../useOperation";

export function OperationFeedback({ operation, onCheck, onRetry, onDismiss, onView }: {
  operation: OperationState | null; onCheck: () => void; onRetry: () => void; onDismiss: () => void; onView?: () => void;
}) {
  if (!operation) return null;
  const unknown = operation.phase === "unconfirmed";
  return <div className={`operation-feedback${unknown || operation.phase === "rejected" ? " caution" : ""}`} role={unknown || operation.phase === "rejected" ? "alert" : "status"} aria-live="polite" aria-atomic="true">
    <p>{operation.phase === "pending" ? operation.label : operation.message}</p>
    {operation.phase === "confirmed" && operation.syncFailed ? <p>Confirmed. The latest page state is still syncing.</p> : null}
    {operation.showChat && onView ? <button type="button" className="link" onClick={onView}>{operation.result ? "View result" : "View request"}</button> : null}
    {unknown || operation.syncFailed ? <button type="button" className="link" disabled={operation.syncing} onClick={onCheck}>{operation.syncing ? "Checking…" : "Check latest status"}</button> : null}
    {unknown && operation.retryAllowed ? <button type="button" className="link" disabled={operation.syncing} onClick={onRetry}>Retry same request</button> : null}
    {operation.phase !== "pending" && !operation.syncing && !operation.syncFailed && (!unknown || operation.kind === "action") ? <button type="button" className="link" onClick={onDismiss}>{unknown ? "Continue after reviewing" : "Dismiss"}</button> : null}
  </div>;
}
