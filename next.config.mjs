import { execSync } from 'child_process'
import { createRequire } from 'module'

const require = createRequire(import.meta.url)
const { version } = require('./package.json')

// Production runs on Railway (RAILWAY_GIT_COMMIT_SHA, auto-injected for a
// GitHub-triggered deploy — see docs.railway.com/reference/variables), not
// Vercel — VERCEL_GIT_COMMIT_SHA is checked too only in case a Vercel
// deployment is ever revived as a parallel/staging target (see CLAUDE.md's
// "Hosting" note). Falls back to local git, then 'dev'.
let commitSha = (process.env.RAILWAY_GIT_COMMIT_SHA ?? process.env.VERCEL_GIT_COMMIT_SHA)?.slice(0, 7) ?? 'dev'
if (commitSha === 'dev') {
  try {
    commitSha = execSync('git rev-parse --short HEAD', { stdio: ['pipe', 'pipe', 'pipe'] }).toString().trim()
  } catch {
    // not a git repo
  }
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  env: {
    NEXT_PUBLIC_APP_VERSION: version,
    NEXT_PUBLIC_COMMIT_SHA: commitSha,
  },
  experimental: {
    typedRoutes: false,
    serverActions: {
      bodySizeLimit: '20mb',
    },
  },
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: '*.supabase.co',
        pathname: '/storage/v1/object/public/**',
      },
    ],
  },
}

export default nextConfig
