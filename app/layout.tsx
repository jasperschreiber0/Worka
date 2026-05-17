import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: {
    default: 'WorkA — AI Operations Manager for Builders',
    template: '%s | WorkA',
  },
  description:
    'AI-powered operations management for Australian residential builders. Upload plans, get AI-assisted draft quotes, builder-approved and live in one click.',
  keywords: ['builder', 'construction', 'quoting', 'AI', 'Australia', 'residential'],
  authors: [{ name: 'WorkA' }],
  creator: 'WorkA',
  metadataBase: new URL(process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000'),
  openGraph: {
    type: 'website',
    locale: 'en_AU',
    siteName: 'WorkA',
  },
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en-AU" suppressHydrationWarning>
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="min-h-screen bg-white antialiased">{children}</body>
    </html>
  )
}
