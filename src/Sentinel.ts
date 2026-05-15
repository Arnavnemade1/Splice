/**
 * Splice Sentinel V4.1 — Deep Telemetry
 * High-fidelity tracking client for product intelligence.
 */

export const Sentinel = {
  init(config = { debug: false }) {
    console.log("[Splice Sentinel] Deep Telemetry Active.");

    const report = (event: string, data: any = {}) => {
      console.debug(`[SPLICE_BEHAVIOR] ${JSON.stringify({
        event,
        path: window.location.pathname,
        timestamp: Date.now(),
        ...data
      })}`);
    };

    const getElementId = (el: HTMLElement) => el.getAttribute('data-splice-id') || el.id || 'unknown';

    // 1. CLICK & RAGE CLICK
    let lastClicks: { time: number; x: number; y: number }[] = [];
    document.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      const elementId = getElementId(target);
      const now = Date.now();
      
      lastClicks.push({ time: now, x: e.clientX, y: e.clientY });
      lastClicks = lastClicks.filter(c => now - c.time < 1000);
      
      if (lastClicks.length >= 4) {
        report('rage_click', { elementId, text: target.innerText?.substring(0, 30) });
      } else {
        report('click', { elementId, text: target.innerText?.substring(0, 30) });
      }
    });

    // 2. FORM ABANDONMENT
    const inputs = new Map<HTMLElement, string>();
    document.addEventListener('focusin', (e) => {
      const target = e.target as HTMLElement;
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) {
        inputs.set(target, (target as HTMLInputElement).value);
      }
    });

    document.addEventListener('focusout', (e) => {
      const target = e.target as HTMLElement;
      if (inputs.has(target)) {
        const initialValue = inputs.get(target);
        const finalValue = (target as HTMLInputElement).value;
        if (initialValue === finalValue && finalValue === '') {
          report('form_abandoned', { elementId: getElementId(target), tag: target.tagName });
        }
        inputs.delete(target);
      }
    });

    // 3. SCROLL DEPTH
    let maxScroll = 0;
    window.addEventListener('scroll', () => {
      const scrollPercent = Math.round((window.scrollY + window.innerHeight) / document.documentElement.scrollHeight * 100);
      if (scrollPercent > maxScroll) {
        maxScroll = scrollPercent;
        if (maxScroll % 25 === 0) report('scroll_depth', { depth: maxScroll });
      }
    });

    // 4. VISIBILITY (INTERSECTION OBSERVER)
    const observer = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          const target = entry.target as HTMLElement;
          report('visibility', { elementId: getElementId(target), status: 'visible' });
        }
      });
    }, { threshold: 0.5 });

    // Track important elements (buttons, forms, headings)
    document.querySelectorAll('button, input, h1, h2, a').forEach(el => observer.observe(el));

    // 5. GLOBAL ERRORS
    window.addEventListener('error', (e) => {
      report('js_error', { message: e.message, filename: e.filename, lineno: e.lineno });
    });

    // 6. INTENT SIGNALS (Copy/Selection)
    document.addEventListener('copy', () => {
      const selection = window.getSelection()?.toString();
      report('intent_copy', { length: selection?.length, textPreview: selection?.substring(0, 50) });
    });

    if (config.debug) console.log("[Splice Sentinel] Monitoring intense data streams.");
  }
};
