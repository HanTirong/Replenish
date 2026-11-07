import { useEffect, useRef, useState, type ReactNode } from "react";
import { getActivity, getBudget, type ActivityPayload, type BudgetPayload, type HomePayload } from "../api";
import { dollars } from "../copy";
import { GuidePage, GuideSpot, useGuide } from "./guide";

export type DetailKind = "pet" | "plan" | "budget" | "activity" | "notifications";
export function DetailSheet({ title, onClose, busy, children, error, className = "" }: {
  title: string; onClose: () => void; busy: boolean; children: ReactNode; error?: string | null; className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  const working = useRef(busy);
  close.current = onClose;
  working.current = busy;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !working.current) { event.preventDefault(); close.current(); }
      if (event.key !== "Tab") return;
      const targets = [...(ref.current?.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled), a[href]") ?? [])];
      const first = targets[0], last = targets.at(-1);
      if (!first || !last) { event.preventDefault(); return; }
      if (event.shiftKey && (document.activeElement === first || document.activeElement === ref.current)) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || document.activeElement === ref.current)) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", key);
    return () => { document.removeEventListener("keydown", key); previous?.focus(); };
  }, []);
  return <>
    <div className="scrim" />
    <div className={`sheet detail-sheet ${className}`} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} ref={ref}>
      <div className="grab" />
      <div className="detail-heading"><h2>{title}</h2><button type="button" className="link" disabled={busy} onClick={onClose}>Close</button></div>
      {error ? <p className="notice" role="alert">{error}</p> : null}
      {children}
    </div>
  </>;
}

export function PetDetails({ home, busy, onCalibrate, onFeeding, onUndo, onNavigate, workingLabel, onCompose, guideAvailable = false }: {
  home: HomePayload; busy: boolean; onCalibrate: (grams: number) => void; onFeeding: (grams: number) => void;
  onUndo: () => void; onNavigate: (kind: DetailKind) => void;
  workingLabel?: string;
  onCompose?: () => void; guideAvailable?: boolean;
}) {
  const guide = useGuide();
  const food = home.feeding;
  const [stock, setStock] = useState("");
  const [grams, setGrams] = useState("");
  if (!food) return <p className="reason">Feeding details are unavailable. Please refresh.</p>;
  return <>
    <GuideSpot active={guide.step === "details"} title="Food and feeding details" description="Food is estimated from the saved feeding plan; daily check-ins are optional." actions={<><button type="button" className="link" onClick={() => guide.setStep("explore")}>Show other places</button><button type="button" className="link" onClick={onCompose}>Go to message box</button></>}>
    <dl className="detail-rows">
      <div><dt>Estimated food left</dt><dd>{Math.round(food.stockG).toLocaleString("en-US")} g</dd></div>
      <div><dt>Daily use</dt><dd>{food.dailyGrams} g</dd></div>
      <div><dt>Feeding plan</dt><dd>{food.mealsPerDay} × {food.gramsPerMeal} g</dd></div>
    </dl>
    </GuideSpot>
    <p className="hint">Food is estimated from scheduled meals. Tell me about a change; daily check-ins are optional.</p>
    <form className="detail-form" onSubmit={event => { event.preventDefault(); onCalibrate(Number(stock)); }}>
      <label htmlFor="stock">Food remaining in the bag (g)</label>
      <input id="stock" type="number" inputMode="decimal" min="0" step="any" required value={stock} onChange={event => setStock(event.target.value)} placeholder={String(Math.round(food.stockG))} disabled={busy} />
      <button type="submit" className="btn secondary" disabled={busy}>{busy && workingLabel?.startsWith("Calibrating") ? workingLabel : "Calibrate stock"}</button>
    </form>
    <form className="detail-form" onSubmit={event => { event.preventDefault(); onFeeding(Number(grams)); }}>
      <label htmlFor="grams">New grams per meal</label>
      <input id="grams" type="number" inputMode="decimal" min="0.1" max="5000" step="any" required value={grams} onChange={event => setGrams(event.target.value)} placeholder={String(food.gramsPerMeal)} disabled={busy} />
      <button type="submit" className="btn primary" disabled={busy}>{busy && workingLabel?.startsWith("Saving feeding") ? workingLabel : "Save feeding plan"}</button>
    </form>
    <p className="hint">Changes recalculate the forecast immediately. The order date moves when needed under the 24-hour rule.</p>
    <button type="button" className="link" onClick={onUndo} disabled={busy || !home.undoRevisionId}>{busy && workingLabel?.startsWith("Undoing") ? workingLabel : "Undo last feeding change"}</button>
    {guideAvailable && !guide.step ? <button type="button" className="link guide-explain" onClick={() => guide.start("explore")}>Show me around</button> : null}
    <GuideSpot active={guide.step === "explore"} title="Explore more here" description="Choose a real link below for the plan, budget, activity or notifications. These pages are optional." actions={<button type="button" className="link" onClick={onCompose}>Go to message box</button>}>
    <nav className="detail-nav" aria-label="Household details">
      <button type="button" className="link" onClick={() => onNavigate("plan")}>Replenishment plan</button>
      <button type="button" className="link" onClick={() => onNavigate("budget")}>Budget details</button>
      <button type="button" className="link" onClick={() => onNavigate("activity")}>Recent activity</button>
      <button type="button" className="link" onClick={() => onNavigate("notifications")}>Notifications</button>
    </nav>
    </GuideSpot>
  </>;
}

export function PlanDetails({ home, selectedDay }: { home: HomePayload; selectedDay: number | null }) {
  const date = selectedDay === null ? null : home.dates[selectedDay];
  const plan = home.plan;
  return <>
    <AgentDetails home={home} />
    {date ? <p className="reason">{date.date}: {date.markers.length ? date.markers.map(marker => ({ order: "planned order", delivery: "expected delivery", runout: "estimated runout", skip: "skipped meal" })[marker] ?? marker).join(", ") : "No planned event."}</p> : null}
    <GuidePage kind="plan"><ol className="plan-nodes">
      <li><span>Planned order</span><strong>{formatPlanDate(plan.plannedOrderAt ?? plan.orderDateRaw, home.pet.timezone)}</strong></li>
      <li><span>Expected delivery</span><strong>{formatPlanDate(plan.estimatedDeliveryAt, home.pet.timezone)}</strong></li>
      <li><span>Estimated runout</span><strong>{formatPlanDate(plan.predictedRunoutAt, home.pet.timezone)}</strong></li>
    </ol></GuidePage>
    <p className="hint">Forecast dates in {home.pet.timezone}. These are planned events; actual payment and delivery are shown on the order.</p>
    <dl className="detail-rows">
      <div><dt>Estimated stock</dt><dd>{home.feeding ? `${Math.round(home.feeding.stockG)} g` : "Unavailable"}</dd></div>
      <div><dt>Daily use</dt><dd>{home.feeding ? `${home.feeding.dailyGrams} g` : "Unavailable"}</dd></div>
      <div><dt>Store shipping time</dt><dd>{plan.shippingHours ?? "—"} hours</dd></div>
      <div><dt>Safety buffer</dt><dd>{plan.bufferHours ?? "—"} hours</dd></div>
    </dl>
    <p className="reason">{home.order ? "This order is already paid. Feeding changes affect the next forecast and will not cancel it." : "The order date is calculated from estimated runout, shipping time and a safety buffer."}</p>
  </>;
}

function AgentDetails({ home }: { home: HomePayload }) {
  const agent = home.agentStatus;
  const labels: Record<string, string> = { disabled: "Background checks disabled", not_checked: "No completed check yet", running: "A check is in progress", waiting: "Waiting for the next check", failed: "Last check failed", interrupted: "Previous check was interrupted", stale: "Check status is overdue" };
  return <section aria-label="Agent status">
    <h3 className="detail-subheading">Agent status</h3>
    {!agent ? <p className="hint">No background check record is available.</p> : <>
      <p className={ ["failed", "interrupted", "stale"].includes(agent.state) ? "notice" : "reason" }>{labels[agent.state] ?? "Status unavailable"}</p>
      <dl className="detail-rows">
        <div><dt>Last check started</dt><dd>{formatInstant(agent.lastStartedAt ?? undefined, home.pet.timezone, true)}</dd></div>
        <div><dt>Last successful check</dt><dd>{formatInstant(agent.lastSucceededAt ?? undefined, home.pet.timezone, true)}</dd></div>
        <div><dt>Next expected check</dt><dd>{agent.enabled ? formatInstant(agent.nextCheckAt ?? undefined, home.pet.timezone, true) : "Disabled"}</dd></div>
      </dl>
      <p className="reason">{agent.waitingReason}</p>
      {agent.lastResult && agent.lastResult !== agent.waitingReason ? <p className="hint">Last check result: {agent.lastResult}</p> : null}
    </>}
    <p className="hint">Check times update when the agent runs. Opening this page does not run a check. Active describes the automatic buying setting.</p>
  </section>;
}

export function BudgetDetails({ home, busy, onSave, workingLabel }: { home: HomePayload; busy: boolean; workingLabel?: string; onSave: (input: { perOrderLimitCents: number; monthlyLimitCents: number }) => void }) {
  const [budget, setBudget] = useState<BudgetPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [perOrder, setPerOrder] = useState(String(home.budget.perOrderLimitCents / 100));
  const [monthly, setMonthly] = useState(String(home.budget.monthlyLimitCents / 100));
  useEffect(() => {
    let alive = true;
    void getBudget().then(value => { if (alive) { setBudget(value); setError(null); } }).catch(() => { if (alive) setError("Could not load this month's budget. Reopen to retry."); });
    return () => { alive = false; };
  }, [home]);
  return <>
    {error ? <p className="notice" role="alert">{error}</p> : null}
    {budget ? <dl className="detail-rows">
      <div><dt>Settled this month</dt><dd>{dollars(budget.monthSettledCents, 2)}</dd></div>
      <div><dt>Committed to open orders</dt><dd>{dollars(budget.monthCommittedCents, 2)}</dd></div>
      <div><dt>Remaining this month</dt><dd>{dollars(budget.monthRemainingCents, 2)}</dd></div>
    </dl> : <p className="hint">Loading budget…</p>}
    <p className="hint">Calendar month in {home.pet.timezone} · USD. Open orders remain reserved across months until their outcome is confirmed. A one-time approval does not change these limits.</p>
    <GuidePage kind="budget"><form className="detail-form" onSubmit={event => { event.preventDefault(); onSave({ perOrderLimitCents: Math.round(Number(perOrder) * 100), monthlyLimitCents: Math.round(Number(monthly) * 100) }); }}>
      <label htmlFor="per-order">Per-order auto-pay limit ($)</label>
      <input id="per-order" type="number" inputMode="decimal" min="0.01" step="0.01" required value={perOrder} onChange={event => setPerOrder(event.target.value)} disabled={busy || !home.paypal.connected} />
      <label htmlFor="monthly">Monthly budget ($)</label>
      <input id="monthly" type="number" inputMode="decimal" min="0.01" step="0.01" required value={monthly} onChange={event => setMonthly(event.target.value)} disabled={busy || !home.paypal.connected} />
      <button type="submit" className="btn primary" disabled={busy || !home.paypal.connected}>{busy ? workingLabel ?? "Saving…" : "Save limits"}</button>
    </form></GuidePage>
    {!home.paypal.connected ? <p className="hint">Connect PayPal from the status button to edit limits.</p> : null}
  </>;
}

export function ActivityDetails({ home }: { home: HomePayload }) {
  const [items, setItems] = useState<ActivityPayload[] | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    let alive = true;
    void getActivity().then(value => { if (alive) setItems(value); }).catch(() => { if (alive) setError(true); });
    return () => { alive = false; };
  }, [home]);
  if (error) return <p className="notice" role="alert">Could not load recent activity. Reopen to retry.</p>;
  if (!items) return <p className="hint">Loading recent activity…</p>;
  return <GuidePage kind="activity">{items.length ? <ul className="activity-list">{items.map(item => <li key={item.id}>
    <p>{item.summary}</p><time dateTime={item.at}>{formatInstant(item.at, home.pet.timezone)}</time>
    {activityChange(item, home.pet.timezone) ? <p className="hint">{activityChange(item, home.pet.timezone)}</p> : null}
  </li>)}</ul> : <p className="reason">No activity yet. Feeding changes and buying decisions will appear here.</p>}</GuidePage>;
}

function activityChange(item: ActivityPayload, timeZone: string): string | null {
  const before = item.before_json, after = item.after_json;
  if (before === null || after === null) return null;
  if (item.kind === "feeding") return `Order date: ${formatInstant(before, timeZone)} → ${formatInstant(after, timeZone)}`;
  if (item.kind === "stock" || item.kind === "delivery") return `Estimated stock: ${Math.round(Number(before))} g → ${Math.round(Number(after))} g`;
  if (item.kind === "budget") {
    try {
      const old = JSON.parse(before) as { perOrder: number; monthly: number };
      const next = JSON.parse(after) as { perOrder: number; monthly: number };
      return `Per order: ${dollars(old.perOrder, 2)} → ${dollars(next.perOrder, 2)}. Monthly: ${dollars(old.monthly, 2)} → ${dollars(next.monthly, 2)}.`;
    } catch { return null; }
  }
  return null;
}

function formatInstant(value: string | undefined, timeZone: string, includeSeconds = false) {
  if (!value || !Number.isFinite(Date.parse(value))) return "Unavailable";
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", ...(includeSeconds ? { second: "2-digit" as const } : {}), timeZone }).format(new Date(value));
}

function formatPlanDate(value: string | undefined, timeZone: string) {
  if (!value || !Number.isFinite(Date.parse(value))) return "Unavailable";
  return new Intl.DateTimeFormat("en-US", { year: "numeric", month: "short", day: "numeric", timeZone }).format(new Date(value));
}
