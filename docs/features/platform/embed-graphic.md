# Embed graphic (Open Graph / Discord)

## What it is

When this repository's link — or any page of the site — is pasted into Discord
or another social client, it renders a large embedded graphic showing the
actual product: the app's mark, its real interface language, and its name. A
bare grey card is a first impression thrown away.

## What the site serves

The served HTML carries, in `<head>`:

- `og:title`, `og:description`, `og:url`, `og:type website`, `og:site_name`
- `og:image` — an **absolute** `https://…/social-preview.png` URL (a relative
  path is the single most common reason an embed shows no picture)
- `og:image:width` 1280 and `og:image:height` 640, so clients can lay out
  before fetching
- `og:image:alt` describing the image for screen-reader users
- `twitter:card` set to `summary_large_image` — the tag that decides between a
  big picture and a stamp-sized thumbnail
- `theme-color` for both schemes, which Discord paints as the embed's edge

## How the image stays honest

`scripts/gen-social-preview.mjs` draws the graphic procedurally (gradient,
rounded-bar mark, monoline wordmark) and writes **two copies that are asserted
byte-identical**: the repository root master (`/social-preview.png`) and the
served copy (`/site/social-preview.png`). Two unverified duplicates would drift
eventually; one generator writing both in one run, with a comparison that fails
the build on mismatch, cannot.

The graphic contains no stock photos, no mockups, and nothing claiming an
interface capture that does not exist yet.

## Crawler realities this design respects

- Crawlers do not run JavaScript — every tag is static HTML.
- The image URL must fetch anonymously; it does.
- Caches are aggressive: when the design changes meaningfully, the filename or
  a version suffix should change rather than overwriting in place.

## Repository-level preview

GitHub's own social-preview upload is a repository setting not exposed by the
public API, so it is a manual step: upload the root `social-preview.png`
(Settings → General → Social preview). Until that happens, the auto-generated
card shows repository metadata only.

## Verification status

Generator implemented with byte-identity assertion. Post-deploy tag readback
(fetch page → confirm tags → confirm anonymous image 2xx) runs after the first
Pages deployment.

## Suggested articles

- [Status reporting](status-reporting.md)
- [Line counts & estimates](line-counts-and-estimates.md)
