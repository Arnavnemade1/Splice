// ============================================================================
// SCROLL ANIMATIONS
// ============================================================================

const observerOptions = {
  threshold: 0.1,
  rootMargin: '0px 0px -50px 0px'
};

const observer = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    if (entry.isIntersecting) {
      entry.target.style.opacity = '1';
      entry.target.style.transform = 'translateY(0)';
    }
  });
}, observerOptions);

// Observe all section headers and cards on scroll
document.querySelectorAll('.capability-card, .workflow-step, .integration-option, .feature, .start-step').forEach(el => {
  el.style.opacity = '0';
  el.style.transform = 'translateY(20px)';
  el.style.transition = 'opacity 0.6s cubic-bezier(0.4, 0, 0.2, 1), transform 0.6s cubic-bezier(0.4, 0, 0.2, 1)';
  observer.observe(el);
});

// ============================================================================
// NAVBAR SCROLL EFFECT
// ============================================================================

const navbar = document.querySelector('.navbar');
let lastScrollY = 0;

window.addEventListener('scroll', () => {
  lastScrollY = window.scrollY;

  if (lastScrollY > 10) {
    navbar.style.borderBottomColor = 'rgba(42, 42, 42, 0.5)';
    navbar.style.background = 'rgba(10, 10, 10, 0.95)';
  } else {
    navbar.style.borderBottomColor = 'rgb(42, 42, 42)';
    navbar.style.background = 'rgba(10, 10, 10, 0.8)';
  }
});

// ============================================================================
// SMOOTH SCROLL LINKS
// ============================================================================

document.querySelectorAll('a[href^="#"]').forEach(link => {
  link.addEventListener('click', (e) => {
    const href = link.getAttribute('href');
    if (href === '#') return;

    e.preventDefault();
    const target = document.querySelector(href);
    if (target) {
      const offsetTop = target.offsetTop - 80;
      window.scrollTo({
        top: offsetTop,
        behavior: 'smooth'
      });
    }
  });
});

// ============================================================================
// INTERACTIVE HOVER EFFECTS
// ============================================================================

// Add hover scale effect to buttons
document.querySelectorAll('.btn').forEach(btn => {
  btn.addEventListener('mouseenter', (e) => {
    btn.style.transform = 'translateY(-2px)';
  });

  btn.addEventListener('mouseleave', (e) => {
    btn.style.transform = 'translateY(0)';
  });
});

// ============================================================================
// CODE SNIPPET COPY FUNCTIONALITY
// ============================================================================

document.querySelectorAll('.code-snippet, .code-inline').forEach(codeBlock => {
  const wrapper = document.createElement('div');
  wrapper.style.position = 'relative';
  wrapper.style.display = 'inline-block';
  wrapper.style.width = '100%';
  codeBlock.parentNode.insertBefore(wrapper, codeBlock);
  wrapper.appendChild(codeBlock);

  const copyBtn = document.createElement('button');
  copyBtn.textContent = 'Copy';
  copyBtn.style.cssText = `
    position: absolute;
    top: 12px;
    right: 12px;
    background: rgba(52, 245, 197, 0.1);
    border: 1px solid rgba(52, 245, 197, 0.3);
    color: rgb(52, 245, 197);
    padding: 6px 12px;
    border-radius: 4px;
    font-size: 0.8rem;
    cursor: pointer;
    transition: all 200ms cubic-bezier(0.4, 0, 0.2, 1);
    font-weight: 500;
  `;

  copyBtn.addEventListener('mouseenter', () => {
    copyBtn.style.background = 'rgba(52, 245, 197, 0.2)';
    copyBtn.style.borderColor = 'rgba(52, 245, 197, 0.5)';
  });

  copyBtn.addEventListener('mouseleave', () => {
    copyBtn.style.background = 'rgba(52, 245, 197, 0.1)';
    copyBtn.style.borderColor = 'rgba(52, 245, 197, 0.3)';
  });

  copyBtn.addEventListener('click', () => {
    const text = codeBlock.textContent;
    navigator.clipboard.writeText(text).then(() => {
      copyBtn.textContent = 'Copied!';
      copyBtn.style.color = 'rgb(52, 245, 197)';
      setTimeout(() => {
        copyBtn.textContent = 'Copy';
      }, 2000);
    });
  });

  wrapper.style.marginBottom = '12px';
  wrapper.appendChild(copyBtn);
});

// ============================================================================
// PARALLAX SCROLL EFFECT
// ============================================================================

const heroContent = document.querySelector('.hero-content');
if (heroContent) {
  window.addEventListener('scroll', () => {
    const scrollY = window.scrollY;
    const heroSection = document.querySelector('.hero');
    const distanceFromTop = heroSection.offsetTop + heroSection.offsetHeight;

    if (scrollY < distanceFromTop) {
      const parallaxValue = scrollY * 0.5;
      heroContent.style.transform = `translateY(${parallaxValue}px)`;
    }
  });
}

// ============================================================================
// STAGGERED ANIMATION ON LOAD
// ============================================================================

const staggerElements = document.querySelectorAll(
  '.nav-link, .hero-title, .hero-subtitle, .hero-cta, .hero-visual'
);

let delay = 0;
staggerElements.forEach((el, index) => {
  const style = window.getComputedStyle(el);
  const animation = style.animation || style.WebkitAnimation || '';

  if (animation.includes('fadeIn')) {
    delay = (index + 1) * 0.1;
  }
});

// ============================================================================
// ENHANCED RESPONSIVE BEHAVIOR
// ============================================================================

// Handle resize events for responsive adjustments
let resizeTimeout;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimeout);
  resizeTimeout = setTimeout(() => {
    // Adjust hero layout if needed
    const heroContent = document.querySelector('.hero-content');
    if (window.innerWidth < 1024 && heroContent) {
      heroContent.style.gridTemplateColumns = '1fr';
    } else if (heroContent) {
      heroContent.style.gridTemplateColumns = '1fr 1fr';
    }
  }, 250);
});

// ============================================================================
// PERFORMANCE MONITORING
// ============================================================================

// Log page performance metrics
if (window.performance && window.performance.timing) {
  window.addEventListener('load', () => {
    const perfData = window.performance.timing;
    const pageLoadTime = perfData.loadEventEnd - perfData.navigationStart;

    if (pageLoadTime > 0) {
      console.log(`%c⚡ Splice loaded in ${pageLoadTime}ms`, 'color: #34f5c5; font-weight: bold;');
    }
  });
}

// ============================================================================
// ACCESSIBILITY ENHANCEMENTS
// ============================================================================

// Add focus visible styles dynamically
document.addEventListener('keydown', (e) => {
  if (e.key === 'Tab') {
    document.body.classList.add('keyboard-nav');
  }
});

document.addEventListener('mousedown', () => {
  document.body.classList.remove('keyboard-nav');
});

// Enhance contrast on focus for keyboard navigation
const style = document.createElement('style');
style.textContent = `
  body.keyboard-nav a:focus,
  body.keyboard-nav button:focus {
    outline: 2px solid #34f5c5;
    outline-offset: 2px;
    border-radius: 4px;
  }
`;
document.head.appendChild(style);
