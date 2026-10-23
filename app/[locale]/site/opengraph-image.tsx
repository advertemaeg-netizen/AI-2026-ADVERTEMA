import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { ImageResponse } from 'next/og'
import { OG_ALT } from '@/site/metadata'

/**
 * The site's share image, one per locale, built at build time from the logo
 * (public/brand/mudrik-logo.svg, the one source), charcoal on the brand
 * gradient. The file fills with currentColor, which an image has no parent
 * to resolve, so the charcoal is set here. No words: those are the copy
 * owner's. Every page names it in its head (src/site/metadata.ts).
 */

const SIZE = { width: 1200, height: 630 }
// public/brand/mudrik-logo.svg's viewBox is 771.8 × 142.7. At 760 wide its
// clear space (the M's height, 134px) fits on every side with room to spare
const LOGO_WIDTH = 760
const LOGO_HEIGHT = Math.round((LOGO_WIDTH * 142.7) / 771.8)
// globals.css --brand-gradient (periwinkle → sand → cream, 35deg); charcoal on it is 10.90–11.91
const GRADIENT = 'linear-gradient(35deg, #DBE2F6 0%, #E9DFC1 50%, #F8D585 100%)'

export function generateImageMetadata() {
  return [{ id: 'og', alt: OG_ALT, size: SIZE, contentType: 'image/png' }]
}

export default async function OpenGraphImage() {
  const svg = (await readFile(path.join(process.cwd(), 'public/brand/mudrik-logo.svg'), 'utf8')).replace('fill="currentColor"', 'fill="#222527"')
  const logo = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: '#EEF3F6',
          backgroundImage: GRADIENT,
        }}
      >
        <img src={logo} width={LOGO_WIDTH} height={LOGO_HEIGHT} alt="" />
      </div>
    ),
    SIZE
  )
}
