#!/usr/bin/env python3
"""Render the Markdown guides into static HTML for the Cloudflare Workers site.

Source:  ../guides-content/*.md
Output:  public/guides/index.html
         public/guides/<slug>/index.html
         public/sitemap.xml

URLs are identical to the ones the Flask app used to serve (/guides and
/guides/<slug>) because those are indexed — do not change them.

The frontmatter parser is deliberately the same simple `key: value` format
used by tool-public/app.py:_parse_post, so the same .md files work in both.

    pip install markdown2
    python3 build_guides.py
"""

import html
import os
import shutil
import sys
from datetime import date

try:
    import markdown2
except ImportError:
    sys.exit("markdown2 is required:  pip install markdown2")

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "..", "guides-content")
OUT = os.path.join(HERE, "public", "guides")
SITEMAP = os.path.join(HERE, "public", "sitemap.xml")
BASE_URL = "https://lentora.co.uk"

# Order the index by how a supplier new to this would read it, not by date.
CATEGORY_ORDER = [
    "The basics",
    "Finding tenders",
    "Bidding",
    "Routes to market",
    "Rules & regulations",
    "Sectors",
]

STATIC_PAGES = ["/", "/bid-writing-services", "/guides", "/privacy"]


# ── source ────────────────────────────────────────────────────────────────────

def parse_post(path):
    with open(path, encoding="utf-8") as f:
        raw = f.read()
    meta, body = {}, raw
    if raw.startswith("---"):
        parts = raw.split("---", 2)
        if len(parts) == 3:
            _, fm, body = parts
            for line in fm.strip().splitlines():
                if ":" in line:
                    k, v = line.split(":", 1)
                    meta[k.strip()] = v.strip()
    meta.setdefault("slug", os.path.splitext(os.path.basename(path))[0])
    meta.setdefault("title", meta["slug"].replace("-", " ").title())
    meta.setdefault("description", "")
    meta.setdefault("date", "")
    meta.setdefault("author", "The Lentora team")
    meta.setdefault("category", "")
    meta["body_md"] = body.strip()
    return meta


def load_posts():
    posts = [
        parse_post(os.path.join(SRC, fn))
        for fn in sorted(os.listdir(SRC))
        if fn.endswith(".md")
    ]
    posts.sort(key=lambda p: p.get("date", ""), reverse=True)
    return posts


def render_markdown(text):
    return markdown2.markdown(
        text or "",
        extras=["tables", "fenced-code-blocks", "header-ids", "cuddled-lists"],
    )


def related_for(post, posts):
    """Three others, preferring the same category — matches the old Flask logic."""
    others = [p for p in posts if p["slug"] != post["slug"]]
    cat = post.get("category")
    related = [p for p in others if cat and p.get("category") == cat][:3]
    for p in others:
        if len(related) >= 3:
            break
        if p not in related:
            related.append(p)
    return related


# ── shared chrome ─────────────────────────────────────────────────────────────

def head(title, description, canonical, extra=""):
    return f"""<!DOCTYPE html>
<html lang="en-GB">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>{html.escape(title)}</title>
  <meta name="description" content="{html.escape(description)}">
  <link rel="canonical" href="{canonical}">

  <meta property="og:type" content="article">
  <meta property="og:url" content="{canonical}">
  <meta property="og:site_name" content="Lentora">
  <meta property="og:title" content="{html.escape(title)}">
  <meta property="og:description" content="{html.escape(description)}">
  <meta name="twitter:card" content="summary">

  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,300;0,9..40,400;0,9..40,500;0,9..40,700&family=Playfair+Display:wght@400;500;600;700&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="/assets/site.css">

  <!-- Analytics loads only after consent — see assets/consent.js -->
  <script src="/assets/consent.js" defer></script>
{extra}</head>
<body>

<a class="ls-skip" href="#ls-main">Skip to content</a>

<nav class="ls-nav">
  <div class="ls-nav-inner">
    <a href="/" class="ls-logo">Lentora<span>.</span></a>
    <ul class="ls-nav-links">
      <li><a href="/#ls-how">How it works</a></li>
      <li><a href="/#ls-specialisms">Specialisms</a></li>
      <li><a href="/bid-writing-services">Bid writing</a></li>
      <li><a href="/#ls-suppliers">For suppliers</a></li>
      <li><a href="/guides">Guides</a></li>
    </ul>
    <a href="/#ls-contact" class="ls-nav-cta">Talk to us</a>
  </div>
</nav>
"""


FOOTER = """
<footer class="ls-footer">
  <div class="ls-footer-inner">
    <div class="ls-footer-text">
      &copy; 2026 Lentora &middot; England &amp; Wales<br>
      Company registration pending
    </div>
    <div class="ls-footer-links">
      <a href="/#ls-how">How it works</a>
      <a href="/bid-writing-services">Bid writing</a>
      <a href="/#ls-suppliers">For suppliers</a>
      <a href="/guides">Guides</a>
      <a href="/privacy">Privacy</a>
      <a href="/#ls-contact">Contact</a>
    </div>
  </div>
</footer>

</body>
</html>
"""

ARTICLE_CTA = """
        <div class="ls-article-cta">
          <h3>Finding the tender is the easy part</h3>
          <p>
            Lentora bids for UK public sector contracts on behalf of specialist SMEs. We
            find the opportunities, write the submission, and win the work on your behalf.
            5&ndash;10% of contract value, and nothing at all if we don't win.
          </p>
          <a href="/#ls-contact" class="ls-btn ls-btn-primary">Talk to us</a>
        </div>
"""


# ── pages ─────────────────────────────────────────────────────────────────────

def render_post(post, posts):
    canonical = f"{BASE_URL}/guides/{post['slug']}"
    jsonld = f"""  <script type="application/ld+json">
  {{
    "@context": "https://schema.org",
    "@type": "Article",
    "headline": {json_str(post['title'])},
    "description": {json_str(post.get('description', ''))},
    "datePublished": {json_str(post.get('date', ''))},
    "author": {{"@type": "Organization", "name": {json_str(post.get('author', 'Lentora'))}}},
    "publisher": {{"@type": "Organization", "name": "Lentora", "url": "{BASE_URL}/"}},
    "mainEntityOfPage": "{canonical}"
  }}
  </script>
"""
    related = related_for(post, posts)
    related_html = "\n".join(
        f'            <li><a href="/guides/{p["slug"]}">{html.escape(p["title"])}</a></li>'
        for p in related
    )
    meta_bits = []
    if post.get("category"):
        meta_bits.append(html.escape(post["category"]))
    if post.get("date"):
        meta_bits.append(pretty_date(post["date"]))

    return (
        head(f"{post['title']} — Lentora", post.get("description", ""), canonical, jsonld)
        + f"""
<main id="ls-main">
  <header class="ls-article-head">
    <div class="ls-container-narrow">
      <h1>{html.escape(post['title'])}</h1>
      <p class="ls-article-meta">{' &middot; '.join(meta_bits)}</p>
    </div>
  </header>

  <section class="ls-section">
    <div class="ls-container-narrow">
      <article class="ls-prose">
{render_markdown(post['body_md'])}
      </article>
{ARTICLE_CTA}
      <nav class="ls-related">
        <h3>Related guides</h3>
        <ul>
{related_html}
        </ul>
      </nav>
    </div>
  </section>
</main>
"""
        + FOOTER
    )


def render_index(posts):
    by_cat = {}
    for p in posts:
        by_cat.setdefault(p.get("category") or "Other", []).append(p)

    ordered = [c for c in CATEGORY_ORDER if c in by_cat]
    ordered += sorted(c for c in by_cat if c not in CATEGORY_ORDER)

    groups = []
    for cat in ordered:
        cards = "\n".join(
            f"""        <a class="ls-guide-card" href="/guides/{p['slug']}">
          <span class="ls-guide-cat">{html.escape(p.get('category', ''))}</span>
          <h3>{html.escape(p['title'])}</h3>
          <p>{html.escape(p.get('description', ''))}</p>
        </a>"""
            for p in by_cat[cat]
        )
        groups.append(
            f"""    <div class="ls-guide-group">
      <h2>{html.escape(cat)}</h2>
      <div class="ls-guides-grid">
{cards}
      </div>
    </div>"""
        )

    return (
        head(
            "Guides to UK public sector procurement — Lentora",
            "Plain-English guides to UK government tendering, written for suppliers: how "
            "procurement works, where tenders are published, and how bids are scored.",
            f"{BASE_URL}/guides",
        )
        + f"""
<main id="ls-main">
  <header class="ls-article-head">
    <div class="ls-container-narrow">
      <h1>Guides</h1>
      <p class="ls-article-meta">{len(posts)} plain-English guides to UK public sector procurement</p>
    </div>
  </header>

  <section class="ls-section">
    <div class="ls-container">
      <div class="ls-section-header">
        <p>Written for suppliers rather than buyers. How UK government tendering actually
          works, where the opportunities are published, and what makes a bid score. Free,
          no sign-up.</p>
      </div>
{chr(10).join(groups)}
    </div>
  </section>
</main>
"""
        + FOOTER
    )


def render_404():
    return (
        head("Page not found — Lentora", "That page doesn't exist.", f"{BASE_URL}/404")
        + """
<main id="ls-main">
  <header class="ls-article-head">
    <div class="ls-container-narrow">
      <h1>That page isn't here</h1>
      <p class="ls-article-meta">404</p>
    </div>
  </header>
  <section class="ls-section">
    <div class="ls-container-narrow" style="text-align:center;">
      <p style="color:var(--ls-text-muted);margin-bottom:2rem;line-height:1.8;">
        The link may be out of date. Start from the homepage, or browse the guides to UK
        public sector procurement.
      </p>
      <div class="ls-hero-actions">
        <a href="/" class="ls-btn ls-btn-primary">Homepage</a>
        <a href="/guides" class="ls-btn ls-btn-outline">Read the guides</a>
      </div>
    </div>
  </section>
</main>
"""
        + FOOTER
    )


def render_sitemap(posts):
    today = date.today().isoformat()
    urls = [(f"{BASE_URL}{p}", today, "0.9" if p == "/" else "0.7") for p in STATIC_PAGES]
    urls += [
        (f"{BASE_URL}/guides/{p['slug']}", p.get("date") or today, "0.6") for p in posts
    ]
    body = "\n".join(
        f"  <url><loc>{loc}</loc><lastmod>{mod}</lastmod><priority>{pri}</priority></url>"
        for loc, mod, pri in urls
    )
    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
        f"{body}\n</urlset>\n"
    )


# ── helpers ───────────────────────────────────────────────────────────────────

def json_str(value):
    return '"' + str(value).replace("\\", "\\\\").replace('"', '\\"') + '"'


def pretty_date(iso):
    try:
        y, m, d = iso.split("-")
        months = ["January", "February", "March", "April", "May", "June", "July",
                  "August", "September", "October", "November", "December"]
        return f"{int(d)} {months[int(m) - 1]} {y}"
    except (ValueError, IndexError):
        return iso


def write(path, content):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(content)


# ── main ──────────────────────────────────────────────────────────────────────

def main():
    posts = load_posts()
    if not posts:
        sys.exit(f"No .md files found in {SRC}")

    if os.path.isdir(OUT):
        shutil.rmtree(OUT)

    write(os.path.join(OUT, "index.html"), render_index(posts))
    for post in posts:
        write(os.path.join(OUT, post["slug"], "index.html"), render_post(post, posts))

    write(os.path.join(HERE, "public", "404.html"), render_404())
    write(SITEMAP, render_sitemap(posts))

    print(f"Built {len(posts)} guides -> public/guides/")
    print("Wrote public/404.html and public/sitemap.xml")


if __name__ == "__main__":
    main()
