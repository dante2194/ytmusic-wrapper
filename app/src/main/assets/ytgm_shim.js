// Greasemonkey shim for Android WebView.
// GM_xmlhttpRequest is routed through native code (YTMGm), which avoids CORS and
// YouTube's CSP and only allows the SponsorBlock API hosts.
(function () {
  if (window.__ytmGmShim) return;
  window.__ytmGmShim = true;
  var pending = {}, seq = 0;

  window.__ytmGmDone = function (id, status, text, err) {
    var cb = pending[id];
    if (cb) cb(status, text, err);
  };

  window.GM_xmlhttpRequest = function (d) {
    var id = 'gm' + (++seq) + '_' + Date.now();
    var finished = false, timer = null;

    function finish(fn) {
      if (finished) return;
      finished = true;
      if (timer) clearTimeout(timer);
      delete pending[id];
      try { fn(); } catch (e) {}
    }

    pending[id] = function (status, text, err) {
      finish(function () {
        if (err || !status) {
          if (d.onerror) d.onerror({ error: err || 'network error', status: 0 });
          return;
        }
        if (d.onload) d.onload({
          status: status, statusText: '', responseText: text, response: text,
          finalUrl: d.url, responseHeaders: ''
        });
      });
    };

    if (d.timeout) {
      timer = setTimeout(function () {
        finish(function () { if (d.ontimeout) d.ontimeout({}); });
      }, d.timeout);
    }

    try {
      window.YTMGm.request(id, d.method || 'GET', d.url,
        JSON.stringify(d.headers || {}), d.data == null ? '' : String(d.data));
    } catch (e) {
      finish(function () { if (d.onerror) d.onerror({ error: String(e), status: 0 }); });
    }
    return { abort: function () { finished = true; delete pending[id]; } };
  };

  window.GM_addStyle = function (css) {
    var s = document.createElement('style');
    s.textContent = css;
    (document.head || document.documentElement).appendChild(s);
    return s;
  };
})();
