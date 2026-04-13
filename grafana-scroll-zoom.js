(function () {
  'use strict';

  console.log('[scroll-zoom] loaded');

  var ZOOM_FACTOR = 0.15;
  var DEBOUNCE_MS = 50;
  var MIN_SPAN = 60000;      // 1 minute
  var MAX_SPAN = 31536000000; // 1 year
  var DEFAULT_FROM = 'now-24h';
  var DEFAULT_TO = 'now';

  var debounceTimer = null;
  var pendingFrom = null;
  var pendingTo = null;
  var lastFrom = null; // persists after applyZoom
  var lastTo = null;

  function parseTime(str) {
    if (!str) return null;
    var now = Date.now();
    if (str === 'now') return now;
    var m = str.match(/^now-(\d+)([smhdwMy])$/);
    if (m) {
      var mult = { s: 1e3, m: 6e4, h: 36e5, d: 864e5, w: 6048e5, M: 2592e6, y: 31536e6 };
      return now - parseInt(m[1], 10) * (mult[m[2]] || 864e5);
    }
    var n = Number(str);
    return isNaN(n) ? null : n;
  }

  function getTimeRange() {
    // 1. Mid-debounce pending values
    if (pendingFrom !== null) {
      return { from: pendingFrom, to: pendingTo };
    }

    // 2. URL params
    var params = new URLSearchParams(window.location.search);
    var from = parseTime(params.get('from'));
    var to = parseTime(params.get('to'));
    if (from && to) {
      console.log('[scroll-zoom] time range from URL params');
      return { from: from, to: to };
    }

    // 3. Last applied values (Grafana may have stripped URL params)
    if (lastFrom !== null) {
      console.log('[scroll-zoom] time range from last applied');
      return { from: lastFrom, to: lastTo };
    }

    // 4. Dashboard default
    console.log('[scroll-zoom] time range from dashboard default');
    return { from: parseTime(DEFAULT_FROM), to: parseTime(DEFAULT_TO) };
  }

  function applyZoom() {
    if (pendingFrom === null) return;
    var url = new URL(window.location);
    url.searchParams.set('from', pendingFrom.toString());
    url.searchParams.set('to', pendingTo.toString());
    lastFrom = pendingFrom;
    lastTo = pendingTo;
    console.log('[scroll-zoom] applying zoom: from=' + pendingFrom + ' to=' + pendingTo);
    window.history.pushState({}, '', url.pathname + url.search + url.hash);
    window.dispatchEvent(new PopStateEvent('popstate', { state: {} }));
    pendingFrom = null;
    pendingTo = null;
  }

  // Reset tracked state when user changes time range via Grafana UI
  var observer = new MutationObserver(function () {
    var params = new URLSearchParams(window.location.search);
    var urlFrom = parseTime(params.get('from'));
    var urlTo = parseTime(params.get('to'));
    if (urlFrom && urlTo && lastFrom !== null) {
      if (urlFrom !== lastFrom || urlTo !== lastTo) {
        console.log('[scroll-zoom] time range changed externally, resetting');
        lastFrom = urlFrom;
        lastTo = urlTo;
      }
    }
  });
  observer.observe(document.querySelector('head > title') || document.head, {
    childList: true, subtree: true, characterData: true
  });

  document.addEventListener('wheel', function (e) {
    var uplotEl = e.target.closest('.uplot');
    if (!uplotEl) return;

    e.preventDefault();
    console.log('[scroll-zoom] wheel on uplot, deltaY=' + e.deltaY);

    var range = getTimeRange();
    var from = range.from;
    var to = range.to;

    // Cursor position as fraction of the plot area width
    var plotArea = uplotEl.querySelector('.u-over');
    var cursorFrac = 0.5;
    if (plotArea) {
      var rect = plotArea.getBoundingClientRect();
      cursorFrac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    }

    var span = to - from;
    var zoomDir = e.deltaY > 0 ? 1 : -1; // scroll down = zoom out
    var delta = span * ZOOM_FACTOR * zoomDir;

    var newFrom = Math.round(from - delta * cursorFrac);
    var newTo = Math.round(to + delta * (1 - cursorFrac));

    // Clamp to min/max span
    var newSpan = newTo - newFrom;
    if (newSpan < MIN_SPAN || newSpan > MAX_SPAN) return;

    pendingFrom = newFrom;
    pendingTo = newTo;

    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(applyZoom, DEBOUNCE_MS);
  }, { passive: false });
})();
