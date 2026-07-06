# Assessment System — Integration Architecture

How the reason-first assessment flow (document intake → scoping → estimate →
handover) wires into the existing **chat** and **upload** UX without tight
coupling or duplicated logic.

Grounded in what exists today:

- **Chat** — `app/api/chat/route.ts` classifies intent (edge fn `classify-intent`
  or keyword fallback), dispatches to handlers, returns a `ChatResponse` whose
  `events[]` drive UI side-effects. UI: `components/chat/ChatInterface.tsx`.
- **Upload** — `app/api/upload/route.ts` creates a `files` row + returns an
  upload URL; the browser PUTs bytes to Supabase Storage; `app/api/intake/[fileId]`
  streams SSE progress while `app/api/intake/[fileId]/worker/route.ts` runs the
  real extraction with an **untyped admin client**.
- **Assessment (Stages 1–5)** — `lib/estimation-reasoning.ts`,
  `lib/estimate-generation.ts`, `lib/rate-library.ts`, `lib/estimate-export.ts`,
  `lib/xlsx.ts`, fixtures in `lib/estimation-assessment-demo.ts` /
  `lib/estimate-demo.ts`, routes under `app/api/estimation/*`. Demo/real split via
  `isDemoMode()` in `lib/auth/api-auth.ts`.

The design keeps the CLAUDE.md four-layer rule intact: chat stays **Layer 1
(classify) → Layer 2 (decide)**, the runner is **Layer 2**, the output contract
is **Layer 3 (events)**, and the UI is **Layer 4 (render only)**.

---

## 1. High-level architecture — three layers

```
┌─ UI Layer ────────────────────────────────────────────────────────────┐
│ Next.js client components. Render state, dispatch user actions to API  │
│ routes, react to output-contract events. NO business logic / DB / LLM. │
│ ChatInterface, UploadPanel, ProjectAssessmentCard, ClarifyingQuestions,│
│ EstimateView.                                                          │
└───────────────────────────────────────────────────────────────────────┘
                │  HTTP (thin API routes: auth, parse, delegate)
┌─ Orchestration Layer ─────────────────────────────────────────────────┐
│ API routes + AssessmentRunner. Owns routing + stage sequencing, builds │
│ the output contract. Calls services and repositories through injected  │
│ interfaces. NO SQL, NO prompt text, NO UI, NO Supabase import.         │
└───────────────────────────────────────────────────────────────────────┘
                │  typed interfaces (dependency injection)
┌─ Core Services  (+ infrastructure adapters beneath) ──────────────────┐
│ Domain services — pure, stateless, unit-testable without DB/LLM:       │
│   extraction · reasoning · estimation (+guards) · rate-library · export│
│ Infrastructure adapters (injected into services/runner):               │
│   repositories (data) · llm provider (Anthropic) · storage (Supabase). │
└───────────────────────────────────────────────────────────────────────┘
```

| Layer | Owns | Never does |
|-------|------|------------|
| **UI** | Rendering, user input, dispatching actions, reacting to events | Business logic, DB, LLM, extraction |
| **Orchestration** | Stage routing, sequencing, assembling the contract | SQL, prompt strings, UI concerns |
| **Core Services** | Domain logic (deterministic where possible) | Know about HTTP, React, or `isDemoMode()` |
| **Infra adapters** | Supabase, Anthropic, Storage access behind interfaces | Leak the concrete client to callers |

The single most important rule: **everything above Core Services depends on
*interfaces*, never on the Supabase or Anthropic client directly.** That is what
makes chat and upload share one path and makes the whole thing testable with
in-memory fakes.

---

## 2. Single orchestration entry point — `AssessmentRunner`

One entry point both chat and upload funnel into. It routes by input kind and by
the job's current stage; it does not contain business logic — it delegates to
services and persists through repositories. It is constructed with its
dependencies (DI), so tests inject fakes and production injects the real
Supabase/Anthropic adapters.

```ts
// lib/assessment/contract.ts

export type AssessmentStage = 'intake' | 'scoping' | 'estimate' | 'handover'

/** Discriminated union of everything that can advance an assessment. Both chat
 *  and upload construct one of these and call runner.run(). */
export type AssessmentInput =
  | { kind: 'upload'; fileIds: string[]; jobId?: string }
  | { kind: 'chat'; message: string; jobId?: string }
  | { kind: 'answer_question'; jobId: string; questionId: string; answer: string }
  | { kind: 'skip_questions'; jobId: string }
  | { kind: 'complete_questions'; jobId: string }
  | { kind: 'generate_estimate'; jobId: string; pricingMode: 'market' | 'user_supplied' }
  | { kind: 'export'; jobId: string; format: 'xlsx' | 'pdf' | 'client' }

/** Per-request context. Carries identity + mode; deps are injected separately. */
export interface RunContext {
  builderId: string
  mode: 'demo' | 'real'
}

// lib/assessment/runner.ts

export interface AssessmentRunner {
  run(input: AssessmentInput, ctx: RunContext): Promise<AssessmentResult>
}

/** The injected dependency container — interfaces only, no concrete clients. */
export interface AssessmentDeps {
  repos: Repositories          // §5 — data access
  llm: LlmProvider             // §5 — Anthropic wrapper
  storage: StoragePort         // §5 — Supabase Storage wrapper
  services: {
    extraction: ExtractionService
    reasoning: ReasoningService
    estimation: EstimationService
    export: ExportService
  }
}

/** Factory — production wires real adapters, tests wire fakes, demo wires
 *  fixture-backed repos. The runner code is identical in all three. */
export function createAssessmentRunner(deps: AssessmentDeps): AssessmentRunner
```

Routing sketch (shape only — no business logic lives here, it delegates):

```ts
async run(input, ctx) {
  switch (input.kind) {
    case 'upload':
      return this.stages.runIntake(input, ctx)        // extract → classify → reason → persist
    case 'chat':
      return this.stages.fromChat(input, ctx)          // resolve job + stage, advance appropriately
    case 'answer_question':
    case 'skip_questions':
    case 'complete_questions':
      return this.stages.resolveQuestions(input, ctx)  // scoping stage
    case 'generate_estimate':
      return this.stages.generateEstimate(input, ctx)  // estimate stage
    case 'export':
      return this.stages.handover(input, ctx)          // handover stage
  }
}
```

The runner never imports React, `next/server`, the Supabase client, or the
Anthropic SDK — only the interfaces in `AssessmentDeps`.

---

## 3. Input flows

Both flows produce an `AssessmentInput` and call `runner.run()`. That is the
"same core logic path" — the difference is only how the input is constructed.

### Upload flow

```
1. UI (UploadPanel)        → PUT bytes to Supabase Storage (existing direct upload)
2. UI                      → POST /api/estimation/assess { fileIds, jobId? }
3. Route (thin)            → auth + parse → runner.run({ kind:'upload', fileIds, jobId }, ctx)
4. Runner.runIntake        → storage.load(fileIds)                     [StoragePort]
                           → services.extraction.extract(docs)         [text layer / vision]
                           → services.reasoning.classify(docs)         [LLM, per-document + letterhead guard]
                           → services.reasoning.reason(docs, scope)    [LLM, scope object]
                           → repos.documents.replaceForJob(jobId, …)   [persist]
                           → repos.projectScope.upsert(jobId, scope)
                           → repos.openQuestions.replaceForJob(jobId, …)
5. Runner                  → returns AssessmentResult { stage:'scoping', nextAction:'answer_questions', … }
6. UI                      → renders ProjectAssessmentCard + ClarifyingQuestions from the contract
```

Persistence and LLM calls happen **only inside the runner/services**. The route
is ~10 lines: authenticate, parse body, delegate, return JSON. The existing SSE
progress route (`/api/intake/[fileId]`) keeps its job — it observes
`repos.files` progress — but no longer contains extraction logic.

### Chat flow

Chat must **not** touch DB, LLM, or extraction directly. It classifies, then
either answers conversationally or hands an `AssessmentInput` to the runner.

```
1. UI (ChatInterface)      → POST /api/chat { message, builder_id, jobId? }
2. Route → classifyIntent  → Layer 1 (existing classify-intent edge fn / keyword fallback)
3. Dispatch:
   • non-assessment intent → existing handler → ChatResponse (unchanged)
   • assessment intent      → build AssessmentInput and delegate:
        "generate the estimate"     → { kind:'generate_estimate', jobId, pricingMode }
        "answer: <text>"            → { kind:'answer_question', jobId, questionId, answer }
        "skip questions"            → { kind:'skip_questions', jobId }
        "export excel"              → { kind:'export', jobId, format:'xlsx' }
     → runner.run(input, ctx)
4. Adapter                 → maps AssessmentResult → ChatResponse.events (Layer 3)
5. UI                      → same event dispatcher renders the right component
```

The chat handler's only new responsibility is **translation**: intent →
`AssessmentInput`, and `AssessmentResult` → `ChatResponse.events`. It calls one
function (`runner.run`) and never sees Supabase, Anthropic, or a prompt string.

---

## 4. Output contract

One strict schema drives UI behaviour across both surfaces. It is a
discriminated union on `stage` so each stage carries exactly its payload, plus a
stable envelope (`jobId`, `summary`, `nextAction`, `uiHints`).

```ts
// lib/assessment/contract.ts

export type NextAction =
  | { type: 'answer_questions'; questionCount: number }
  | { type: 'generate_estimate'; pricingModes: Array<'market' | 'user_supplied'> }
  | { type: 'review_flags'; flagCount: number }
  | { type: 'export'; formats: Array<'xlsx' | 'pdf' | 'client'> }
  | { type: 'none' }

/** UI hints reuse the existing ChatEvent shape so ChatInterface's dispatcher and
 *  the assessment page share one renderer. `open_project_assessment`,
 *  `open_clarifying_questions`, `open_estimate` extend the current ChatEvent union. */
export type UiHint =
  | { type: 'open_project_assessment'; jobId: string }
  | { type: 'open_clarifying_questions'; jobId: string }
  | { type: 'open_estimate'; jobId: string }
  | { type: 'download'; url: string; filename: string }

interface AssessmentEnvelope {
  jobId: string
  summary: string                 // one-line, plain-English, UI-safe (never raw data)
  isIndicative: boolean           // drives the budget-range watermark everywhere
  nextAction: NextAction
  uiHints: UiHint[]
  warnings?: Array<{ severity: 'warn' | 'block'; message: string }>  // guard output
}

export type AssessmentResult =
  | (AssessmentEnvelope & { stage: 'intake';   data: { documents: ClassifiedDocument[] } })
  | (AssessmentEnvelope & { stage: 'scoping';  data: { scope: ScopeReasoning; questions: OpenQuestion[] } })
  | (AssessmentEnvelope & { stage: 'estimate'; data: { estimate: GeneratedEstimate } })
  | (AssessmentEnvelope & { stage: 'handover'; data: { exports: Array<{ format: string; url: string }> } })
```

Why this shape:

- **`stage`** is the discriminant the UI switches on to pick a component.
- **`summary` + `nextAction`** let the UI render a headline and the single most
  important button without understanding domain internals.
- **`uiHints`** map 1:1 onto `ChatResponse.events`, so chat and the assessment
  page reuse the same dispatcher — no second event system.
- **`isIndicative`** is surfaced once, at the top level, so every renderer and
  every export inherits the watermark decision (already true of Stages 2 & 5).
- **`warnings`** carries the estimation guards (window flat-rating, schedule
  subtotal, branding) as data, not baked into prose.

---

## 5. Supabase integration strategy

**Isolate all data access behind repository interfaces.** Nothing above the repo
layer imports `@supabase/supabase-js`. Each aggregate gets a repo; a factory
returns real or demo implementations, which is the *one* place `isDemoMode()`
lives (today it is scattered across every route).

```ts
// lib/repositories/index.ts

export interface DocumentsRepo {
  replaceForJob(jobId: string, docs: ClassifiedDocument[]): Promise<void>
  listForJob(jobId: string): Promise<ClassifiedDocument[]>
}
export interface ProjectScopeRepo {
  upsert(jobId: string, scope: ScopeReasoning, meta: ScopeMeta): Promise<void>
  get(jobId: string): Promise<StoredScope | null>
  setClarification(jobId: string, status: ClarificationStatus, isIndicative: boolean): Promise<void>
}
export interface OpenQuestionsRepo {
  replaceForJob(jobId: string, qs: OpenQuestion[]): Promise<void>
  listForJob(jobId: string): Promise<StoredQuestion[]>
  answer(jobId: string, questionId: string, answer: string): Promise<void>
}
export interface QuoteRepo {
  saveEstimate(jobId: string, estimate: GeneratedEstimate): Promise<{ quoteId: string }>
  latestForJob(jobId: string): Promise<StoredEstimate | null>
}
export interface FilesRepo {
  load(fileIds: string[], builderId: string): Promise<LoadedFile[]>
  updateProgress(fileId: string, stage: string, pct: number): Promise<void>
}

export interface Repositories {
  documents: DocumentsRepo
  projectScope: ProjectScopeRepo
  openQuestions: OpenQuestionsRepo
  quotes: QuoteRepo
  files: FilesRepo
}

/** The ONLY place the demo/real branch lives. */
export function createRepositories(mode: 'demo' | 'real'): Repositories {
  return mode === 'demo' ? createDemoRepositories() : createSupabaseRepositories()
}
```

**Avoiding UI/runner ↔ Supabase coupling.** The runner receives `Repositories`
through `AssessmentDeps`; it calls `repos.projectScope.get(jobId)`, never
`supabase.from('project_scope')`. The UI never sees a repo at all — it only sees
the output contract over HTTP.

**How the current untyped admin client fits — temporarily.** The concrete
`createSupabaseRepositories()` keeps using the untyped admin client
(`SupabaseClient<any>`, exactly as `intake/[fileId]/worker/route.ts` does today)
*inside the repo module only*. Callers already see fully typed methods
(`ClassifiedDocument[]`, `GeneratedEstimate`), so the `any` is quarantined behind
the interface. When `database.types.ts` is updated (step 1 below), swap
`createClient()` → `createClient<Database>()` inside the repo impls; **no caller
changes**. This is the migration seam that lets the untyped client exist now
without leaking.

**Providers** follow the same pattern:

```ts
// lib/providers/llm.ts
export interface LlmProvider {
  /** Tool-call helper extracted from the duplicated runTool/runExtraction. */
  toolCall<T>(opts: { system: string; blocks: unknown[]; userText: string;
                      toolName: string; schema: object; timeoutMs: number }): Promise<T | null>
}
// lib/providers/storage.ts
export interface StoragePort {
  load(fileIds: string[]): Promise<LoadedFile[]>   // wraps file-cache + Storage download
}
```

---

## 6. Folder structure

Target layout. The current `lib/` is flat; this groups by responsibility. Moves
are mechanical (re-export shims can keep old import paths alive during migration).

```
lib/
  assessment/
    runner.ts                 # AssessmentRunner + createAssessmentRunner
    contract.ts               # AssessmentInput, AssessmentResult, NextAction, UiHint
    stages.ts                 # stage machine: runIntake / resolveQuestions / generateEstimate / handover
  services/
    extraction/index.ts       # ← from intake/[fileId]/worker (text-layer/vision extraction)
    reasoning/index.ts        # ← estimation-reasoning.ts (classify + reason)
    estimation/
      generate.ts             # ← estimate-generation.ts
      guards.ts               # ← guards (window/schedule/branding)
      rate-library.ts         # ← rate-library.ts
    export/
      workbook.ts             # ← estimate-export.ts
      xlsx.ts                 # ← xlsx.ts (dependency-free writer)
  repositories/
    index.ts                  # Repositories interface + createRepositories()
    supabase/                 # real impls (untyped admin client quarantined here)
      documents.repo.ts  project-scope.repo.ts  open-questions.repo.ts
      quote.repo.ts      files.repo.ts
    demo/                     # fixture-backed impls
      index.ts                # ← estimation-assessment-demo.ts / estimate-demo.ts
  providers/
    llm.ts                    # Anthropic wrapper (LlmProvider)
    storage.ts                # Supabase Storage + file-cache (StoragePort)
  auth/api-auth.ts            # isDemoMode(), getAuthenticatedBuilderId() (unchanged)

app/api/
  estimation/assess/route.ts          # thin: auth → runner.run({kind:'upload'})
  estimation/questions/route.ts       # thin: → runner.run({kind:'answer|skip|complete'})
  estimation/estimate/route.ts        # thin: → runner.run({kind:'generate_estimate'})
  estimation/estimate/export/route.ts # thin: → runner.run({kind:'export'}) → stream
  chat/route.ts                       # classify → build AssessmentInput → runner → events
  upload/route.ts                     # unchanged (creates files row + upload URL)
  intake/[fileId]/route.ts            # SSE progress observer (reads repos.files)

components/
  chat/ChatInterface.tsx              # dispatches AssessmentInput actions, renders uiHints
  estimation/                         # ProjectAssessmentCard, ClarifyingQuestions,
                                      # EstimateView, IndicativeBanner (render-only)
```

Route handlers collapse to a uniform shape:

```ts
export async function POST(req: NextRequest) {
  const builderId = await getAuthenticatedBuilderId()
  if (!builderId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const body = await req.json()
  const runner = createAssessmentRunner(buildDeps(isDemoMode() ? 'demo' : 'real'))
  const result = await runner.run(toInput(body), { builderId, mode: isDemoMode() ? 'demo' : 'real' })
  return NextResponse.json(result)
}
```

---

## 7. Migration / implementation order

Sequenced so the risky UX changes come last and the early steps are pure
refactors with no behavioural change — each independently shippable.

| # | Step | Risk | Why this order |
|---|------|------|----------------|
| **1** | **Update `database.types.ts`** for `documents`, `project_scope`, `open_questions`, and the `quote_line_items` additions (`estimate_section`, `location_scope`, `basis`). | none | Unblocks typed repos; no runtime change. |
| **2** | **Repository layer + factory.** Wrap existing Supabase calls into `supabase/*.repo.ts`; build `demo/*` from the fixtures. Point existing routes at repos. | low | Pure refactor. Centralises the scattered `isDemoMode()` branches into one factory. Behaviour identical. |
| **3** | **Providers.** Extract the duplicated `runTool`/`runExtraction` into `LlmProvider`; wrap Storage + file-cache into `StoragePort`. | low | Removes duplication; gives services a seam to fake in tests. |
| **4** | **AssessmentRunner scaffold + contract.** Move stage sequencing out of routes into `runner.ts`/`stages.ts`. Routes become the thin uniform shape. | medium | Now there is one path; services/repos already exist from 2–3. |
| **5** | **Upload integration.** Repoint `intake/[fileId]/worker` extraction into `services.extraction` + `runner.runIntake`. SSE route becomes a progress observer over `repos.files`. | medium | Upload is the higher-volume path; do it first while the estimate UI is stable. |
| **6** | **Chat integration.** Chat dispatch builds `AssessmentInput` and calls the runner; add the `AssessmentResult → ChatResponse.events` adapter. Assert no DB/LLM/extraction import remains in chat handlers. | medium | Chat now shares the exact upload path. |
| **7** | **UI enhancements (last).** Extend the `ChatEvent` union with the assessment `uiHints`; unify the dispatcher so `ChatInterface` and the assessment page render `nextAction`/`uiHints`; wire assessment entry points into `UploadPanel`/`ChatInterface`. | user-facing | Only touched once the contract underneath is stable, so UI churn happens once. |

Guiding constraints honoured throughout: **separation of concerns** (UI ⟂
orchestration ⟂ services ⟂ infra), **testability** (services are pure; repos and
providers are fakeable interfaces), **one shared path** (chat and upload both go
through `runner.run`), and **no overengineering** (five repos, four services, one
runner, one contract — no event bus, no CQRS, no premature microservices). Real
Supabase + Anthropic execution stays a production concern injected at the edge;
every layer above the adapters is exercised in this environment with demo/fake
implementations, exactly as the Stage 1–5 harnesses already do.
