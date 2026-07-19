import { NextRequest, NextResponse } from 'next/server'
import { getAuthenticatedBuilderId } from '@/lib/auth/api-auth'
import { tradeCategoryName } from '@/lib/trade-taxonomy'
import { withTimeoutAndRetry } from '@/supabase/functions/smooth-responder/pipeline-logic'
import { guardedClaudeCall } from '@/supabase/functions/smooth-responder/ai-gateway'
import { gatewaySupabase } from '@/lib/ai-gateway-client'

interface ExtractedRate {
  trade_category_id: number
  trade_category_name: string
  description: string
  unit: string
  rate: number
}

const DEMO_EXTRACTED: ExtractedRate[] = [
  { trade_category_id: 1,  trade_category_name: 'Site Works & Concrete',  description: '65MPa slab pour – 100mm',           unit: 'm²', rate: 110 },
  { trade_category_id: 1,  trade_category_name: 'Site Works & Concrete',  description: 'Strip footing – standard',            unit: 'lm', rate: 85  },
  { trade_category_id: 2,  trade_category_name: 'Framing',                description: 'Pine wall frame – 90mm studs',        unit: 'lm', rate: 42  },
  { trade_category_id: 2,  trade_category_name: 'Framing',                description: 'Roof truss – standard pitch',         unit: 'ea', rate: 420 },
  { trade_category_id: 3,  trade_category_name: 'Roofing',                description: 'Colorbond roofing sheet',             unit: 'm²', rate: 55  },
  { trade_category_id: 3,  trade_category_name: 'Roofing',                description: 'Gutters and downpipes',               unit: 'lm', rate: 38  },
  { trade_category_id: 9,  trade_category_name: 'Paint',                  description: 'Walls and ceiling – 2 coats',         unit: 'm²', rate: 18  },
  { trade_category_id: 11, trade_category_name: 'Fixtures & Tapware',     description: 'Hot water unit – 26L gas',            unit: 'ea', rate: 1200},
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

    // Attach the PDF's text layer as the authoritative source for numbers — the
    // vision model alone routinely misreads column-aligned rate tables (returns
    // no rates from a real builder's estimate). Best-effort: '' for image-only
    // scans, in which case the model reads the rendered document as before.
    const { extractPdfText, hasUsableText, buildTextLayerBlock } = await import('@/lib/pdf-text')
    const textLayer = await Promise.race([
      extractPdfText(base64Data),
      new Promise<string>((resolve) => setTimeout(() => resolve(''), 15_000)),
    ])

    const { default: Anthropic } = await import('@anthropic-ai/sdk')
    const client = new Anthropic({ apiKey: anthropicKey })

    const systemPrompt = `You are reviewing an Australian residential builder's document — this may be a supplier invoice, a trade quote, or a builder's own estimation/cost breakdown spreadsheet exported as PDF.

Australian builder estimation documents typically have columns: Description | Quantity | Unit | Rate | Total (or similar). Extract the unit rate directly from the Rate column. If no Rate column exists but Quantity and Total are present, calculate: rate = Total ÷ Quantity.

Rules:
- Extract every line item that has a quantity and a rate (or from which a rate can be calculated).
- Include items from ALL sections: Preliminaries, Site Works & Concrete, Framing, Roofing, External Cladding, Insulation, Internal Linings, Fit-out Carpentry, Cabinetry, Paint, Flooring, Fixtures & Tapware, Electrical, Building Labour, etc.
- Do NOT skip items just because they are in a section labelled "Preliminaries" or "Building Labour" — map them to the closest trade category.
- Skip only true lump-sum items where no quantity or rate exists at all (just a single dollar amount with no breakdown).
- Units may be: m², lm, m, ea, hr, wk, allow, item, set, lot — include all.`

    const userPrompt = `Extract all line items with unit rates from this Australian builder document.

Map each item to the closest trade_category_id (1-13):
1=Site Works & Concrete (excavation, footings, slab, paths, drainage, retaining walls, site toilets, skip bins, scaffolding, site establishment, fencing, surveying)
2=Framing (floor/wall/roof framing, structural steel, LVL beams, timber frames, roof trusses, structural posts)
3=Roofing (roof sheets, tiles, gutters, downpipes, fascia, sarking, ridge caps, flashings)
4=External Cladding (brick, render, weatherboard, FC cladding, timber cladding, stone, windows, external doors, sliding doors, skylights, garage doors)
5=Insulation (wall batts, ceiling batts, foil underlay, underfloor insulation)
6=Internal Linings (plasterboard, cornice, set, acoustic batts)
7=Fit-out Carpentry (internal doors, door hardware, skirtings, architraves, shelving, staircases)
8=Cabinetry (kitchen, bathroom vanities, laundry, wardrobes, linen, benchtops)
9=Paint (internal and external painting, sealer, undercoat)
10=Flooring (floor tiles, wall tiles, waterproofing, carpet, timber flooring, vinyl, polished concrete)
11=Fixtures & Tapware (toilets, basins, showers, baths, taps, rough-in, hot water, drainage, stormwater)
12=Electrical (power points, lights, switchboard, rough-in, data, alarms)
13=Preliminaries (permits, council fees, site costs, insurance, supervision)

If an item spans multiple categories, pick the best single match.
Use the extract_rates tool to return your results.`

    // Tool use forces Claude to return schema-validated JSON — no parsing needed.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { response } = await guardedClaudeCall<any>(
      { supabase: gatewaySupabase(), attribution: { kind: 'builder', builderId }, callSite: 'rates_extract_pdf', model: 'claude-sonnet-4-6' },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (signal) => (client.messages.create as any)({
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
            ...(hasUsableText(textLayer) ? [buildTextLayerBlock(textLayer)] : []),
            { type: 'text', text: userPrompt },
          ],
        },
      ],
      }, { signal }),
      { timeoutMs: 90_000, maxRetries: 1, label: 'rates_extract_pdf' }
    )

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
        trade_category_name: tradeCategoryName(r.trade_category_id),
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
