import { NextRequest, NextResponse } from 'next/server'
import { getAuthenticatedBuilderId } from '@/lib/auth/api-auth'
import { DEMO_QUOTE, DEMO_LINE_ITEMS } from '@/lib/quote-demo'
import type { DemoQuote, DemoQuoteLineItem } from '@/lib/quote-demo'

// ─── Format helpers ───────────────────────────────────────────────────────────

function formatCurrency(value: number): string {
  return `$${value.toLocaleString('en-AU')}`
}

function formatDate(isoString: string): string {
  return new Date(isoString).toLocaleDateString('en-AU', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  })
}

// ─── Group line items by category ─────────────────────────────────────────────

interface CategoryGroup {
  category_id: number
  category_name: string
  items: DemoQuoteLineItem[]
  category_total: number
}

function groupByCategory(items: DemoQuoteLineItem[]): CategoryGroup[] {
  const map = new Map<number, CategoryGroup>()

  for (const item of items) {
    if (item.assumption_status === 'excluded') continue

    if (!map.has(item.trade_category_id)) {
      map.set(item.trade_category_id, {
        category_id: item.trade_category_id,
        category_name: item.trade_category_name,
        items: [],
        category_total: 0,
      })
    }

    const group = map.get(item.trade_category_id)!
    group.items.push(item)
    group.category_total += item.total ?? 0
  }

  return Array.from(map.values()).sort((a, b) => a.category_id - b.category_id)
}

// ─── Render a category section as HTML ────────────────────────────────────────

function renderCategorySection(group: CategoryGroup): string {
  const rows = group.items.map((item) => {
    const isUnresolved = item.is_assumption && item.assumption_status === 'unresolved'
    const rowStyle = isUnresolved ? 'background:#fff7ed;' : ''
    const qty = item.quantity !== null ? String(item.quantity) : '?'
    const unit = item.unit ?? ''
    const rate = item.rate !== null ? formatCurrency(item.rate) : '?'
    const total = item.total !== null ? formatCurrency(item.total) : 'TBC'
    const flag = isUnresolved ? ' <span style="color:#d97706;font-size:11px;">[needs input]</span>' : ''

    return `
      <tr style="${rowStyle}">
        <td style="padding:6px 8px;border-bottom:1px solid #e2e8f0;font-size:13px;color:#1e293b;">${item.description}${flag}</td>
        <td style="padding:6px 8px;border-bottom:1px solid #e2e8f0;font-size:13px;text-align:right;color:#475569;">${qty} ${unit}</td>
        <td style="padding:6px 8px;border-bottom:1px solid #e2e8f0;font-size:13px;text-align:right;color:#475569;">${rate}</td>
        <td style="padding:6px 8px;border-bottom:1px solid #e2e8f0;font-size:13px;text-align:right;font-weight:600;color:#0f172a;">${total}</td>
      </tr>`
  }).join('')

  return `
    <div style="margin-bottom:24px;break-inside:avoid;">
      <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px;overflow:hidden;">
        <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 12px;background:#1e293b;">
          <span style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;color:#e2e8f0;">${group.category_name}</span>
          <span style="font-size:13px;font-weight:700;color:#f8fafc;">${formatCurrency(group.category_total)}</span>
        </div>
        <table style="width:100%;border-collapse:collapse;">
          <thead>
            <tr style="background:#f1f5f9;">
              <th style="padding:6px 8px;text-align:left;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;color:#64748b;border-bottom:1px solid #e2e8f0;">Description</th>
              <th style="padding:6px 8px;text-align:right;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;color:#64748b;border-bottom:1px solid #e2e8f0;">Qty</th>
              <th style="padding:6px 8px;text-align:right;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;color:#64748b;border-bottom:1px solid #e2e8f0;">Rate</th>
              <th style="padding:6px 8px;text-align:right;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;color:#64748b;border-bottom:1px solid #e2e8f0;">Total</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>`
}

// ─── Build the full HTML page ─────────────────────────────────────────────────

function buildHtmlPage(quote: DemoQuote, items: DemoQuoteLineItem[]): string {
  const groups = groupByCategory(items)
  const categorySections = groups.map(renderCategorySection).join('')

  const businessName = 'Nguyen Building Co.'
  const builderName = 'Dave Nguyen'
  const builderEmail = 'dave@nguyenbuilding.com.au'
  const builderPhone = '0412 345 678'

  const quoteDate = formatDate(quote.created_at)
  const quoteNumber = `Q-${quote.id.slice(0, 8).toUpperCase()}`

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Quote — ${quote.job_address}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      max-width: 820px;
      margin: 0 auto;
      padding: 40px 32px;
      color: #1e293b;
      background: #ffffff;
    }

    @media print {
      .no-print { display: none !important; }
      body { padding: 20px; }
      @page { margin: 20mm; }
    }

    .print-bar {
      background: #f0f9ff;
      border: 1px solid #bae6fd;
      border-radius: 8px;
      padding: 12px 16px;
      margin-bottom: 32px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }

    .print-bar p {
      font-size: 13px;
      color: #0369a1;
    }

    .print-btn {
      background: #0284c7;
      color: white;
      border: none;
      border-radius: 6px;
      padding: 8px 16px;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      white-space: nowrap;
    }

    .print-btn:hover { background: #0369a1; }

    .quote-header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      margin-bottom: 32px;
      padding-bottom: 24px;
      border-bottom: 2px solid #e2e8f0;
    }

    .business-name {
      font-size: 22px;
      font-weight: 800;
      color: #0f172a;
      letter-spacing: -0.02em;
    }

    .builder-info {
      font-size: 13px;
      color: #64748b;
      line-height: 1.7;
      margin-top: 4px;
    }

    .quote-meta {
      text-align: right;
    }

    .quote-label {
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: #94a3b8;
    }

    .quote-number {
      font-size: 20px;
      font-weight: 800;
      color: #0f172a;
      margin: 2px 0;
    }

    .quote-date {
      font-size: 13px;
      color: #64748b;
    }

    .project-section {
      background: #f8fafc;
      border: 1px solid #e2e8f0;
      border-radius: 8px;
      padding: 16px 20px;
      margin-bottom: 28px;
    }

    .project-label {
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: #94a3b8;
      margin-bottom: 4px;
    }

    .project-address {
      font-size: 16px;
      font-weight: 700;
      color: #0f172a;
    }

    .summary-table {
      width: 100%;
      border-collapse: collapse;
      margin-bottom: 32px;
      border: 1px solid #e2e8f0;
      border-radius: 8px;
      overflow: hidden;
    }

    .summary-table th {
      background: #f1f5f9;
      padding: 8px 16px;
      text-align: left;
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: #64748b;
      border-bottom: 1px solid #e2e8f0;
    }

    .summary-table td {
      padding: 10px 16px;
      font-size: 14px;
      border-bottom: 1px solid #f1f5f9;
    }

    .summary-table tr:last-child td {
      border-bottom: none;
      font-weight: 700;
      font-size: 16px;
      color: #0f172a;
      background: #f8fafc;
    }

    .section-heading {
      font-size: 14px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: #475569;
      margin-bottom: 12px;
    }

    .total-row {
      display: flex;
      justify-content: flex-end;
      margin-top: 24px;
      margin-bottom: 40px;
    }

    .total-box {
      background: #0f172a;
      color: white;
      border-radius: 8px;
      padding: 16px 24px;
      text-align: right;
    }

    .total-label {
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: #94a3b8;
      margin-bottom: 4px;
    }

    .total-amount {
      font-size: 28px;
      font-weight: 800;
      color: #ffffff;
    }

    .total-margin {
      font-size: 12px;
      color: #94a3b8;
      margin-top: 2px;
    }

    .footer {
      border-top: 1px solid #e2e8f0;
      padding-top: 20px;
      margin-top: 20px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    .footer-note {
      font-size: 12px;
      color: #94a3b8;
    }

    .worka-badge {
      font-size: 11px;
      color: #cbd5e1;
      font-weight: 600;
    }

    .validity-note {
      background: #f0fdf4;
      border: 1px solid #bbf7d0;
      border-radius: 6px;
      padding: 12px 16px;
      margin-bottom: 32px;
      font-size: 13px;
      color: #15803d;
    }
  </style>
</head>
<body>

  <!-- Print bar — hidden when printing -->
  <div class="no-print print-bar">
    <p>This page is optimised for printing. Use the button to save as PDF or print.</p>
    <button class="print-btn" onclick="window.print()">Print / Save as PDF</button>
  </div>

  <!-- Quote header -->
  <div class="quote-header">
    <div>
      <div class="business-name">${businessName}</div>
      <div class="builder-info">
        ${builderName}<br />
        ${builderEmail}<br />
        ${builderPhone}
      </div>
    </div>
    <div class="quote-meta">
      <div class="quote-label">Quote</div>
      <div class="quote-number">${quoteNumber}</div>
      <div class="quote-date">v${quote.version} &mdash; ${quoteDate}</div>
    </div>
  </div>

  <!-- Project details -->
  <div class="project-section">
    <div class="project-label">Project address</div>
    <div class="project-address">${quote.job_address}</div>
  </div>

  <!-- Validity note -->
  <div class="validity-note">
    This quote is valid for 30 days from the date above. To accept, reply to this email or call ${builderPhone} directly.
  </div>

  <!-- Trade category sections -->
  <div class="section-heading">Line items by trade</div>
  ${categorySections}

  <!-- Grand total -->
  <div class="total-row">
    <div class="total-box">
      <div class="total-label">Total project cost</div>
      <div class="total-amount">${formatCurrency(quote.total_cost)}</div>
      <div class="total-margin">Includes ${quote.margin_pct}% builder margin</div>
    </div>
  </div>

  <!-- Footer -->
  <div class="footer">
    <div class="footer-note">
      All amounts in AUD including GST unless stated. Quote prepared ${quoteDate}.
    </div>
    <div class="worka-badge">Quote prepared by WorkA</div>
  </div>

</body>
</html>`
}

// ─── Route handler ────────────────────────────────────────────────────────────

export async function GET(
  _request: NextRequest,
  { params }: { params: { quoteId: string } }
): Promise<NextResponse> {
  const builderId = await getAuthenticatedBuilderId()
  if (!builderId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { quoteId } = params

  let quote: DemoQuote
  let items: DemoQuoteLineItem[]

  if (quoteId === 'demo-quote-id') {
    quote = DEMO_QUOTE
    items = DEMO_LINE_ITEMS
  } else {
    // Real Supabase path — not implemented in this session
    return NextResponse.json({ error: 'Quote not found' }, { status: 404 })
  }

  const html = buildHtmlPage(quote, items)

  return new NextResponse(html, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  })
}
