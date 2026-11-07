import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { paidCaptureLine } from "../copy";
import { DAY_STRIP, daysThroughRunout, isKeyMarker, scrollLeftToReveal, tileWidthToFit, type DayTile } from "../days";
import { Composer, DogPortrait, Headline, Phone, TopBar } from "./chrome";
import { GuideEntry, GuideSpot, useGuide } from "./guide";

const LABELS: Record<string, string> = {
  order: "Order",
  delivery: "Delivery",
  runout: "Runs out",
  skip: "Skip",
};

export function HomeScreen({
  screen,
  headline,
  reason,
  captureId,
  petName,
  days,
  notice,
  pill = "active",
  draft,
  onDraft,
  onSend,
  onPill,
  onOrder,
  onPet,
  onDay,
  onCheckPayment,
  onRecoverPayment,
  recoverySummary,
  busy = false,
  feedback,
  sheet,
  guideAvailable = false,
  firstVisit = false,
  exampleAllowed = false,
}: {
  screen: string;
  headline: string;
  reason: string;
  captureId?: string | null;
  petName: string;
  days: DayTile[];
  notice?: string;
  pill?: "active" | "warn" | "paused";
  draft: string;
  onDraft: (value: string) => void;
  onSend: (value: string) => void;
  onPill?: () => void;
  onOrder?: () => void;
  onPet?: () => void;
  onDay?: (index: number) => void;
  onCheckPayment?: () => void;
  onRecoverPayment?: (operatorCode: string) => void;
  recoverySummary?: string;
  busy?: boolean;
  feedback?: ReactNode;
  sheet?: ReactNode;
  guideAvailable?: boolean;
  firstVisit?: boolean;
  exampleAllowed?: boolean;
}) {
  const guide = useGuide();
  return (
    <Phone screen={screen}>
      <TopBar pill={pill} onPill={onPill} />
      <div className="content">
        <Headline text={headline} />
        {feedback}
        {captureId ? <PaidLine captureId={captureId} onOrder={onOrder} /> : onOrder
          ? <button type="button" className="reason" onClick={onOrder}>{reason}</button>
          : <p className="reason">{reason}</p>}
        {onCheckPayment ? <button type="button" className="link" onClick={onCheckPayment} disabled={busy}>{busy ? "Checking…" : "Check payment status"}</button> : null}
        {onRecoverPayment ? <PaymentRecovery onRecover={onRecoverPayment} busy={busy} summary={recoverySummary} /> : null}
        <GuideSpot active={guide.step === "pet"} title={`Tap ${petName}`} description="See estimated food remaining and the feeding plan. This shared demo uses a simulated store and PayPal Sandbox.">
        <button type="button" className="dog pet-entry" aria-label={`View ${petName}'s details`} onClick={onPet}>
          <DogPortrait name={petName} size="hero" />
          <div className="name">{petName}</div>
        </button>
        </GuideSpot>
      </div>
      <DayStrip days={days} onDay={onDay} />
      {notice ? <p className="notice home-notice">{notice}</p> : null}
      {guideAvailable && !guide.step ? <GuideEntry firstVisit={firstVisit} /> : null}
      <Composer value={draft} onChange={onDraft} onSend={onSend} busy={busy} tour={!sheet} exampleAllowed={exampleAllowed} />
      {sheet}
    </Phone>
  );
}

function PaymentRecovery({ onRecover, busy, summary }: { onRecover: (operatorCode: string) => void; busy: boolean; summary?: string }) {
  const [review, setReview] = useState(false);
  const [operatorCode, setOperatorCode] = useState("");
  return review ? <form className="detail-form" onSubmit={event => {
    event.preventDefault(); if (busy || !operatorCode.trim()) return;
    const code = operatorCode; setOperatorCode(""); setReview(false); onRecover(code);
  }}>
    {summary ? <p>{summary}</p> : null}
    <p>This may complete the original approved payment using the same payment method. It will not start a replacement order.</p>
    <label>Owner recovery access code<input aria-label="Owner recovery access code" type="password" autoComplete="off" value={operatorCode} onChange={event => setOperatorCode(event.target.value)} disabled={busy} /></label>
    <button type="submit" className="btn primary sm" disabled={busy || !operatorCode.trim()}>Confirm recovery of original payment</button>
    <button type="button" className="link" disabled={busy} onClick={() => { setOperatorCode(""); setReview(false); }}>Cancel</button>
  </form> : <button type="button" className="link" disabled={busy} onClick={() => setReview(true)}>Recover original payment request</button>;
}

function PaidLine({ captureId, onOrder }: { captureId: string; onOrder?: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="reason" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        {paidCaptureLine(captureId, open)}
      </button>
      {open && onOrder ? <button type="button" className="link" onClick={onOrder}>View order</button> : null}
    </>
  );
}

export function DayStrip({ days, onDay }: { days: DayTile[]; onDay?: (index: number) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const align = () => {
      const phone =
        typeof window.matchMedia === "function" && window.matchMedia(`(max-width: ${DAY_STRIP.phoneMax}px)`).matches;
      if (phone) {
        el.style.removeProperty("--day-tile");
        if (el.scrollLeft !== 0) el.scrollLeft = 0;
        return;
      }
      const tiles = [...el.querySelectorAll<HTMLElement>(".tile")];
      if (!tiles.length) return;
      const viewport = el.clientWidth;
      if (viewport <= 0) return;
      const style = getComputedStyle(el);
      const gap = Number.parseFloat(style.columnGap || style.gap) || 0;
      const gutter = Number.parseFloat(style.paddingLeft) || Number.parseFloat(style.scrollPaddingLeft) || 0;
      const markerIndexes = days.flatMap((tile, index) => (isKeyMarker(tile.marker) ? [index] : []));
      const probe = document.createElement("div");
      probe.style.width = "var(--day-preferred)";
      probe.style.position = "absolute";
      probe.style.visibility = "hidden";
      el.appendChild(probe);
      const preferred = probe.getBoundingClientRect().width;
      probe.remove();
      if (markerIndexes.length > 0 && preferred > 0) {
        const span = Math.max(...markerIndexes) - Math.min(...markerIndexes) + 1;
        const fitted = tileWidthToFit(viewport, span, gap, gutter, preferred);
        const next = fitted > 0 && fitted < preferred - 0.5 ? `${fitted}px` : "";
        if (el.style.getPropertyValue("--day-tile") !== next) {
          if (next) el.style.setProperty("--day-tile", next);
          else el.style.removeProperty("--day-tile");
        }
      }
      const view = el.getBoundingClientRect();
      const placed = [...el.querySelectorAll<HTMLElement>(".tile")];
      const tileWidth = placed[0]?.getBoundingClientRect().width ?? preferred;
      const tileStarts = placed.map((tile) => tile.getBoundingClientRect().left - view.left + el.scrollLeft);
      const scroll = scrollLeftToReveal({
        viewport,
        contentWidth: el.scrollWidth,
        tileStarts,
        tileWidth,
        markerIndexes,
        gutter,
      });
      if (Math.abs(el.scrollLeft - scroll) > 0.5) el.scrollLeft = scroll;
    };
    align();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(align);
    observer.observe(el);
    return () => observer.disconnect();
  }, [days]);
  const span = daysThroughRunout(days);
  return (
    <div className="days" ref={ref} style={{ "--day-span": String(span) } as CSSProperties} aria-label="Upcoming days">
      {days.map((tile, index) => {
        const kind = tile.marker === "runout" ? "out" : tile.marker ?? (tile.today ? "today" : "");
        const past = index >= span ? "after-runout" : "";
        return (
          <button type="button" className={`tile ${kind} ${past}`.trim()} key={`${tile.weekday}-${tile.day}-${index}`}
            aria-label={`${tile.weekday} ${tile.day}${tile.marker ? `, ${LABELS[tile.marker]}` : ", no planned event"}`} onClick={() => onDay?.(index)}>
            <span className="dow">{tile.weekday}</span>
            <span className="d">{tile.day}</span>
            <span className="dot" />
            <span className="lbl">{tile.marker ? LABELS[tile.marker] : ""}</span>
          </button>
        );
      })}
    </div>
  );
}
