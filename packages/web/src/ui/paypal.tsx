import { useState, type ReactNode } from "react";
import { PAYPAL_TITLES } from "../copy";
import { CalendarIcon, CheckIcon, ChevronIcon, TagIcon } from "./icons";
import { Composer, Headline, Phone, TopBar } from "./chrome";

export type PayPalPhase = keyof typeof PAYPAL_TITLES;

export function PayPalScreen({
  screen,
  phase,
  perOrder,
  monthly,
  onPrimary,
  onPause,
  paused = false,
  pauseReason,
  onKeepPaused,
  busy = false,
  workingLabel,
  feedback,
  error,
  onEditLimit,
  onReorderNow,
  last4,
  draft,
  onDraft,
  onSend,
  onBudget,
  onActivity,
  onNotifications,
  onBack,
  sheet,
}: {
  screen: string;
  phase: PayPalPhase;
  perOrder: string;
  monthly: string;
  onPrimary: () => void;
  onPause?: () => void;
  paused?: boolean;
  pauseReason?: string | null;
  onKeepPaused?: () => void;
  busy?: boolean;
  workingLabel?: string;
  feedback?: ReactNode;
  error?: string | null;
  onEditLimit?: (which: "perOrder" | "monthly") => void;
  onReorderNow?: (maintenanceToken: string) => void;
  last4?: string | null;
  draft: string;
  onDraft: (value: string) => void;
  onSend: (value: string) => void;
  onBudget?: () => void;
  onActivity?: () => void;
  onNotifications?: () => void;
  onBack?: () => void;
  sheet?: ReactNode;
}) {
  const editable = phase !== "disconnected";
  const [maintenanceToken, setMaintenanceToken] = useState("");
  return (
    <Phone screen={screen}>
      <TopBar />
      <div className="content">
        <Headline text={paused && phase === "authorized" ? "Automatic buying\nis paused." : PAYPAL_TITLES[phase]} />
        {feedback}
        <span className="badge">
          <i />
          Sandbox
        </span>
        <div className="pp">
          <div className="h">
            <span className="wm">
              <b>Pay</b>
              <em>Pal</em>
            </span>
            {phase === "disconnected" ? (
              <span className="pill off">
                <i />
                Not connected
              </span>
            ) : (
              <span className="pill">
                <i />
                Connected
              </span>
            )}
          </div>
          <p className="msg">{paused && phase === "authorized" ? pauseReason ?? "Automatic buying is paused. Your payment authorization is kept." : messageFor(phase, last4)}</p>
        </div>
        {paused && onKeepPaused ? <button type="button" className="link" onClick={onKeepPaused} disabled={busy}>Keep paused until I resume</button> : null}
        <div className={`limits${phase === "disconnected" ? " pending" : ""}`}>
          <LimitRow
            icon={<TagIcon />}
            title="Per-order limit"
            caption={phase === "disconnected" ? "Maximum per order" : "Maximum per order"}
            value={perOrder}
            editable={editable}
            onEdit={onEditLimit ? () => onEditLimit("perOrder") : undefined}
          />
          <LimitRow
            icon={<CalendarIcon size={22} />}
            title="Monthly limit"
            caption="Maximum per month"
            value={monthly}
            editable={editable}
            onEdit={onEditLimit ? () => onEditLimit("monthly") : undefined}
          />
        </div>
        {phase === "authorized" ? null : (
          <p className="hint">{phase === "disconnected" ? "You can change these after connecting." : "Tap a limit to change it."}</p>
        )}
        {phase === "authorized" ? (
          <div className="assure">
            <span className="ck">
              <CheckIcon />
            </span>
            <span>I'll only order within these limits. Anything above, I'll ask you first.</span>
          </div>
        ) : null}
        {error ? <p className="notice" role="alert">{error}</p> : null}
        {onReorderNow ? (
          <form className="detail-form" onSubmit={event => {
            event.preventDefault(); const token = maintenanceToken; setMaintenanceToken(""); onReorderNow(token);
          }}>
            <label htmlFor="maintenance-token">Maintenance access code</label>
            <input id="maintenance-token" type="password" autoComplete="off" value={maintenanceToken}
              onChange={event => setMaintenanceToken(event.target.value)} disabled={busy || paused} required />
            <button type="submit" className="link" disabled={busy || paused || !maintenanceToken}>Run reorder check now</button>
          </form>
        ) : null}
        {onBudget || onActivity || onNotifications || onBack ? <nav className="detail-nav" aria-label="Payment details">
          {onBudget ? <button type="button" className="link" onClick={onBudget}>Budget details</button> : null}
          {onActivity ? <button type="button" className="link" onClick={onActivity}>Recent activity</button> : null}
          {onNotifications ? <button type="button" className="link" onClick={onNotifications}>Notifications</button> : null}
          {onBack ? <button type="button" className="link" onClick={onBack}>Back to home</button> : null}
        </nav> : null}
      </div>
      <div className="bottom stack above-chat">
        <button type="button" className="btn primary" onClick={onPrimary} disabled={busy}>
          {busy ? workingLabel ?? "Please wait…" : primaryLabel(phase)}
        </button>
        {phase === "authorized" ? (
          <button type="button" className="link" onClick={onPause} disabled={busy}>
            {paused ? "Resume autopilot" : "Pause autopilot"}
          </button>
        ) : null}
      </div>
      <Composer value={draft} onChange={onDraft} onSend={onSend} busy={busy} />
      {sheet}
    </Phone>
  );
}

function LimitRow({
  icon,
  title,
  caption,
  value,
  editable,
  onEdit,
}: {
  icon: ReactNode;
  title: string;
  caption: string;
  value: string;
  editable: boolean;
  onEdit?: () => void;
}) {
  const body = (
    <>
      {icon}
      <div className="tx">
        <div className="t">{title}</div>
        <div className="c">{caption}</div>
      </div>
      <span className="v">{value}</span>
      {editable ? <ChevronIcon /> : null}
    </>
  );
  if (!editable || !onEdit) return <div className="lrow">{body}</div>;
  return (
    <button type="button" className="lrow" onClick={onEdit}>
      {body}
    </button>
  );
}

function messageFor(phase: PayPalPhase, last4?: string | null): string {
  const card = last4 ? ` Sandbox card ····${last4}.` : "";
  if (phase === "disconnected") return "Connect a PayPal sandbox account to pay for Qizai's food.";
  if (phase === "connected") return `Automatic payments not enabled yet.${card}`;
  return `Automatic payments enabled. You can revoke access anytime.${card}`;
}

function primaryLabel(phase: PayPalPhase): string {
  if (phase === "disconnected") return "Connect PayPal";
  if (phase === "connected") return "Allow automatic payments";
  return "Save and continue";
}
