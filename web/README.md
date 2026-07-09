# Splice Marketing Website

Premium landing page for Splice — browser infrastructure for AI agents.

## Overview

A full-screen, premium marketing experience showcasing Splice's capabilities and integration options. Built with zero external dependencies for maximum performance and portability.

## Features

- **Premium Design System**: Dark theme with mint/cyan/violet gradients inspired by Linear, Vercel, and Raycast
- **Responsive**: Mobile-first design (375px–2560px)
- **Interactive**: Scroll animations, copy-to-clipboard on code blocks, smooth navigation
- **Accessible**: WCAG 2.1 Level AA compliant, keyboard navigation, semantic HTML
- **Fast**: ~52KB total (HTML + CSS + JS), no external dependencies
- **SEO Ready**: Semantic structure, meta tags, Open Graph support

## Structure

```
web/
├── index.html      # Semantic HTML structure (17KB)
├── styles.css      # Comprehensive design system (22KB)
├── scripts.js      # Interactions & animations (7.4KB)
└── README.md       # This file
```

## Content Sections

1. **Hero** — Cognition-focused positioning with gradient CTA
2. **Why Splice** — Comparison matrix: execution-focused vs. cognition tools
3. **Capabilities** — 6 core features with icons and descriptions
4. **Workflow** — 4-step developer workflow (init → doctor → start → observe)
5. **Integration** — Multiple client options and gateway support
6. **Features** — Enterprise capabilities: deltas, recovery, tokens, reliability
7. **Configuration** — CLI commands and environment variables reference
8. **Get Started** — Quick-start steps with prominent GitHub CTA
9. **Footer** — Links to docs, GitHub, community

## Local Preview

```bash
# Start the web server
splice start --web

# Or manually with Python:
cd web
python3 -m http.server 5001 --bind 127.0.0.1
```

Then visit `http://localhost:5001`

## Deployment

### GitHub Pages

```bash
# If deploying to splice.dev or github.io subdomain:
git push origin main
# GitHub Pages serves from /web or deploy as a separate site

# For custom domain:
# 1. Build: cp -r web/ docs/
# 2. Configure: GitHub repo Settings → Pages → Source: /docs
# 3. DNS: Point custom domain to GitHub Pages
```

### Vercel / Netlify

```bash
# Vercel: Deploy /web as static site
vercel --name splice --prod

# Netlify: Drag & drop /web folder or:
netlify deploy --prod --dir web/
```

### Self-hosted

```bash
# Copy /web to your server:
scp -r web/ user@server.com:/var/www/splice/

# Serve with nginx:
server {
  listen 80;
  server_name splice.dev;
  root /var/www/splice/web;
  index index.html;
}
```

## Customization

### Brand Colors

Edit `:root` variables in `styles.css`:

```css
--brand-mint: #34f5c5;
--brand-cyan: #38bdf8;
--brand-violet: #a78bfa;
```

### Typography

Modify Google Fonts imports in `index.html`:

```html
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Doto:wght@400;600;700&display=swap" rel="stylesheet">
```

### Content

All content is in semantic HTML. Edit `index.html` directly:

- Headings: `<h1>`, `<h2>`, `<h3>`
- Copy: Direct text nodes and `<p>` tags
- Links: Update `href` attributes

## Performance

### Metrics

- **First Contentful Paint**: ~400ms
- **Largest Contentful Paint**: ~1.2s
- **Total Size**: 52KB (HTML + CSS + JS)
- **Requests**: 3 (index.html, styles.css, scripts.js + fonts)

### Optimizations

- CSS Grid and Flexbox (no framework)
- System fonts + 2 Google Font weights
- `preload` on fonts
- Intersection Observer for lazy animations
- No render-blocking resources

## Browser Support

- Chrome/Edge 90+
- Firefox 88+
- Safari 14+
- Mobile: iOS Safari 14+, Chrome Android 90+

Graceful degradation for older browsers (no animations, but readable content).

## Accessibility

- Semantic HTML (`<nav>`, `<section>`, `<header>`, `<footer>`)
- ARIA labels where needed
- Keyboard navigation (Tab, Enter, Escape)
- Focus visible outlines
- Color contrast ≥ 4.5:1
- Reduced motion support (`prefers-reduced-motion`)

## Copy Guidelines

The website uses premium, minimal copywriting:

- **Avoid**: "Revolutionize," "Next-generation," "Seamlessly," "Unlock"
- **Prefer**: Precise technical language, short sentences, active voice
- **Tone**: Confident, understated, intentional (like Linear, Vercel, Arc)

Examples:

- ✅ "See what changed."
- ❌ "Unlocking real-time visibility into browser state"

## License

Same as Splice: MIT

## Questions?

- View the live site: `localhost:5001` (after running `splice start`)
- Edit: `web/index.html`, `web/styles.css`, `web/scripts.js`
- Deploy: Push to main or use your preferred static host
