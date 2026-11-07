import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";

type GuideStep = "pet" | "details" | "explore" | "compose" | "waiting" | "result" | "undo" | null;
const STORAGE = "replenish.guide.v1.dismissed";
const GuideContext = createContext<{
  step: GuideStep; setStep: (step: GuideStep) => void; fresh: boolean;
  dismiss: () => void; start: (step?: GuideStep) => void; finish: () => void;
}>({ step: null, setStep: () => {}, fresh: false, dismiss: () => {}, start: () => {}, finish: () => {} });

export function GuideProvider({ children }: { children: ReactNode }) {
  const [step, setStep] = useState<GuideStep>(null);
  const [fresh, setFresh] = useState(() => {
    try { return localStorage.getItem(STORAGE) !== "true"; } catch { return true; }
  });
  useEffect(() => {
    if (!step) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault(); event.stopImmediatePropagation(); setStep(null);
    };
    document.addEventListener("keydown", escape, true);
    return () => document.removeEventListener("keydown", escape, true);
  }, [step]);
  function dismiss() {
    setFresh(false);
    try { localStorage.setItem(STORAGE, "true"); } catch { /* Reading help must work without storage. */ }
  }
  return <GuideContext.Provider value={{ step, setStep, fresh, dismiss,
    start: (next = "pet") => { dismiss(); setStep(next); }, finish: () => setStep(null) }}>{children}</GuideContext.Provider>;
}

export const useGuide = () => useContext(GuideContext);

/** Inline positioning keeps the explanation and real target together on short screens. */
export function GuideSpot({ active, title, children, description, actions, onDismiss }: {
  active: boolean; title: string; children: ReactNode; description: ReactNode; actions?: ReactNode; onDismiss?: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!active) return;
    ref.current?.scrollIntoView?.({ block: "nearest", behavior: "instant" });
    ref.current?.querySelector<HTMLButtonElement>(".pet-entry, .detail-nav button:not(:disabled), .guide-actions button:not(:disabled)")?.focus({ preventScroll: true });
  }, [active]);
  return <div className={active ? "guide-spot active" : "guide-spot"} ref={ref}>
    <div className="guide-target">{children}</div>
    {active ? <GuideTip title={title} actions={actions} onDismiss={onDismiss}>{description}</GuideTip> : null}
  </div>;
}

export function GuideTip({ title, children, actions, onDismiss, anchor }: { title: string; children: ReactNode; actions?: ReactNode; onDismiss?: () => void; anchor?: RefObject<HTMLElement | null> }) {
  const guide = useGuide();
  const ref = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    if (!anchor?.current || !ref.current) return;
    const position = () => {
      const target = anchor.current?.getBoundingClientRect(), tip = ref.current?.getBoundingClientRect();
      if (target && tip) ref.current?.style.setProperty("--guide-pointer", `${Math.max(16, Math.min(tip.width - 24, target.left + target.width / 2 - tip.left - 6))}px`);
    };
    position();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(position);
    observer.observe(anchor.current); observer.observe(ref.current);
    return () => observer.disconnect();
  }, [anchor]);
  return <aside ref={ref} className="guide-tip" aria-label={title}>
    <strong>{title}</strong><div>{children}</div>
    <div className="guide-actions">{actions}<button type="button" className="link" onClick={onDismiss ?? guide.finish}>Skip tour</button></div>
  </aside>;
}

export function GuideEntry({ firstVisit = false }: { firstVisit?: boolean }) {
  const guide = useGuide();
  return <div className="guide-entry">
    {firstVisit && guide.fresh ? <span>New here?</span> : null}
    <button type="button" className="link" onClick={() => guide.start()}>Show me around</button>
    {firstVisit && guide.fresh ? <button type="button" className="link" aria-label="Dismiss first-visit hint" onClick={guide.dismiss}>×</button> : null}
  </div>;
}

const PAGE_HELP = {
  plan: { title: "Why these dates?", text: "See the planned order, expected delivery and estimated runout. The calculation inputs are below; planned dates are not completed events." },
  budget: { title: "Your spending limits", text: "Review settled, committed and remaining amounts, and your current limits. Approving one order does not raise these limits." },
  activity: { title: "What happened?", text: "Review recorded actions, their times and results. An empty list means there are no recorded actions to show." },
  notifications: { title: "Updates can find the owner", text: "When configured, Telegram reports key events with this page closed. This shared demo reports to its owner, not automatically to this visitor." },
};

export function GuidePage({ kind, children }: { kind: keyof typeof PAGE_HELP; children: ReactNode }) {
  const guide = useGuide();
  const [open, setOpen] = useState(guide.step === "explore");
  const help = PAGE_HELP[kind];
  return <>
    <button type="button" className="link guide-explain" onClick={() => setOpen(value => !value)} aria-expanded={open}>Explain this page</button>
    <GuideSpot active={open} title={help.title} onDismiss={() => { setOpen(false); guide.finish(); }} description={<>{help.text}<div className="guide-actions"><button type="button" className="link" onClick={() => setOpen(false)}>Got it</button></div></>}>{children}</GuideSpot>
  </>;
}
