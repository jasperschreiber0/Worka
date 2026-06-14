import { NextRequest, NextResponse } from 'next/server'
import { getAuthenticatedBuilderId } from '@/lib/auth/api-auth'

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
  const builderId = await getAuthenticatedBuilderId()
  if (!builderId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

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

    const systemPrompt = `You are reviewing an Australian builder's quote or invoice PDF.
Extract every line item that has a unit rate (price per unit).
Only include items where you can determine a reliable unit rate. Skip lump-sum items with no quantity.
For the unit rate: if only a total is shown, divide total by quantity to get the unit rate.`

    const userPrompt = `Extract all line items with unit rates from this document.
Map each item to a trade_category_id (1-13):
1=Earthworks & Site Prep, 2=Concrete, 3=Framing & Structural, 4=Roofing,
5=Windows & External Doors, 6=External Cladding, 7=Insulation, 8=Internal Linings,
9=Joinery & Cabinetry, 10=Painting, 11=Plumbing, 12=Electrical, 13=Tiling & Finishes

Use the extract_rates tool to return your results.`

    // Tool use forces Claude to return schema-validated JSON — no parsing needed.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const response = await (client.messages.create as any)({
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      system: systemPrompt,
      tools: [
        {
          name: 'extract_rates',
          description: 'Return all extracted unit rates from the document',
          input_schema: {
            type: 'object',
            properties: {
              rates: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    trade_category_id: { type: 'integer', minimum: 1, maximum: 13 },
                    description:       { type: 'string' },
                    unit:              { type: 'string' },
                    rate:              { type: 'number', exclusiveMinimum: 0 },
                  },
                  required: ['trade_category_id', 'description', 'unit', 'rate'],
                },
              },
            },
            required: ['rates'],
          },
        },
      ],
      tool_choice: { type: 'tool', name: 'extract_rates' },
      messages: [
        {
          role: 'user',
          content: [
            { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64Data } },
            { type: 'text', text: userPrompt },
          ],
        },
      ],
    })

    // Tool use response: find the tool_use block and read its validated input directly
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const toolBlock = response.content?.find((b: any) => b.type === 'tool_use' && b.name === 'extract_rates')
    if (!toolBlock) {
      console.error('[extract-pdf] no tool_use block in response', JSON.stringify(response.content?.map((b: any) => b.type)))
      return NextResponse.json({ error: 'Could not extract rates from this PDF.' }, { status: 422 })
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rawRates: Array<{ trade_category_id: number; description: string; unit: string; rate: number }> = (toolBlock.input as any)?.rates ?? []

    const rates: ExtractedRate[] = rawRates
      .filter((r) => r.rate > 0 && r.description && r.trade_category_id >= 1 && r.trade_category_id <= 13)
      .map((r) => ({
        trade_category_id: r.trade_category_id,
        trade_category_name: TRADE_CATEGORIES.find((c) => c.id === r.trade_category_id)?.name ?? 'Unknown',
        description: r.description,
        unit: r.unit,
        rate: r.rate,
      }))

    return NextResponse.json({ rates })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[extract-pdf] Error:', message)
    return NextResponse.json({ error: 'Could not extract rates from this PDF. Please try again or re-export the PDF.' }, { status: 500 })
  }
}


export const maxDuration = 60
