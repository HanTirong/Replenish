import { approvalNote } from "./copy";
import type { DayTile } from "./days";
import type { ApprovalModel } from "./ui/approval";
import type { ChatRow } from "./ui/chat";

const WEEK: DayTile[] = [
  { weekday: "Today", day: "28", today: true },
  { weekday: "Thu", day: "29", today: false },
  { weekday: "Fri", day: "30", today: false },
  { weekday: "Sat", day: "31", today: false },
  { weekday: "Sun", day: "1", today: false },
  { weekday: "Mon", day: "2", today: false, marker: "order" },
  { weekday: "Tue", day: "3", today: false, marker: "delivery" },
  { weekday: "Wed", day: "4", today: false, marker: "runout" },
  { weekday: "Thu", day: "5", today: false },
  { weekday: "Fri", day: "6", today: false },
];

export const scheduledDays: DayTile[] = WEEK;
export const unchangedDays: DayTile[] = WEEK.map((tile, index) =>
  index === 1 ? { ...tile, marker: "skip" as const } : tile,
);

export const scheduledHome = {
  headline: "Qizai has about\n8 days of food left.",
  reason: "I'll reorder on Nov 2 so it arrives before food runs out.",
  petName: "Qizai",
};

export const unchangedHome = {
  headline: "Noted. Qizai skips\ndinner tomorrow.",
  reason: "That's half a day of food, so the reorder date stays Nov 2.",
  petName: "Qizai",
};

export const skipChat = {
  userText: "Skip Qizai's dinner tomorrow.",
  headline: "Noted. Qizai skips dinner tomorrow.",
  reason: "That's half a day of food, so the reorder date stays Nov 2.",
  rows: [
    { icon: "bowl", title: "Feeding plan updated (temporary)", caption: "Tomorrow's dinner: skipped" },
    { icon: "calendar", title: "Reorder plan: No change", caption: "Still Mon, Nov 2" },
  ] satisfies ChatRow[],
};

export const approvalFixture: ApprovalModel = {
  headline: "Qizai's next order\nneeds your approval.",
  badge: "Sandbox · Example store",
  productName: "Taste of the Wild",
  productDetail: "Pacific Stream Small Breed · 8 kg",
  price: "$72.99",
  rows: [
    { title: "Per-order limit", caption: "$50.00", delta: "+$22.99" },
    { title: "Monthly limit", caption: "$120.00 · $162.99 this month", delta: "+$42.99" },
  ],
  note: approvalNote([
    { code: "per_order", limitCents: 50_00 },
    { code: "monthly", limitCents: 120_00 },
  ]),
  approveLabel: "Approve $72.99",
};
