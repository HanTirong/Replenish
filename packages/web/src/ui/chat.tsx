import { BowlIcon, CalendarIcon } from "./icons";
import { Composer } from "./chrome";
import { useRef, type ReactNode } from "react";
import { DetailSheet } from "./details";
import { GuideSpot, GuideTip, useGuide } from "./guide";

export interface ChatRow {
  icon: "bowl" | "calendar";
  title: string;
  caption: string;
}

export function ChatSheet({
  userText,
  headline,
  reason,
  rows,
  draft,
  onDraft,
  onSend,
  onOkay,
  onUndo,
  busy = false,
  canUndo = true,
  status = "completed",
  feedback,
}: {
  userText: string;
  headline: string;
  reason: string;
  rows: ChatRow[];
  draft: string;
  onDraft: (value: string) => void;
  onSend: (value: string) => void;
  onOkay: () => void;
  onUndo: () => void;
  busy?: boolean;
  canUndo?: boolean;
  status?: "pending" | "completed" | "unconfirmed" | "rejected";
  feedback?: ReactNode;
}) {
  const guide = useGuide();
  const undoButton = useRef<HTMLButtonElement>(null);
  const guidedResult = !busy && status === "completed" && canUndo;
  return (
    <>
      <DetailSheet title="Conversation" onClose={onOkay} busy={false} className="conversation-sheet">
        <div className="b-user">{userText}</div>
        <div className="agent">
          <div className="av">
            <img src="/assets/replenish-icon.png" alt="" />
          </div>
          <div className="col">
            <p className="b-agent" role="status" aria-live="polite" aria-atomic="true">
              <b>{headline}</b>
              {reason}
            </p>
            {feedback}
            {rows.length > 0 ? (
              <GuideSpot active={guide.step === "result" && guidedResult} title="Check what changed" description="These are the saved amounts and the actual reorder decision. Okay closes this result; it does not save it again." actions={<button type="button" className="link" onClick={() => guide.setStep("undo")}>Show Undo</button>}><div className="results">
                {rows.map((row) => (
                  <div className="rrow" key={row.title}>
                    {row.icon === "bowl" ? <BowlIcon /> : <CalendarIcon />}
                    <div>
                      <div className="t">{row.title}</div>
                      <div className="c">{row.caption}</div>
                    </div>
                  </div>
                ))}
              </div></GuideSpot>
            ) : null}
            <div className="acts">
              <button type="button" className="btn primary sm" onClick={onOkay} disabled={busy}>
                Okay
              </button>
              {canUndo && status === "completed" ? <button ref={undoButton} type="button" className={`btn secondary sm${guide.step === "undo" && guidedResult ? " guide-highlight" : ""}`} onClick={onUndo} disabled={busy}>
                Undo
              </button> : null}
            </div>
            {guide.step === "undo" && guidedResult ? <GuideTip anchor={undoButton} title="Undo is optional" actions={<button type="button" className="link" onClick={guide.finish}>Finish tour</button>}>Use the Undo button above only if you want to reverse this feeding change. Finishing the tour changes nothing.</GuideTip> : null}
            {guide.step === "waiting" && status === "completed" && !canUndo ? <GuideTip title="Read the actual response">No saved feeding change is available to undo here. If the agent asks a question, reply in the box below; the tour will not confirm for you.</GuideTip> : null}
          </div>
        </div>
        <Composer value={draft} onChange={onDraft} onSend={onSend} busy={busy || status === "unconfirmed"} />
      </DetailSheet>
    </>
  );
}
