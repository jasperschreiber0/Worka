import { NextRequest, NextResponse } from 'next/server'
import { getJobProofEvents, verifyProofChain } from '@/lib/proof'

// ─── GET /api/jobs/[jobId]/proof/export ───────────────────────────────────────
// Downloads the WorkA Proof Pack — a plain-text evidence document of every
// recorded event on the job, in chronological order with exact UTC timestamps
// and the hash chain, suitable for attaching to a payment dispute or
// security-of-payment claim.
//
// Note: this is the one place exact timestamps are intentional — an evidence
// pack is a legal document, not UI.

export async function GET(
  _req: NextRequest,
  { params }: { params: { jobId: string } }
): Promise<NextResponse> {
  const { jobId } = params

  const events = await getJobProofEvents(jobId)
  const chain = verifyProofChain(events)

  if (events.length === 0) {
    return NextResponse.json({ error: 'No proof events recorded for this job yet.' }, { status: 404 })
  }

  const ascending = [...events].sort(
    (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
  )

  const lines: string[] = []
  lines.push('═══════════════════════════════════════════════════════════════')
  lines.push('  WORKA PROOF PACK — JOB EVIDENCE RECORD')
  lines.push('═══════════════════════════════════════════════════════════════')
  lines.push('')
  lines.push(`Job ID:        ${jobId}`)
  lines.push(`Generated:     ${new Date().toISOString()} (UTC)`)
  lines.push(`Events:        ${events.length} recorded`)
  lines.push(
    `Integrity:     ${
      chain.chained_count === 0
        ? 'No hash-chained events'
        : chain.verified
          ? `VERIFIED — ${chain.chained_count} of ${chain.total_count} events hash-chained, chain intact`
          : `WARNING — hash chain verification FAILED; record may have been altered`
    }`
  )
  lines.push('')
  lines.push('Each hash-chained event includes a SHA-256 digest computed over')
  lines.push('the event content and the preceding event\'s digest. Altering any')
  lines.push('past event invalidates every digest that follows it.')
  lines.push('')
  lines.push('───────────────────────────────────────────────────────────────')

  ascending.forEach((event, index) => {
    const proofHash = typeof event.metadata?.proof_hash === 'string' ? event.metadata.proof_hash : null
    const prevHash = typeof event.metadata?.prev_hash === 'string' ? event.metadata.prev_hash : null

    lines.push('')
    lines.push(`#${index + 1}  ${event.event_type.toUpperCase().replace(/_/g, ' ')}`)
    lines.push(`    Timestamp:  ${event.created_at} (UTC)`)
    lines.push(`    Record:     ${event.description}`)
    if (proofHash) {
      lines.push(`    SHA-256:    ${proofHash}`)
      lines.push(`    Previous:   ${prevHash ?? 'genesis'}`)
    } else {
      lines.push('    SHA-256:    (recorded before hash chaining was enabled)')
    }
  })

  lines.push('')
  lines.push('───────────────────────────────────────────────────────────────')
  lines.push('End of record. Generated automatically by WorkA Proof.')
  lines.push('')

  return new NextResponse(lines.join('\n'), {
    status: 200,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Disposition': `attachment; filename="worka-proof-pack-${jobId.slice(0, 8)}.txt"`,
    },
  })
}
