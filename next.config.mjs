import { execSync } from 'child_process'
import { createRequire } from 'module'

const require = createRequire(import.meta.url)
const { version } = require('./package.json')

let commitSha = 'dev'
try {
  commitSha = execSync('git rev-parse --short HEAD').toString().trim()
} catch {
  // not a git repo or git not available
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
