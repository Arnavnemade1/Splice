/**
 * Synthetic fixture pages — a regression pack of known failure patterns.
 *
 * Each page reproduces one class of real-world breakage that has bitten
 * autonomous agents before: late-rendered menus, async form validation,
 * skeleton screens, framework re-mount churn, and stacked overlays.
 * The regression suite (regression.ts) drives BrowserManager against these
 * pages so behavior changes in cognition/observation code surface as
 * deterministic test failures instead of production incidents.
 */
import http from 'node:http';

const baseStyles = `
  body { font-family: Inter, system-ui, sans-serif; margin: 0; color: #101820; background: #f5f7fb; }
  main { max-width: 880px; margin: 0 auto; padding: 48px 24px; }
  button { font: inherit; border: 0; border-radius: 6px; padding: 10px 14px; background: #143d59; color: white; cursor: pointer; }
  button:disabled { background: #9aa3b2; cursor: not-allowed; }
  input { padding: 10px 12px; border: 1px solid #b7c1d0; border-radius: 6px; font-size: 15px; }
  input[aria-invalid="true"] { border-color: #c0334d; }
  .error { color: #c0334d; font-size: 13px; min-height: 18px; }
  .ok { color: #0f7b54; font-size: 13px; min-height: 18px; }
`;

function pageShell(title: string, body: string, extraStyles = ''): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>${title}</title>
  <style>${baseStyles}${extraStyles}</style>
</head>
<body>
${body}
</body>
</html>`;
}

/** Dynamic navigation: submenu items enter the DOM ~300ms after the trigger is clicked. */
function dynamicMenuPage(): string {
  return pageShell('Fixture: Dynamic Menu', `
  <main>
    <h1>Dynamic navigation lab</h1>
    <p>The Products menu renders its items asynchronously after the trigger is clicked.</p>
    <nav>
      <button id="products-trigger" aria-haspopup="true" aria-expanded="false">Products</button>
      <ul id="products-menu" role="menu" hidden style="list-style:none;padding:8px;border:1px solid #b7c1d0;border-radius:6px;background:white;max-width:260px"></ul>
    </nav>
    <div id="menu-view"></div>
  </main>
  <script>
    const trigger = document.getElementById('products-trigger');
    const menu = document.getElementById('products-menu');
    trigger.addEventListener('click', () => {
      const open = trigger.getAttribute('aria-expanded') === 'true';
      trigger.setAttribute('aria-expanded', String(!open));
      if (open) { menu.hidden = true; menu.innerHTML = ''; return; }
      // Simulate an async render: items land in the DOM 300ms after the click.
      setTimeout(() => {
        menu.innerHTML = [
          'Analytics suite',
          'Quarterly reports',
          'Billing exports',
        ].map(label => '<li role="none" style="margin:4px 0"><button role="menuitem" class="menu-item">' + label + '</button></li>').join('');
        menu.hidden = false;
        menu.querySelectorAll('.menu-item').forEach(item => {
          item.addEventListener('click', () => {
            if (item.textContent === 'Quarterly reports') {
              history.pushState({}, '', '/menu/reports');
              document.title = 'Quarterly Reports';
              document.getElementById('menu-view').innerHTML = '<h2>Quarterly reports archive</h2><p>Q1 through Q4 filings are available below.</p>';
            }
          });
        });
      }, 300);
    });
  </script>`);
}

/** Form validation gauntlet: async email availability check, sync password rules, gated submit. */
function formValidationPage(): string {
  return pageShell('Fixture: Form Validation', `
  <main>
    <h1>Signup validation lab</h1>
    <form id="signup" style="display:grid;gap:10px;max-width:420px">
      <label for="email">Work email</label>
      <input id="email" name="email" type="email" required placeholder="agent@example.com">
      <div id="email-status" role="alert" class="error"></div>
      <label for="password">Choose password</label>
      <input id="password" name="password" type="password" required minlength="8">
      <div id="password-status" role="alert" class="error"></div>
      <label for="confirm">Confirm password</label>
      <input id="confirm" name="confirm" type="password" required>
      <div id="confirm-status" role="alert" class="error"></div>
      <label><input id="terms" name="terms" type="checkbox"> Agree to terms</label>
      <button id="create" type="submit" disabled>Create account</button>
      <div id="signup-result" role="status" class="ok"></div>
    </form>
  </main>
  <script>
    const email = document.getElementById('email');
    const password = document.getElementById('password');
    const confirm = document.getElementById('confirm');
    const terms = document.getElementById('terms');
    const create = document.getElementById('create');
    const emailStatus = document.getElementById('email-status');
    let emailOk = false;
    let checkTimer = null;

    function gate() {
      const passOk = password.value.length >= 8;
      const matchOk = confirm.value === password.value && confirm.value.length > 0;
      create.disabled = !(emailOk && passOk && matchOk && terms.checked);
    }

    email.addEventListener('input', () => {
      emailOk = false;
      email.removeAttribute('aria-invalid');
      emailStatus.textContent = email.value ? 'Checking availability…' : '';
      emailStatus.className = 'error';
      clearTimeout(checkTimer);
      if (!email.checkValidity()) { gate(); return; }
      // Simulated server-side availability check with a 350ms round trip.
      checkTimer = setTimeout(() => {
        if (email.value.toLowerCase() === 'taken@example.com') {
          email.setAttribute('aria-invalid', 'true');
          emailStatus.textContent = 'That email is already registered.';
          emailStatus.className = 'error';
        } else {
          emailOk = true;
          emailStatus.textContent = 'Email available.';
          emailStatus.className = 'ok';
        }
        gate();
      }, 350);
      gate();
    });

    password.addEventListener('input', () => {
      const short = password.value.length > 0 && password.value.length < 8;
      password.toggleAttribute('aria-invalid', short);
      document.getElementById('password-status').textContent = short ? 'Password must be at least 8 characters.' : '';
      gate();
    });

    confirm.addEventListener('input', () => {
      const mismatch = confirm.value.length > 0 && confirm.value !== password.value;
      confirm.toggleAttribute('aria-invalid', mismatch);
      document.getElementById('confirm-status').textContent = mismatch ? 'Passwords do not match.' : '';
      gate();
    });

    terms.addEventListener('change', gate);

    document.getElementById('signup').addEventListener('submit', (event) => {
      event.preventDefault();
      document.getElementById('signup-result').textContent = 'Account created for ' + email.value;
      history.pushState({}, '', '/form/success');
      document.title = 'Signup Complete';
    });
  </script>`);
}

/** Late content: skeleton placeholders resolve after ~1s; ?stall=1 never resolves. */
function lateContentPage(stall: boolean): string {
  return pageShell('Fixture: Late Content', `
  <main aria-busy="true" id="report-root">
    <div class="skeleton" style="height:28px;width:60%"></div>
    <div class="skeleton" style="height:16px;width:90%"></div>
    <div class="skeleton" style="height:16px;width:80%"></div>
    <div class="spinner" role="progressbar" aria-label="Loading dashboard" style="margin-top:16px">Loading dashboard…</div>
  </main>
  <script>
    ${stall ? '// Stalled variant: the skeleton never resolves.' : `
    setTimeout(() => {
      const root = document.getElementById('report-root');
      root.removeAttribute('aria-busy');
      root.innerHTML = '<h1>Team velocity report</h1>'
        + '<ul id="entries"><li>Entry from January</li><li>Entry from February</li></ul>'
        + '<button id="load-more" type="button">Load more entries</button>'
        + '<div id="more-status" role="status"></div>';
      document.getElementById('load-more').addEventListener('click', () => {
        document.getElementById('more-status').textContent = 'Loading…';
        setTimeout(() => {
          const li = document.createElement('li');
          li.textContent = 'Entry from March';
          document.getElementById('entries').appendChild(li);
          document.getElementById('more-status').textContent = '';
        }, 500);
      });
    }, 1000);`}
  </script>`, `
  .skeleton { background: linear-gradient(90deg,#e3e8f0,#f0f3f9,#e3e8f0); border-radius: 6px; margin: 10px 0; }
  .spinner { color: #626e84; font-size: 14px; }`);
}

/** Re-render churn: the catalog list re-mounts with identical content on a timer; a ticker mutates text. */
function rerenderChurnPage(): string {
  return pageShell('Fixture: Re-render Churn', `
  <main>
    <h1>Framework re-mount lab</h1>
    <button id="ticker" type="button">Ticker tick 0</button>
    <ul id="catalog" style="list-style:none;padding:0">
      <li style="margin:6px 0"><button class="buy">Buy the Aurora lamp</button></li>
      <li style="margin:6px 0"><button class="buy">Buy the Basalt desk</button></li>
      <li style="margin:6px 0"><button class="buy">Buy the Cirrus chair</button></li>
    </ul>
  </main>
  <script>
    let tick = 0;
    setInterval(() => {
      tick += 1;
      document.getElementById('ticker').textContent = 'Ticker tick ' + tick;
    }, 250);
    // Simulate a framework re-render: replace the whole list with freshly
    // created nodes carrying identical content every 600ms.
    setInterval(() => {
      const old = document.getElementById('catalog');
      const fresh = document.createElement('ul');
      fresh.id = 'catalog';
      fresh.style.cssText = old.style.cssText;
      fresh.innerHTML = old.innerHTML;
      // Strip any observer-assigned identity so the new nodes are truly new.
      fresh.querySelectorAll('[data-splice-id]').forEach(el => el.removeAttribute('data-splice-id'));
      old.replaceWith(fresh);
    }, 600);
  </script>`);
}

/** Stacked overlays: a modal above a cookie banner, both in front of the primary action. */
function obstructionStackPage(): string {
  return pageShell('Fixture: Overlay Stack', `
  <main>
    <h1>Dashboard gateway</h1>
    <p>The continue button is blocked by a newsletter modal and a cookie banner.</p>
    <button id="continue" type="button">Continue to dashboard</button>
    <div id="gateway-status" role="status"></div>
  </main>
  <div id="cookie-banner" style="position:fixed;left:0;right:0;bottom:0;background:#101820;color:white;padding:16px;display:flex;gap:12px;align-items:center;z-index:30">
    <span>We use cookies to improve the experience.</span>
    <button id="cookie-accept" type="button">Accept all</button>
    <button id="cookie-reject" type="button">Reject non-essential</button>
  </div>
  <div id="newsletter" role="dialog" aria-modal="true" aria-label="Join our newsletter" style="position:fixed;inset:0;display:grid;place-items:center;background:rgba(16,24,32,.55);z-index:40">
    <div style="width:min(420px,calc(100vw - 32px));border-radius:8px;background:white;padding:24px">
      <h2>Join our newsletter</h2>
      <p>This modal intentionally blocks the primary action.</p>
      <button aria-label="Close newsletter modal">Close</button>
    </div>
  </div>
  <script>
    document.querySelector('#newsletter button').addEventListener('click', () => document.getElementById('newsletter').remove());
    document.getElementById('cookie-accept').addEventListener('click', () => document.getElementById('cookie-banner').remove());
    document.getElementById('cookie-reject').addEventListener('click', () => document.getElementById('cookie-banner').remove());
    document.getElementById('continue').addEventListener('click', () => {
      history.pushState({}, '', '/obstruct/dashboard');
      document.title = 'Dashboard';
      document.getElementById('gateway-status').textContent = 'Welcome to the dashboard';
    });
  </script>`);
}

function indexPage(): string {
  return pageShell('Splice Synthetic Fixtures', `
  <main>
    <h1>Splice synthetic fixture pack</h1>
    <ul>
      <li><a href="/menu">Dynamic menu</a></li>
      <li><a href="/form">Form validation</a></li>
      <li><a href="/late">Late content</a> (<a href="/late?stall=1">stalled</a>)</li>
      <li><a href="/rerender">Re-render churn</a></li>
      <li><a href="/obstruct">Overlay stack</a></li>
    </ul>
  </main>`);
}

export interface SyntheticFixtureServer {
  url: string;
  close: () => Promise<void>;
}

/** Serve the synthetic fixture pack on an ephemeral local port. */
export function startSyntheticFixtureServer(): Promise<SyntheticFixtureServer> {
  const server = http.createServer((req, res) => {
    const requestUrl = new URL(req.url || '/', 'http://127.0.0.1');
    const route = requestUrl.pathname;
    let html: string;
    if (route.startsWith('/menu')) html = dynamicMenuPage();
    else if (route.startsWith('/form')) html = formValidationPage();
    else if (route.startsWith('/late')) html = lateContentPage(requestUrl.searchParams.get('stall') === '1');
    else if (route.startsWith('/rerender')) html = rerenderChurnPage();
    else if (route.startsWith('/obstruct')) html = obstructionStackPage();
    else html = indexPage();
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'x-content-type-options': 'nosniff',
    });
    res.end(html);
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Could not bind synthetic fixture server.');
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}
