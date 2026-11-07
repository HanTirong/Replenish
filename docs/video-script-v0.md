# Replenish — final demonstration script

Video: https://www.youtube.com/watch?v=6BOedfIEZoA

Final cut: approximately 1 minute 55 seconds. The English narration below follows the final-cut subtitle timing. The remaining closing card contains the project link, service credits and thanks.

| Time | English narration |
| --- | --- |
| 00:00:00,100 → 00:00:05,398 | Pet owners have to estimate when food will run out, and remember to reorder. |
| 00:00:05,398 → 00:00:12,433 | Replenish manages that routine for my dog, Qizai, while keeping me in control of spending. |
| 00:00:12,433 → 00:00:15,662 | I ask for 10g less per meal. |
| 00:00:15,662 → 00:00:21,200 | DeepSeek understands this as a change to each meal, not the daily total. |
| 00:00:21,200 → 00:00:29,267 | Replenish saves 65g per meal, recalculates the food supply, and updates the reorder plan. |
| 00:00:29,267 → 00:00:33,767 | If I make a mistake, I can undo the change. |
| 00:00:33,767 → 00:00:37,626 | Skipping one dinner saves only half a day of food. |
| 00:00:37,626 → 00:00:40,667 | The order date stays unchanged. |
| 00:00:40,667 → 00:00:44,467 | Every change is recorded in recent activity. |
| 00:00:44,467 → 00:00:47,016 | The check runs on the server. |
| 00:00:47,016 → 00:00:52,667 | For this demo, I trigger it early, without waiting for the scheduled date. |
| 00:00:52,667 → 00:00:56,667 | Telegram sends me an approval request. |
| 00:00:56,667 → 00:01:01,000 | Its link opens the exact order, still unpaid. |
| 00:01:01,000 → 00:01:06,214 | This 8kg bag costs $72.99. |
| 00:01:06,214 → 00:01:11,533 | This order is over my 50 dollar limit, so it stopped and asked me. |
| 00:01:11,533 → 00:01:13,967 | I approve it once. |
| 00:01:13,967 → 00:01:19,267 | PayPal Sandbox completes the payment using the saved payment method. |
| 00:01:19,267 → 00:01:24,115 | The same transaction appears as Completed in the Sandbox dashboard. |
| 00:01:24,115 → 00:01:27,433 | The full capture ID matches the app. |
| 00:01:27,433 → 00:01:31,433 | When the food arrives, I confirm receipt. |
| 00:01:31,433 → 00:01:36,433 | Replenish adds one 8kg bag and plans the next cycle. |
| 00:01:36,433 → 00:01:42,200 | The new supply updates the next order, delivery, and estimated runout dates. |
| 00:01:42,200 → 00:01:45,229 | Less routine work for pet owners. |
| 00:01:45,229 → 00:01:49,100 | Clear approval before spending beyond their limits. |

## Demonstration boundaries

- Default purchase: Taste of the Wild Pacific Stream Small Breed, 8kg, $72.99. Limits: $50 per order and $120 per month.
- The reorder check is triggered early for the recording; this does not advance the clock or bypass approval.
- Store and delivery are simulated. The payment and matching transaction shown are PayPal Sandbox test records.
- Receipt is explicitly confirmed; the next bag is added to the food remaining once. No automatic real-world delivery confirmation is claimed.
- The full Sandbox transaction ID in the recording was approved for display by the owner. No credentials or vault data belong in a recording.
- See the [demo walkthrough](demo-runbook.md) and [PayPal integration](paypal-integration.md).
