(function () {
  'use strict';
  if (window.__ytmBridge) { window.__ytmBridge.push(true); return; }
  if (!window.YTMBridge || !window.YTMBridge.onState) return;

  // Remember the page's own Media Session handlers (next / previous) if it sets any later.
  var handlers = {};
  try {
    var ms = navigator.mediaSession;
    if (ms && typeof ms.setActionHandler === 'function') {
      var orig = ms.setActionHandler.bind(ms);
      ms.setActionHandler = function (action, handler) {
        handlers[action] = handler;
        return orig(action, handler);
      };
    }
  } catch (e) {}

  var NEXT = ['ytmusic-player-bar .next-button', '.next-button',
              'button[aria-label="Next"]', 'button[aria-label="Next song"]',
              '[aria-label="Next"]', '[aria-label="Next song"]'];
  var PREV = ['ytmusic-player-bar .previous-button', '.previous-button',
              'button[aria-label="Previous"]', 'button[aria-label="Previous song"]',
              '[aria-label="Previous"]', '[aria-label="Previous song"]'];

  function video() { return document.querySelector('video'); }

  function text(sel) {
    var el = document.querySelector(sel);
    return el ? (el.textContent || '').trim() : '';
  }

  function meta() {
    var t = '', a = '', al = '', art = '';
    try {
      var m = navigator.mediaSession && navigator.mediaSession.metadata;
      if (m) {
        t = m.title || ''; a = m.artist || ''; al = m.album || '';
        var aw = m.artwork || [];
        if (aw.length) art = aw[aw.length - 1].src || '';
      }
    } catch (e) {}
    if (!t) t = text('ytmusic-player-bar .title');
    if (!a) a = text('ytmusic-player-bar .byline').split('\u2022')[0].trim();
    if (!art) {
      var img = document.querySelector('ytmusic-player-bar img');
      if (img) art = img.src || '';
    }
    if (!t) t = (document.title || '').replace(/\s*-\s*YouTube Music$/, '');
    return { title: t, artist: a, album: al, artwork: art };
  }

  var last = null, lastKey = '', lastSent = 0;

  function push(force) {
    var v = video();
    if (!v || !isFinite(v.duration) || v.duration <= 0) return;   // nothing valid loaded yet
    var m = meta();
    var s = {
      title: m.title, artist: m.artist, album: m.album, artwork: m.artwork,
      playing: !v.paused && !v.ended,
      position: Math.round(v.currentTime * 1000),
      duration: Math.round(v.duration * 1000)
    };
    var key = [s.title, s.artist, s.album, s.artwork, s.playing, s.duration].join('|');
    var now = Date.now(), drift = 0;
    if (last) {
      var expected = last.playing ? last.position + (now - lastSent) : last.position;
      drift = Math.abs(s.position - expected);
    }
    if (force || !last || key !== lastKey || drift > 1500) {
      last = s; lastKey = key; lastSent = now;
      window.YTMBridge.onState(JSON.stringify(s));
    }
  }

  var bound = null;
  function bind(v) {
    if (!v || v === bound) return;
    bound = v;
    ['play', 'pause', 'seeked', 'durationchange', 'loadedmetadata', 'ended'].forEach(function (ev) {
      v.addEventListener(ev, function () { push(true); });
    });
  }

  function trigger(action, selectors) {
    var h = handlers[action];
    if (typeof h === 'function') {
      try { h({ action: action }); return; } catch (e) {}
    }
    for (var i = 0; i < selectors.length; i++) {
      var el = document.querySelector(selectors[i]);
      if (el) { el.click(); return; }
    }
  }

  window.__ytmBridge = {
    push: push,
    cmd: function (name, arg) {
      var v = video();
      try {
        switch (name) {
          case 'play':
            if (v) { var p = v.play(); if (p && p.catch) p.catch(function () {}); }
            break;
          case 'pause': if (v) v.pause(); break;
          case 'seek':  if (v) v.currentTime = arg / 1000; break;
          case 'next':  trigger('nexttrack', NEXT); break;
          case 'prev':  trigger('previoustrack', PREV); break;
        }
      } catch (e) {}
      setTimeout(function () { push(true); }, 400);
    }
  };

  setInterval(function () { bind(video()); push(false); }, 1000);
})();
