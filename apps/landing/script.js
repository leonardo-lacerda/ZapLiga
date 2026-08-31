(() => {
  const menuToggle = document.querySelector('#menuToggle');
  const nav = document.querySelector('#mainNav');
  menuToggle?.addEventListener('click', () => {
    const open = nav?.classList.toggle('open') ?? false;
    menuToggle.setAttribute('aria-expanded', String(open));
    menuToggle.setAttribute('aria-label', open ? 'Fechar menu' : 'Abrir menu');
  });
  nav?.querySelectorAll('a').forEach((link) => link.addEventListener('click', () => {
    nav.classList.remove('open');
    menuToggle?.setAttribute('aria-expanded', 'false');
  }));

  document.querySelectorAll('.faq-item button').forEach((button) => button.addEventListener('click', () => {
    const item = button.closest('.faq-item');
    if (!item) return;
    const wasOpen = item.classList.contains('open');
    document.querySelectorAll('.faq-item').forEach((other) => {
      other.classList.remove('open');
      other.querySelector('button')?.setAttribute('aria-expanded', 'false');
    });
    if (!wasOpen) {
      item.classList.add('open');
      button.setAttribute('aria-expanded', 'true');
    }
  }));

  document.querySelectorAll('.demo-form').forEach((form) => form.addEventListener('submit', (event) => {
    event.preventDefault();
    const input = form.querySelector('input');
    if (!input?.value.trim()) return;
    form.innerHTML = '<div class="form-success"><b>✓</b><span><strong>Pedido recebido.</strong><small>Falamos com você em breve.</small></span></div>';
  }));
})();
