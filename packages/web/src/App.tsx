import { useEffect, useRef, useState } from "react";
import {
  approveOrder,
  authorizePaypal,
  connectPaypal,
  reorderNow,
  resetDemo,
  getHome,
  pauseAutopilot,
  resumeAutopilot,
  receiveOrder,
  postChat,
  postUndo,
  rejectOrder,
  updateBudget,
  calibrateStock,
  updateFeeding,
  checkPayment,
  recoverPayment,
  RequestError,
  type ChatPayload,
  type HomePayload,
} from "./api";
import { useOperation, type PendingOperation } from "./useOperation";
import { OperationFeedback } from "./ui/feedback";
import { approvalNote, breakHeadline, dollars, reorderCaption, signedDollars } from "./copy";
import { buildStrip } from "./days";
import { approvalFixture, scheduledDays, scheduledHome, skipChat, unchangedDays, unchangedHome } from "./fixtures";
import { ApprovalScreen, type ApprovalModel } from "./ui/approval";
import { ChatSheet, type ChatRow } from "./ui/chat";
import { Headline, Phone } from "./ui/chrome";
import { HomeScreen } from "./ui/home";
import { PayPalScreen, type PayPalPhase } from "./ui/paypal";
import { OrderSheet } from "./ui/order";
import { LinkedOrder, NotificationDetails } from "./ui/notifications";
import { DetailSheet, PetDetails, PlanDetails, BudgetDetails, ActivityDetails, type DetailKind } from "./ui/details";
import { GuideProvider, useGuide } from "./ui/guide";

export function App({ path = "/", search = "" }: { path?: string; search?: string }) {
  const shot = /^\/shots\/([1-7])$/.exec(path);
  if (shot?.[1]) return <Shot id={shot[1]} />;
  return <GuideProvider><LiveApp startOnPaypal={path === "/paypal"} search={search} /></GuideProvider>;
}

function Shot({ id }: { id: string }) {
  const idle = () => undefined;
  if (id === "1") {
    return <HomeScreen screen="1" {...scheduledHome} days={scheduledDays} draft="" onDraft={idle} onSend={idle} />;
  }
  if (id === "2") {
    return (
      <HomeScreen
        screen="2"
        {...scheduledHome}
        days={scheduledDays}
        draft=""
        onDraft={idle}
        onSend={idle}
        sheet={<ChatSheet {...skipChat} draft="" onDraft={idle} onSend={idle} onOkay={idle} onUndo={idle} />}
      />
    );
  }
  if (id === "3") {
    return <HomeScreen screen="3" {...unchangedHome} days={unchangedDays} draft="" onDraft={idle} onSend={idle} />;
  }
  const chat = { draft: "", onDraft: idle, onSend: idle };
  if (id === "4") return <ApprovalScreen model={approvalFixture} onNotNow={idle} onApprove={idle} {...chat} />;
  if (id === "5") return <PayPalScreen screen="5" phase="disconnected" perOrder="$50" monthly="$120" onPrimary={idle} {...chat} />;
  if (id === "6") return <PayPalScreen screen="6" phase="connected" perOrder="$50" monthly="$120" onPrimary={idle} {...chat} />;
  return <PayPalScreen screen="7" phase="authorized" perOrder="$50" monthly="$120" onPrimary={idle} onPause={idle} {...chat} />;
}

function LiveApp({ startOnPaypal, search }: { startOnPaypal: boolean; search: string }) {
  const guide = useGuide();
  const params = new URLSearchParams(search);
  const demo = params.get("demo") === "1";
  const resetStarted = useRef(false);
  useEffect(() => {
    if (params.get("reset") !== "1" || resetStarted.current) return;
    resetStarted.current = true;
    const full = params.get("full") === "1";
    void resetDemo(full)
      .catch(() => undefined)
      .finally(() => {
        const url = new URL(window.location.href);
        url.searchParams.delete("reset");
        url.searchParams.delete("full");
        const next = url.searchParams.toString();
        window.location.replace(`${url.pathname}${next ? `?${next}` : ""}${url.hash}`);
      });
  }, [search]);
  const [home, setHome] = useState<HomePayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [chatOpen, setChatOpen] = useState(true);
  const [paypal, setPaypal] = useState(startOnPaypal);
  const [orderOpen, setOrderOpen] = useState(false);
  const [details, setDetails] = useState<DetailKind | null>(() => params.get("view") === "plan" ? "plan" : null);
  const [linkedOrder, setLinkedOrder] = useState<string | null>(() => params.get("order"));
  const [selectedDay, setSelectedDay] = useState<number | null>(null);
  const mutation = useRef(false);
  const refreshVersion = useRef(0);

  async function refresh() {
    const version = ++refreshVersion.current;
    const next = await getHome();
    if (version === refreshVersion.current) setHome(next);
    return next;
  }
  const actions = useOperation(refresh);
  const { operation, busy, blocked } = actions;
  const sheet = chatOpen && operation?.showChat && operation.kind !== "action" ? { text: operation.text ?? "Undo last feeding change", turn: operation.result ?? null } : null;
  const workingLabel = operation?.phase === "unconfirmed" || operation?.syncFailed ? "Check status first" : operation?.syncing ? "Syncing latest state…" : operation?.label;
  const operationPanel = <OperationFeedback operation={operation} onCheck={() => void actions.verify()} onRetry={() => void actions.retry()} onDismiss={actions.dismiss} onView={!sheet ? () => setChatOpen(true) : undefined} />;
  const pageFeedback = sheet ? null : operationPanel;
  const importantState = Boolean(home?.pendingApproval || home?.paymentCheckOrderId || home?.paymentRecovery ||
    (home && ["awaiting_approval", "reconciling", "failed", "preparing"].includes(home.state)));
  const guideAvailable = !importantState && !linkedOrder && !paypal && !orderOpen && !blocked && !error;
  useEffect(() => {
    if (!guide.step) return;
    if (importantState || linkedOrder || paypal || operation?.phase === "unconfirmed" || operation?.syncFailed || error) {
      guide.finish();
      if (importantState) setDetails(null);
      return;
    }
    if (guide.step === "waiting" && operation?.phase === "confirmed" && operation.kind === "chat" &&
      operation.result?.receipt?.feeding && operation.result.receipt.outcome === "applied" && operation.result.receipt.undoRevisionId) {
      guide.setStep("result");
    }
  }, [importantState, linkedOrder, paypal, operation, error, guide.step]);
  useEffect(() => {
    if (operation?.phase === "rejected" && operation.kind === "chat") setDraft(operation.text ?? "");
  }, [operation?.id, operation?.phase]);

  useEffect(() => {
    refresh().catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "Could not load the household."));
    const update = () => {
      if (!mutation.current && document.visibilityState === "visible") void refresh().catch(() => undefined);
    };
    const timer = window.setInterval(update, 30_000);
    window.addEventListener("focus", update);
    document.addEventListener("visibilitychange", update);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", update);
      document.removeEventListener("visibilitychange", update);
      refreshVersion.current++;
    };
  }, []);

  async function act(work: (id: string) => Promise<unknown>, fallback: string, returnHome = false, task: Partial<PendingOperation> = {}) {
    // The ref closes the gap before React renders disabled buttons.
    if (mutation.current || blocked) return;
    mutation.current = true;
    setError(null);
    try {
      const result = await actions.run(work, { id: crypto.randomUUID(), kind: "action", label: "Saving change…", success: "Change saved.", ...task });
      if (result !== undefined && returnHome) {
        setPaypal(false);
        setOrderOpen(false);
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : fallback);
    } finally {
      mutation.current = false;
    }
  }

  async function send(text: string) {
    const trimmed = text.trim();
    if (!trimmed || mutation.current || blocked) return;
    if (guide.step === "compose") guide.setStep("waiting");
    const revisionId = (sheet?.turn?.receipt?.undoRevisionId ?? home?.undoRevisionId) ?? undefined;
    setDraft("");
    setChatOpen(true); setDetails(null); setPaypal(false);
    await act(id => postChat(trimmed, id, revisionId), "Could not send that.", false, { kind: "chat", text: trimmed, revisionId, label: "Processing your message…", success: "Your message was processed.", showChat: true });
  }

  async function okay() {
    if (["waiting", "result", "undo"].includes(guide.step ?? "")) guide.finish();
    setChatOpen(false);
    if (operation?.phase !== "unconfirmed" && !operation?.syncFailed) actions.dismiss();
  }

  async function undo(showChat = true) {
    guide.finish();
    const revisionId = (showChat ? sheet?.turn?.receipt?.undoRevisionId : home?.undoRevisionId) ?? undefined;
    if (showChat) setChatOpen(true);
    await act(id => postUndo(id, revisionId), "Could not undo.", false, { kind: "undo", text: "Undo last feeding change", label: "Undoing the last feeding change…", success: "The last feeding change was undone.", revisionId, showChat });
  }

  function openDetails(kind: DetailKind) {
    setError(null);
    setSelectedDay(null);
    setDetails(kind);
    if (guide.step === "pet" && kind === "pet") guide.setStep("details");
    else if (guide.step && kind !== "pet") guide.setStep("explore");
  }

  function closeDetails() {
    if (guide.step === "explore" && details !== "pet") { setDetails("pet"); return; }
    setDetails(null);
    if (guide.step === "details" || guide.step === "explore") guide.setStep("compose");
  }

  function saveDetails(operation: () => Promise<unknown>, message: string, label = "Saving change…") {
    void act(operation, "Could not save the change.", false, { label, success: message });
  }

  if (error && !home) {
    return (
      <Phone screen="error">
        <div className="content">
          <Headline text={"Something went\nwrong."} />
          <p className="reason">{error}</p>
        </div>
      </Phone>
    );
  }
  if (!home) {
    return (
      <Phone screen="loading">
        <div className="content">
          <Headline text={"Checking Qizai's\nfood."} />
          <p className="reason">Loading the latest plan.</p>
        </div>
      </Phone>
    );
  }

  function closeLinkedOrder() {
    setLinkedOrder(null);
    const url = new URL(window.location.href);
    url.searchParams.delete("order");
    window.history.replaceState(null, "", url.pathname + url.search + url.hash);
  }
  const detailTitles = { pet: `${home.pet.name}'s details`, plan: "Replenishment plan", budget: "Budget details", activity: "Recent activity", notifications: "Notifications" };
  const detailsLayer = linkedOrder ? <LinkedOrder key={linkedOrder} id={linkedOrder} home={home} onClose={closeLinkedOrder}
    onReview={() => { closeLinkedOrder(); setPaypal(false); setChatOpen(false); }}
    onReceipt={() => { closeLinkedOrder(); setPaypal(false); setOrderOpen(true); }} /> : details ? <DetailSheet key={details} title={detailTitles[details]} busy={false} error={error} onClose={closeDetails}>
    {pageFeedback}
    {details === "pet" ? <PetDetails home={home} busy={blocked} workingLabel={workingLabel} onNavigate={openDetails}
      onCalibrate={grams => saveDetails(() => calibrateStock(grams), "Stock calibrated. The forecast has been recalculated.", "Calibrating stock…")}
      onFeeding={grams => saveDetails(() => updateFeeding(grams), "Feeding plan saved. The forecast has been recalculated.", "Saving feeding plan…")}
      onCompose={() => { setDetails(null); guide.setStep("compose"); }} guideAvailable={guideAvailable}
      onUndo={() => void undo(false)} /> : null}
    {details === "plan" ? <PlanDetails home={home} selectedDay={selectedDay} /> : null}
    {details === "budget" ? <BudgetDetails home={home} busy={blocked} workingLabel={workingLabel} onSave={limits => saveDetails(() => updateBudget(limits), "Spending limits saved.", "Saving spending limits…")} /> : null}
    {details === "activity" ? <ActivityDetails home={home} /> : null}
    {details === "notifications" ? <NotificationDetails home={home} /> : null}
  </DetailSheet> : null;

  if (paypal) {
    const phase: PayPalPhase = !home.paypal.connected
      ? "disconnected"
      : home.paypal.automaticPaymentAuthorized
        ? "authorized"
        : "connected";
    return (
      <PayPalScreen
        screen={phase === "disconnected" ? "5" : phase === "connected" ? "6" : "7"}
        phase={phase}
        perOrder={dollars(home.budget.perOrderLimitCents, 0)}
        monthly={dollars(home.budget.monthlyLimitCents, 0)}
        busy={blocked}
        workingLabel={workingLabel}
        feedback={detailsLayer ? null : pageFeedback}
        error={error}
        paused={home.autopilot === "paused"}
        pauseReason={home.autopilotPauseReason}
        onKeepPaused={home.autopilot === "paused" && home.autopilotResumeAt ? () => void act(pauseAutopilot, "Could not keep autopilot paused.", true, { label: "Keeping automatic buying paused…", success: "Automatic buying remains paused. The resume deadline was cancelled." }) : undefined}
        onPrimary={() => {
          if (phase === "authorized") {
            setPaypal(false);
            setError(null);
            return;
          }
          void act(async () => {
            if (phase === "disconnected") return connectPaypal();
            return authorizePaypal();
          }, "PayPal update failed.", false, { label: phase === "disconnected" ? "Connecting PayPal…" : "Saving payment authorization…", success: "The PayPal request completed. Check the connection and authorization shown below." });
        }}
        draft={draft}
        onDraft={setDraft}
        onSend={(text) => {
          setPaypal(false);
          void send(text);
        }}
        last4={home.paypal.last4}
        onReorderNow={
          demo
            ? (maintenanceToken: string) => {
                void act(() => reorderNow(maintenanceToken), "Could not run the reorder check.", true, { label: "Checking replenishment…", success: "The reorder check completed. Review the order status." });
              }
            : undefined
        }
        onPause={() => {
          void act(home.autopilot === "paused" ? resumeAutopilot : pauseAutopilot, "Could not update autopilot.", true, { label: "Updating automatic buying…", success: home.autopilot === "paused" ? "Automatic buying resumed. Authorization and budget rules still apply." : "Automatic buying is paused until you resume." });
        }}
        onEditLimit={() => {
          if (mutation.current) return;
          openDetails("budget");
        }}
        onBudget={() => openDetails("budget")}
        onActivity={() => openDetails("activity")}
        onNotifications={() => openDetails("notifications")}
        onBack={() => { setPaypal(false); setError(null); }}
        sheet={detailsLayer}
      />
    );
  }

  if (home.pendingApproval && !sheet) {
    const model = approvalFromHome(home);
    const pending = home.pendingApproval;
    return (
      <ApprovalScreen
        model={model}
        sheet={detailsLayer}
        busy={blocked}
        workingLabel={workingLabel}
        feedback={detailsLayer ? null : pageFeedback}
        error={error}
        onNotNow={() => {
          void act(() => rejectOrder(pending.orderId), "Could not dismiss the order.", false, { label: "Rejecting this order…", success: "This order was rejected. No payment was requested." });
        }}
        draft={draft}
        onDraft={setDraft}
        onSend={(text) => void send(text)}
        onApprove={() => {
          void act(async () => {
            const result = await approveOrder(pending.orderId, pending.totalCents, pending.approvalSnapshot) as { voided?: boolean; message?: string };
            if (result.voided) throw new RequestError(result.message ?? "This order has changed. Review the current order before approving.", "rejected");
            return result;
          }, "Could not approve the order.", false, { label: "Submitting this approval…", success: "The approval request completed. Review the verified payment status." });
        }}
      />
    );
  }

  const rows = sheet?.turn ? rowsFor(sheet.turn, home.pet.timezone) : [];
  return (
    <HomeScreen
      screen={home.state === "scheduled" ? "1" : "3"}
      headline={breakHeadline(home.headline)}
      reason={error ?? home.reason}
      captureId={error ? null : home.payment?.captureId}
      petName={home.pet.name}
      days={buildStrip(home.dates)}
      notice={home.notice ? `${home.notice.headline} ${home.notice.reason}`.trim() : undefined}
      pill={home.pendingApproval ? "warn" : home.autopilot === "paused" ? "paused" : "active"}
      draft={draft}
      onDraft={setDraft}
      onSend={(text) => void send(text)}
      onPill={() => setPaypal(true)}
      onPet={() => openDetails("pet")}
      onDay={index => { openDetails("plan"); setSelectedDay(index); }}
      onCheckPayment={home.paymentCheckOrderId ? () => void act(() => checkPayment(home.paymentCheckOrderId!), "Could not check the payment.", false, { label: "Checking the payment result…", success: "The payment lookup completed. Review the current payment status." }) : undefined}
      onRecoverPayment={home.paymentRecovery?.recoverable ? operatorCode => void act(() => recoverPayment(home.paymentRecovery!, operatorCode), "The original payment is still unconfirmed.", false, { label: "Recovering the original payment…", success: "Recovery checked. Review the current payment status before continuing." }) : undefined}
      recoverySummary={home.paymentRecovery ? [home.paymentRecovery.productName, home.paymentRecovery.productDetail, home.paymentRecovery.merchant,
        `${home.paymentRecovery.currency ?? "USD"} ${dollars(home.paymentRecovery.totalCents)}`].filter(Boolean).join(" · ") : undefined}
      busy={blocked}
      guideAvailable={guideAvailable && !sheet && !details}
      firstVisit={home.state === "scheduled"}
      exampleAllowed={Boolean(home.feeding && home.feeding.gramsPerMeal > 10 && !home.order)}
      feedback={detailsLayer || orderOpen ? null : pageFeedback}
      onOrder={home.order ? () => { setError(null); setOrderOpen(true); } : undefined}
      sheet={
        detailsLayer ?? (orderOpen && home.order ? (
          <OrderSheet order={home.order} busy={blocked} error={error} feedback={pageFeedback}
            onClose={() => setOrderOpen(false)}
            onReceive={() => void act(() => receiveOrder(home.order!.id), "Could not confirm receipt.", true, { label: "Recording confirmed receipt…", success: "Receipt recorded. The next bag was added once and the plan recalculated." })} />
        ) : sheet ? (
          <ChatSheet
            userText={sheet.text}
            headline={sheet.turn?.headline ?? (operation?.phase === "pending" ? "Processing your message…" : operation?.phase === "rejected" ? "The change was not saved." : "This result is not confirmed yet.")}
            reason={sheet.turn?.reason ?? (operation?.phase === "pending" ? "Waiting for confirmation. Your original message is kept above." : "Your original message is kept above. Check the result before repeating it.")}
            busy={busy}
            status={operation?.phase === "confirmed" ? "completed" : operation?.phase}
            canUndo={sheet.turn?.receipt ? sheet.turn.receipt.undoRevisionId !== null : Boolean(sheet.turn && ["feeding_permanent", "skip_meal", "temporary_meal", "actual_intake"].includes(sheet.turn.command.type))}
            feedback={operation?.phase === "unconfirmed" || operation?.phase === "rejected" || operation?.syncFailed || operation?.message?.startsWith("The saved result") ? operationPanel : null}
            rows={rows}
            draft={draft}
            onDraft={setDraft}
            onSend={(text) => void send(text)}
            onOkay={() => void okay()}
            onUndo={() => void undo()}
          />
        ) : null)
      }
    />
  );
}

function approvalFromHome(home: HomePayload): ApprovalModel {
  const pending = home.pendingApproval;
  if (!pending) throw new Error("No order is waiting");
  const environment = home.paypal.environment === "live" ? "Live" : "Sandbox";
  return {
    headline: breakHeadline(home.headline),
    badge: `${environment} · ${pending.merchant}`,
    productName: pending.productName,
    productDetail: pending.productDetail,
    price: dollars(pending.totalCents, 2),
    approveLabel: pending.retry ? "Try again" : `Approve ${dollars(pending.totalCents, 2)}`,
    note: pending.retry && pending.failure ? pending.failure : approvalNote(pending.violations),
    rows: pending.violations.map((violation) => ({
      title: violation.code === "per_order" ? "Per-order limit" : "Monthly limit",
      caption:
        violation.code === "monthly"
          ? `${dollars(violation.limitCents, 2)} · ${dollars(violation.actualCents, 2)} this month`
          : dollars(violation.limitCents, 2),
      delta: signedDollars(violation.overByCents),
    })),
  };
}

function rowsFor(turn: ChatPayload, timeZone: string): ChatRow[] {
  const rows: ChatRow[] = [];
  const change = turn.receipt?.feeding;
  if (change) rows.push({ icon: "bowl", title: "Feeding plan saved", caption: `${change.before.gramsPerMeal}g → ${change.after.gramsPerMeal}g per meal · ${change.before.dailyGrams}g → ${change.after.dailyGrams}g per day` });
  if (turn.command.type === "skip_meal") {
    rows.push({
      icon: "bowl",
      title: "Feeding plan updated (temporary)",
      caption: turn.command.meal === "dinner" ? "Tomorrow's dinner: skipped" : "That meal was skipped",
    });
  } else if (!change && (turn.command.type === "feeding_permanent" || turn.command.type === "temporary_meal" || turn.command.type === "actual_intake")) {
    rows.push({ icon: "bowl", title: "Feeding plan updated", caption: turn.headline });
  } else if (turn.command.type === "pause_orders") {
    rows.push({ icon: "calendar", title: "Autopilot paused", caption: turn.reason });
  }
  if (turn.decision) {
    rows.push({
      icon: "calendar",
      title: turn.decision.planChanged ? "Reorder plan updated" : "Reorder plan: No change",
      caption: reorderCaption(turn.decision.orderDate, turn.decision.orderDateRaw, timeZone, turn.decision.planChanged),
    });
  }
  return rows;
}
