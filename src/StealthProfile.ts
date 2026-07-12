/**
 * StealthProfile — coherent, deterministic browser fingerprints.
 *
 * Automation frameworks leak: navigator.webdriver is true, headless Chrome
 * ships no plugins, the WebGL vendor reads "Google SwiftShader", client-hint
 * headers are missing, and the UA/platform/timezone often disagree. Each of
 * those is a trivial bot signal. StealthProfile assembles an internally
 * consistent desktop identity — UA, platform, viewport, locale, timezone,
 * hardware, and WebGL strings that all agree — and an init script that masks
 * the residual automation tells.
 *
 * Determinism matters: the same seed always yields the same profile, so an
 * agent presents a STABLE identity across a session instead of a new random
 * fingerprint on every navigation (itself a detection signal). This layers on
 * top of puppeteer-extra-plugin-stealth; it does not replace it.
 *
 * Scope note: this reduces gratuitous blocking of legitimate automation. It is
 * not a defeat for sites that categorically prohibit bots, and it never
 * touches CAPTCHA — those still route to human intervention.
 */

import type { BrowserContextOptions } from 'playwright';
import { createHash } from 'node:crypto';

export interface StealthFingerprint {
  userAgent: string;
  platform: string;
  viewport: { width: number; height: number };
  locale: string;
  timezoneId: string;
  hardwareConcurrency: number;
  deviceMemory: number;
  webglVendor: string;
  webglRenderer: string;
  /** Full Sec-CH-UA header value. */
  secChUa: string;
  secChUaPlatform: string;
  languages: string[];
}

/** A small pool of coherent, current desktop identities. */
const CHROME_MAJOR = 131;
const PROFILES: Omit<StealthFingerprint, 'secChUa'>[] = [
  {
    userAgent: `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_MAJOR}.0.0.0 Safari/537.36`,
    platform: 'MacIntel',
    viewport: { width: 1512, height: 982 },
    locale: 'en-US',
    timezoneId: 'America/New_York',
    hardwareConcurrency: 10,
    deviceMemory: 8,
    webglVendor: 'Google Inc. (Apple)',
    webglRenderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)',
    secChUaPlatform: '"macOS"',
    languages: ['en-US', 'en'],
  },
  {
    userAgent: `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_MAJOR}.0.0.0 Safari/537.36`,
    platform: 'Win32',
    viewport: { width: 1920, height: 1080 },
    locale: 'en-US',
    timezoneId: 'America/Chicago',
    hardwareConcurrency: 16,
    deviceMemory: 8,
    webglVendor: 'Google Inc. (NVIDIA)',
    webglRenderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)',
    secChUaPlatform: '"Windows"',
    languages: ['en-US', 'en'],
  },
  {
    userAgent: `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_MAJOR}.0.0.0 Safari/537.36`,
    platform: 'Win32',
    viewport: { width: 1366, height: 768 },
    locale: 'en-GB',
    timezoneId: 'Europe/London',
    hardwareConcurrency: 8,
    deviceMemory: 8,
    webglVendor: 'Google Inc. (Intel)',
    webglRenderer: 'ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)',
    secChUaPlatform: '"Windows"',
    languages: ['en-GB', 'en'],
  },
  {
    userAgent: `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_MAJOR}.0.0.0 Safari/537.36`,
    platform: 'Linux x86_64',
    viewport: { width: 1680, height: 1050 },
    locale: 'en-US',
    timezoneId: 'America/Los_Angeles',
    hardwareConcurrency: 12,
    deviceMemory: 8,
    webglVendor: 'Google Inc. (Intel)',
    webglRenderer: 'ANGLE (Intel, Mesa Intel(R) Graphics (ADL GT2), OpenGL 4.6)',
    secChUaPlatform: '"Linux"',
    languages: ['en-US', 'en'],
  },
];

function secChUaFor(): string {
  // Chromium's GREASE format for the current major version.
  return `"Chromium";v="${CHROME_MAJOR}", "Not(A:Brand";v="24", "Google Chrome";v="${CHROME_MAJOR}"`;
}

/**
 * Plausible secondary axes, varied per-seed on top of the coherent base OS
 * identity. These keep two accounts that land on the same base profile from
 * presenting an identical fingerprint — an important property when Splice runs
 * many isolated sessions in parallel. Each remains individually realistic, so
 * the identity stays coherent.
 */
const VIEWPORTS: Array<{ width: number; height: number }> = [
  { width: 1512, height: 982 },
  { width: 1920, height: 1080 },
  { width: 1680, height: 1050 },
  { width: 1440, height: 900 },
  { width: 1366, height: 768 },
  { width: 2560, height: 1440 },
];
const HARDWARE_CONCURRENCY = [4, 8, 10, 12, 16];
const DEVICE_MEMORY = [8, 16, 32];

/**
 * Resolve a deterministic fingerprint from an optional seed. The same seed
 * always maps to the same identity; no seed uses a fixed default so a single
 * session is internally consistent. Distinct seeds are additionally varied
 * across viewport, hardware concurrency, and device memory so parallel
 * sessions that share a base OS profile still present distinct fingerprints.
 */
export function resolveFingerprint(seed?: string): StealthFingerprint {
  const key = seed && seed.length > 0 ? seed : 'splice-default';
  const digest = createHash('sha256').update(key).digest();
  const base = PROFILES[digest[0] % PROFILES.length];
  return {
    ...base,
    viewport: VIEWPORTS[digest[1] % VIEWPORTS.length],
    hardwareConcurrency: HARDWARE_CONCURRENCY[digest[2] % HARDWARE_CONCURRENCY.length],
    deviceMemory: DEVICE_MEMORY[digest[3] % DEVICE_MEMORY.length],
    secChUa: secChUaFor(),
  };
}

/** Chromium launch flags that remove the loudest automation tells. */
export function stealthLaunchArgs(): string[] {
  return [
    // The single most important flag — drops the AutomationControlled blink
    // feature that sets navigator.webdriver at the native level.
    '--disable-blink-features=AutomationControlled',
    '--disable-features=IsolateOrigins,site-per-process,ImprovedCookieControls',
    '--no-first-run',
    '--no-default-browser-check',
    '--no-service-autorun',
    '--password-store=basic',
    '--use-mock-keychain',
    '--disable-infobars',
  ];
}

/** Context options that make the whole request/JS surface agree. */
export function stealthContextOptions(fp: StealthFingerprint): BrowserContextOptions {
  return {
    userAgent: fp.userAgent,
    viewport: fp.viewport,
    locale: fp.locale,
    timezoneId: fp.timezoneId,
    deviceScaleFactor: 1,
    isMobile: false,
    hasTouch: false,
    extraHTTPHeaders: {
      'Accept-Language': `${fp.locale},${fp.locale.split('-')[0]};q=0.9`,
      'sec-ch-ua': fp.secChUa,
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': fp.secChUaPlatform,
    },
  };
}

/**
 * Init script injected before any page script runs. Masks the automation
 * tells that survive at the JS layer. Deliberately leaves NO global marker in
 * production — a `window.__splice*` flag would itself be a fingerprint.
 */
export function stealthInitScript(fp: StealthFingerprint): string {
  const cfg = JSON.stringify({
    platform: fp.platform,
    languages: fp.languages,
    hardwareConcurrency: fp.hardwareConcurrency,
    deviceMemory: fp.deviceMemory,
    webglVendor: fp.webglVendor,
    webglRenderer: fp.webglRenderer,
  });
  return `(() => {
    const CFG = ${cfg};
    const def = (obj, prop, getter) => {
      try { Object.defineProperty(obj, prop, { get: getter, configurable: true }); } catch (e) {}
    };

    // 1. navigator.webdriver — the canonical bot flag.
    def(Navigator.prototype, 'webdriver', () => undefined);

    // 2. Coherent navigator surface.
    def(Navigator.prototype, 'platform', () => CFG.platform);
    def(Navigator.prototype, 'languages', () => Object.freeze(CFG.languages.slice()));
    def(Navigator.prototype, 'hardwareConcurrency', () => CFG.hardwareConcurrency);
    def(Navigator.prototype, 'deviceMemory', () => CFG.deviceMemory);

    // 3. Non-empty plugin + mimeType lists (headless ships none).
    const makePlugins = () => {
      const data = [
        { name: 'PDF Viewer', filename: 'internal-pdf-viewer', desc: 'Portable Document Format' },
        { name: 'Chrome PDF Viewer', filename: 'internal-pdf-viewer', desc: 'Portable Document Format' },
        { name: 'Chromium PDF Viewer', filename: 'internal-pdf-viewer', desc: 'Portable Document Format' },
      ];
      const arr = data.map(d => {
        const p = Object.create(Plugin.prototype);
        def(p, 'name', () => d.name);
        def(p, 'filename', () => d.filename);
        def(p, 'description', () => d.desc);
        def(p, 'length', () => 1);
        return p;
      });
      def(arr, 'item', () => (i) => arr[i]);
      def(arr, 'namedItem', () => (n) => arr.find(p => p.name === n) || null);
      return arr;
    };
    try {
      const plugins = makePlugins();
      def(Navigator.prototype, 'plugins', () => plugins);
    } catch (e) {}

    // 4. window.chrome runtime shim (present in real Chrome, absent in headless).
    if (!window.chrome) {
      window.chrome = {};
    }
    if (!window.chrome.runtime) {
      window.chrome.runtime = { connect: () => {}, sendMessage: () => {} };
    }

    // 5. Permissions.query for 'notifications' must not report a denied
    //    prompt state that never matches a real user's default.
    try {
      const orig = window.navigator.permissions.query.bind(window.navigator.permissions);
      window.navigator.permissions.query = (params) =>
        params && params.name === 'notifications'
          ? Promise.resolve({ state: Notification.permission, onchange: null })
          : orig(params);
    } catch (e) {}

    // 6. WebGL vendor/renderer — headless reports SwiftShader; spoof to a
    //    plausible GPU that matches the platform.
    const patchGL = (proto) => {
      if (!proto) return;
      const getParameter = proto.getParameter;
      proto.getParameter = function (param) {
        // UNMASKED_VENDOR_WEBGL / UNMASKED_RENDERER_WEBGL
        if (param === 37445) return CFG.webglVendor;
        if (param === 37446) return CFG.webglRenderer;
        return getParameter.apply(this, arguments);
      };
    };
    try { patchGL(window.WebGLRenderingContext && window.WebGLRenderingContext.prototype); } catch (e) {}
    try { patchGL(window.WebGL2RenderingContext && window.WebGL2RenderingContext.prototype); } catch (e) {}
  })();`;
}
