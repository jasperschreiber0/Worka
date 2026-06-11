import { NextRequest, NextResponse } from 'next/server'

export interface ClassificationResult {
  type: 'plan' | 'receipt' | 'supplier_quote' | 'variation_request' | 'certificate' | 'contract' | 'photo' | 'unknown'
  confidence: number
  summary: string
  job_match_hint: string | null
  amount: number | null
  supplier: string | null
  questions: string[]
  actions: Array<{ label: string; primary: boolean; intent: string }>
}

function demoClassification(filename: string): ClassificationResult {
  const lower = filename.toLowerCase()
  if (lower.includes('plan') || lower.includes('drawing') || lower.endsWith('.pdf')) {
    return {
      type: 'plan',
      confidence: 88,
      summary: 'Architectural plans — bathroom renovation',
      job_match_hint: null,
      amount: null,
      supplier: null,
      questions: ['What tile allowance should I use per m²?', 'What is your margin for this job?'],
      actions: [
        { label: 'Create quote from these plans', primary: true, intent: 'create_quote' },
        { label: 'Attach to existing job', primary: false, intent: 'attach_to_job' },
      ],
    }
  }
  if (lower.includes('receipt') || lower.includes('bunnings') || lower.includes('img') || lower.match(/\.(jpg|jpeg|png|heic)$/)) {
    return {
      type: 'receipt',
      confidence: 94,
      summary: 'Bunnings receipt — $184.20',
      job_match_hint: null,
      amount: 184.20,
      supplier: 'Bunnings',
      questions: ['Which job should this cost be allocated to?'],
      actions: [
        { label: 'Add to project costs', primary: true, intent: 'add_to_costs' },
      ],
    }
  }
  if (lower.includes('quote') || lower.includes('supplier') || lower.includes('invoice')) {
    return {
      type: 'supplier_quote',
      confidence: 91,
      summary: 'Supplier quote — $14,200 for timber and framing materials',
      job_match_hint: '14 Merri St, Fitzroy',
      amount: 14200,
      supplier: 'Midland Timber',
      questions: [],
      actions: [
        { label: 'Accept supplier quote', primary: true, intent: 'accept_supplier_quote' },
        { label: 'Compare with previous supplier', primary: false, intent: 'compare_supplier' },
        { label: 'Update project budget', primary: false, intent: 'update_budget' },
      ],
    }
  }
  return {
    type: 'unknown',
    confidence: 40,
    summary: 'Document uploaded',
    job_match_hint: null,
    amount: null,
    supplier: null,
    questions: ['Which job does this belong to?', 'What type of document is this?'],
    actions: [
      { label: 'Attach to a job', primary: true, intent: 'attach_to_job' },
    ],
  }
}

const PROMPT = `You are analyzing a document uploaded by an Australian residential builder.
Determine what this document is and what action is needed.

Return ONLY valid JSON:
{
  "type": "plan|receipt|supplier_quote|variation_request|certificate|contract|photo|unknown",
  "confidence": 0-100,
  "summary": "Under 12 words describing what this is",
  "job_match_hint": "any job address or client name found in the document, or null",
  "amount": null or number in AUD excluding GST,
  "supplier": "supplier or company name if present, or null",
  "questions": ["Only ask what is genuinely missing to proceed, max 3 questions"],
  "actions": [
    {"label": "Primary action label", "primary": true, "intent": "create_quote|add_to_costs|accept_supplier_quote|compare_supplier|update_budget|create_variation|store_certificate|attach_to_job"},
    {"label": "Secondary option if applicable", "primary": false, "intent": "action_key"}
  ]
}

Document types:
- plan: architectural or engineering drawings/plans
- receipt: purchase receipts or proof of payment
- supplier_quote: supplier price quotes or estimates
- variation_request: client-requested scope changes
- certificate: compliance certs (waterproofing, electrical, occupation permit)
- contract: legal agreements or subcontracts
- photo: site photos with no structured data
- unknown: cannot determine

Keep summary under 12 words. Be direct. Only include secondary actions when genuinely useful.`

export async function POST(request: NextRequest): Promise<NextResponse> {
  let formData: FormData
  try {
    formData = await request.formData()
  } catch {
    return NextResponse.json({ error: 'Invalid form data' }, { status: 400 })
  }

  const file = formData.get('file') as File | null
  if (!file) return NextResponse.json({ error: 'No file provided' }, { status: 400 })

  const anthropicKey = process.env.ANTHROPIC_API_KEY
  if (!anthropicKey) {
    return NextResponse.json(demoClassification(file.name))
  }

  const isImage = file.type.startsWith('image/')
  const isPDF = file.type === 'application/pdf'

  if (!isImage && !isPDF) {
    return NextResponse.json({ error: 'Upload a PDF or image file.' }, { status: 400 })
  }

  try {
    const fileBuffer = await file.arrayBuffer()
    const base64Data = Buffer.from(fileBuffer).toString('base64')

    const { default: Anthropic } = await import('@anthropic-ai/sdk')
    const client = new Anthropic({ apiKey: anthropicKey })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const contentBlock: any = isImage
      ? { type: 'image', source: { type: 'base64', media_type: file.type, data: base64Data } }
      : { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64Data } }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const response = await (client.messages.create as any)({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      messages: [
        {
          role: 'user',
          content: [contentBlock, { type: 'text', text: PROMPT }],
        },
      ],
    })

    const text = response.content[0]?.type === 'text' ? response.content[0].text : ''
    const jsonMatch = text.match(/\{[\s\S]*\}/)
    if (!jsonMatch) return NextResponse.json({ error: 'Could not classify document' }, { status: 422 })

    const result = JSON.parse(jsonMatch[0]) as ClassificationResult
    return NextResponse.json(result)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[classify-document]', message)
    return NextResponse.json({ error: `Classification failed: ${message}` }, { status: 500 })
  }
}

export const maxDuration = 60
