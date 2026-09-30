/*
 * Site analytics: Google Analytics 4, with Consent Mode v2.
 *
 * - In the EEA, the UK and Switzerland, analytics storage is denied by default:
 *   GA receives cookieless pings only, until the visitor chooses "Allow".
 *   Elsewhere it is granted by default. Either way the banner lets a visitor
 *   say no, and "Analytics settings" in the footer reopens it.
 * - No advertising features: ad storage, ad user data and ad personalisation
 *   are denied everywhere, always.
 * - Besides page views (and GA's enhanced measurement: scrolls, outbound
 *   clicks to GitHub/npm), two things are measured: copying an install
 *   command, and Core Web Vitals (LCP, INP, CLS) from real visits.
 */
(function () {
  // The Google tag itself, and the consent defaults, are inline in each page's
  // <head>: Search Console's "Google Analytics" verification looks for the
  // standard snippet in the page source, not for one injected by script.
  var gtag = window.gtag;
  if (typeof gtag !== 'function') return;

  var KEY = 'stratigraph-analytics-consent';
  var NO_ADS = { ad_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied' };
  function consent(state) {
    return Object.assign({ analytics_storage: state }, NO_ADS);
  }

  var stored = null;
  try { stored = localStorage.getItem(KEY); } catch (e) { /* storage blocked: ask each visit */ }

  function remember(state) {
    try { localStorage.setItem(KEY, state); } catch (e) { /* not remembered; asked again next visit */ }
    gtag('consent', 'update', consent(state));
  }

  function banner() {
    if (document.getElementById('consent')) return;
    var el = document.createElement('div');
    el.id = 'consent';
    el.className = 'consent';
    el.setAttribute('role', 'region');
    el.setAttribute('aria-label', 'Analytics consent');
    el.innerHTML =
      '<p>This site uses Google Analytics to count visits and measure page speed. ' +
      'No advertising, no cross-site tracking.</p>' +
      '<div class="consent-actions">' +
      '<button type="button" class="btn btn-ghost" data-choice="denied">No thanks</button>' +
      '<button type="button" class="btn btn-primary" data-choice="granted">Allow</button>' +
      '</div>';
    el.addEventListener('click', function (event) {
      var choice = event.target && event.target.getAttribute('data-choice');
      if (!choice) return;
      remember(choice);
      el.remove();
    });
    document.body.appendChild(el);
  }

  function ready(fn) {
    if (document.readyState !== 'loading') fn();
    else document.addEventListener('DOMContentLoaded', fn);
  }

  ready(function () {
    if (stored !== 'granted' && stored !== 'denied') banner();

    var settings = document.getElementById('analytics-settings');
    var wrap = document.getElementById('analytics-settings-wrap');
    if (settings && wrap) {
      wrap.hidden = false;
      settings.addEventListener('click', banner);
    }

    // The conversion that matters: someone copied an install command.
    document.querySelectorAll('.copy').forEach(function (button) {
      button.addEventListener('click', function () {
        gtag('event', 'copy_install_command', { command: (button.dataset.copy || '').slice(0, 100) });
      });
    });
  });

  // Core Web Vitals from real visitors, reported as GA4 events.
  var vitals = document.createElement('script');
  vitals.async = true;
  vitals.src = 'https://unpkg.com/web-vitals@4.2.4/dist/web-vitals.iife.js';
  vitals.onload = function () {
    if (!window.webVitals) return;
    function send(metric) {
      gtag('event', metric.name, {
        value: Math.round(metric.name === 'CLS' ? metric.value * 1000 : metric.value),
        metric_id: metric.id,
        metric_value: metric.value,
        metric_rating: metric.rating,
        non_interaction: true,
      });
    }
    window.webVitals.onLCP(send);
    window.webVitals.onINP(send);
    window.webVitals.onCLS(send);
  };
  document.head.appendChild(vitals);
})();
