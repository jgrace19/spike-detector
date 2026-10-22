---
description: Use when an observability alert must be classified as an expected change or a bug before any paging.
---

# Expected versus bug

Call `list_recent_changes` first. Classify only from that result and the
alert's metric, env, baseline, value, and window.

Search scope: the tool returns about 24 hours of commits and pull
requests, and marks `inAlertWindow` for the alert's own window. A change
outside the alert window can still explain a slow rollout. A change
older than the tool's `since` is invisible. Do not invent commits.

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

Call `record_bug`. The note says which of those applied. Then launch
triage, open the Linear issue, and page the code owner.

## Do not classify

`list_recent_changes` returned `ok: false`. Report the error. Do not
call `log_expected_change` or `record_bug`.
