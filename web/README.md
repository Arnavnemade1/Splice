# Splice Marketing Website

Multi-page landing site for Splice — a reliable browser layer for coding agents.

## Design

Cinematic dark aesthetic aimed at a technical audience: a full-screen looping
aurora-borealis background sets the atmosphere on every page, over a deep
near-black canvas with restrained typography and a single aurora-teal accent used
sparingly. Motion is tame — a load rise, scroll-reveal on sections, cursor-tracked
card glows, and a solidifying nav. Whitespace and hierarchy over density; every
page carries a small amount of text and one clear next action.

## Structure

```
web/
├── index.html      # Home — full-screen hero, the problem, stats, CTA
├── features.html   # Features — premium bento grid + secondary capabilities
├── how.html        # How it works — three steps + the loop
├── agents.html     # For agents — the one-prompt self-install path
├── start.html      # Get started — install commands + requirements
├── styles.css      # Design system (dark, one accent, shared components)
├── scripts.js      # Nav state, scroll reveal, hover glow, copy buttons
└── README.md       # This file
```

Nav and footer markup is duplicated across the static pages (no build step); the
active nav link is marked with `aria-current="page"`.

## Cinematic background

The aurora video is "Time Lapse Video Of Aurora Borealis" via
[Pexels](https://www.pexels.com/video/time-lapse-video-of-aurora-borealis-852435/),
streamed from the Pexels CDN. It falls under the **Pexels License** (free for
commercial and personal use, no attribution required); full credit lives in a
comment in `index.html`. It is `muted`, `loop`, `playsinline`, and `autoplay`, so
it plays inline without sound; a flat dark poster prevents any flash before load.

## Conventions

- Every code block has a copy button: async clipboard API, then
  `document.execCommand('copy')`, then select-and-hint as a last resort.
- Honors `prefers-reduced-motion`: the video holds on its first frame, and all
  reveals/animations resolve to their final state.
- Scroll reveals use `IntersectionObserver`; elements opt in with `data-reveal`
  (and optional `data-delay="1..5"` for stagger).
- The logo mark is inline SVG using `currentColor`, tinted by the accent.

## Deployment

Static files — serve the directory from any host (GitHub Pages, Netlify, Vercel).
The favicon references `../assets/logo-mark.svg`, so deploy from the repo root or
adjust the path. The only external dependencies are the Inter + JetBrains Mono
webfonts and the Pexels-hosted background video.
