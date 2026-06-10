// ─── Morning brief email delivery ─────────────────────────────────────────────
// Shared formatting for the scheduled morning brief email — the daily habit.
// The brief content itself comes from the morning-brief edge function (real
// mode) or the demo brief below (demo mode). This module only formats it as
// a plain-text email a builder reads in 20 seconds at 6:45am.

export interface BriefAlert {
  priority: 'high' | 'medium' | 'low'
  message: string
  action?: string
}

export interface BriefEmail {
  subject: string
  text: string
}

// ─── Email formatting ─────────────────────────────────────────────────────────

export function buildBriefEmail(builderName: string, brief: string, alerts: BriefAlert[]): BriefEmail {
  const highAlerts = alerts.filter((a) => a.priority === 'high')
  const mediumAlerts = alerts.filter((a) => a.priority === 'medium')
  const lowAlerts = alerts.filter((a) => a.priority === 'low')

  const subject =
    highAlerts.length > 0
      ? `Morning brief — ${highAlerts.length} urgent item${highAlerts.length !== 1 ? 's' : ''} today`
      : mediumAlerts.length > 0
        ? `Morning brief — ${mediumAlerts.length} item${mediumAlerts.length !== 1 ? 's' : ''} needing attention`
        : 'Morning brief — all clear today'

  const firstName = builderName.split(' ')[0] || builderName
  const lines: string[] = []
  lines.push(`G'day ${firstName},`)
  lines.push('')
  lines.push(brief)
  lines.push('')

  if (highAlerts.length > 0) {
    lines.push('NEEDS ACTION TODAY')
    for (const alert of highAlerts) {
      lines.push(`  • ${alert.message}`)
      if (alert.action) lines.push(`    → ${alert.action}`)
    }
    lines.push('')
  }

  if (mediumAlerts.length > 0) {
    lines.push('WORTH A LOOK')
    for (const alert of mediumAlerts) {
      lines.push(`  • ${alert.message}`)
      if (alert.action) lines.push(`    → ${alert.action}`)
    }
    lines.push('')
  }

  if (lowAlerts.length > 0) {
    lines.push('THE BIG PICTURE')
    for (const alert of lowAlerts) {
      lines.push(`  • ${alert.message}`)
    }
    lines.push('')
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000'
  lines.push(`Open WorkA to action any of these: ${appUrl}/chat`)
  lines.push('')
  lines.push('— WorkA')

  return { subject, text: lines.join('\n') }
}

// ─── Demo brief (mirrors the in-chat demo morning brief) ─────────────────────

export function getDemoBrief(): { builderName: string; brief: string; alerts: BriefAlert[] } {
  return {
    builderName: 'Dave Nguyen',
    brief:
      "Here's what needs your attention today. You have an overdue invoice on the Fitzroy job, two variations waiting on approval, and a quote sent to Tom Caruso last week with no reply.",
    alerts: [
      {
        priority: 'high',
        message: 'Invoice for $28,000 on the Fitzroy job (14 Merri St) is 3 days overdue. The Hendersons have not paid.',
        action: 'Chase payment',
      },
      {
        priority: 'high',
        message:
          '2 variations on the Fitzroy job are waiting for approval — kitchen benchtop upgrade ($3,200) and extra GPO points ($680).',
        action: 'Review variations',
      },
      {
        priority: 'medium',
        message: 'Toorak quote for $127,500 was sent to Tom Caruso 5 days ago with no response yet.',
        action: 'Follow up',
      },
      {
        priority: 'low',
        message: '3 active jobs · 2 pending variations · 1 overdue invoice. Brunswick job at 52 Bendigo St is still in quoting.',
      },
    ],
  }
}
