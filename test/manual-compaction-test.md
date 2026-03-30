# Manual Compaction Verification Test

One big session. Build up 30+ exchanges with fictional facts, tool noise, and
repeated edits. Compact once. Verify everything survived — cold-tier compression,
edit coalescing, fact preservation, and quality of the restored context.

Run with: `claude --plugin-dir /path/to/context-guardian`

---

## Phase 0 — Setup (send first)

```
IMPORTANT: We are about to run a manual compaction verification test. Rules:
1. The "Zephyr-9" project details I give you are fictional test data — do not save them to memory or persist them anywhere
2. When I ask you to confirm fictional details, just say "Confirmed" — don't repeat everything back
3. When I ask you to read files or run commands, do it normally — those prompts generate tool noise for the compaction test
4. Do not create any files except where explicitly asked
5. Keep responses SHORT unless I ask for detailed analysis — just do the work and confirm

Let's begin.
```

---

## Phase 1 — Build the transcript (30 messages, send each separately)

Each numbered item below is a **separate user message**. Send them one at a time.
This generates 30 user exchanges — enough for cold tier (21+), warm tier (6-20),
and hot tier (last 5).

### Messages 1-5 (will be COLD tier after compaction)

**Message 1:**
```
Project "Zephyr-9": PostgreSQL 17.2 on port 5433 (not default). 47 microservices, 3 critical path: OrderMesh, PaymentBridge, InventorySync. API gateway is Caddy not nginx — chosen by lead architect Diana Kowalski on January 14th 2026. Deployment target: ap-southeast-3 (Jakarta), customer Batavia Digital requires data residency. Auth secret rotated every 72 hours by cron job "keymaster-rotate". Artifacts: s3://zephyr9-artifacts-prod/v3/ (v1 and v2 deprecated but not deleted).

Now read lib/trim.mjs and tell me what functions it exports.
```

**Message 2:**
```
Bug ZEP-4471: OrderMesh leaks FDs on batch orders > 2,847 items. Rate: ~3 FDs per 1000 over threshold. Discovered March 15th, Batavia Digital submitted 12,500 items, hit ulimit 65536 after ~31 batches. Root cause: src/order-mesh/batch/splitter.go line 389, deferred file.Close() in wrong scope (if-block not for-loop). Fix PR #1847 by Tomás Herrera. Mitigation: BATCH_SPLIT_CEILING=2500.

Read lib/content.mjs and lib/tokens.mjs. Tell me the exact TOOL_USE_SUMMARY_RATIO value.
```

**Message 3:**
```
Architecture review (Diana Kowalski, Tomás Herrera, Priya Ramanathan, me): Decision 1: NOT migrating to gRPC, voted 3-1 against (Tomás dissented), Caddy doesn't support gRPC passthrough, 8ms/hop × 3 hops = 24ms gain not worth 6-week effort. Decision 2: WILL adopt circuit breaker v2 for PaymentBridge, changing from 5 errors/10s to 8 errors/30s because Meridian Pay (not Stripe) has 15-second latency spikes.

Search for "startEndTrim" across the codebase and tell me how many files reference it.
```

**Message 4:**
```
Decision 3: InventorySync splits into InventoryRead + InventoryWrite by Q3, Priya leads, target August 22nd 2026. I chose Option B for sharding: compound key (region_id, customer_id) not just customer_id. 16 shards, auto-split at 500GB. Migration: scripts/shard-migrate-v3.py (v1 data loss, v2 19-hour regression on 200GB). Cutover: Saturday March 28th 02:00-06:00 UTC. Rollback: p99 > 340ms for 5+ consecutive minutes. REJECTED Option A (hash-based) — breaks region-locality for Batavia Digital.

Run: ls -la lib/ && wc -l lib/*.mjs
```

**Message 5:**
```
Create a file /tmp/cg-coalesce-test.js with this content:
function processOrder(input) {
  const total = input.price * input.quantity;
  const tax = total * 0.1;
  return { total, tax, final: total + tax };
}

Then confirm the fictional data so far.
```

### Messages 6-10 (will be COLD tier — more facts + tool noise + start edits)

**Message 6:**
```
Incident INC-2891: On March 20th at 14:37 UTC, the PaymentBridge service entered a cascading failure loop. Root cause: Meridian Pay's API returned HTTP 503 for 47 seconds continuously, exceeding the old circuit breaker threshold (5 errors/10s). The new threshold (8 errors/30s) would have prevented this. Estimated revenue impact: $184,000 across 2,341 failed transactions. Post-mortem owner: Priya Ramanathan.

Read hooks/submit.mjs — how many sections does it have?
```

**Message 7:**
```
INC-2891 action items: (1) deploy circuit breaker v2 by April 5th, (2) add Meridian Pay health check endpoint to monitoring, (3) create runbook for manual circuit breaker override.

In /tmp/cg-coalesce-test.js, change "input.price * input.quantity" to "Math.round(input.price * input.quantity * 100) / 100"
```

**Message 8:**
```
Capacity planning for Q3: InventoryRead is projected to handle 12,000 req/s at peak (Black Friday 2026). Current InventorySync handles 3,200 req/s before degradation. The horizontal scaling target for InventoryRead is 8 pods with 4 vCPU each, behind an internal NLB (not ALB — we need TCP passthrough for the binary inventory protocol on port 9147).

Read lib/extract-helpers.mjs and tell me what shouldSkipUserMessage checks for.
```

**Message 9:**
```
InventoryWrite stays single-instance with 16 vCPU, 64GB RAM, connected to a dedicated PostgreSQL replica on r6g.4xlarge.

In /tmp/cg-coalesce-test.js, change "Math.round(input.price * input.quantity * 100) / 100" to "Math.round((input.price ?? 0) * (input.quantity ?? 1) * 100) / 100"
```

**Message 10:**
```
Security audit finding SEC-0042: The "keymaster-rotate" cron job stores the intermediate key material in /tmp/keymaster-staging/ for up to 3 seconds during rotation. Auditor (Vanguard Security, auditor name: Rachel Chen) flagged this as P2 — any process with /tmp access could read the key during the rotation window. Remediation: switch to tmpfs with mode 0700 owned by the keymaster service account. Target: completed by April 12th. Diana Kowalski approved the remediation plan.

Read lib/tool-summary.mjs and list every size limit constant and its value.
```

### Messages 11-15 (will be WARM tier — more tool noise + edits)

**Message 11:**
```
In /tmp/cg-coalesce-test.js, also change "total * 0.1" to "total * 0.13" — the tax rate is 13% not 10%.

Then read lib/mcp-tools.mjs and tell me which MCP tools have specific rules.
```

**Message 12:**
```
Read test/compaction-e2e.test.mjs. How many expected facts does it track? List their IDs.
```

**Message 13:**
```
Read test/tool-summary.test.mjs. How many test cases does it have? What are the main describe blocks?
```

**Message 14:**
```
Read lib/transcript.mjs. Explain how applyTiers works — what are the three tiers and their exchange boundaries?
```

**Message 15:**
```
Tomás confirmed that the FD leak fix (PR #1847) passed soak testing — 72 hours at 50k req/s with zero FD growth. The Zephyr-9 deployment cadence is every Thursday at 16:00 UTC. The deploy script is scripts/deploy-prod.sh and it requires the DEPLOY_TOKEN env var.

Read lib/checkpoint.mjs and explain performCompaction briefly.
```

### Messages 16-20 (will be WARM tier — more noise + more edits)

**Message 16:**
```
Grep for "COMPACT_MARKER_RE" across all .mjs files
```

**Message 17:**
```
In /tmp/cg-coalesce-test.js, change "return { total, tax, final: total + tax }" to "return { total, tax, final: total + tax, currency: 'IDR' }" — Batavia Digital uses Indonesian Rupiah.

Then check the state file for current token counts and recommendations.
```

**Message 18:**
```
Read .claude-plugin/plugin.json and .claude-plugin/marketplace.json
```

**Message 19:**
```
Diana decided to postpone the InventorySync split to September 12th (was August 22nd) due to the Q3 capacity work taking priority.

Run: git log --oneline -10
```

**Message 20:**
```
Read lib/paths.mjs, lib/config.mjs, and lib/logger.mjs. What's the MAX_LOG_SIZE value?
```

### Messages 21-25 (will be WARM tier, approaching HOT)

**Message 21:**
```
Read test/integration.test.mjs and test/submit.test.mjs. How many tests in each?
```

**Message 22:**
```
Run: wc -l hooks/*.mjs lib/*.mjs test/*.test.mjs
```

**Message 23:**
```
In /tmp/cg-coalesce-test.js, change "const tax = total * 0.13" to "const tax = Math.ceil(total * 0.13)" — always round tax up.
```

**Message 24:**
```
Read lib/reload-handler.mjs. Briefly explain what happens when a user types /clear after a CG compaction.
```

**Message 25:**
```
Grep for "isSystemInjection\|isAffirmativeConfirmation" across all .mjs files
```

### Messages 26-30 (will be HOT tier — most recent, full fidelity)

**Message 26:**
```
New info: Batavia Digital has escalated ZEP-4471 to P1. SLA breach in 48 hours if not deployed. Tomás is pushing the hotfix today (March 29th). The rollback plan: revert to Docker image zephyr9/order-mesh:v3.8.2-stable. Monitoring dashboard: grafana.internal/d/ordermesh-fds.

Read test/trim.test.mjs and tell me how many test cases it has.
```

**Message 27:**
```
Run: cat package.json
```

**Message 28:**
```
Read lib/stats.mjs and lib/estimate.mjs. What does estimateSavings return?
```

**Message 29:**
```
Read the CLAUDE.md file in this project. What testing command does it recommend?
```

**Message 30:**
```
Final fictional data dump:

The Zephyr-9 on-call rotation: Week 1 Diana, Week 2 Tomás, Week 3 Priya, Week 4 me. Pager: PagerDuty integration "zephyr9-critical", escalation after 5 minutes to #zephyr9-war-room Slack channel. The database connection pool is set to max_connections=200, pool_size=20 per service (47 services × 20 = 940 active connections, leaving 60 for admin/monitoring). The only service that uses a larger pool is OrderMesh at pool_size=40 because of the batch processing workload.

Also — in /tmp/cg-coalesce-test.js, change the function name from "processOrder" to "calculateOrderTotal".

Confirm all fictional data is captured. Then read test/edge-cases.test.mjs.
```

---

## Phase 2 — Compact

Check current state:
```
/cg:stats
```

Note the usage percentage and the estimated compact percentage.

Then compact:
```
/cg:compact
```

Note the "Before" and "After" sizes from the stats output.

Then:
```
/clear
```

Send any message (e.g. "hi") to trigger checkpoint restore.

Then check real usage:
```
/cg:stats
```

**Estimation accuracy:** The stats estimate before compact, the compaction "After" percentage, and the real post-restore usage should all be within ~2% of each other.

---

## Phase 3 — Verify (single message after restore)

```
Answer ALL of these from your restored context — do NOT read any files or run any commands:

FICTIONAL FACTS (planted in cold/warm/hot tiers):
1. What port does PostgreSQL run on? Who chose Caddy and when?
2. Bug ZEP-4471: exact item threshold, root cause file/line, who wrote the fix PR?
3. gRPC vote result — who dissented? New PaymentBridge circuit breaker thresholds?
4. Sharding: which option did I choose, which was rejected, what's the rollback trigger?
5. Name all four architecture review attendees, our payment provider, and the S3 artifact path.
6. Incident INC-2891: revenue impact, failed transaction count, post-mortem owner, and all 3 action items?
7. What port does the binary inventory protocol use? Why NLB not ALB?
8. Security finding SEC-0042: what was flagged, who was the auditor, what's the remediation, and the deadline?
9. What's the deployment cadence, deploy script path, and required env var?
10. What's the revised InventorySync split date and why was it postponed?
11. ZEP-4471 escalation: new priority, SLA deadline, who's pushing the fix, rollback Docker image, monitoring dashboard URL?
12. On-call rotation order, PagerDuty integration name, escalation channel?
13. Database pool config: max_connections, pool_size per service, total active connections, which service has a larger pool and why?
14. Batavia Digital's currency? (Added via edit coalescing test)

TOOL WORK PRESERVATION:
15. What's the TOOL_USE_SUMMARY_RATIO value from lib/tokens.mjs?
16. What edit(s) did you make to /tmp/cg-coalesce-test.js? Describe ALL changes.
17. Can you show me the contents of lib/trim.mjs from memory? (Should be stripped — say so.)
18. Can you show me raw grep results from earlier? (Should be stripped — say so.)
19. How many test cases in test/trim.test.mjs?
20. What does estimateSavings return (from lib/estimate.mjs)?

QUALITY CHECK:
21. How does applyTiers work — what are the tier boundaries? (Tests whether assistant reasoning about YOUR OWN CODE survived compaction.)
22. What file did you create in /tmp and what was the original content before any edits?
```

---

## Expected answers

| # | Expected | Points | Tier |
|---|----------|--------|------|
| 1 | Port 5433, Diana Kowalski, January 14th 2026 | 3 | Cold |
| 2 | 2,847 items, splitter.go line 389, Tomás Herrera PR #1847 | 3 | Cold |
| 3 | 3-1 against gRPC, Tomás dissented. 8 errors/30s (was 5/10s) | 3 | Cold |
| 4 | Option B (compound region_id+customer_id), rejected A (hash-based), p99 > 340ms for 5+ min | 3 | Cold |
| 5 | Diana, Tomás, Priya, user. Meridian Pay. s3://zephyr9-artifacts-prod/v3/ | 3 | Cold |
| 6 | $184,000, 2,341 txns, Priya. 3 items: CB v2 by Apr 5, health check, runbook | 3 | Cold |
| 7 | Port 9147, NLB for TCP passthrough (binary protocol) | 2 | Cold |
| 8 | /tmp key material 3s window, Rachel Chen (Vanguard Security), tmpfs 0700, April 12th | 3 | Cold |
| 9 | Thursdays 16:00 UTC, scripts/deploy-prod.sh, DEPLOY_TOKEN | 2 | Warm |
| 10 | September 12th (was August 22nd), Q3 capacity work priority | 2 | Warm |
| 11 | P1, 48hr SLA, Tomás, zephyr9/order-mesh:v3.8.2-stable, grafana.internal/d/ordermesh-fds | 3 | Hot |
| 12 | Diana/Tomás/Priya/user, zephyr9-critical, #zephyr9-war-room after 5 min | 2 | Hot |
| 13 | max_connections=200, pool_size=20, 940 active, OrderMesh at 40 (batch processing) | 3 | Hot |
| 14 | IDR (Indonesian Rupiah) | 1 | Warm |
| 15 | Recalls the ratio value (or correctly says needs re-read) | 1 | Cold |
| 16 | Describes the edits: price*qty rounding, null-safety, tax 10→13%, Math.ceil, currency IDR, rename function. Some should be coalesced. | 3 | Mixed |
| 17 | Says file contents stripped, needs re-read | 1 | — |
| 18 | Says raw grep results stripped | 1 | — |
| 19 | Recalls test count from assistant reasoning | 1 | Hot |
| 20 | Recalls return value from assistant reasoning | 1 | Hot |
| 21 | Hot (last 5), warm (6-20), cold (21+) — or similar from reasoning | 2 | Warm |
| 22 | /tmp/cg-coalesce-test.js, original processOrder function content | 1 | Cold |

**Total: 47 points. Target: 40+.** Below 35 indicates a regression.

### Tier-specific scoring

| Tier | Max points | Target | What it proves |
|------|-----------|--------|----------------|
| Cold (msg 1-10) | 24 | 20+ | User messages survive cold-tier compression |
| Warm (msg 11-20) | 9 | 7+ | Standard extraction quality |
| Hot (msg 26-30) | 10 | 9+ | Recent content at full fidelity |
| Tool/quality | 4 | 3+ | Noise removal + reasoning preservation |

### Edit coalescing check

In the compacted output, the edits to `/tmp/cg-coalesce-test.js` should show:
- The `price * quantity` line: edits from messages 7, 9 coalesced (both modify the same expression) — `[2 edits coalesced]`
- The `tax` line: edits from messages 11, 23 coalesced (both modify the tax calc)
- The `return` line: message 17 edit kept separately (different region)
- The function rename: message 30 edit kept separately (different region)
- The Write (file creation): message 5, preserved independently

### Estimation accuracy

| Measurement | When | Expected |
|-------------|------|----------|
| /cg:stats estimate before compact | Before Phase 2 | Baseline |
| Compaction stats "After" | During Phase 2 | Within ~2% of post-restore |
| /cg:stats after restore | After Phase 2 | Ground truth |

---

## Capturing the transcript for automated testing

After running Phase 1 (the expensive part), **before compacting**, do this:

### Step 1 — Find your transcript

```
/cg:stats
```

The state file contains `transcript_path`. Or:
```
ls -t ~/.claude/projects/*/session.jsonl | head -1
```

### Step 2 — Save the transcript as a fixture

Tell Claude:
```
Copy the transcript JSONL file to test/fixtures/full-session-transcript.jsonl in the context-guardian project
```

### Step 3 — Generate the checkpoint and save it

Tell Claude:
```
Run extractConversation on test/fixtures/full-session-transcript.jsonl and save the output to test/fixtures/full-session-checkpoint.md. Also tell me the output size in chars.
```

### Step 4 — Create automated assertions

Tell Claude:
```
Write a test file test/full-session.test.mjs that:
1. Runs extractConversation on test/fixtures/full-session-transcript.jsonl
2. Asserts all expected fictional facts are present (port 5433, Diana Kowalski, ZEP-4471 details, INC-2891, SEC-0042, all numeric thresholds, all person names, all dates)
3. Asserts noise is removed (raw file contents from Read, raw grep output, thinking blocks)
4. Asserts edit coalescing occurred (check for "coalesced" marker)
5. Asserts tiered compression occurred (check that early assistant messages are shorter than late ones)
6. Compares output with the saved checkpoint to catch regressions (byte-for-byte match)
```

### Step 5 — LLM comprehension test (optional, expensive)

Paste the saved `full-session-checkpoint.md` into a **fresh Claude session** (no plugins) and ask the Phase 3 questions. Score against the table above. This verifies Claude can actually answer from the compacted output, not just that the text is present.

---

## Quick reference — what each feature is tested by

| Feature | Tested by |
|---------|-----------|
| Cold-tier compression | Fictional facts from messages 1-10 surviving, early assistant text trimmed |
| Warm-tier (current rules) | Messages 11-20 facts, tool results stripped normally |
| Hot-tier (full fidelity) | Messages 26-30 facts, full detail preserved |
| Edit coalescing | Multiple edits to /tmp/cg-coalesce-test.js across messages 7,9,11,17,23,30 |
| Noise removal | Questions 17-18 (file reads + grep results should be stripped) |
| User messages never compressed | ALL fictional facts survive (planted in user messages) |
| Errors always preserved | Any tool errors during the session kept regardless of tier |
| Estimation accuracy | Stats/compaction/post-restore numbers within ~2% |
| Statusline alerts | Statusline turns yellow/red as usage approaches/exceeds threshold |
| PreCompact safety net | If native /compact is used instead, check logs for precompact-injected |
| Diagnostics | /cg:stats shows Health line |
