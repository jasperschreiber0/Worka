import { NextRequest, NextResponse } from 'next/server'

interface ExtractedRate {
  trade_category_id: number
  trade_category_name: string
  description: string
  unit: string
  rate: number
}

const TRADE_CATEGORIES = [
  { id: 1,  name: 'Earthworks & Site Prep' },
  { id: 2,  name: 'Concrete' },
  { id: 3,  name: 'Framing & Structural' },
  { id: 4,  name: 'Roofing' },
  { id: 5,  name: 'Windows & External Doors' },
  { id: 6,  name: 'External Cladding' },
  { id: 7,  name: 'Insulation' },
  { id: 8,  name: 'Internal Linings' },
  { id: 9,  name: 'Joinery & Cabinetry' },
  { id: 10, name: 'Painting' },
  { id: 11, name: 'Plumbing' },
  { id: 12, name: 'Electrical' },
  { id: 13, name: 'Tiling & Finishes' },
]

const DEMO_EXTRACTED: ExtractedRate[] = [
  { trade_category_id: 2,  trade_category_name: 'Concrete',               description: '65MPa slab pour – 100mm',           unit: 'm²', rate: 110 },
  { trade_category_id: 2,  trade_category_name: 'Concrete',               description: 'Strip footing – standard',            unit: 'lm', rate: 85  },
  { trade_category_id: 3,  trade_category_name: 'Framing & Structural',   description: 'Pine wall frame – 90mm studs',        unit: 'lm', rate: 42  },
  { trade_category_id: 3,  trade_category_name: 'Framing & Structural',   description: 'Roof truss – standard pitch',         unit: 'ea', rate: 420 },
  { trade_category_id: 4,  trade_category_name: 'Roofing',                description: 'Colorbond roofing sheet',             unit: 'm²', rate: 55  },
  { trade_category_id: 4,  trade_category_name: 'Roofing',                description: 'Gutters and downpipes',               unit: 'lm', rate: 38  },
  { trade_category_id: 10, trade_category_name: 'Painting',               description: 'Walls and ceiling – 2 coats',         unit: 'm²', rate: 18  },
  { trade_category_id: 11, trade_category_name: 'Plumbing',               description: 'Hot water unit – 26L gas',            unit: 'ea', rate: 1200},
  { trade_category_id: 12, trade_category_name: 'Electrical',             description: 'GPO double power point',              unit: 'ea', rate: 85  },
  { trade_category_id: 12, trade_category_name: 'Electrical',             description: 'LED downlight – installed',           unit: 'ea', rate: 120 },
]

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
    // Demo mode — return example extracted rates
    return NextResponse.json({ rates: DEMO_EXTRACTED, demo: true })
  }

  try {
    const fileBuffer = await file.arrayBuffer()
    const base64Data = Buffer.from(fileBuffer).toString('base64')

    const { default: Anthropic } = await import('@anthropic-ai/sdk')
    const client = new Anthropic({ apiKey: anthropicKey })

    const prompt = `You are reviewing an Australian builder's quote or invoice PDF.

Extract every line item that has a unit rate (price per unit). For each item return:
- trade_category_id: map to one of these categories (1-13):
  1=Earthworks & Site Prep, 2=Concrete, 3=Framing & Structural, 4=Roofing,
  5=Windows & External Doors, 6=External Cladding, 7=Insulation, 8=Internal Linings,
  9=Joinery & Cabinetry, 10=Painting, 11=Plumbing, 12=Electrical, 13=Tiling & Finishes
- description: the line item name (string)
- unit: the unit of measure — m², lm, ea, m³, hr, etc. (string)
- rate: the unit rate in AUD excluding GST (number, not a total — divide total by qty if needed)

Only include items where you can determine a reliable unit rate. Skip lump-sum items with no quantity.

Return ONLY valid JSON:
{"rates": [{"trade_category_id": number, "description": string, "unit": string, "rate": number}]}`

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const response = await (client.messages.create as any)({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2048,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64Data } },
            { type: 'text', text: prompt },
          ],
        },
      ],
    })

    const text = response.content[0]?.type === 'text' ? response.content[0].text : ''
    const jsonMatch = text.match(/\{[\s\S]*\}/)
    if (!jsonMatch) return NextResponse.json({ error: 'Could not extract rates from PDF' }, { status: 422 })

    const parsed = JSON.parse(jsonMatch[0]) as { rates: Array<{ trade_category_id: number; description: string; unit: string; rate: number }> }

    const rates: ExtractedRate[] = (parsed.rates ?? []).map((r) => ({
      trade_category_id: r.trade_category_id,
      trade_category_name: TRADE_CATEGORIES.find((c) => c.id === r.trade_category_id)?.name ?? 'Unknown',
      description: r.description,
      unit: r.unit,
      rate: r.rate,
    })).filter((r) => r.rate > 0 && r.description)

    return NextResponse.json({ rates })
  } catch (err) {
    console.error('[extract-pdf] Error:', err)
    return NextResponse.json({ error: 'PDF extraction failed — try uploading as CSV instead.' }, { status: 500 })
  }
}
