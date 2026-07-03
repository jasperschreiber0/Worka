'use client'

import { useEffect } from 'react'

// Detect when the browser is talking to a stale Vercel deployment.
// Next.js sends X-Deployment-Id on every response; if it changes mid-session,
// the user has a stale tab and should reload so their JS bundle matches the server.
// Also catches the "Failed to find Server Action" error which occurs for the same reason.

const STORAGE_KEY = 'worka_deployment_id'

export default function DeploymentGuard() {
  useEffect(() => {
    // Intercept all fetch responses to watch for deployment-id drift
    const origFetch = window.fetch.bind(window)
    window.fetch = async (...args) => {
      const res = await origFetch(...args)

      const deploymentId = res.headers.get('x-deployment-id') ?? res.headers.get('x-vercel-deployment-url')
      if (deploymentId) {
        const stored = sessionStorage.getItem(STORAGE_KEY)
        if (stored && stored !== deploymentId) {
          // New deployment detected mid-session — reload once
          sessionStorage.setItem(STORAGE_KEY, deploymentId)
          window.location.reload()
          return res
        }
        if (!stored) sessionStorage.setItem(STORAGE_KEY, deploymentId)
      }

      // Catch Server Action mismatch responses (Next.js returns these as 200s with a specific body)
      if (
        args[0] &&
        typeof args[0] === 'string' &&
        args[0].includes('/_next/') === false &&
        res.status === 200
      ) {
        const contentType = res.headers.get('content-type') ?? ''
        if (contentType.includes('text/x-component')) {
          // Clone so we can inspect without consuming the stream
          const clone = res.clone()
          clone.text().then((body) => {
            if (body.includes('Failed to find Server Action')) {
              console.warn('[DeploymentGuard] Stale Server Action detected — reloading')
              window.location.reload()
            }
          }).catch(() => {/* ignore */})
        }
      }

      return res
    }

    return () => {
      window.fetch = origFetch
    }
  }, [])

  return null
}
