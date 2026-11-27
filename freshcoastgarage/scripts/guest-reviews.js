(() => {
  const carousel = document.querySelector('.reviews-card');
  if (!carousel) return;

  const slides = [...carousel.querySelectorAll('.review-slide')];
  const stage = carousel.querySelector('.review-stage');
  const toggle = carousel.querySelector('.review-toggle');
  const count = carousel.querySelector('.review-count');
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let index = 0;
  let paused = reducedMotion.matches;
  let hovering = false;
  let timer;

  function show(next) {
    index = (next + slides.length) % slides.length;
    slides.forEach((slide, position) => {
      const active = position === index;
      slide.classList.toggle('is-active', active);
      slide.setAttribute('aria-hidden', String(!active));
    });
    count.textContent = `${index + 1} / ${slides.length}`;
  }

  function schedule() {
    clearTimeout(timer);
    toggle.textContent = paused ? 'Play rotation' : 'Pause rotation';
    stage.setAttribute('aria-live', paused ? 'polite' : 'off');
    if (paused || hovering || document.hidden) return;
    // Give longer quotes more reading time (about 180 words per minute).
    const words = slides[index].querySelector('blockquote').textContent.trim().split(/\s+/).length;
    timer = setTimeout(() => {
      show(index + 1);
      schedule();
    }, Math.max(8000, words * 340));
  }

  carousel.classList.add('reviews-enhanced');
  carousel.querySelector('.review-controls').hidden = false;
  show(0);
  toggle.addEventListener('click', () => {
    paused = !paused;
    schedule();
  });
  for (const [selector, direction] of [['.review-previous', -1], ['.review-next', 1]]) {
    carousel.querySelector(selector).addEventListener('click', () => {
      paused = true;
      schedule();
      show(index + direction);
    });
  }
  carousel.addEventListener('mouseenter', () => { hovering = true; schedule(); });
  carousel.addEventListener('mouseleave', () => { hovering = false; schedule(); });
  // Keyboard interaction stops autoplay until the guest explicitly starts it.
  carousel.addEventListener('focusin', () => { paused = true; schedule(); });
  document.addEventListener('visibilitychange', schedule);
  reducedMotion.addEventListener('change', () => {
    if (reducedMotion.matches) paused = true;
    schedule();
  });
  schedule();
})();
