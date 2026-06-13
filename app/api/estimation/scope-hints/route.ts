import { NextRequest, NextResponse } from 'next/server'
import type { ScopeHint, ProjectMetadata } from '@/lib/types/estimation.types'
import { SCOPE_HINTS_BY_TYPE, DEMO_SCOPE_HINTS } from '@/lib/estimation-demo'
import { getAuthenticatedBuilderId } from '@/lib/auth/api-auth'

// ─── POST /api/estimation/scope-hints ────────────────────────────────────────
// Returns likely missing scope items for a given project type.
// In live mode with Claude: AI generates hints from the project description.
// In demo/no-API mode: returns seeded pattern matching.

export async function POST(request: NextRequest): Promise<NextResponse> {
  const builderId = await getAuthenticatedBuilderId()
  if (!builderId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let body: { project_metadata: ProjectMetadata; description?: string }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const { project_metadata, description } = body

  const anthropicKey = process.env.ANTHROPIC_API_KEY

  // Pattern matching fallback (always available)
  const patternHints: ScopeHint[] = project_metadata.job_type
    ? (SCOPE_HINTS_BY_TYPE[project_metadata.job_type] ?? DEMO_SCOPE_HINTS)
    : DEMO_SCOPE_HINTS

  if (!anthropicKey) {
    return NextResponse.json({ scope_hints: patternHints, source: 'patterns' })
  }

  // AI-enhanced scope detection
  try {
    const { default: Anthropic } = await import('@anthropic-ai/sdk')
    const client = new Anthropic({ apiKey: anthropicKey })

    const prompt = `You are an experienced Australian residential builder's estimator reviewing a project scope.

PROJECT:
Type: ${project_metadata.job_type ?? 'unknown'}
Summary: ${project_metadata.project_summary}
Floor area: ${project_metadata.floor_area_m2 ? `${project_metadata.floor_area_m2}sqm` : 'unknown'}
Storeys: ${project_metadata.storeys ?? 'unknown'}
Wet areas: ${project_metadata.wet_areas ?? 'unknown'}
Finish level: ${project_metadata.finish_level ?? 'unknown'}
Region: ${project_metadata.region ?? 'unknown'}
${description ? `\nExtracted from plans:\n${description}` : ''}

Identify scope items that are almost certainly MISSING from the above description but would typically be required for this type of project.

Focus on hidden, easily-missed items that:
- Are required by building code (BCA)
- Are commonly discovered on-site causing cost blowouts
- Are logically implied by the project type

Return ONLY valid JSON:
{
  "scope_hints": [
    {
      "description": "Item name — max 8 words",
      "trade_category_id": number (1=Earthworks, 2=Concrete, 3=Framing, 4=Roofing, 5=Windows/Doors, 6=Cladding, 7=Insulation, 8=Linings, 9=Joinery, 10=Painting, 11=Plumbing, 12=Electrical, 13=Tiling),
      "confidence": 0-100,
      "reason": "Why this is likely needed — one sentence",
      "typical_cost_range": "e.g. $1,200–$3,500"
    }
  ]
}

Maximum 5 items. Only include items with confidence ≥ 65. Order by confidence descending.`

    const response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }],
    })

    const text = response.content[0]?.type === 'text' ? response.content[0].text : ''
    const jsonMatch = text.match(/\{[\s\S]*\}/)
    if (!jsonMatch) {
      return NextResponse.json({ scope_hints: patternHints, source: 'patterns' })
    }

    const parsed = JSON.parse(jsonMatch[0]) as { scope_hints: ScopeHint[] }
    const aiHints = (parsed.scope_hints ?? []).slice(0, 5)

    // Merge: AI hints take priority, fill remaining with pattern hints not already covered
    const aiDescriptions = new Set(aiHints.map(h => h.description.toLowerCase()))
    const merged = [
      ...aiHints,
      ...patternHints.filter(p => !aiDescriptions.has(p.description.toLowerCase())),
    ].slice(0, 6)

    return NextResponse.json({ scope_hints: merged, source: 'ai' })
  } catch (err) {
    console.error('[scope-hints]', err)
    return NextResponse.json({ scope_hints: patternHints, source: 'patterns' })
  }
}
