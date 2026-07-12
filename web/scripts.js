// ============================================================================
// SCROLL REVEAL
// ============================================================================

const revealElements = document.querySelectorAll('.reveal');

const revealObserver = new IntersectionObserver((entries) => {
  entries.forEach((entry) => {
    if (entry.isIntersecting) {
      entry.target.classList.add('is-visible');
    }
  });
}, {
  threshold: 0.08,
  rootMargin: '0px 0px -40px 0px'
});

revealElements.forEach((el) => revealObserver.observe(el));


// ============================================================================
// NAVBAR SCROLL
// ============================================================================

const nav = document.getElementById('nav');
const hero = document.querySelector('.hero');

function updateNav() {
  if (!nav) return;
  const scrolled = window.scrollY > 40;
  nav.classList.toggle('is-scrolled', scrolled);
}

window.addEventListener('scroll', updateNav, { passive: true });
updateNav();


// ============================================================================
// SMOOTH SCROLL ANCHORS
// ============================================================================

document.querySelectorAll('a[href^="#"]').forEach((link) => {
  link.addEventListener('click', (e) => {
    const href = link.getAttribute('href');
    if (href === '#') return;

    e.preventDefault();
    const target = document.querySelector(href);
    if (target) {
      window.scrollTo({
        top: target.offsetTop - 72,
        behavior: 'smooth'
      });
    }
  });
});


// ============================================================================
// HERO PARALLAX
// ============================================================================

const heroContent = document.querySelector('.hero-content');
const heroVideo = document.querySelector('.hero-video');

if (heroContent && hero) {
  window.addEventListener('scroll', () => {
    const y = window.scrollY;
    const h = hero.offsetHeight;

    if (y < h) {
      const progress = y / h;
      heroContent.style.opacity = String(Math.max(0, 1 - progress * 1.5));
      heroContent.style.transform = `translateY(${y * 0.15}px)`;
    }
  }, { passive: true });
}


// ============================================================================
// VIDEO AUTOPLAY FALLBACK
// ============================================================================

if (heroVideo) {
  heroVideo.play().catch(() => {
    // Autoplay blocked — poster image provides the fallback
  });
}


// ============================================================================
// CODE COPY BUTTONS
// ============================================================================

document.querySelectorAll('.code-body code, .card-code').forEach((block) => {
  const wrapper = document.createElement('div');
  wrapper.style.position = 'relative';
  block.parentNode.insertBefore(wrapper, block);
  wrapper.appendChild(block);

  const btn = document.createElement('button');
  btn.textContent = 'Copy';
  btn.setAttribute('aria-label', 'Copy code to clipboard');
  Object.assign(btn.style, {
    position: 'absolute',
    top: '8px',
    right: '8px',
    background: 'rgba(255, 255, 255, 0.06)',
    border: '1px solid rgba(255, 255, 255, 0.1)',
    color: 'rgba(255, 255, 255, 0.5)',
    padding: '4px 10px',
    borderRadius: '4px',
    fontSize: '0.72rem',
    fontWeight: '500',
    cursor: 'pointer',
    transition: 'all 0.2s ease',
    fontFamily: 'inherit'
  });

  btn.addEventListener('mouseenter', () => {
    btn.style.background = 'rgba(255, 255, 255, 0.1)';
    btn.style.color = 'rgba(255, 255, 255, 0.8)';
  });

  btn.addEventListener('mouseleave', () => {
    btn.style.background = 'rgba(255, 255, 255, 0.06)';
    btn.style.color = 'rgba(255, 255, 255, 0.5)';
  });

  btn.addEventListener('click', () => {
    navigator.clipboard.writeText(block.textContent).then(() => {
      btn.textContent = 'Copied';
      btn.style.color = '#4ade80';
      setTimeout(() => {
        btn.textContent = 'Copy';
        btn.style.color = 'rgba(255, 255, 255, 0.5)';
      }, 1500);
    });
  });

  wrapper.appendChild(btn);
});


// ============================================================================
// KEYBOARD NAVIGATION
// ============================================================================

document.addEventListener('keydown', (e) => {
  if (e.key === 'Tab') {
    document.body.classList.add('keyboard-nav');
  }
});

document.addEventListener('mousedown', () => {
  document.body.classList.remove('keyboard-nav');
});

const focusStyle = document.createElement('style');
focusStyle.textContent = `
  body.keyboard-nav a:focus,
  body.keyboard-nav button:focus {
    outline: 2px solid #4ade80;
    outline-offset: 2px;
    border-radius: 4px;
  }
`;
document.head.appendChild(focusStyle);


// ============================================================================
// RESIZE HANDLER
// ============================================================================

let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(updateNav, 200);
});


// ============================================================================
// PERFORMANCE LOG
// ============================================================================

if (window.performance && window.performance.timing) {
  window.addEventListener('load', () => {
    const t = window.performance.timing;
    const loadTime = t.loadEventEnd - t.navigationStart;
    if (loadTime > 0) {
      console.log(`%c⚡ Splice loaded in ${loadTime}ms`, 'color: #4ade80; font-weight: bold;');
    }
  });
}
