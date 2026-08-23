# base

## The problem
Mid-incident an operator cannot tell a spike in node pressure apart from a slow
degradation, so they open Grafana or guess.

## Who has it
Whoever is on call, in the first two minutes of an incident.

## What changes for them
A tab on the cluster page showing how node conditions trended over the last 24
hours, so the shape of the problem is visible without leaving Rancher.

## What we are deliberately not doing
No alerting, and no history beyond 24 hours. Both belong in monitoring.

## How we will know it worked
- [x] The tab appears under the cluster nav without a reload
- [x] It renders with metrics-server absent, and says why
- [ ] A 24-hour trend is readable at a glance
- [ ] Nothing on the existing cluster page moves or changes

## Verification

Verdict: **2 still to check**

Passed 2 of 4. Not looked at: 2.

### Criteria

- **Met**: The tab appears under the cluster nav without a reload
- **Met**: It renders with metrics-server absent, and says why
- **Not looked at**: A 24-hour trend is readable at a glance
- **Not looked at**: Nothing on the existing cluster page moves or changes
