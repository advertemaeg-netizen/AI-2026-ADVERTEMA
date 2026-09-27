import { notFound } from 'next/navigation'

// Unknown URLs under a locale get the translated [locale]/not-found page
export default function CatchAllPage() {
  notFound()
}
