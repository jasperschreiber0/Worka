import { NextRequest, NextResponse } from 'next/server'
import { DEMO_QUOTE } from '@/lib/quote-demo'

// ─── Request body ─────────────────────────────────────────────────────────────

interface ReviseRequestBody {
  builder_id: string
}

// ─── Response shape ───────────────────────────────────────────────────────────

interface ReviseResponse {
  new_quote_id: string
  version: number
}

// ─── Route handler ────────────────────────────────────────────────────────────

export async function POST(
  request: NextRequest,
  { params }: { params: { quoteId: string } }
): Promise<NextResponse> {
  const { quoteId } = params

  let body: ReviseRequestBody
  try {
    body = await request.json() as ReviseRequestBody
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  if (!body.builder_id) {
    return NextResponse.json({ error: 'builder_id is required' }, { status: 400 })
  }

  if (quoteId === 'demo-quote-id') {
    // Demo mode: return a mock new version
    const newVersion = DEMO_QUOTE.version + 1
    const newQuoteId = `demo-quote-v${newVersion}-${Date.now()}`

    const response: ReviseResponse = {
      new_quote_id: newQuoteId,
      version: newVersion,
    }

    return NextResponse.json(response, { status: 201 })
  }

  // Real Supabase path:
  // 1. Fetch existing quote and line items
  // 2. Insert new quote row with version = existing.version + 1, status = 'draft'
  // 3. Copy all line items to new quote
  // 4. Return { new_quote_id, version }
  return NextResponse.json({ error: 'Quote not found' }, { status: 404 })
}
