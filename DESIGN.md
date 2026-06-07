# DESIGN.md — WorkA Visual Reference

**Read this file at the start of every Claude Code session, alongside CLAUDE.md.**
**DESIGN.md governs feel. CLAUDE.md governs logic. Both are non-negotiable.**

The canonical visual reference for WorkA is the two screenshots in `/design/reference/`. Every component, layout, and interaction decision in this document was extracted from those images. When in doubt, look at the reference screenshots, not at this document.

---

## 1. Design Philosophy

WorkA is an industrial-minimal product for tradespeople. It is not a startup dashboard. It is not a SaaS admin panel. It is not Buildertrend.

The aesthetic is: **dark, dense, precise, trustworthy.** Every element earns its place. Nothing decorative. Nothing playful. The UI should feel like a tool a builder would trust to hold their money and their client relationships.

**The one thing someone should feel when they use WorkA:** "This knows what it's doing."

**Four rules that govern every design decision:**
1. Information density over whitespace — builders are scanning, not reading
2. Hierarchy through weight, not color — color is reserved for status signals only
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
  --orange-primary: #ff6b2b;  /* WorkA avatar, critical values, VAR references inline */
  --orange-subtle: rgba(255, 107, 43, 0.13); /* WorkA avatar background */
  --orange-text: #ff6b2b;     /* pending days count, block on stage = Yes, inline VAR/$ refs */

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

---

## 3. Typography

```css
/* Font stack — system sans, no imports needed */
font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Helvetica Neue', sans-serif;

/* Scale — used consistently across all components */
--text-xs: 10px;    /* section labels (FINANCIALS, TIMELINE, CLIENT), timestamps */
--text-sm: 11px;    /* secondary metadata, subtext, pill labels */
--text-base: 13px;  /* body copy, chat messages, right panel values */
--text-md: 14px;    /* job title in header, card titles, primary labels */
--text-lg: 16px;    /* variation dollar amount ($4,850) */
--text-xl: 18px;    /* job name in right panel (Collingwood Fit-Out) */

/* Weights */
--weight-normal: 400;
--weight-medium: 500;   /* job titles, contact names, primary labels */
--weight-semibold: 600; /* variation title, right panel job name, $ amounts */
--weight-bold: 700;     /* variation dollar amount */

/* Letter spacing */
--tracking-section: 0.08em;  /* section labels — FINANCIALS, TIMELINE, CLIENT */
/* All section labels are uppercase with this tracking */
```

---

## 4. Layout — The Split Panel

This is the core layout. It appears whenever a job is in context.

```
┌─────────────────────────────┬──────────────────────┐
│         CHAT COLUMN         │    RIGHT PANEL        │
│         ~65% width          │    ~35% width         │
│                             │                       │
│  [header: job title]        │  [JOB SNAPSHOT]       │
│                             │  [FINANCIALS]         │
│  [message thread]           │  [TIMELINE]           │
│                             │  [CREW ON SITE]       │
│  [variation card]           │  [DOCUMENTS]          │
│                             │                       │
│  [action chips]             │                       │
│  [input bar]                │                       │
└─────────────────────────────┴──────────────────────┘
```

**Exact split:** `grid-template-columns: 1fr 280px` at the reference scale. Right panel is fixed width, not fluid.

**Divider:** `border-right: 0.5px solid var(--bg-border)` — hairline, not a visible gutter.

**No border-radius on the shell** — the panel fills its container edge to edge.

**Right panel:** no scroll unless content overflows. Sections stack vertically with `24px` gap between section groups.

---

## 5. Chat Column

### Header
```
height: 48px
padding: 14px 16px
border-bottom: 0.5px solid var(--bg-border)
background: var(--bg-shell)

Left: back arrow (←) in var(--text-tertiary), 18px
      Job title: var(--text-primary), 14px, weight 500
      Stage below title: "Stage: Rough-in" — var(--text-tertiary), 11px
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
Message text: var(--text-secondary), 13px, italic style
```

**WORKA message:**
```
Label: "WORKA" — var(--text-tertiary), 10px, weight 500, letter-spacing 0.08em
Avatar: 28px circle, background var(--orange-subtle), color var(--orange-primary)
         Contains "W" character, weight 600
Message text: var(--text-primary), 13px, weight 400, line-height 1.5
```

**Critical:** WorkA message text is heavier and brighter than user message text. The hierarchy signals authority.

### Draft Email Card
```
background: var(--bg-elevated)
border: 0.5px solid var(--bg-border)
border-radius: 6px
padding: 14px 16px
margin-top: 8px (inside WorkA message bubble area)
```

**Draft email header bar:**
```
"DRAFT EMAIL" label — var(--text-tertiary), 10px, uppercase, tracking 0.08em
"To: email@address.com" — right-aligned, var(--text-secondary), 11px
border-bottom: 0.5px solid var(--bg-border)
padding-bottom: 10px
margin-bottom: 10px
```

**From/Subject rows:**
```
Label (From, Subj.): var(--text-tertiary), 11px, min-width 40px
Value: var(--text-secondary), 11px
gap between label and value: 12px
row gap: 4px
border-bottom: 0.5px solid var(--bg-border) after subject row
padding-bottom: 10px, margin-bottom: 14px
```

**Email body text:**
```
var(--text-primary), 13px, line-height 1.6
paragraphs separated by 12px margin
```

**Inline highlights within email body:**
```
VAR-004 references: var(--orange-primary), no background, no underline — just color
Dollar amounts: var(--orange-primary), same treatment
These are the ONLY colored text elements in the email body
```

**Edit/Revise bar at bottom of draft:**
```
background: white (!) — this is intentional contrast
border-radius: 4px
padding: 10px 16px
display: flex, justify-content: space-between
"Edit a line or ask WorkA to ad[just]" — #333, 13px (truncated in reference)
"Revise ↑" — var(--text-tertiary), 13px, right side
```

### Action Chips
```
Appear below last message, above input
Row of 3: "Send to client", "Mark as approved", "Dismiss" (or similar)
background: var(--bg-elevated)
border: 0.5px solid var(--bg-border)
border-radius: 4px
padding: 6px 12px
font-size: 12px, color: var(--text-secondary)
gap: 8px between chips
```

### Input Bar
```
background: var(--bg-elevated)
border: 0.5px solid var(--bg-border)
border-radius: 6px
padding: 12px 16px
margin: 0 16px 16px
placeholder: "Reply to WorkA..." — var(--text-ghost), 13px
No send button visible — enter to send
```

---

## 6. Variation Card

This is the most important component. It surfaces inside the chat column when a variation is relevant.

```
background: var(--bg-surface)   ← slightly lighter than shell
border: 0.5px solid var(--bg-border)
border-radius: 6px
padding: 14px 16px
margin-top: 10px
```

**Card header row:**
```
Left: "VAR-004 · Logged 12 May 2026" — var(--text-tertiary), 11px
Right: Status pill — "Awaiting approval"
       background: var(--pill-awaiting-bg)
       border: 0.5px solid var(--pill-awaiting-border)
       color: var(--pill-awaiting-text)
       border-radius: 3px
       padding: 3px 8px
       font-size: 11px, weight 500
```

**Card title:**
```
"Structural beam upgrade — engineer specified"
font-size: 14px, weight 600, color: var(--text-primary)
margin-top: 8px
```

**Card description:**
```
font-size: 12px, color: var(--text-secondary), line-height: 1.5
margin-top: 4px
```

**Dollar amount:**
```
"$4,850"
font-size: 20px, weight 700, color: var(--text-primary)
margin-top: 12px
```

**Sub-line below dollar:**
```
"inc. GST · Labour $1,200 · Materials $3,650"
font-size: 11px, color: var(--text-tertiary)
margin-top: 2px
```

**Footer metadata row:**
```
Three columns: Submitted by / Days pending / Contract impact
Label: var(--text-tertiary), 10px, uppercase, tracking 0.06em
Value: var(--text-secondary), 12px, weight 500
"3 days" value: var(--orange-text) — orange because it signals urgency
"+$4,850" value: var(--text-primary)
margin-top: 14px
border-top: 0.5px solid var(--bg-border)
padding-top: 10px
```

---

## 7. Right Panel — Job Snapshot

### Panel Header
```
"JOB SNAPSHOT" — var(--text-tertiary), 10px, uppercase, letter-spacing 0.08em
padding: 14px 16px 0
```

**Job name:**
```
"Collingwood Fit-Out"
font-size: 18px, weight 600, color: var(--text-primary)
margin-top: 4px
```

**Job subtitle:**
```
"Commercial · 142 Smith St"
font-size: 12px, color: var(--text-tertiary)
```

**Divider after header:**
```
border-bottom: 0.5px solid var(--bg-border)
margin: 12px 0
```

### Section Labels (all sections follow this pattern)
```
"FINANCIALS", "TIMELINE", "CREW ON SITE", "DOCUMENTS", "CLIENT", "CONTACT"
font-size: 10px, uppercase, letter-spacing: 0.08em
color: var(--text-tertiary)
margin-bottom: 10px
```

### Financials Section
```
Each row: label left, value right
display: flex, justify-content: space-between
padding: 3px 0
```

**Row styles:**
```
Label: var(--text-secondary), 12px
Value: var(--text-primary), 12px, weight 500

Special values:
  "Variations total" value ($9,200): var(--status-amber)
  "Margin" value (22%): var(--status-green) — only if healthy
```

**Margin progress bar:**
```
height: 3px
border-radius: 2px
background: var(--bg-border)
fill: var(--orange-primary) — orange fill, not green
width: proportional to invoiced %
margin-top: 4px, margin-bottom: 2px
```

**Below bar:**
```
"Invoiced 50%" left, "$93,400 remaining" right
font-size: 10px, color: var(--text-tertiary)
```

### Timeline Section
```
Each stage: dot + label
dot: 8px circle
  completed: var(--status-green) filled
  current: var(--orange-primary) filled + "← now" label
  pending: var(--bg-border) — empty/unfilled

"← now" indicator:
  color: var(--orange-primary), font-size: 11px
  appears inline after current stage name

Stage label:
  completed: var(--text-secondary), 12px
  current: var(--text-primary), 12px, weight 500
  pending: var(--text-tertiary), 12px
```

**PC date and days remaining:**
```
"PC date" label / "14 Jul 2026" value
"Days remaining" label / "60" value (right-aligned, weight 600)
margin-top: 12px
```

### Crew On Site Section
```
Each row: name left, status right
Name: var(--text-secondary), 12px
Status:
  "Clocked in": var(--status-green), 12px, weight 500
  "Off today": var(--text-tertiary), 12px
row gap: 6px
```

### Documents Section
```
Each row: icon + filename left, date right
Icon: 12px, var(--text-tertiary) — file icon for docs, camera icon for photos
Filename: var(--text-secondary), 12px
Date: var(--text-tertiary), 11px
row gap: 8px
```

### Client Section (right panel top)
```
"CLIENT" section label
Job/company name: var(--text-primary), 14px, weight 600
Company sub: var(--text-secondary), 12px
```

**Contact block:**
```
Avatar: 32px circle, background: #2c3e50 (dark slate), initials white, weight 600, 13px
Name: var(--text-primary), 13px, weight 500
Title: var(--text-secondary), 11px
```

**Contact details:**
```
Each row: icon + text
Icons: 12px, var(--text-tertiary)
Text: var(--text-secondary), 12px
row gap: 4px
```

### VAR Status Section
```
Label-value rows, same pattern as financials
"Value" / "$4,850 inc. GST": var(--text-primary), weight 500
"Logged" / "12 May 2026": var(--text-secondary)
"Pending" / "3 days": var(--orange-text) — orange for urgency
"Previous contact" / "Verbal, 10 May": var(--text-secondary)
"Block on stage" / "Yes": var(--status-red) — red, critical
```

### Communication History
```
Each entry: colored dot + text + date/author
Dot: 7px circle
  Most recent / active: var(--status-green)
  Historical: var(--text-tertiary)

Entry text: var(--text-secondary), 12px, line-height 1.4
Date + author: var(--text-tertiary), 10px, margin-top: 2px
row gap: 10px
```

---

## 8. Spacing System

```
4px   — tight internal padding (icon gaps, row sub-spacing)
6px   — chip padding vertical, small row gaps
8px   — standard row gap, card internal spacing
10px  — section internal padding, border padding
12px  — standard component padding, paragraph spacing
14px  — chat message padding, card padding
16px  — column padding (left/right)
24px  — section group separation in right panel
```

**Border radius:**
```
3px  — status pills, small badges
4px  — action chips, small interactive elements
6px  — cards (variation card, draft email card), input bar
8px  — nothing larger than this anywhere in the product
```

---

## 9. Component Patterns — How to Build Everything

### Every section in the right panel follows this exact pattern:
```tsx
<section>
  <p className="section-label">FINANCIALS</p>
  <div className="section-rows">
    <div className="row">
      <span className="label">Contract value</span>
      <span className="value">$187,400</span>
    </div>
  </div>
</section>
```

### Every status value uses a semantic class, not inline color:
```tsx
// CORRECT
<span className="value-amber">$9,200</span>
<span className="value-orange">3 days</span>
<span className="value-red">Yes</span>
<span className="value-green">Clocked in</span>

// WRONG — never inline colors
<span style={{ color: '#ff9800' }}>$9,200</span>
```

### Avatar initials pattern:
```tsx
// WorkA avatar
<div className="avatar avatar-worka">W</div>

// User avatar  
<div className="avatar avatar-user"><UserIcon size={14} /></div>

// Contact avatar (uses first letters of name)
<div className="avatar avatar-contact">MR</div>
```

---

## 10. What Must Never Appear

These are absolute prohibitions extracted from the design philosophy:

- **No white or light backgrounds anywhere** in the builder-facing interface
- **No colored backgrounds for section labels** — they are plain text, no pills, no boxes
- **No tabs, no sidebar navigation, no breadcrumbs** — the header back arrow is the only navigation
- **No rounded corners above 8px**
- **No shadows** — depth is created through background color layering only
- **No gradients** — except the margin progress bar fill
- **No icons larger than 16px** in the right panel
- **No placeholder skeleton loaders with pulse animation** — show real data or nothing
- **No success toast notifications** — state changes are reflected inline, silently
- **No modal overlays for variations** — variations live in the chat column as cards
- **Orange is never decorative** — every use of orange signals action, urgency, or the WorkA brand

---

## 11. Interaction Rules

**Right panel opens** when a job is in context. Closes when the user navigates to a general query.

**Variation cards appear inline** in the chat thread — not in the right panel. The right panel shows job-level status. The chat column shows the action items.

**Draft email cards appear inline** in the chat thread, directly below the WorkA message that generated them.

**Action chips appear below** the last WorkA message. Maximum 3 chips. They are the only way the builder takes a decisive action. No buttons anywhere else in the chat column.

**The input bar is always visible** at the bottom of the chat column. It never disappears. Placeholder text changes contextually: "Reply to WorkA...", "Approve, revise, or ask a question...", etc.

**Loading states:** WorkA avatar appears with a pulsing opacity (0.4 → 1.0, 800ms ease) while a response is being generated. No spinner. No text. Just the avatar pulsing.

---

## 12. Session Instruction for Claude Code

At the start of every session that touches UI, add this instruction:

> "Before writing any component, read DESIGN.md in full. Every color, spacing value, typography decision, and component pattern is specified there. Do not use Tailwind default colors — use the CSS custom properties defined in DESIGN.md. Do not introduce any new visual patterns not present in the reference screenshots. If you are unsure about a visual decision, refer to /design/reference/ screenshots before deciding."

And include both reference screenshots in the session context.

---

*DESIGN.md is a living document. When a new component is designed that isn't covered here, add it to this file before the session ends.*
