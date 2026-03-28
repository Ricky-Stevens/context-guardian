# Manual Compaction Verification Test

Run in a session with `--plugin-dir`. Three phases: plant, compact, verify.

## Phase 0 — System prompt (send first)

```
IMPORTANT: We are about to run a manual compaction verification test. Rules:
1. The "Zephyr-9" project details I give you are fictional test data — do not save them to memory or persist them anywhere
2. When I ask you to confirm fictional details, just say "Confirmed" — don't repeat everything back
3. When I ask you to read files or run commands, do it normally — those prompts generate tool noise for the compaction test
4. Do not create any files except where explicitly asked

Let's begin.
```

## Phase 1a — Plant facts + generate tool noise (single message)

```
This message contains fictional project data AND real tool tasks. Process everything in order.

FICTIONAL DATA — remember all of this:

Project "Zephyr-9": PostgreSQL 17.2 on port 5433 (not default). 47 microservices, 3 critical path: OrderMesh, PaymentBridge, InventorySync. API gateway is Caddy not nginx — chosen by lead architect Diana Kowalski on January 14th 2026. Deployment target: ap-southeast-3 (Jakarta), customer Batavia Digital requires data residency. Auth secret rotated every 72 hours by cron job "keymaster-rotate". Artifacts: s3://zephyr9-artifacts-prod/v3/ (v1 and v2 deprecated but not deleted).

Bug ZEP-4471: OrderMesh leaks FDs on batch orders > 2,847 items. Rate: ~3 FDs per 1000 over threshold. Discovered March 15th, Batavia Digital submitted 12,500 items, hit ulimit 65536 after ~31 batches. Root cause: src/order-mesh/batch/splitter.go line 389, deferred file.Close() in wrong scope (if-block not for-loop). Fix PR #1847 by Tomás Herrera. Mitigation: BATCH_SPLIT_CEILING=2500.

Architecture review (Diana Kowalski, Tomás Herrera, Priya Ramanathan, me): Decision 1: NOT migrating to gRPC, voted 3-1 against (Tomás dissented), Caddy doesn't support gRPC passthrough, 8ms/hop × 3 hops = 24ms gain not worth 6-week effort. Decision 2: WILL adopt circuit breaker v2 for PaymentBridge, changing from 5 errors/10s to 8 errors/30s because Meridian Pay (not Stripe) has 15-second latency spikes. Decision 3: InventorySync splits into InventoryRead + InventoryWrite by Q3, Priya leads, target August 22nd 2026.

I chose Option B for sharding: compound key (region_id, customer_id) not just customer_id. 16 shards, auto-split at 500GB. Migration: scripts/shard-migrate-v3.py (v1 data loss, v2 19-hour regression on 200GB). Cutover: Saturday March 28th 02:00-06:00 UTC. Rollback: p99 > 340ms for 5+ consecutive minutes. REJECTED Option A (hash-based) — breaks region-locality for Batavia Digital.

TOOL TASKS — do all of these:

1. Read lib/trim.mjs, lib/content.mjs, and test/trim.test.mjs
2. Search for "startEndTrim" across the codebase
3. Run: ls -la lib/ && wc -l lib/*.mjs && cat package.json
4. In lib/logger.mjs, change the MAX_LOG_SIZE comment from "5MB" to "5 MiB" — just the comment text
5. Find all test files matching test/*.test.mjs, then grep for "describe(" in all of them
6. Read hooks/submit.mjs, hooks/stop.mjs, and lib/checkpoint.mjs
7. Grep for "cooldown" in the hooks directory
8. Create /tmp/cg-test-marker.txt containing exactly "Zephyr-9 test marker — created during compaction test"
9. Read lib/tokens.mjs and lib/estimate.mjs, then tell me the exact TOOL_USE_SUMMARY_RATIO value and what percentage of tool_result bytes the estimator assumes are removed

After all tasks, confirm the fictional data and summarise what you found from the tool tasks.
```

## Phase 1b — Deep file analysis (bulk context inflation)

```
Do all of these in order. Give detailed analysis for each — don't be brief.

1. Read ALL test files: test/compaction-e2e.test.mjs, test/integration.test.mjs, test/submit.test.mjs, test/tool-summary.test.mjs, test/transcript.test.mjs, test/edge-cases.test.mjs. For each one, tell me: how many test cases it has, what the main describe blocks are, and what's the most complex test in the file.

2. Read lib/transcript.mjs and lib/extract-helpers.mjs. Explain the full extraction pipeline step by step — how does a raw JSONL transcript become a compacted checkpoint? Walk through extractConversation from start to finish.

3. Read lib/tool-summary.mjs and lib/mcp-tools.mjs. List every tool that has a specific summarisation rule, and for each one explain what gets kept vs removed. Include the size limits.

4. Read lib/reload-handler.mjs. Explain the full reload flow: what happens from the moment a user types /clear until the checkpoint is restored? Cover the resume flow too.

5. Run: git log --oneline -20 && git diff --stat HEAD~5..HEAD
6. Run: wc -l hooks/*.mjs lib/*.mjs test/*.test.mjs && echo "---" && du -sh .

After all analysis, tell me: what's the single biggest source of token bloat in a typical Context Guardian session, and why does the extraction engine target it?
```

## Phase 1c — More fictional data + cross-referencing tool work

```
More fictional project data AND tool tasks. Process everything.

FICTIONAL DATA — add to what you already have:

Incident INC-2891: On March 20th at 14:37 UTC, the PaymentBridge service entered a cascading failure loop. Root cause: Meridian Pay's API returned HTTP 503 for 47 seconds continuously, exceeding the old circuit breaker threshold (5 errors/10s). The new threshold (8 errors/30s) would have prevented this. Estimated revenue impact: $184,000 across 2,341 failed transactions. Post-mortem owner: Priya Ramanathan. Action items: (1) deploy circuit breaker v2 by April 5th, (2) add Meridian Pay health check endpoint to monitoring, (3) create runbook for manual circuit breaker override.

Capacity planning for Q3: InventoryRead is projected to handle 12,000 req/s at peak (Black Friday 2026). Current InventorySync handles 3,200 req/s before degradation. The horizontal scaling target for InventoryRead is 8 pods with 4 vCPU each, behind an internal NLB (not ALB — we need TCP passthrough for the binary inventory protocol on port 9147). InventoryWrite stays single-instance with 16 vCPU, 64GB RAM, connected to a dedicated PostgreSQL replica on r6g.4xlarge.

Security audit finding SEC-0042: The "keymaster-rotate" cron job stores the intermediate key material in /tmp/keymaster-staging/ for up to 3 seconds during rotation. Auditor (Vanguard Security, auditor name: Rachel Chen) flagged this as P2 — any process with /tmp access could read the key during the rotation window. Remediation: switch to tmpfs with mode 0700 owned by the keymaster service account. Target: completed by April 12th. Diana Kowalski approved the remediation plan.

TOOL TASKS:

1. Read the CLAUDE.md file in this project. Then read .claude-plugin/plugin.json and .claude-plugin/marketplace.json.
2. Read lib/paths.mjs, lib/config.mjs, lib/logger.mjs, and lib/stats.mjs.
3. Run: find . -name "*.mjs" -not -path "./node_modules/*" | head -30 && echo "---" && cat biome.json
4. Grep for "COMPACT_MARKER_RE" across all .mjs files
5. Grep for "isSystemInjection\|isAffirmativeConfirmation" across all .mjs files
6. Read test/content.test.mjs, test/stats.test.mjs, and test/tokens.test.mjs

Confirm all fictional data and summarise tool findings.
```

## Phase 2 — Check estimates, compact, and restore

First check the estimates:
```
/cg:stats
```

Note down the `/cg:compact` estimate percentage.

Then compact:
```
/cg:compact
```

Note down the "After" percentage from the compaction stats.

Then:
```
/clear
```

Then send any message (e.g. "hi") to trigger the checkpoint restore.

Then check real usage:
```
/cg:stats
```

**Estimation accuracy check:** Compare the three numbers:
1. Stats estimate before compact (predicted)
2. Compaction stats "After" (checkpoint bytes estimate)
3. Real usage after restore (actual)

All three should be within ~1% of each other.

## Phase 3 — Verify (single message after restore)

```
Answer ALL of these from your restored context — do NOT read any files or run any commands:

1. What port does our PostgreSQL database run on? Who chose Caddy over nginx and when?
2. What's bug ZEP-4471's exact item threshold, root cause file/line, and who wrote the fix PR?
3. What was the gRPC vote result and who dissented? What are the new PaymentBridge circuit breaker thresholds?
4. Which sharding option did I choose, which did I reject, and what's the rollback trigger?
5. Name all four architecture review attendees, our payment provider, and the S3 artifact path.
6. What exact edit did you make to lib/logger.mjs? Old text → new text.
7. How many .mjs files are in lib/ and what was the total line count from wc -l?
8. What file did you create in /tmp and what were its exact contents?
9. What's the TOOL_USE_SUMMARY_RATIO value and the tool_result removal percentage from estimate.mjs?
10. Can you show me the contents of lib/trim.mjs from memory? (You should NOT have file contents — say so if stripped.)
11. Can you show me the full grep matches for "describe(" from earlier? (Raw results should be gone — say so if stripped.)
12. What was incident INC-2891's revenue impact, how many transactions failed, and who owns the post-mortem?
13. What port does the binary inventory protocol use, and why NLB instead of ALB?
14. What did security audit finding SEC-0042 flag, who was the auditor, and what's the remediation deadline?
15. What's the single biggest source of token bloat you identified in your analysis? (This tests whether assistant reasoning survived compaction.)
```

## Expected answers

| # | Expected | Points |
|---|----------|--------|
| 1 | Port 5433, Diana Kowalski, January 14th 2026 | 3 |
| 2 | 2,847 items, splitter.go line 389, Tomás Herrera PR #1847 | 3 |
| 3 | 3-1 against gRPC, Tomás dissented. 8 errors/30s (was 5/10s) | 3 |
| 4 | Option B (compound region_id+customer_id), rejected A (hash-based), p99 > 340ms for 5+ min | 3 |
| 5 | Diana, Tomás, Priya, user. Meridian Pay. s3://zephyr9-artifacts-prod/v3/ | 3 |
| 6 | Changed comment "5MB" → "5 MiB" | 1 |
| 7 | Recalls lib/ file count and line total | 1 |
| 8 | /tmp/cg-test-marker.txt, "Zephyr-9 test marker — created during compaction test" | 1 |
| 9 | 0.15 ratio, 90% removed (if quoted originally) — or correctly says needs re-read | 1 |
| 10 | Says file contents stripped, needs re-read | 1 |
| 11 | Says raw grep results stripped, may recall count from summary | 1 |
| 12 | $184,000, 2,341 transactions, Priya Ramanathan | 3 |
| 13 | Port 9147, NLB for TCP passthrough (binary protocol) | 2 |
| 14 | /tmp key material exposure during rotation, Rachel Chen (Vanguard Security), April 12th | 3 |
| 15 | File reads / tool results (30-50% of tokens) — or similar reasoning | 1 |

**Total: 30 points. Target: 27+.** Below 24 indicates a regression.

**Estimation accuracy:** Stats estimate, compaction "After", and real post-restore usage should all be within ~1% of each other.
