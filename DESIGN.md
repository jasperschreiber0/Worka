# DESIGN.md — WorkA Visual Reference

**Read this file at the start of every Claude Code session that touches UI, alongside CLAUDE.md.**
**DESIGN.md governs feel. CLAUDE.md governs logic. Both are non-negotiable.**

---

## 1. Design Philosophy

WorkA is an industrial-minimal product for tradespeople. It is not a startup dashboard. It is not a SaaS admin panel. It is not Buildertrend.

The aesthetic is: **dark, dense, precise, trustworthy.** Every element earns its place. Nothing decorative. Nothing playful. The UI should feel like a tool a builder would trust to hold their money and their client relationships.

**The one thing someone should feel when they use WorkA:** "This knows what it's doing."

**Four rules that govern every design decision:**
1. Information density over whitespace — builders are scanning, not reading
2. Hierarchy through weight and size, not color — color is reserved for status signals only
3. No chrome, no navigation, no tabs — the job IS the interface
4. Orange means action or alert. Never decorative.

---

## 2. Color Tokens

These are the exact values. Do not approximate. Do not introduce new colors.

```css
:root {
  /* Backgrounds — layered depth */
  --bg-shell: #1a1a1a;        /* outermost shell, app background */
  --bg-surface: #222222;      /* cards, panels, chat column */
  --bg-elevated: #2a2a2a;     /* inputs, draft email container, hover states */
  --bg-border: #2e2e2e;       /* dividers, borders, separators */

  /* Text hierarchy — 4 levels */
  --text-primary: #e0e0e0;    /* headings, job titles, primary values */
  --text-secondary: #999999;  /* labels, secondary info, metadata */
  --text-tertiary: #555555;   /* timestamps, muted labels, stage indicators */
  --text-ghost: #333333;      /* placeholder text */

  /* Brand — orange, used sparingly */
  --orange-primary: #ff6b2b;  /* WorkA avatar, critical values, action buttons */
  --orange-subtle: rgba(255, 107, 43, 0.13); /* WorkA avatar background */
  --orange-text: #ff6b2b;     /* pending days count, inline $ refs */

  /* Status signals */
  --status-green: #4caf50;    /* clocked in, completed stages, active dot */
  --status-amber: #ff9800;    /* variations total, warnings, awaiting states */
  --status-red: #f44336;      /* block on stage, overdue, critical */
  --status-blue: #2196f3;     /* neutral info, document icons */

  /* Awaiting approval pill */
  --pill-awaiting-bg: rgba(255, 152, 0, 0.15);
  --pill-awaiting-text: #ff9800;
  --pill-awaiting-border: rgba(255, 152, 0, 0.3);
}
```

**RGBA tinted backgrounds** (use when you need a background tied to a status):
```
Green bg:  rgba(76,175,80,0.15)   border: rgba(76,175,80,0.25)
Red bg:    rgba(244,67,54,0.1)    border: rgba(244,67,54,0.3)
Amber bg:  rgba(255,152,0,0.1)    border: rgba(255,152,0,0.3)
Blue bg:   rgba(33,150,243,0.1)   border: rgba(33,150,243,0.3)
```

**How to apply colors in code — always inline style, never Tailwind color classes:**
```tsx
// CORRECT
<span style={{ color: 'var(--status-amber)' }}>$9,200</span>
<div style={{ backgroundColor: 'rgba(244,67,54,0.1)', border: '0.5px solid rgba(244,67,54,0.3)' }}>

// WRONG — never Tailwind color utilities
<span className="text-amber-500">$9,200</span>
<div className="bg-red-100 border-red-300">
```

---

## 3. Typography

```
Font: Inter (loaded from Google Fonts in app/layout.tsx)
Mono: JetBrains Mono (for references, quote refs, VAR codes)

Scale used across all components:
  10px  — section labels (FINANCIALS, TIMELINE, CLIENT), timestamps, badge labels
  11px  — secondary metadata, subtext, pill labels, sub-rows
  12px  — body copy in right panel, card metadata rows
  13px  — chat messages, main card text, form inputs
  14px  — card titles, primary labels, job status
  15px  — URGENT alert message text
  16px  — variation dollar amount
  18px  — job name in right panel header

Weights:
  400 — body copy, secondary labels
  500 — job titles, contact names, primary values, medium/low alert text
  600 — URGENT alert message, card titles, dollar amounts
  700 — large dollar amounts (variation total)

Section labels: 10px, uppercase, letter-spacing 0.08em, var(--text-tertiary)
```

---

## 4. Layout — The Split Panel

This is the core layout. It appears whenever a job is in context.

```
┌─────────────────────────────┬──────────────────────┐
│         CHAT COLUMN         │    RIGHT PANEL        │
│         ~65% width          │    ~35% width         │
│                             │                       │
│  [header: WorkA + version]  │  [JOB SNAPSHOT]       │
│  [stats bar: 4 numbers]     │  [CLIENT]             │
│                             │  [FINANCIALS]         │
│  [message thread]           │  [TIMELINE]           │
│                             │  [NEXT MILESTONE]     │
│  [variation card]           │  [PENDING ACTIONS]    │
│                             │  [CREW ON SITE]       │
│  [contextual chips]         │  [COMMS]              │
│  [input bar]                │  [quick actions bar]  │
└─────────────────────────────┴──────────────────────┘
```

**Split:** `ChatShell.tsx` uses a flex layout — chat column grows, right panel is `w-80` (320px) fixed on md+. On mobile, right panel becomes a bottom sheet (`MobileJobSheet.tsx`).

**Divider:** `borderLeft: '0.5px solid var(--bg-border)'` — hairline only.

**Right panel scroll:** the panel body scrolls independently. Header and quick-actions bar are sticky.

**When no job is selected:** right panel shows the aggregate pulse — active jobs count, pipeline value, overdue total, pending variations. Not an empty state.

---

## 5. Stats Bar

Four always-visible numbers above the message thread. Each is a clickable button that sends a chat message.

```
┌──────────┬──────────┬──────────┬──────────┐
│  3       │  $455k   │  $28k    │  2       │
│  JOBS    │ PIPELINE │  OVERDUE │  VAR     │
└──────────┴──────────┴──────────┴──────────┘

height: auto (py-2)
border-bottom: 0.5px solid var(--bg-border)
background: var(--bg-shell)
Values: 15px, font-semibold, color varies by state
Labels: 10px, uppercase, letter-spacing 0.06em, var(--text-tertiary)
Overdue value: var(--status-red) when > 0
Variations value: var(--status-amber) when > 0
Active jobs / Pipeline: var(--text-primary)
```

---

## 6. Chat Column

### Header
```
height: 48px
padding: 14px 16px
border-bottom: 0.5px solid var(--bg-border)
background: var(--bg-shell)

Left:  WorkA logo + "WorkA" wordmark (14px, weight 600)
       version chip (10px, var(--text-tertiary))
Right: "Rates" link, Demo pill (when in demo mode), username, avatar menu
```

### Message Thread

```
padding: 16px
gap between messages: 14px
```

**YOU message:**
```
Label: "YOU" — var(--text-tertiary), 10px, weight 500, letter-spacing 0.08em
Avatar: 28px circle, background var(--bg-elevated), color var(--text-tertiary)
Message text: var(--text-secondary), 13px
```

**WORKA message:**
```
Label: "WORKA" — var(--text-tertiary), 10px, weight 500, letter-spacing 0.08em
Avatar: 28px circle, background var(--orange-subtle), color var(--orange-primary), "W" weight 600
Message text: var(--text-primary), 13px, weight 400, line-height 1.5
```

WorkA message text is heavier and brighter than user message text. The hierarchy signals authority.

### Contextual Action Chips

Appear below the last WorkA message, above the input. Maximum 3. Derived from the actual alerts returned — first chip is primary (orange tint), others are secondary (elevated).

```
Primary chip:   background rgba(255,107,43,0.13), border rgba(255,107,43,0.3), color var(--orange-primary)
Secondary chip: background var(--bg-elevated), border var(--bg-border), color var(--text-secondary)
border-radius: 4px, padding: 6px 12px, font-size: 12px
```

Chip labels are derived from real alert data — address extracted from the actual alert message text, not hardcoded names.

### Input Bar
```
background: var(--bg-elevated)
border: 0.5px solid var(--bg-border)
border-radius: 6px
padding: 12px 16px
margin: 0 16px 16px
placeholder: "Ask WorkA anything..." — var(--text-ghost), 13px
Mic button: right side, activates speech recognition (en-AU)
```

---

## 7. Morning Brief Card

The most important chat component. Rendered by `MorningBriefCard.tsx`.

### HIGH alerts (priority: 'high') — badge label: URGENT

These must dominate the visual field. They are the reason the builder opened the app.

```
border-radius: 8px (rounded-lg)
background: rgba(244,67,54,0.07)
border: 1px solid rgba(244,67,54,0.3)
border-left: 3px solid var(--status-red)   ← thick left accent
padding: 14px 16px

Badge: "URGENT" — 10px, bold, uppercase, red bg/text
Message: 15px, weight 600, var(--text-primary), margin-bottom 10px
Quick-action button: filled orange background (#ff6b2b), white text, 12px semibold, 3px border-radius
Action label: "Chase payment →" — 12px, var(--orange-primary), secondary to button
```

### MEDIUM alerts (priority: 'medium') — badge label: ACTION

```
background: var(--bg-surface)
border: 0.5px solid var(--bg-border)
padding: 9px 12px, border-radius: 4px

Badge: "ACTION" — amber bg/text
Message: 13px, weight 400, var(--text-secondary)
Quick-action: ghost style (bg-elevated + orange border + orange text)
```

### LOW alerts (priority: 'low') — badge label: FYI

Same structure as MEDIUM but badge uses muted colors (`--bg-elevated` / `--text-tertiary`).

### Blocker chips

When an alert message contains "waiting on client / trade / council / supplier", a blocker chip appears above the message text:

```
CLIENT:   rgba(33,150,243,0.12) bg, var(--status-blue) text
TRADE:    pill-awaiting colors
COUNCIL:  rgba(156,39,176,0.12) bg, #ce93d8 text
SUPPLIER: var(--bg-elevated) bg, var(--text-tertiary) text
```

### Summary text

The brief opens with a summary paragraph (13px, var(--text-primary), line-height 1.5) before the alert cards. Tight ops-manager tone: "3 jobs active. $28k overdue from Fitzroy — 3 days past due."

### Follow-up injection

700ms after the morning brief renders, a second WorkA message is injected. It comes from the server's `follow_up` field — always specific to the top alert: "Want me to send the payment chaser for Fitzroy now? It takes 30 seconds."

---

## 8. Variation Card

Rendered inline in the chat thread when a variation is relevant.

```
background: var(--bg-surface)
border: 0.5px solid var(--bg-border)
border-radius: 6px
padding: 14px 16px
margin-top: 10px
```

**Card header:** `"VAR-001 · 2 days ago"` left, status pill right
**Title:** 14px, weight 600, var(--text-primary)
**Description:** 12px, var(--text-secondary), line-height 1.5
**Dollar amount:** 20px, weight 700, var(--text-primary)
**Sub-line:** `"Labour $800 · Materials $2,400"` — 11px, var(--text-tertiary)
**Footer metadata:** Submitted by / Days pending (orange if urgent) / Contract impact
**Action row:** Approve (green) + Reject (red) buttons, then "Send to client →" link button below

---

## 9. Right Panel — Job Snapshot

### Panel Header
```
"JOB SNAPSHOT" eyebrow — 10px, uppercase, letter-spacing 0.08em, var(--text-tertiary)
Job address: 16px, weight 600, var(--text-primary)
Job ref + status pill: 11px row below
Stage pipeline: 4 dots (Quoting / Quoted / Active / Complete)
```

### Section pattern (all sections)
```tsx
<SectionGroup label="FINANCIALS">
  {/* rows */}
</SectionGroup>
```
Section label: 10px, uppercase, letter-spacing 0.08em, var(--text-tertiary), margin-bottom 8px.
Rows: `display: flex, justify-content: space-between`. Label 12px var(--text-secondary), value 12px var(--text-primary) weight 500.

### Financials Section

**Only rendered when at least one of: quote total > 0, variations total > 0, invoiced total > 0.** Hidden entirely for quoting jobs with no quote yet.

Rows: Contract / Variations / Invoiced / Margin (health badge: Healthy/Watch/At risk)
Progress bar: 3px height, var(--orange-primary) fill, var(--bg-border) track.
Below bar: "X% invoiced" left, "$Y remaining" right — 10px, var(--text-tertiary).

### Next Milestone callout

Appears inside the Timeline section. Shows the next actionable step with timing:
- Quoting → "Send quote" + quote deadline if set
- Quoted → "Awaiting client approval" + sent date
- Active → next invoice amount + due date

```
8px orange dot + label (12px, weight 500, var(--text-primary)) + timing (11px, var(--text-tertiary))
```

### Client Section
Avatar: 32px circle, background `#2c3e50`, initials white weight 700, 11px.
Name: 14px, weight 600. Email/phone rows with SVG icons.
Last contact: derived from most recent comms message timestamp.

### Pending Actions Section
Only rendered when `pendingVariations.length > 0 || overdueInvoices.length > 0`.
Card rows with amber/red tinting per item type.

### Crew on Site / Tasks / Comms
Standard section pattern. Comms section only rendered when messages exist.

### Quick Actions Bar (bottom, sticky)
```
padding: 10px 16px
border-top: 0.5px solid var(--bg-border)
background: var(--bg-shell)
flex row of text buttons: "Compose email", "View quote", "Upload plans", "Add task"
color: var(--orange-primary), 12px, weight 500
```

---

## 10. Aggregate Pulse (no job selected)

When no job is in context, right panel shows a 2×2 grid of stat cards:

```
Active jobs / Pipeline value / Overdue / Variations
Each: centered value (22px, weight 700) + label (10px, uppercase, var(--text-tertiary))
Card: var(--bg-surface) background, padding 12px 8px
Overdue value: var(--status-red) when > 0
Variations value: var(--status-amber) when > 0
```

Below the grid: muted hint text pointing to chat as the entry point.

---

## 11. Client Variation Approval Portal (`/approve/variation/[id]`)

A separate public-facing dark page. Uses hardcoded dark values (not CSS vars, since globals.css may not be available in all rendering contexts):

```
Shell: #0f1117
Card: #1a1f2e, border rgba(255,255,255,0.08), border-radius 16px (rounded-2xl)
Text primary: #f1f5f9
Text secondary: #94a3b8
Text tertiary: #64748b
Orange: #ff6b2b
Approve button: #4caf50 filled
Reject button: rgba(244,67,54,0.12) bg, #f44336 text
```

The approve button shows the amount inline: "Approve — $3,200". Name confirmation step appears as a modal before any action is committed.

---

## 12. Spacing System

```
4px   — tight internal padding (icon gaps, row sub-spacing)
6px   — chip padding vertical, small row gaps
8px   — standard row gap, card internal spacing, section label margin
9px   — compact alert card padding (medium/low)
10px  — section internal padding
12px  — standard component padding, paragraph spacing
14px  — chat message padding, URGENT alert padding
16px  — column padding (left/right), quick actions padding
24px  — section group separation in right panel
```

**Border radius:**
```
3px  — status pills, small badges
4px  — action chips, medium/low alert cards, small interactive elements
6px  — cards (variation card, draft email card), input bar
8px  — URGENT alert cards, client portal cards (rounded-lg)
16px — client portal main card only (rounded-2xl)
```

---

## 13. Interaction Rules

**Right panel opens** when a job is explicitly selected (clicking a job row, sending a job message, tapping a job name in chat). It does NOT auto-open from morning brief alert clicks — those trigger `onAction` which sends a chat message. The panel opens as a side-effect of that if the response mentions a job.

**Variation cards appear inline** in the chat thread — not in the right panel. The right panel shows job-level status. The chat column shows the action items.

**Draft email cards appear inline** in the chat thread, directly below the WorkA message that generated them.

**Quick-action buttons on URGENT alerts** execute directly — they don't navigate. They call `handleQuickAction` which drafts emails, approves variations, or sends chasers without leaving chat.

**Loading state:** WorkA avatar pulses (opacity 0.4 → 1.0, 800ms) while generating. No spinner, no text.

**Proactive check-in:** After 25 minutes of inactivity, WorkA injects a time-aware message surfacing the next risk: morning → variations, afternoon → milestone, evening → outstanding items. Fires once per session.

**Voice input:** Mic button in input bar. Uses Web Speech API, `lang: 'en-AU'`. Transcribed text populates the input field, builder presses enter to send.

**Scope hints in AssumptionReview:** Accept removes the hint from the list and increments an accepted counter shown in the completion banner. Dismiss removes from list only. Both are local state — not persisted to DB in demo mode.

---

## 14. Alert Copy Convention

Every alert message follows the same structure:

```
[Short address] — [specific fact with numbers] — [consequence or urgency]
```

Examples:
- `"Fitzroy — $28,000 invoice 3 days overdue. Draft a chaser before it becomes a dispute."`
- `"Fitzroy — 2 variations worth $3,880 need your sign-off today. Trades are invoicing you regardless."`
- `"Toorak — $127,500 quote sent to Tom Caruso 5 days ago, no reply. Waiting on CLIENT."`
- `"Brunswick — 11 days since job created, no quote sent yet. Client is waiting. Waiting on CLIENT."`

Rules:
- Always start with the short address (first part before comma)
- Always include the dollar amount and days elapsed
- Never use passive voice for consequences ("trades will invoice" not "trade invoicing may occur")
- Blocker label (Waiting on CLIENT/TRADE/COUNCIL/SUPPLIER) appears in the message text AND as a styled chip in the card

---

## 15. What Must Never Appear

- **No white or light backgrounds** anywhere in the builder-facing interface
- **No Tailwind color utilities** — `bg-slate-*`, `text-gray-*`, `bg-white`, `bg-green-*`, etc. Use CSS vars.
- **No colored backgrounds for section labels** — they are plain text
- **No tabs, no sidebar navigation, no breadcrumbs** — the chat input is the only navigation
- **No rounded corners above 16px** (and 16px only on the client approval portal)
- **No shadows** — depth through background color layering only
- **No gradients** — except the margin progress bar fill
- **No success toast notifications** — state changes reflected inline
- **No modal overlays for variations** — variations live in the chat column as inline cards
- **No hardcoded names in the UI layer** (no "Hendersons", "Tom Caruso" in ChatInterface.tsx) — derive from alert data
- **Orange is never decorative** — every use of orange signals action, urgency, or the WorkA brand

---

## 16. Session Instruction for Claude Code

At the start of every session that touches UI:

> "Read DESIGN.md in full before writing any component. Every color must use CSS custom properties from Section 2 — never Tailwind color utilities. Every alert must follow the copy convention in Section 14. Check Section 15 (What Must Never Appear) before shipping. If uncertain about a visual decision, check DESIGN.md first, then ask."

---

*DESIGN.md is a living document. When a new component is built that isn't covered here, add it before the session ends.*
