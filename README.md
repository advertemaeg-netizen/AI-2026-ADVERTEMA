This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.

## Knowledge base storage (Supabase)

Uploaded knowledge-base files live in a private Supabase Storage bucket named
`knowledge-base`. The migration `supabase/migrations/20260928100000_knowledge_base_rag.sql`
sets everything up, so normally `npx supabase db push` is all you need:

- enables `pgvector` (in the `extensions` schema) and adds the chunk/embedding columns
- creates the private `knowledge-base` bucket (10 MB limit; PDF, DOCX and TXT only)
- adds Storage RLS policies on `storage.objects`: objects are stored as
  `<client_id>/<document_id>.<ext>`, users can read files of clients they have
  access to, and only super/org/client admins can upload or delete them

To set the bucket up by hand instead (Dashboard → Storage → New bucket):

1. Name it `knowledge-base` and leave **Public bucket** off.
2. Set the file size limit to `10 MB` and the allowed MIME types to
   `application/pdf`, `text/plain`,
   `application/vnd.openxmlformats-officedocument.wordprocessingml.document`.
3. Run the `storage.objects` policy statements from the migration in the SQL editor.

Uploads go through `POST /api/knowledge/upload/[clientId]`, which uses
`SUPABASE_SECRET_KEY` server-side; the browser never writes to Storage directly.
Embeddings use `GOOGLE_GEMINI_API_KEY` with `gemini-embedding-001` at 768 dimensions
(override with `GOOGLE_GEMINI_EMBEDDING_MODEL`).
