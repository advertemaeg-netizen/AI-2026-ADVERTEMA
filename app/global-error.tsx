'use client'

import './globals.css'

/**
 * Only for errors in the locale layout itself, which renders <html>; every
 * page error is caught by an error.tsx below it. There are no translations
 * this high up, so the message is in both languages.
 */
export default function GlobalError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <html lang="ar" dir="rtl">
      <body className="flex min-h-screen items-center justify-center bg-background p-8 font-sans text-foreground antialiased">
        <title>Connecta AI</title>
        <div role="alert" className="grid max-w-md gap-4 text-center">
          <h1 className="text-2xl font-bold">حدث خطأ غير متوقع</h1>
          <p className="text-muted-foreground">حاول مرة أخرى، ولو استمرت المشكلة تواصل مع الدعم.</p>
          <p className="text-muted-foreground" dir="ltr">
            Something went wrong. Please try again, and contact support if it keeps happening.
          </p>
          {error.digest && (
            <p className="text-xs text-muted-foreground" dir="ltr">
              {error.digest}
            </p>
          )}
          <button
            type="button"
            onClick={() => retry()}
            className="mx-auto rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
          >
            حاول مرة أخرى · Try again
          </button>
        </div>
      </body>
    </html>
  )
}
