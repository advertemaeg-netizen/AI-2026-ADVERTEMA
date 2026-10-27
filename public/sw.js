/**
 * The dashboard's service worker, registered by the install card with the
 * locale's dashboard as its scope (dashboardAppScope in
 * src/lib/install-prompt.ts). Its one job is a fetch handler: Chrome offers
 * its install prompt (beforeinstallprompt) only to a page that a worker with
 * one controls. Every request goes to the network exactly as it would
 * without it: no cache, no offline page, no precache. Chrome ignores an empty
 * handler, so this one answers each request with the network's own response.
 * tests/dashboard/service-worker.test.ts fails the day it stops doing that.
 */
self.addEventListener('fetch', (event) => {
  event.respondWith(fetch(event.request))
})
