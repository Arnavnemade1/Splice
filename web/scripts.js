// Splice site — nav state, scroll reveal, hover glow, reduced motion, copy buttons.

const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/* Nav: transparent over the hero, solid once scrolled. */
const nav = document.querySelector('.nav');
if (nav) {
  const setNavState = () => nav.classList.toggle('scrolled', window.scrollY > 40);
  setNavState();
  window.addEventListener('scroll', setNavState, { passive: true });
}

/* Hold the aurora video on its first frame when motion is reduced. */
if (reduceMotion) {
  document.querySelectorAll('video').forEach((v) => {
    v.removeAttribute('autoplay');
    v.pause();
  });
}

/* Scroll reveal via IntersectionObserver. */
const revealEls = document.querySelectorAll('[data-reveal]');
if (reduceMotion || !('IntersectionObserver' in window)) {
  revealEls.forEach((el) => el.classList.add('in'));
} else {
  const io = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        entry.target.classList.add('in');
        io.unobserve(entry.target);
      }
    });
  }, { threshold: 0.12, rootMargin: '0px 0px -8% 0px' });
  revealEls.forEach((el) => io.observe(el));
}

/* Let the card glow follow the cursor horizontally. */
if (!reduceMotion) {
  document.querySelectorAll('.card').forEach((card) => {
    card.addEventListener('pointermove', (e) => {
      const r = card.getBoundingClientRect();
      card.style.setProperty('--mx', `${((e.clientX - r.left) / r.width) * 100}%`);
    });
  });
}

/* Copy buttons on code blocks. */
function legacyCopy(text) {
  const scratch = document.createElement('textarea');
  scratch.value = text;
  scratch.setAttribute('readonly', '');
  scratch.style.cssText = 'position:fixed;top:-1000px;opacity:0';
  document.body.appendChild(scratch);
  scratch.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  scratch.remove();
  return ok;
}

document.querySelectorAll('[data-copy]').forEach((block) => {
  const button = block.querySelector('.copy-btn');
  const code = block.querySelector('code');
  if (!button || !code) return;

  button.addEventListener('click', async () => {
    const text = code.innerText;
    let ok = false;
    try {
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch {
      ok = legacyCopy(text);
    }

    if (ok) {
      button.textContent = 'Copied';
      button.classList.add('copied');
      setTimeout(() => { button.textContent = 'Copy'; button.classList.remove('copied'); }, 1600);
    } else {
      const range = document.createRange();
      range.selectNodeContents(code);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      button.textContent = 'Press ⌘C';
      setTimeout(() => { button.textContent = 'Copy'; }, 2000);
    }
  });
});
