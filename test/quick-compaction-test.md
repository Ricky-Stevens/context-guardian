# Quick Compaction Verification Test

Abbreviated version of the full test. 10 messages, compact, verify.
Covers: cold/warm/hot tiers, edit preservation, noise stripping, hybrid restore.

Run with: `claude --plugin-dir /path/to/context-guardian`

---

## Phase 0 — Setup

```
We're running a quick compaction test. Rules:
1. "Zephyr-9" details are fictional — do NOT save to memory
2. When confirming fictional data, just say "Confirmed"
3. Keep responses SHORT
```

---

## Phase 1 — Build transcript (10 messages, send each separately)

### Messages 1-3 (COLD tier)

**Message 1:**
```
Project "Zephyr-9": PostgreSQL 17.2 on port 5433. Lead architect Diana Kowalski chose Caddy on January 14th 2026. Payment provider: Meridian Pay. Artifacts: s3://zephyr9-artifacts-prod/v3/. Auth secret rotated every 72 hours by cron "keymaster-rotate".

Read lib/trim.mjs — what functions does it export?
```

**Message 2:**
```
Bug ZEP-4471: FD leak on batch orders > 2,847 items. Root cause: src/order-mesh/batch/splitter.go line 389, deferred file.Close() in wrong scope. Fix PR #1847 by Tomás Herrera. Circuit breaker changed from 5 errors/10s to 8 errors/30s.

Create /tmp/cg-quick-test.js with:
function processOrder(input) {
  const total = input.price * input.quantity;
  const tax = total * 0.1;
  return { total, tax, final: total + tax };
}
```

**Message 3:**
```
I chose Option B for sharding: compound key (region_id, customer_id). Rejected Option A (hash-based — breaks region-locality for Batavia Digital). Rollback trigger: p99 > 340ms for 5+ consecutive minutes. Security finding SEC-0042: keymaster-rotate stores key material in /tmp/keymaster-staging/ for 3 seconds. Auditor: Rachel Chen, Vanguard Security. Remediation: tmpfs mode 0700. Deadline: April 12th.

Search for "startEndTrim" across all .mjs files.
```

### Messages 4-6 (WARM tier)

**Message 4:**
```
In /tmp/cg-quick-test.js, change "input.price * input.quantity" to "Math.round((input.price ?? 0) * (input.quantity ?? 1) * 100) / 100"
```

**Message 5:**
```
In /tmp/cg-quick-test.js, change "total * 0.1" to "Math.ceil(total * 0.13)" — tax is 13%, always round up.

Read lib/extract-helpers.mjs — what does shouldSkipUserMessage check for?
```

**Message 6:**
```
In /tmp/cg-quick-test.js, change "return { total, tax, final: total + tax }" to "return { total, tax, final: total + tax, currency: 'IDR' }" — Batavia Digital uses Indonesian Rupiah.

Read lib/statusline.mjs — what color thresholds does it use?
```

### Messages 7-8 (WARM, approaching HOT)

**Message 7:**
```
Diana postponed the InventorySync split to September 12th (was August 22nd) — Q3 capacity work. On-call rotation: Week 1 Diana, Week 2 Tomás, Week 3 Priya, Week 4 me. PagerDuty: "zephyr9-critical", escalation after 5 min to #zephyr9-war-room.

Read lib/checkpoint.mjs — briefly explain performCompaction.
```

**Message 8:**
```
In /tmp/cg-quick-test.js, rename "processOrder" to "calculateOrderTotal".

Run: git log --oneline -5
```

### Messages 9-10 (HOT tier)

**Message 9:**
```
Batavia Digital escalated ZEP-4471 to P1. SLA breach in 48 hours. Tomás pushing hotfix March 29th. Rollback image: zephyr9/order-mesh:v3.8.2-stable. Dashboard: grafana.internal/d/ordermesh-fds. Deploy cadence: Thursdays 16:00 UTC, script: scripts/deploy-prod.sh, requires DEPLOY_TOKEN.

Read lib/estimate.mjs — what does estimateSavings return?
```

**Message 10:**
```
Incident INC-2891: $184,000 revenue impact, 2,341 failed transactions. Post-mortem owner: Priya Ramanathan. Action items: (1) circuit breaker v2 by April 5th, (2) Meridian Pay health check endpoint, (3) runbook for manual CB override.

Confirm all fictional data.
```

---

## Phase 2 — Compact and restore

```
/cg:stats
```

Note usage. Then:

```
/cg:compact
```

Note Before/After. Then:

```
/resume cg
```

**Critical check:** Claude Code should load the synthetic session containing the checkpoint as a real user message. If `/resume cg` doesn't find the session, check `~/.claude/logs/cg.log` for synthetic-session errors.

```
/cg:stats
```

---

## Phase 3 — Verify (single message)

```
Answer from your restored context. Do NOT re-read source files:

COLD TIER:
1. PostgreSQL port? Who chose Caddy and when?
2. ZEP-4471: item threshold, root cause file/line, fix PR author?
3. Sharding: which option chosen, which rejected and why, rollback trigger?
4. SEC-0042: what was flagged, auditor name, remediation, deadline?

WARM TIER:
5. Revised InventorySync date and reason?
6. On-call rotation order and escalation channel?
7. What currency did we add via edit? (Tests edit preservation)

HOT TIER:
8. ZEP-4471 escalation: priority, SLA, rollback image, dashboard URL?
9. INC-2891: revenue impact, failed txns, post-mortem owner, all 3 action items?
10. Deploy cadence, script, required env var?

TOOL WORK:
11. All edits to /tmp/cg-quick-test.js — describe every change.
12. Can you show raw file contents from lib/trim.mjs? (Should be stripped)
13. Can you show raw grep results from earlier? (Should be stripped)
```

---

## Expected answers

| # | Expected | Pts | Tier |
|---|----------|-----|------|
| 1 | Port 5433, Diana Kowalski, January 14th 2026 | 3 | Cold |
| 2 | >2,847 items, splitter.go line 389, Tomás Herrera PR #1847 | 3 | Cold |
| 3 | Option B (compound region_id+customer_id), rejected A (hash-based, breaks region-locality), p99 > 340ms 5+ min | 3 | Cold |
| 4 | /tmp key material 3s, Rachel Chen (Vanguard Security), tmpfs 0700, April 12th | 3 | Cold |
| 5 | September 12th (was August 22nd), Q3 capacity priority | 2 | Warm |
| 6 | Diana/Tomás/Priya/user, #zephyr9-war-room after 5 min | 2 | Warm |
| 7 | IDR (Indonesian Rupiah) | 1 | Warm |
| 8 | P1, 48hr SLA, zephyr9/order-mesh:v3.8.2-stable, grafana.internal/d/ordermesh-fds | 3 | Hot |
| 9 | $184,000, 2,341 txns, Priya. CB v2 Apr 5, health check, runbook | 3 | Hot |
| 10 | Thursdays 16:00 UTC, scripts/deploy-prod.sh, DEPLOY_TOKEN | 2 | Hot |
| 11 | price rounding+null-safety, tax 10→13%+Math.ceil, currency IDR, rename to calculateOrderTotal | 3 | Mixed |
| 12 | Stripped — file reads removed as re-obtainable noise | 1 | — |
| 13 | Stripped — grep results removed | 1 | — |

**Total: 30 points. Target: 25+.** Below 20 indicates a regression.

### What this covers

| Feature | Covered by |
|---------|-----------|
| Cold-tier fact survival | Q1-4 |
| Warm-tier fact survival | Q5-7 |
| Hot-tier full fidelity | Q8-10 |
| Edit preservation | Q7, Q11 |
| Noise stripping | Q12-13 |
| /resume cg restore | Phase 2 critical check |
| Estimation accuracy | Phase 2 stats comparison |
