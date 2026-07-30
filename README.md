# lentora.co.uk

Marketing site for Lentora — the public face of the thin prime business. No login,
no tool, nothing to do with Anton's interface. Anton lives privately at
`anton.lentora.co.uk`.

## Layout

```
public/            everything served (Cloudflare Workers Static Assets)
  index.html       homepage
  privacy.html
  404.html         generated
  assets/site.css  the whole design system
  guides/          generated — do not edit by hand
  sitemap.xml      generated
worker/index.js    /api/contact endpoint; everything else falls through to assets
guides-src/         the 22 guides as Markdown — source of truth
build_guides.py    renders guides-src/*.md into public/guides/
wrangler.toml
```

## Guides

Source of truth is `guides-src/*.md`. Edit the Markdown,
then rebuild:

```bash
python3 -m venv .venv && .venv/bin/pip install markdown2   # first time only
.venv/bin/python build_guides.py
```

That regenerates `public/guides/`, `public/404.html` and `public/sitemap.xml`.
Commit the output — the deploy has no build step.

**The URLs are load-bearing.** `/guides/<slug>` is indexed and is the main inbound
channel. `html_handling = "drop-trailing-slash"` in `wrangler.toml` keeps those URLs
serving 200 rather than redirecting. Don't change slugs.

## Contact form

`POST /api/contact` → validates → Brevo HTTP API → `info@lentora.co.uk`, with
`replyTo` set to the enquirer, plus an auto-reply to them.

Secrets (`npx wrangler secret put <NAME>`):

| Name | Required | Notes |
|---|---|---|
| `BREVO_API_KEY` | yes | HTTP API key. The SMTP credential won't work — it's IP-locked to the Hetzner box. |
| `TURNSTILE_SECRET` | no | Bot check is enforced only when this is set. |
| `CONTACT_TO` | no | Overrides the `info@lentora.co.uk` destination. |

`lentora.co.uk` is domain-authenticated in Brevo, so `hello@lentora.co.uk` is a valid
sender without registering it individually.

To enable Turnstile: create a widget for `lentora.co.uk` (a new one — never reuse
another site's keys), put the site key in `window.LENTORA_TURNSTILE_SITE_KEY` near the
bottom of `public/index.html`, and set the secret. Until then the honeypot is the only
spam defence and the form still works.

## Local development

```bash
nvm use 22                       # wrangler needs node >= 22
npx wrangler dev --port 8788     # serves assets + the worker
```

Put secrets in `.dev.vars` (gitignored) to exercise the contact form locally.

## Deploy

`git push` to `main` — Cloudflare rebuilds via `npx wrangler deploy`.
