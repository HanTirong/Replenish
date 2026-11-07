import { useEffect, type ReactNode } from "react";
import type { PaidOrder } from "../api";
import { dollars, paidCaptureLine } from "../copy";

export function OrderSheet({ order, onClose, onReceive, busy, error, feedback }: {
  order: PaidOrder;
  onClose: () => void;
  onReceive: () => void;
  busy: boolean;
  error: string | null;
  feedback?: ReactNode;
}) {
  useEffect(() => {
    const close = (event: KeyboardEvent) => { if (event.key === "Escape" && !busy) onClose(); };
    document.addEventListener("keydown", close);
    return () => document.removeEventListener("keydown", close);
  }, [busy, onClose]);
  return (
    <>
      <div className="scrim" />
      <div className="sheet order-sheet" role="dialog" aria-modal="true" aria-label="Qizai's food order">
        <div className="grab" />
        <h2>Qizai's food order.</h2>
        {feedback}
        <span className="badge"><i />Sandbox · Example store</span>
        <div className="card">
          <p>{order.productName}</p>
          <p className="hint">{order.productDetail}</p>
          <p>{dollars(order.totalCents, 2)}</p>
          <p className="hint">{order.captureId ? paidCaptureLine(order.captureId) : "Test-store payment confirmed."}</p>
        </div>
        <p className="reason">Confirm only after the food has arrived. This records a simulated delivery and schedules the next bag.</p>
        {error ? <p className="notice" role="alert">{error}</p> : null}
        <div className="acts">
          <button type="button" className="btn primary" onClick={onReceive} disabled={busy}>{busy ? "Recording receipt…" : "Food received"}</button>
          <button type="button" className="btn secondary" onClick={onClose} disabled={busy}>Close</button>
        </div>
      </div>
    </>
  );
}
