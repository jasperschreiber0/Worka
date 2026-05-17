# WorkA — Architecture Reference

## Start here — read this every session

**Always read this file first before writing any code.** This file is the source of truth for the WorkA architecture. Every session starts by reading CLAUDE.md to maintain consistency across the 15-session build plan.

Never invent table names, column names, intent names, or function signatures. Everything is defined here.

---

## What WorkA is

WorkA is an AI-powered operations manager for Australian residential builders. It replaces the builder's whiteboard, notebook, and spreadsheet with a single conversational interface. Builders type or speak in plain English; WorkA classifies the intent, executes the correct backend action, and returns plain-English results — zero raw data in the UI. The core workflow is: upload plans → AI-assisted draft quote (builder-reviewed, never auto-sent) → builder-approved → live job in one click.

---

## The Four-Layer Architecture

Every feature in WorkA is implemented across exactly four layers. **No layer does another layer's job.**

```
Layer 1 — Intent (AI)
  └── classify-intent edge function
  └── Receives: raw message string from builder
  └── Returns: { intent, entities, confidence, raw_message }
  └── Rule: ONLY classifies — never queries DB, never creates records

Layer 2 — Decision (Backend)
  └── Supabase edge functions: morning-brief, create-worker, create-job, etc.
  └── Receives: structured intent + entities from Layer 1
  └── Queries/mutates DB, applies business rules, rank-orders results
  └── Rule: ONLY backend logic — never calls Claude API directly (except classify-intent)
  └── Rule: NEVER sends anything to clients without builder approval

Layer 3 — Events (Schema)
  └── Structured event objects returned inside every Layer 2 response
  └── e.g. { type: 'open_upload_panel', job_id: '...' }
  └── e.g. { type: 'open_worker_modal', worker_id: '...' }
  └── e.g. { type: 'show_duplicate_warning', job_id: '...' }
  └── Rule: events are INSTRUCTIONS to the UI — they are data, not code
  └── Rule: the UI reads events and decides how to render them

Layer 4 — Presentation (UI)
  └── Next.js App Router (built in Sessions 3–15)
  └── Receives Layer 3 events and renders modals, panels, alerts
  └── Rule: ONLY renders — never makes business decisions
  └── Rule: zero raw data shown — all numbers and dates in plain English
```

**The golden rule:** If you find yourself writing database queries in a UI component, or rendering logic in an edge function, you have broken layer separation. Stop and move the code to the correct layer.

---

## Database Schema

All tables live in the `public` schema with RLS enabled.

### Core Entities

| Table | Purpose |
|-------|---------|
| `builders` | Main user accounts. `id` matches `auth.uid()`. One builder per subscription. |
| `workers` | Crew members belonging to a builder. Each gets an `invite_token` for onboarding. |
| `clients` | Home owners or developers that a builder works for. Optional on jobs. |

### Trade Categories (locked — never alter)

| Table | Purpose |
|-------|---------|
| `trade_categories` | The 13 locked trade categories. `sort_order` 1–13 is fixed forever. Seeded in migration 001. |

### Jobs & Quotes

| Table | Purpose |
|-------|---------|
| `jobs` | A physical building project at an address. Status machine: `quoting → quoted → active → complete → archived`. |
| `quotes` | A price proposal for a job. Has version number. Status: `draft → pending_review → sent → approved/rejected`. |
| `quote_line_items` | Individual priced items within a quote. Linked to a trade category. Has confidence score 0–100. |

### Rate Hierarchy (see 5-Tier section below)

| Table | Tier | Purpose |
|-------|------|---------|
| `builder_learned_rates` | Tier 1 | Auto-captured from builder's accepted quotes. Highest priority. |
| `builder_rate_preferences` | Tier 2 | Builder manually overrides a rate. |
| `builder_supplier_rates` | Tier 3 | Imported from supplier price lists. |
| `cost_rates` | Tier 4 | Platform defaults — 360+ items seeded in migration 002. |
| `network_rate_aggregates` | Tier 5 | Anonymised P25/P50/P75 across all builders. Lowest priority. |

### Variations & Invoices

| Table | Purpose |
|-------|---------|
| `variations` | Scope changes / change orders on active jobs. Status: `draft → pending → approved/rejected`. |
| `invoices` | Payment requests sent to clients. Status: `draft → sent → overdue → paid`. Forward-only. |

### Communications & Files

| Table | Purpose |
|-------|---------|
| `communication_history` | All inbound/outbound emails, SMS, and chat messages linked to jobs. |
| `files` | Uploaded PDFs, images, DWG files. `intake_status` tracks AI extraction pipeline. |
| `assumptions` | Line items the AI could not fully verify. Each must be resolved before quote is sent. |

---

## The 5-Tier Rate Hierarchy

When calculating a line item rate, WorkA checks tiers in this order and uses the **first match**:

```
Tier 1  builder_learned_rates      — builder's own historical rates (auto-updated on quote accept)
Tier 2  builder_rate_preferences   — builder manually pinned a rate
Tier 3  builder_supplier_rates     — imported supplier price list
Tier 4  cost_rates                 — WorkA platform defaults (360+ items, state-aware)
Tier 5  network_rate_aggregates    — anonymised network median (P50)
```

**Key rules:**
- A builder's own data always beats platform data (Tiers 1–3 beat Tier 4–5)
- Tier 4 is state-aware: `state = NULL` is the national fallback
- Tier 1 rates are updated automatically — never require manual action
- If no rate is found in any tier, the line item is flagged as an assumption (confidence = 0)

---

## The 13 Trade Categories

These categories are **locked forever**. Never rename, reorder, or add to them. All 360+ cost rates and every quote line item maps to one of these 13.

| # | Category | Typical Items |
|---|----------|--------------|
| 1 | Site Works & Concrete | Excavation, Footings, Slab, Paths, Drainage |
| 2 | Framing | Floor framing, Wall framing, Roof framing, Structural steel, LVL beams |
| 3 | Roofing | Roof sheeting Colorbond, Roof sheeting tile, Flashings, Gutters, Downpipes |
| 4 | External Cladding | Brick, Render, Weatherboard, Fibre cement, Timber cladding, Stone |
| 5 | Insulation | Wall batts, Ceiling batts, Foil underlay, Sarking |
| 6 | Internal Linings | Plasterboard walls, Plasterboard ceilings, Cornice, Set |
| 7 | Fit-out Carpentry | Doors, Door hardware, Skirtings, Architraves, Shelving |
| 8 | Cabinetry | Kitchen cabinetry, Laundry cabinetry, Vanities, Wardrobes, Linen |
| 9 | Paint | Internal walls, Internal ceilings, External paint, Feature walls |
| 10 | Flooring | Tiles, Carpet, Timber flooring, Vinyl, Polished concrete |
| 11 | Fixtures & Tapware | Toilets, Basins, Showers, Baths, Taps, Heated rails |
| 12 | Electrical | GPOs, Switches, Lights, Data, Alarms, Switchboard |
| 13 | Preliminaries | Permits, Council fees, Site costs, Insurance, Scaffolding |

---

## The 3 Quantity Validation Gates

Every AI-generated line item passes through 3 gates before it can be included in a quote. If it fails any gate, it is flagged as an assumption and must be resolved by the builder.

```
Gate 1 — No unit
  Condition: unit field is null or empty
  Action: flag as assumption, assumption_status = 'unresolved'
  Message: "Quantity unit not specified — please confirm the unit for [description]"

Gate 2 — No dimensions string
  Condition: quantity is non-null but dimensions_string is null
  Action: flag as assumption, assumption_status = 'unresolved'
  Message: "Quantity could not be verified from plans — confirm [quantity] [unit] for [description]"

Gate 3 — Zero or negative quantity
  Condition: quantity <= 0
  Action: exclude from quote, is_assumption = true, assumption_status = 'excluded'
  Message: "Invalid quantity ([quantity]) for [description] — excluded from quote"
```

**Builder approval is required to resolve Gate 1 and Gate 2 assumptions before quote can be sent.**

---

## Edge Functions

All edge functions live in `supabase/functions/`. They use Deno + ESM imports.

### classify-intent

**Layer:** 1 (AI)
**Path:** `supabase/functions/classify-intent/index.ts`

| | |
|-|-|
| **Input** | `POST { message: string, builder_id: string }` |
| **Output** | `{ intent: IntentType, entities: Record<string, string>, confidence: number, raw_message: string }` |
| **Model** | `claude-sonnet-4-20250514` |

Intent values: `morning_brief` | `add_worker` | `new_job` | `job_query` | `variation` | `invoice` | `unknown`

### morning-brief

**Layer:** 2 (Decision)
**Path:** `supabase/functions/morning-brief/index.ts`

| | |
|-|-|
| **Input** | `POST { builder_id: string }` |
| **Output** | `{ brief: string, alerts: Array<{ priority: 'high'|'medium'|'low', message: string, action?: string, entity_id?: string, entity_type?: string }> }` |

Alert ranking: overdue invoices → pending variations → stale sent quotes → inactive active jobs → summary counts

### create-worker

**Layer:** 2 (Decision)
**Path:** `supabase/functions/create-worker/index.ts`

| | |
|-|-|
| **Input** | `POST { builder_id: string, name: string, role: string, email?: string, phone?: string }` |
| **Output** | `{ worker: Worker, invite_url: string, modal_event: { type: 'open_worker_modal', worker_id: string } }` |

Status code: 201 on success. `invite_url` = `${NEXT_PUBLIC_APP_URL}/join/${invite_token}`

### create-job

**Layer:** 2 (Decision)
**Path:** `supabase/functions/create-job/index.ts`

| | |
|-|-|
| **Input** | `POST { builder_id: string, address: string, client_name?: string }` |
| **Output (new)** | `{ job: Job, event: { type: 'open_upload_panel', job_id: string } }` |
| **Output (dup)** | `{ duplicate: true, existing_job: Job, event: { type: 'show_duplicate_warning', job_id: string } }` |

Duplicate check uses case-insensitive ILIKE on first 3 address tokens. Archived jobs are excluded from duplicate check.

---

## The Three Test Messages

Run these after every session to verify the classify-intent function is working correctly.

```bash
# Test 1: Morning brief
curl -X POST https://<project>.supabase.co/functions/v1/classify-intent \
  -H "Content-Type: application/json" \
  -d '{"message": "whats on today", "builder_id": "test-builder-id"}'
# Expected: { "intent": "morning_brief", "entities": {}, "confidence": >= 80 }

# Test 2: Add worker
curl -X POST https://<project>.supabase.co/functions/v1/classify-intent \
  -H "Content-Type: application/json" \
  -d '{"message": "add Jack hes a carpenter", "builder_id": "test-builder-id"}'
# Expected: { "intent": "add_worker", "entities": { "name": "Jack", "role": "carpenter" }, "confidence": >= 80 }

# Test 3: New job
curl -X POST https://<project>.supabase.co/functions/v1/classify-intent \
  -H "Content-Type: application/json" \
  -d '{"message": "new job at 52 Bendigo St help me quote it", "builder_id": "test-builder-id"}'
# Expected: { "intent": "new_job", "entities": { "address": "52 Bendigo St" }, "confidence": >= 80 }
```

All three must return the expected intent with confidence >= 80 before ending a session.

---

## Safety Rules

These rules are non-negotiable. Never violate them, even if the builder seems to want you to.

1. **Never send without builder approval.** No quote, invoice, variation, or communication is ever sent to a client without the builder explicitly approving it. The builder is always the final authority.

2. **Never invent quantities.** If the AI cannot extract a quantity from the uploaded plans with confidence, it creates an assumption. The builder must resolve all assumptions before a quote can progress from `draft` to `pending_review`.

3. **Forward-only state machines.** Job, quote, invoice, and variation statuses only move forward. A `paid` invoice cannot become `draft`. An `approved` variation cannot become `pending`. Write guards in any function that changes status.

4. **Zero raw data in the UI.** The morning brief and all alerts must use plain English. Never display database IDs, raw timestamps, or raw amounts without formatting. Amounts in AUD, dates as "3 days ago" or "Tuesday", never ISO strings.

5. **Builder data isolation.** Every query must include `builder_id = auth.uid()` or use the RLS policies. Never query across builders. The service role key is only used in edge functions, never exposed to the browser.

6. **The 13 trade categories are immutable.** Never create, rename, or delete trade categories. All quote logic depends on the locked sort_order 1–13.

---

## Session Build Plan

| Session | Focus | Key Deliverables |
|---------|-------|-----------------|
| **1** | Scaffold & Schema | Next.js 14, Supabase schema, 4 edge functions, CLAUDE.md ✅ |
| **2** | Morning brief flow | Chat UI, classify-intent → morning-brief flow, ranked alerts ✅ |
| **3** | Add worker flow | Worker modal, invite generated and sent ✅ |
| **4** | New quote routing | Address detected, duplicate check, project created, upload panel ✅ |
| **5** | File upload + AI intake | PDF uploads, live progress states ✅ |
| **6** | Assumption control | Missing items surfaced, three resolution options ✅ |
| **7** | Draft quote output | Quote with confidence scoring per line item ✅ |
| **8** | Quote actions | Send to client, export PDF, revise ✅ |
| **9** | Split panel layout | Chat left, job snapshot right ✅ |
| **10** | Job snapshot panel | All six sections from real data ✅ |
| **11** | Variation surfacing | Pending variation in chat and panel ← current |
| **11** | Variation surfacing | Pending variation in chat and panel |
| **12** | Email draft flow | Draft from context, hold for approval, send logs |
| **13** | Email sync | Gmail/Outlook OAuth, inbound parsing, job matching |
| **14** | Quote to job conversion | One click, full job activation |
| **15** | Homepage | Upload zone hero, sample plans, quotes pipeline |



---

## Environment Variables

See `.env.local.example` for all required variables.

Key variables used in edge functions (Deno):
- `SUPABASE_URL` — injected automatically by Supabase
- `SUPABASE_SERVICE_ROLE_KEY` — injected automatically by Supabase
- `ANTHROPIC_API_KEY` — set in Supabase dashboard → Edge Functions → Secrets
- `NEXT_PUBLIC_APP_URL` — set in Supabase dashboard → Edge Functions → Secrets

---

## Tech Stack Reference

| Layer | Technology | Version |
|-------|-----------|---------|
| Frontend | Next.js App Router | 14.x |
| Styling | Tailwind CSS | 3.x |
| Database | Supabase (Postgres 15) | 2.x client |
| Auth | Supabase Auth | built-in |
| Storage | Supabase Storage | built-in |
| Realtime | Supabase Realtime | built-in |
| AI | Anthropic Claude | claude-sonnet-4-20250514 |
| Payments | Stripe | latest |
| Email | Resend | latest |
| SMS | Twilio | latest |
| Language | TypeScript | 5.x strict |
| Runtime (functions) | Deno | latest (Supabase managed) |
