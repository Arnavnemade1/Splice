// Splice site — minimal interactivity: copy buttons only.

function legacyCopy(text) {
  const scratch = document.createElement('textarea');
  scratch.value = text;
  scratch.setAttribute('readonly', '');
  scratch.style.cssText = 'position:fixed;top:-1000px;opacity:0';
  document.body.appendChild(scratch);
  scratch.select();
  let copied = false;
  try { copied = document.execCommand('copy'); } catch { copied = false; }
  scratch.remove();
  return copied;
}

document.querySelectorAll('[data-copy]').forEach((block) => {
  const button = block.querySelector('.copy-btn');
  const code = block.querySelector('code');
  if (!button || !code) return;

  button.addEventListener('click', async () => {
    const text = code.innerText;
    let copied = false;
    try {
      await navigator.clipboard.writeText(text);
      copied = true;
    } catch {
      copied = legacyCopy(text);
    }

    if (copied) {
      button.textContent = 'Copied';
      button.classList.add('copied');
      setTimeout(() => {
        button.textContent = 'Copy';
        button.classList.remove('copied');
      }, 1600);
    } else {
      // Last resort: select the text so a manual ⌘C works.
      const range = document.createRange();
      range.selectNodeContents(code);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      button.textContent = 'Press ⌘C';
      setTimeout(() => { button.textContent = 'Copy'; }, 2000);
    }
  });
});
