import type { NextConfig } from 'next'
import createNextIntlPlugin from 'next-intl/plugin'

const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts')

const nextConfig: NextConfig = {
  // Self-contained server for the Docker image (see Dockerfile): .next/standalone
  // holds server.js plus only the node_modules files the app actually uses
  output: 'standalone',
  // pdf-parse loads pdf.js's worker file at runtime, which breaks once bundled
  serverExternalPackages: ['pdf-parse'],
  // ...and that worker is imported dynamically, so file tracing misses it:
  // without this, PDF uploads work locally but fail in the standalone image
  outputFileTracingIncludes: {
    '/api/knowledge/**/*': ['./node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs'],
  },
  // The admin panel's organizations are its customers now
  async redirects() {
    return [
      { source: '/:locale(ar|en)/admin/organizations/:path*', destination: '/:locale/admin/customers/:path*', permanent: true },
      { source: '/admin/organizations/:path*', destination: '/admin/customers/:path*', permanent: true },
    ]
  },
}

export default withNextIntl(nextConfig)