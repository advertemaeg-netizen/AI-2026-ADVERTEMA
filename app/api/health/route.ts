// Liveness probe for the Docker healthcheck / Traefik: the Node server is up
// and routing. Deliberately doesn't touch Supabase or Gemini, so an outside
// outage doesn't get the container restarted.
export function GET() {
  return Response.json({ ok: true })
}
