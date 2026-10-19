/**
 * The marketing site: mudrik-ai.com. It lives in this app (app/[locale]/site,
 * src/site, messages/site) so it shares the product's tokens and deploy, and
 * it is kept separate enough to lift out into its own container without
 * touching the product. The trigger for that split is written down in
 * deploy/ROLLBACK.md: the first real client going live, because every site
 * deploy restarts the container serving widget.js and the webhook.
 */

/** Where the site is canonical: metadata, canonical links, the og-image */
export const SITE_ORIGIN = 'https://mudrik-ai.com'

/** The product: everything on the site's hosts that is not a marketing page goes here */
export const APP_ORIGIN = 'https://app.mudrik-ai.com'

/**
 * Hosts that serve the site. www is kept until Traefik redirects it to the
 * apex (deploy/ROLLBACK.md); site.localhost is for running it locally, since
 * browsers resolve *.localhost to this machine.
 */
export const SITE_HOSTS = ['mudrik-ai.com', 'www.mudrik-ai.com', 'site.localhost']

/** The site's pages, as paths after the locale ('' is the home page). Anything else on a site host is the app's. */
export const SITE_PAGES = ['', '/for-businesses', '/for-agencies', '/pricing', '/contact', '/privacy', '/terms'] as const
export type SitePage = (typeof SITE_PAGES)[number]

/**
 * Off until the copy is in: a scaffold whose text is still key names must
 * not be indexed if it is ever deployed by accident.
 */
export const SITE_INDEXABLE = false

/**
 * The channel of Mudrik's own client record, whose widget the site embeds.
 * Ahmed creates the record and the channel through the normal onboarding;
 * put the channel id here then. Null: the embed slot renders nothing.
 */
export const SITE_WIDGET_CHANNEL_ID: string | null = null

/**
 * Where a visitor reaches Mudrik directly, and where the contact form's
 * messages go. Decided by Ahmed, 19 October 2026. The mailbox has to be read:
 * the contact page promises a reply within one working day.
 */
export const SITE_WHATSAPP = '+201010491850'
export const SITE_EMAIL = 'contact@mudrik-ai.com'
