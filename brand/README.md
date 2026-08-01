# BuildHall — Brand Assets

Everything needed to ship the site and apps. All vector sources are SVG with type
converted to outlines, so no font licensing or font loading is required to render a logo.

Primary domain: **buildhall.ai**

---

## 1. Which file do I use?

| Context | File |
| --- | --- |
| Site header, app top bar, email signature, docs | `logo/svg/buildhall-horizontal.svg` |
| Same, on a dark background | `logo/svg/buildhall-horizontal-white.svg` |
| Square-ish space that still needs the name (splash, card, print) | `logo/svg/buildhall-stacked.svg` |
| Anywhere small or square with no room for the name | `logo/svg/buildhall-mark.svg` |
| Rendered at 48px or below | `logo/svg/buildhall-mark-simple.svg` |
| Single-colour printing, embroidery, engraving, fax | `*-mono-black.svg` |

**Horizontal is the default.** If a developer only reaches for one file, it should be that one.

### The simplified mark

`buildhall-mark-simple.svg` removes the mortar joints between the arch segments and merges the
pier blocks. Below roughly 48px those gaps collapse into mud and the mark reads as a smear.
The simplified version keeps the arch silhouette and the amber keystone, which is what actually
identifies the brand at small sizes. The favicons in this package already use it — this is not
an optional nicety, use it anywhere the mark renders small.

---

## 2. Clear space and minimum sizes

**Clear space:** keep a margin equal to the width of one pier block (about 22% of the mark's
height) on all four sides. Nothing — no text, no rule, no other logo, no edge of a container —
enters that zone.

**Minimum sizes:**

- Horizontal lockup: 120px wide on screen, 30mm in print. Below that the word breaks down.
- Stacked lockup: 90px wide.
- Mark alone: 16px, using the simplified variant.

---

## 3. Don't

- Don't recolour the mark outside the palette. The keystone is amber; everything else is navy.
- Don't put the wordmark inside the arch opening. The negative space under the arch is the idea.
- Don't add gradients, shadows, glows, strokes, or bevels.
- Don't stretch, skew, rotate, or condense any lockup.
- Don't rebuild the lockup by placing the mark next to live text — the spacing is deliberate.
  Use the supplied SVG.
- Don't place the navy logo on a dark background or the white logo on a light one. Contrast
  ratio against the surface must be at least 3:1.

---

## 4. Colour

Full ramps in `color/`. Four formats, same values:

- `variables.css` — CSS custom properties, includes a `[data-theme="dark"]` block
- `_colors.scss` — SCSS variables
- `tailwind.colors.js` — drop into `theme.extend.colors`
- `tokens.json` — raw tokens for any other pipeline

**Core roles:**

| Role | Value |
| --- | --- |
| Primary / ink | `#0A2540` (navy-900) |
| Accent | `#F5A524` (amber-500) |
| Surface | `#FFFFFF` |
| Surface alt | slate-50 |
| Border | slate-200 |
| Muted text | slate-500 |

**One rule that matters:** amber is an accent, not a UI colour. It appears on the keystone, on a
primary call to action, and on nothing else. The moment it shows up in three places on a screen
it stops meaning anything. Navy and slate carry the interface.

**Accessibility:** navy-900 on white is 15.8:1, comfortably AAA. Amber-500 on white is only
about 2.1:1 — **never use amber-500 for text on a light background.** For amber-coloured text
use amber-700 or darker. Amber-500 is fine as a fill behind navy-900 text.

---

## 5. Favicons and app icons

Copy everything in `favicon/` to the web root, then paste `HEAD-SNIPPET.html` into `<head>`.

| File | Purpose |
| --- | --- |
| `favicon.ico` | Multi-resolution 16/32/48, for legacy and Windows |
| `favicon-16/32/48/96.png` | Modern browsers |
| `apple-touch-icon.png` | 180×180, iOS home screen. Opaque navy — iOS ignores transparency and applies its own rounded mask, so no corner rounding is baked in. |
| `android-chrome-192/512.png` | Android and PWA install |
| `maskable-icon-512x512.png` | Android adaptive icons. Art sits inside the centre 80% safe zone so it survives circular, squircle and teardrop crops. |
| `safari-pinned-tab.svg` | Safari pinned tabs, single-colour path |
| `site.webmanifest` | PWA manifest, theme colour `#0A2540` |

---

## 6. Social

- `og-image-1200x630.png` — Open Graph, the standard for Facebook, LinkedIn, Slack, Discord
- `twitter-card-1200x600.png` — `summary_large_image`
- `avatar-400x400.png` — square profile picture for any social account

Meta tags are already written in `HEAD-SNIPPET.html`. Update the absolute URLs to the live
domain before shipping — social scrapers will not resolve relative paths.

---

## 7. Typography

The wordmark is set in **Space Grotesk Bold**, outlined in the SVGs. If you want matching type
in the interface, Space Grotesk is available on Google Fonts under the SIL Open Font License —
free for commercial use, no attribution required in the product.

Suggested pairing: Space Grotesk for headings, and a neutral workhorse such as Inter for body
copy. Space Grotesk has enough personality that setting long paragraphs in it gets tiring.

---

## 8. File tree

```
brand/
├─ README.md
├─ logo/
│  ├─ svg/          12 vector variants — navy, white, mono, simplified
│  └─ png/          transparent rasters, 24 files
├─ favicon/         complete icon set + manifest + head snippet
├─ social/          OG, Twitter card, avatar
└─ color/           palette.png + tokens in 4 formats
```
