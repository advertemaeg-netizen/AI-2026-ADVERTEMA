import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { ImageResponse } from 'next/og'
import { OG_ALT } from '@/site/metadata'

/**
 * The site's share image, one per locale, built at build time from the brand
 * lockup (public/brand/mudrik-lockup.svg, the one source) on the cream field.
 * No words: those are the copy owner's. Every page names it in its head
 * (src/site/metadata.ts).
 */

const SIZE = { width: 1200, height: 630 }
// public/brand/mudrik-lockup.svg is 13389 × 1962
const LOCKUP_WIDTH = 760
const LOCKUP_HEIGHT = Math.round((LOCKUP_WIDTH * 1962) / 13389)

export function generateImageMetadata() {
  return [{ id: 'og', alt: OG_ALT, size: SIZE, contentType: 'image/png' }]
}

export default async function OpenGraphImage() {
  const svg = await readFile(path.join(process.cwd(), 'public/brand/mudrik-lockup.svg'))
  const lockup = `data:image/svg+xml;base64,${svg.toString('base64')}`
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: '#FCF9EA',
          // The field's washes (globals.css --field): tint and brand, stronger than the dashboard's
          backgroundImage:
            'radial-gradient(circle at 15% 20%, rgba(219,149,88,0.45), transparent 55%), radial-gradient(circle at 85% 85%, rgba(232,80,2,0.28), transparent 50%)',
        }}
      >
        <img src={lockup} width={LOCKUP_WIDTH} height={LOCKUP_HEIGHT} alt="" />
      </div>
    ),
    SIZE
  )
}
