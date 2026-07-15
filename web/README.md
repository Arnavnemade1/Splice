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

## Motion assets (Remotion)

`web/motion/` is a self-contained Remotion project — it renders the site's original
films. It is isolated from the published package (the root `files` field ships only
`dist`, `dashboard`, `assets`), so it never reaches npm consumers.

Each page gets its **own** composition, so no film is reused:

| Composition | Page | What it argues |
| --- | --- | --- |
| `TheLie` | `index.html` | The page reported success; the click never landed. Splice checked. |
| `AgentSession` | `how.html` | The full loop: diagnose → recover → act → verify. |
| `DoctorHandshake` | `agents.html` | `doctor --json` resolving to `"healthy": true`. |

```
cd web/motion
npm install
npm run render          # all three, into ../media/
npm run render:lie      # or one at a time
npm run studio          # live editor
```

Each film's canvas is `--bg` (`#06080f`), identical to the page, so it sits on the
page with no frame or border. Palettes differ per film (see `src/theme.ts`) so the
pages don't feel like reruns.

## Aurora background

The page-header aurora is "Time Lapse Video Of Aurora Borealis" via
[Pexels](https://www.pexels.com/video/time-lapse-video-of-aurora-borealis-852435/),
streamed from the Pexels CDN under the **Pexels License** (free for commercial use,
no attribution required). Full credit lives in a comment in `index.html`.

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
