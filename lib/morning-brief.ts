// Shared, deterministic email presentation. No AI or delivery side effects.
export interface BriefAlert {
  priority: 'high' | 'medium' | 'low'
  message: string
  action?: string
  href?: string
  entity_type?: string
}
export interface BriefEmail { subject: string; text: string; html: string }
export function shouldSendBrief(alerts: BriefAlert[]): boolean {
  return alerts.some(a => a.entity_type !== 'summary' && Boolean(a.action))
}
const escapeHtml = (s: string) => s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!))
export function buildBriefEmail(builderName: string, _brief: string, alerts: BriefAlert[]): BriefEmail {
  const origin = (process.env.NEXT_PUBLIC_APP_URL || 'https://worka-production.up.railway.app').replace(/\/$/, '')
  const link = (path?: string) => origin + (path && /^\/(jobs\/[a-zA-Z0-9-]+(?:\?section=money)?|variations\/[a-zA-Z0-9-]+\/review)$/.test(path) ? path : '/today')
  const actions = alerts.filter(a => a.entity_type !== 'summary' && a.action).sort((a,b)=>['high','medium','low'].indexOf(a.priority)-['high','medium','low'].indexOf(b.priority))
  const urgent = actions.filter(a=>a.priority==='high').length
  const subject = urgent ? `Morning brief — ${urgent} recorded item${urgent===1?' needs':'s need'} attention` : actions.length ? `Morning brief — ${actions.length} job action${actions.length===1?'':'s'} to review` : 'Morning brief — no recorded actions to review'
  const intro = actions.length ? `${actions.length} recorded job action${actions.length===1?'':'s'} to review.${urgent?'':' No urgent items found in the records checked.'}` : 'No urgent items found in the records checked.'
  const shown = actions.slice(0,8)
  const greeting = `G'day ${builderName.trim().split(/\s+/)[0] || 'there'},`
  const coverage = 'Based on recorded jobs, estimates, invoices and variations. Missing or outdated records can hide work that needs attention. Check Today for site actions and the full job picture.'
  const lines=[greeting,'',intro,'',...shown.flatMap(a=>[a.message,`${a.action}: ${link(a.href)}`,'']),...(actions.length>8?[`${actions.length-8} more actions in WorkA.`,'']:[]),`Review today's jobs: ${link()}`,'',coverage,'','— WorkA']
  const html=`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body style="margin:0;background:#f5f5f5;font-family:Arial,sans-serif;color:#202020"><main style="max-width:560px;margin:24px auto;padding:24px;background:white;border-radius:12px"><p style="font-weight:bold;color:#a63b00">WorkA</p><h1 style="font-size:24px">Your morning brief</h1><p>${escapeHtml(greeting)}</p><p>${escapeHtml(intro)}</p>${shown.map(a=>`<section style="border-top:1px solid #ddd;padding:16px 0"><p>${escapeHtml(a.message)}</p><a style="color:#a63b00" href="${escapeHtml(link(a.href))}">${escapeHtml(a.action!)} →</a></section>`).join('')}${actions.length>8?`<p>${actions.length-8} more actions in WorkA.</p>`:''}<p><a href="${escapeHtml(link())}" style="display:inline-block;background:#ff6b1a;color:#181818;text-decoration:none;padding:14px 18px;border-radius:8px;font-weight:bold">Review today’s jobs</a></p><p style="font-size:13px;line-height:1.5;color:#555">${escapeHtml(coverage)}</p></main></body></html>`
  return {subject,text:lines.join('\n'),html}
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
