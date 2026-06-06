import { execSync } from 'child_process'
import { createRequire } from 'module'

const require = createRequire(import.meta.url)
const { version } = require('./package.json')

// Railway injects RAILWAY_GIT_COMMIT_SHA; fall back to local git, then 'dev'
let commitSha = process.env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 7) ?? 'dev'
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
