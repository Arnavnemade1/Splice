# Splice Marketing Website

Landing page for Splice — a reliable browser layer for coding agents.

## Design

Clean, minimal startup style: white background, near-black text, a single indigo
accent, generous whitespace, 1px-bordered cards. Plain-language copy over jargon.
No gradients, glows, ambient grids, or stock video. Zero external dependencies
beyond the Inter webfont.

## Structure

```
web/
├── index.html      # Semantic HTML
├── styles.css      # Design system (light, one accent)
├── scripts.js      # Copy buttons only (three-tier clipboard fallback)
└── README.md       # This file
```

## Content sections

1. **Hero** — plain-English value proposition with install CTA
2. **Proof strip** — four concrete claims
3. **How it works** — three steps, each with a copyable command
4. **What you get** — nine feature cards in plain language
5. **For agents** — the one-prompt self-install path (AGENT_INSTALL.md)
6. **Get started** — install commands + GitHub links
7. **Footer** — minimal links

## Conventions

- Every code block has a copy button: async clipboard API, then
  `document.execCommand('copy')`, then select-and-hint as a last resort.
- Honors `prefers-reduced-motion`.
- The logo mark is inline SVG using `currentColor`, tinted by the indigo accent.

## Deployment

Static files — serve the directory from any host (GitHub Pages, Netlify, Vercel).
The favicon references `../assets/logo-mark.svg`, so deploy from the repo root or
adjust the path.
