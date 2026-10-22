---
description: Use when an observability alert must be classified as an expected change or a bug before any paging.
---

# Expected versus bug

Call `list_recent_changes` first. Classify only from that result and the
alert's metric, env, baseline, value, and window. Sibling metric lines in
the same message count as evidence. Do not invent commits, and do not
name a file, function, or patch.

Search scope: the tool returns about 24 hours of commits and pull
requests in `jgrace19/marketplace`, and marks `inAlertWindow` for the
alert's own window. A change outside the alert window can still explain
a slow rollout. A change older than the tool's `since` is invisible.

## Expected

All of these are true:

1. A commit message or pull request title/body contains the alert's
   metric name, case-insensitive.
2. That same change mentions the alert's env, or it is a merged change
   whose body says the target applies to that env.
3. The change describes an intentional move in the same direction as
   `value` versus `baseline` (up when value is above baseline, down
   when it is below).
4. If the change states a target number, `value` is within 15% of that
   target. If it states no number, the direction match is enough.

Call `log_expected_change`. The note names the commit SHA or pull
request number. Do not page.

## Bug

Any of these is true:

- No commit or pull request names the metric.
- A change names the metric but the wrong env, the opposite direction,
  or a target the value misses by more than 15%.
- The tool result is empty.
- The checkout revenue shape below matches, and no commit states a
  revenue target the observation is within 15% of.

Call `record_bug`. The note says which of those applied. Then launch
triage, open the Linear issue, and page the code owner. The cloud agent
investigates the symptom. Do not tell it a specific edit.

## Checkout revenue shape

Use this only to classify. It is not a fix.

The checkout metrics are:

- `freshcart.checkout.orders`
- `freshcart.checkout.units`
- `freshcart.checkout.gmv_cents`
- `freshcart.checkout.average_order_value_cents`

Treat it as a bug when `gmv_cents` and `average_order_value_cents` are
about 32% below baseline (a drop from 28% to 36% counts) and, when
`orders` and `units` are in the message, those two stay within 10% of
baseline. A commit that does not state a matching revenue target does not explain that
drop. A recent commit touching checkout or pricing is a suspect worth naming
as evidence (SHA and message), but do not diagnose the code yourself.

If the alert is only `gmv_cents` or only `average_order_value_cents`
and the value is about 32% below baseline, with no commit stating that
target, call `record_bug`.

After a fix, recovery is separate from this rubric. Both
`freshcart.checkout.gmv_cents` and
`freshcart.checkout.average_order_value_cents` on env `preview-<pr>`
must be within 10% of baseline. Orders and units staying flat is not
the recovery check. Deploy ready means the pull request's CI succeeded
or the first `preview-<pr>` snapshot arrived.

## Do not classify

`list_recent_changes` returned `ok: false`. Report the error. Do not
call `log_expected_change` or `record_bug`.
