/* Cookie consent for lentora.co.uk.
 *
 * Google Analytics is a non-essential cookie under PECR, so it must not run
 * until the visitor actively agrees. Nothing analytics-related loads on first
 * paint — gtag.js is injected only after an explicit Accept, and "Decline" is
 * as easy to click as "Accept", which is the part most banners get wrong.
 *
 * Choice is stored in localStorage under "lentora-consent" = granted | denied.
 * Clearing site data returns the visitor to the unasked state.
 */
(function () {
  var KEY = 'lentora-consent';
  var GA_ID = 'G-5RYDB6HXLK';

  function read() {
    try { return localStorage.getItem(KEY); } catch (e) { return null; }
  }
  function write(v) {
    try { localStorage.setItem(KEY, v); } catch (e) {}
  }

  function loadAnalytics() {
    if (window.__lentoraGaLoaded) return;
    window.__lentoraGaLoaded = true;
    var s = document.createElement('script');
    s.async = true;
    s.src = 'https://www.googletagmanager.com/gtag/js?id=' + GA_ID;
    document.head.appendChild(s);
    window.dataLayer = window.dataLayer || [];
    window.gtag = function () { window.dataLayer.push(arguments); };
    window.gtag('js', new Date());
    window.gtag('config', GA_ID, { anonymize_ip: true });
  }

  function build() {
    var bar = document.createElement('div');
    bar.className = 'ls-consent';
    bar.setAttribute('role', 'dialog');
    bar.setAttribute('aria-label', 'Cookies');
    bar.innerHTML =
      '<p>We use Google Analytics to see which pages people find useful. ' +
      'It sets cookies. Nothing loads unless you agree, and declining ' +
      'changes nothing about how the site works. ' +
      '<a href="/privacy">How we handle data</a>.</p>' +
      '<div class="ls-consent-actions">' +
      '<button type="button" data-consent="denied" class="ls-btn ls-btn-outline">Decline</button>' +
      '<button type="button" data-consent="granted" class="ls-btn ls-btn-primary">Accept</button>' +
      '</div>';

    bar.addEventListener('click', function (ev) {
      var btn = ev.target.closest('button[data-consent]');
      if (!btn) return;
      var choice = btn.dataset.consent;
      write(choice);
      if (choice === 'granted') loadAnalytics();
      bar.classList.add('is-leaving');
      setTimeout(function () { bar.remove(); }, 300);
    });

    document.body.appendChild(bar);
    requestAnimationFrame(function () { bar.classList.add('is-in'); });
    // rAF is throttled in background tabs; make sure it still shows.
    setTimeout(function () { bar.classList.add('is-in'); }, 200);
  }

  var choice = read();
  if (choice === 'granted') { loadAnalytics(); return; }
  if (choice === 'denied') return;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', build);
  } else {
    build();
  }
})();
