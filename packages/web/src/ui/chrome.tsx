import { Fragment, useRef, type FormEvent, type ReactNode } from "react";
import { ArrowIcon } from "./icons";
import { GuideTip, useGuide } from "./guide";

export function Phone({ screen, children }: { screen: string; children: ReactNode }) {
  return (
    <div className="screen" data-screen={screen}>
      <div className="scroll">{children}</div>
    </div>
  );
}

export function Brand() {
  return (
    <div className="brand">
      <img src="/assets/replenish-icon.png" alt="" />
      Replenish
    </div>
  );
}

export function TopBar({ pill, onPill }: { pill?: "active" | "warn" | "paused"; onPill?: () => void }) {
  return (
    <div className="top">
      <Brand />
      {pill === "warn" ? (
        <button type="button" className="pill warn" onClick={onPill}>
          <i />
          Action needed
        </button>
      ) : null}
      {pill === "active" ? (
        <button type="button" className="pill" onClick={onPill}>
          <i />
          Active
        </button>
      ) : null}
      {pill === "paused" ? (
        <button type="button" className="pill off" onClick={onPill}><i />Paused</button>
      ) : null}
    </div>
  );
}

export function Headline({ text }: { text: string }) {
  const lines = text.split("\n");
  return (
    <h1>
      {lines.map((line, index) => (
        <Fragment key={`${index}-${line}`}>
          {index > 0 ? <br /> : null}
          {index === 0 && lines.length > 1 ? `${line} ` : line}
        </Fragment>
      ))}
    </h1>
  );
}

const QIZAI_PHOTO = "/assets/qizai-portrait.jpg";

export function DogPortrait({ name, size }: { name: string; size: "hero" | "small" }) {
  if (size === "small") {
    return (
      <span className="avatar">
        <img src={QIZAI_PHOTO} alt="" />
      </span>
    );
  }
  return (
    <div className="portrait">
      <img src={QIZAI_PHOTO} alt={name} />
    </div>
  );
}

export function Composer({
  value,
  onChange,
  onSend,
  busy = false,
  label = "Tell me anything about Qizai…",
  tour = false,
  exampleAllowed = false,
}: {
  value: string;
  onChange: (value: string) => void;
  onSend: (value: string) => void;
  busy?: boolean;
  label?: string;
  tour?: boolean;
  exampleAllowed?: boolean;
}) {
  const guide = useGuide();
  const input = useRef<HTMLInputElement>(null);
  const guided = tour && guide.step === "compose" && !busy;
  function submit(event: FormEvent) {
    event.preventDefault();
    if (!busy) onSend(value);
  }
  return (
    <>
    {guided ? <div className="guide-composer-tip"><GuideTip title="Tell me what changed" actions={exampleAllowed ? <button type="button" className="link" disabled={Boolean(value.trim())} onClick={() => { onChange("Feed 10g less per meal from now on."); input.current?.focus(); }}>Use example</button> : undefined}>
      <p>Describe a feeding change here. Filling the box changes nothing; tap Send when ready.</p>
      {value.trim() ? <p>Keep your draft, or clear it to use the example.</p> : !exampleAllowed ? <p>Use your own message; the example is unavailable for this feeding or order state.</p> : null}
    </GuideTip></div> : null}
    <form className={`composer${guided ? " guide-highlight" : ""}`} onSubmit={submit} aria-busy={busy}>
      <input
        ref={input}
        value={value}
        placeholder={label}
        aria-label="Message about Qizai"
        disabled={busy}
        onChange={(event) => onChange(event.target.value)}
      />
      <button className="send" type="submit" aria-label={busy ? "Waiting for confirmation" : "Send"} disabled={busy || !value.trim()}>
        <ArrowIcon />
      </button>
    </form>
    </>
  );
}
