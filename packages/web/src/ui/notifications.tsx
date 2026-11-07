import { useEffect, useRef, useState } from "react";
import { getNotifications, getOrder, type HomePayload, type NotificationStatus, type PaidOrder } from "../api";
import { dollars } from "../copy";
import { DetailSheet } from "./details";
import { GuidePage } from "./guide";

export function NotificationDetails({ home }: { home: HomePayload }) {
  const [status, setStatus] = useState<NotificationStatus | undefined>(home.notifications);
  const [checking, setChecking] = useState(true), [refreshFailed, setRefreshFailed] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const refresh = useRef<() => void>(() => {}), copySequence = useRef(0);
  useEffect(() => {
    let active = true, inFlight = false;
    const load = async () => {
      if (!active || inFlight) return;
      inFlight = true; setChecking(true);
      try {
        const latest = await getNotifications();
        if (typeof latest.configured !== "boolean" || typeof latest.enabled !== "boolean") throw new Error("Unverified notification status");
        if (active) { setStatus(latest); setRefreshFailed(false); }
      } catch { if (active) setRefreshFailed(true); }
      finally { inFlight = false; if (active) setChecking(false); }
    };
    const visible = () => { if (document.visibilityState !== "hidden") void load(); };
    refresh.current = () => { void load(); };
    visible();
    const timer = window.setInterval(visible, 10_000);
    window.addEventListener("focus", visible); document.addEventListener("visibilitychange", visible);
    return () => {
      active = false; copySequence.current++; window.clearInterval(timer); refresh.current = () => {};
      window.removeEventListener("focus", visible); document.removeEventListener("visibilitychange", visible);
    };
  }, []);
  async function copy(command: "/start" | "/test") {
    const sequence = ++copySequence.current;
    try {
      await navigator.clipboard.writeText(command);
      if (sequence === copySequence.current) setCopied(`Copied ${command}. Paste it into the owner's Bot chat.`);
    } catch { if (sequence === copySequence.current) setCopied(`Copy is unavailable here. Type ${command} in the owner's Bot chat.`); }
  }
  const configured = Boolean(status?.configured), enabled = Boolean(status?.enabled);
  const test = status?.setup?.test;
  const testAccepted = enabled && test?.status === "sent";
  const unavailable = status?.commandStatus === "unavailable" || status?.queueError;
  const heading = !configured ? "Owner setup is needed." : unavailable ? "Telegram checks need attention." : !enabled
    ? "Waiting for the owner to turn notifications on." : testAccepted ? "Notifications are on." : "Notifications are on. Try a test message.";
  const guide = <details className="notification-setup" open={!testAccepted}>
    <summary>Connection steps</summary>
    <ol className="notification-steps" aria-label="Notification setup">
      <SetupStep number={1} done={configured} title="Prepare the owner's Bot" description={configured ? "Bot setup is available for this demo." : "The owner needs to finish Bot setup. Orders and payment rules are ready to use."} />
      <SetupStep number={2} done={enabled} title="Turn notifications on" description={enabled ? "The owner's /start command was received. Automatic payment authorization stays separate." : "In the owner's Bot chat, send /start. Allow about 15 seconds for it to appear here."} />
      <SetupStep number={3} done={testAccepted} title="Try a test message" description={testAccepted ? "Telegram accepted the test. Check the owner's chat to see it." : test ? testFeedback(test.status) : "Send /test in the owner's Bot chat. It creates no order and makes no payment."} />
    </ol>
    {configured ? <nav className="detail-nav" aria-label="Telegram setup actions">
      {status?.botUrl ? <a className="link" href={status.botUrl} target="_blank" rel="noreferrer">Open Telegram</a> : <p className="hint">Open the Bot you created in Telegram.</p>}
      <button type="button" className="link" onClick={() => void copy(enabled ? "/test" : "/start")}>Copy {enabled ? "/test" : "/start"}</button>
    </nav> : null}
    {copied ? <p className="hint" role="status">{copied}</p> : null}
  </details>;
  return <>
    <p className={`operation-feedback${unavailable ? " caution" : ""}`} role="status">{heading}</p>
    <p className="reason">Key updates reach the owner's Telegram chat even with this webpage closed. No Replenish app is needed.</p>
    {!testAccepted ? guide : null}
    <button type="button" className="link notification-refresh" disabled={checking} onClick={() => refresh.current()}>{checking ? "Checking notification status…" : "Refresh notification status"}</button>
    {refreshFailed ? <p className="notice" role="alert">Could not refresh. Showing the last confirmed status; check again before relying on it.</p> : null}
    {unavailable ? <p className="notice">Notifications are temporarily unavailable. Check the website for the latest order status.</p> : null}
    <dl className="detail-rows">
      <div><dt>Telegram</dt><dd>{!configured ? "Not configured" : enabled ? "On" : "Off"}</dd></div>
      <div><dt>Last Bot check</dt><dd>{notificationTime(status?.setup?.lastCommandCheckedAt, home.pet.timezone)}</dd></div>
      <div><dt>Last attempt</dt><dd>{status?.lastOutcome ? deliveryLabel(status.lastOutcome) : "No messages yet"}</dd></div>
      {status?.pending ? <div><dt>Queued</dt><dd>{status.pending}</dd></div> : null}
    </dl>
    <h3 className="detail-subheading">Recent Agent reports</h3>
    {status?.recent?.length ? <ul className="activity-list notification-history" aria-label="Recent Agent reports">{status.recent.map((report, index) => <li key={`${report.kind}:${report.createdAt}:${index}`}>
      <strong>{reportLabel(report.kind)}</strong><span>{deliveryLabel(report.status)}</span>
      <time dateTime={report.acceptedAt ?? report.attemptedAt ?? report.createdAt}>{notificationTime(report.acceptedAt ?? report.attemptedAt ?? report.createdAt, home.pet.timezone)}</time>
    </li>)}</ul> : <p className="hint">No key-event reports since the latest /start. Test messages are shown in the setup steps above.</p>}
    {testAccepted ? guide : null}
    <GuidePage kind="notifications"><details className="notification-setup"><summary>What I'll report</summary>
      <ul className="notification-events"><li>An order needs approval</li><li>A payment is confirmed</li><li>A payment needs attention</li><li>Food may run out before delivery</li></ul>
    </details></GuidePage>
    <p className="hint">Routine checks stay quiet. This shared demo reports only to its owner's private chat. Orders and payments stay on the website.</p>
    <p className="hint">Telegram acceptance does not confirm phone delivery or reading. An unconfirmed send is not automatically repeated.</p>
    <p className="hint">Send /stop in the owner's Bot chat to turn notifications off, or /status to check. Turning notifications off does not pause the Agent.</p>
  </>;
}

function SetupStep({ number, done, title, description }: { number: number; done: boolean; title: string; description: string }) {
  return <li className={done ? "complete" : ""}><span className="notification-step-number" aria-hidden="true">{done ? "✓" : number}</span><div><strong>{title}</strong><span className="notification-step-state">{done ? "Done" : "Waiting"}</span><p>{description}</p></div></li>;
}
function testFeedback(status: string) {
  if (status === "pending") return "The /test command was received. Its test message is queued.";
  if (status === "sending") return "The test message is being sent. Wait for its result.";
  if (status === "unknown") return "The test result is unconfirmed. Check the owner's Bot chat before trying again.";
  if (status === "failed") return "Telegram rejected the test. Check Bot setup before sending /test again.";
  return "Send /test again after turning notifications on.";
}
function deliveryLabel(status: string) {
  return ({ sent: "Telegram accepted the message", unknown: "Send result unconfirmed", failed: "Telegram rejected the message", sending: "Sending", pending: "Queued" } as Record<string, string>)[status] ?? "Pending";
}
function reportLabel(kind: string) {
  return ({ approval: "Approval requested", paid: "Payment confirmed", payment_failed: "Payment could not be completed", payment_unknown: "Payment needs verification", food_risk: "Food-shortage risk" } as Record<string, string>)[kind] ?? "Agent report";
}
function notificationTime(value: string | null | undefined, timeZone: string) {
  if (!value || !Number.isFinite(Date.parse(value))) return "Not checked yet";
  try { return new Intl.DateTimeFormat("en-US", { timeZone, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(value)); }
  catch { return "Time unavailable"; }
}

/** A notification always opens its own order, including when a newer order needs approval. */
export function LinkedOrder({ id, home, onClose, onReview, onReceipt }: {
  id: string; home: HomePayload; onClose: () => void; onReview: () => void; onReceipt: () => void;
}) {
  const [order, setOrder] = useState<PaidOrder | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    void getOrder(id).then(value => { if (active) setOrder(value); }, () => { if (active) setError("This order is unavailable. No action has been taken."); });
    return () => { active = false; };
  }, [id, home]);
  const currentApproval = order && home.pendingApproval?.orderId === order.id;
  const currentReceipt = order && home.order?.id === order.id && order.paymentStatus === "paid";
  return <DetailSheet title="Order from notification" busy={false} onClose={onClose} error={error}>
    {order ? <>
      <p className="reason">{order.productName} · {order.productDetail}</p>
      <dl className="detail-rows">
        <div><dt>Order</dt><dd className="order-reference">{order.id}</dd></div>
        <div><dt>Total</dt><dd>{dollars(order.totalCents, 2)}</dd></div>
        <div><dt>Status</dt><dd>{order.status.replaceAll("_", " ")}</dd></div>
        <div><dt>Payment</dt><dd>{order.paymentStatus === "unknown" ? "Needs verification" : order.paymentStatus === "none" ? "Not paid" : order.paymentStatus}</dd></div>
      </dl>
      {currentApproval ? <button type="button" className="btn primary" onClick={onReview}>Review this approval</button> : null}
      {currentReceipt ? <button type="button" className="btn primary" onClick={onReceipt}>Open this receipt</button> : null}
      {!currentApproval && !currentReceipt ? <p className="hint">This is the order linked in your message. It has no action available here. Close to see the latest household status.</p> : null}
      <p className="hint">Opening a notification does not approve an order or make a payment.</p>
    </> : !error ? <p className="reason">Loading this order…</p> : null}
  </DetailSheet>;
}
