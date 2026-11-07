import type { ReactNode } from "react";
import { BagIcon } from "./icons";
import { Composer, DogPortrait, Headline, Phone, TopBar } from "./chrome";

export interface ApprovalModel {
  headline: string;
  badge: string;
  productName: string;
  productDetail: string;
  price: string;
  rows: { title: string; caption: string; delta: string }[];
  note: string;
  approveLabel: string;
}

export function ApprovalScreen({
  screen = "4",
  model,
  onNotNow,
  onApprove,
  busy = false,
  workingLabel,
  feedback,
  error,
  draft,
  onDraft,
  onSend,
  sheet,
}: {
  screen?: string;
  model: ApprovalModel;
  onNotNow: () => void;
  onApprove: () => void;
  busy?: boolean;
  workingLabel?: string;
  feedback?: ReactNode;
  error?: string | null;
  draft: string;
  onDraft: (value: string) => void;
  onSend: (value: string) => void;
  sheet?: ReactNode;
}) {
  return (
    <Phone screen={screen}>
      <TopBar pill="warn" />
      <div className="content">
        <Headline text={model.headline} />
        {feedback}
        <span className="badge">
          <i />
          {model.badge}
        </span>
        <div className="card" style={{ marginTop: 24 }}>
          <div className="for">
            <DogPortrait name="Qizai" size="small" />
            For Qizai
          </div>
          <div className="prod">
            <div className="bag">
              <BagIcon />
            </div>
            <div className="n">
              {model.productName}
              <small>{model.productDetail}</small>
            </div>
            <div className="p">{model.price}</div>
          </div>
        </div>
        {model.rows.length > 0 ? (
          <div className="over">
            {model.rows.map((row) => (
              <div className="orow" key={row.title}>
                <div>
                  <div className="t">{row.title}</div>
                  <div className="c">{row.caption}</div>
                </div>
                <div className="delta">{row.delta}</div>
              </div>
            ))}
          </div>
        ) : null}
        <p className="note">{model.note}</p>
        {error ? <p className="notice" role="alert">{error}</p> : null}
      </div>
      <div className="bottom above-chat">
        <button type="button" className="btn secondary" onClick={onNotNow} disabled={busy}>
          Not now
        </button>
        <button type="button" className="btn primary" onClick={onApprove} disabled={busy}>
          {busy ? workingLabel ?? "Please wait…" : model.approveLabel}
        </button>
      </div>
      <Composer value={draft} onChange={onDraft} onSend={onSend} busy={busy} />
      {sheet}
    </Phone>
  );
}
