(function () {
  'use strict';

  var ZOOM_FACTOR = 0.15;
  var DEBOUNCE_MS = 50;
  var MIN_SPAN = 60000;      // 1 minute
  var MAX_SPAN = 31536000000; // 1 year

  var debounceTimer = null;
  var pendingFrom = null;
  var pendingTo = null;

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

  function applyZoom() {
    if (pendingFrom === null) return;
    var url = new URL(window.location);
    url.searchParams.set('from', pendingFrom.toString());
    url.searchParams.set('to', pendingTo.toString());
    window.history.pushState({}, '', url.pathname + url.search + url.hash);
    window.dispatchEvent(new PopStateEvent('popstate', { state: {} }));
    pendingFrom = null;
    pendingTo = null;
  }

  document.addEventListener('wheel', function (e) {
    if (!e.ctrlKey) return;

    var uplotEl = e.target.closest('.uplot');
    if (!uplotEl) return;

    e.preventDefault();

    // Use pending values if mid-debounce, otherwise read from URL
    var from, to;
    if (pendingFrom !== null) {
      from = pendingFrom;
      to = pendingTo;
    } else {
      var params = new URLSearchParams(window.location.search);
      from = parseTime(params.get('from'));
      to = parseTime(params.get('to'));
    }
    if (!from || !to) return;

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
