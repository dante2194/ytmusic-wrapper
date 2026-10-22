if (!window.__ytmBeautifier) { window.__ytmBeautifier = true;
try {
  if (typeof GM_getValue === 'undefined') {
    window.GM_getValue = function (k, d) {
      try { var v = localStorage.getItem('ytmb_' + k); return v === null ? d : JSON.parse(v); }
      catch (e) { return d; }
    };
    window.GM_setValue = function (k, v) {
      try { localStorage.setItem('ytmb_' + k, JSON.stringify(v)); } catch (e) {}
    };
  }
} catch (e) {}
// ==UserScript==
// @name         YouTube Music Beautifier
// @namespace    http://tampermonkey.net/
// @version      2.3
// @match        https://music.youtube.com/*
// @grant        GM_addStyle
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
// @run-at       document-end
// ==/UserScript==

(function () {
  'use strict';

  // --- Suppress noisy network errors (lightweight) ---
  (function () {
    const noisy = (msg) =>
      typeof msg === 'string' &&
      [
        'XMLHttpRequest cannot load',
        'Fetch API cannot load',
        'Resource blocked by content blocker',
        'due to access control checks',
      ].some((p) => msg.includes(p));
    const ytTelemetry = (msg) =>
      typeof msg === 'string' &&
      [
        'music.youtube.com/api/stats/atr',
        'music.youtube.com/api/stats/qoe',
        'music.youtube.com/youtubei/v1/log_event',
      ].some((p) => msg.includes(p));
    window._ytmBeautifierSuppressed = window._ytmBeautifierSuppressed || [];
    try {
      ['error', 'warn'].forEach((m) => {
        const orig = console[m].bind(console);
        console[m] = (...args) => {
          try {
            const text = args
              .map((a) =>
                typeof a === 'string'
                  ? a
                  : a && a.message
                  ? a.message
                  : JSON.stringify(a)
              )
              .join(' ');
            if (noisy(text) || ytTelemetry(text)) {
              window._ytmBeautifierSuppressed.push({ t: Date.now(), args });
              if (window._ytmBeautifierSuppressed.length > 200)
                window._ytmBeautifierSuppressed.shift();
              return;
            }
          } catch (e) {}
          return orig(...args);
        };
      });
    } catch (e) {}
    const origOnError = window.onerror;
    window.onerror = function (message, ...rest) {
      if (noisy(String(message))) return true;
      return typeof origOnError === 'function'
        ? origOnError.apply(this, [message, ...rest])
        : false;
    };
    window.addEventListener('unhandledrejection', (ev) => {
      try {
        const r = ev?.reason;
        const msg = typeof r === 'string' ? r : r && r.message ? r.message : '';
        if (noisy(String(msg))) {
          ev.preventDefault();
          return;
        }
      } catch (e) {}
    });
  })();

  // --- GM API fallbacks ---
  const gmGet = (k, d) =>
    typeof GM_getValue !== 'undefined'
      ? GM_getValue(k, d)
      : (function () {
          try {
            const raw = localStorage.getItem('ytm_beautifier_' + k);
            return raw != null ? JSON.parse(raw) : d;
          } catch (e) {
            return d;
          }
        })();
  const gmSet = (k, v) =>
    typeof GM_setValue !== 'undefined'
      ? GM_setValue(k, v)
      : localStorage.setItem('ytm_beautifier_' + k, JSON.stringify(v));
  const gmStyle = (css) =>
    typeof GM_addStyle !== 'undefined'
      ? GM_addStyle(css)
      : document.head.appendChild(
          Object.assign(document.createElement('style'), { textContent: css })
        );
  const gmXhr = (details) => {
    if (typeof GM_xmlhttpRequest !== 'undefined')
      return GM_xmlhttpRequest(details);
    fetch(details.url, {
      method: details.method || 'GET',
      headers: details.headers || {},
    })
      .then((r) =>
        r
          .text()
          .then((t) => {
            if (details.onload) details.onload({ responseText: t, status: r.status, ok: r.ok, headers: r.headers });
          })
      )
      .catch((e) => {
        if (details.onerror) details.onerror(e);
      });
  };

  // --- Config & state ---
  const REST_URL = 'https://ytm.nwvbug.com';
  let currentSong = null,
    lyrics = [],
    times = [],
    offsetSec = 0,
    previousOffset = null,
    containerEl = null,
    currentIndex = 0,
    romanizeEnabled = gmGet('romanize_enabled', false) || false,
    fontSize = gmGet('font_size', 14) || 14,
    attachedMedia = null;

  // --- Utilities ---
  // debug flag and helper
  try {
    window._ytm_debug = window._ytm_debug === undefined ? true : window._ytm_debug;
  } catch (e) {}
  const logDebug = (...args) => {
    try {
      if (window._ytm_debug) console.log('[ytm-beautifier-debug]', ...args);
    } catch (e) {}
  };

  const toSec = (s) => {
    if (!s) return 0;
    const [m, sec] = s.split(':').map((x) => parseInt(x, 10));
    return (m || 0) * 60 + (sec || 0);
  };
  const pad = (s) =>
    `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  const txt = (s) =>
    (s || '').replaceAll('&amp;', '&').replaceAll('&nbsp;', ' ');
  const nowPlaying = () => {
    const bar = document.querySelector('ytmusic-player-bar');
    if (!bar) return null;
    const title = txt(
      bar.querySelector('yt-formatted-string.title.ytmusic-player-bar')
        ?.innerHTML || ''
    );
    const thumbnail = bar.querySelector('img.ytmusic-player-bar')?.src || null;
    const byline = Array.from(
      document.querySelectorAll(
        '.byline.style-scope.ytmusic-player-bar.complex-string > *'
      )
    )
      .map((n) => n.innerText)
      .join('');
    const [artist = '', album = '', date = ''] = byline
      .split('•')
      .map((s) => txt(s?.trim()));
    const left = bar.querySelector('.left-controls');
    const timeStr = left
      ?.querySelector('span.time-info.ytmusic-player-bar')
      ?.innerHTML?.trim();
    if (!timeStr) return null;
    const [elapsed, total] = timeStr.split(' / ');
    const playBtn = left?.querySelector('#play-pause-button');
    const isPlaying = playBtn?.getAttribute('aria-label') === 'Pause';
    let largeImage = null;
    try {
      largeImage = document.querySelector('#thumbnail')?.children?.[0]?.src;
    } catch (e) {}
    return {
      title,
      artist,
      album,
      date,
      thumbnail,
      largeImage,
      isPlaying,
      elapsed: toSec(elapsed),
      total: toSec(total),
    };
  };

  // helper to get the first visible media element (video or audio)
  function getVisibleMediaElement() {
    try {
      const all = Array.from(document.querySelectorAll('video,audio'));
      for (let i = 0; i < all.length; i++) {
        const m = all[i];
        if (!m) continue;
        try {
          if (m.duration > 0 && m.offsetParent !== null) return m;
        } catch (e) {}
      }
    } catch (e) {}
    return null;
  }

  // --- Romanization helper ---
  const romanizationLanguages = new Set([
    'ja', 'ru', 'ko', 'zh-CN', 'zh-TW', 'bn', 'th', 'ar', 'ta', 'te', 'ml', 'kn', 'gu', 'pa', 'mr', 'ur', 'si', 'my', 'ka', 'km', 'lo', 'fa',
  ]);

  function detectLangFromText(text) {
    if (!text) return 'und';
    // quick script checks via Unicode ranges
    if (/[\u3040-\u30FF]/.test(text)) return 'ja'; // Hiragana/Katakana
    if (/[-]/.test(text) === false && /[\u4E00-\u9FFF\u3400-\u4DBF\uF900-\uFAFF]/.test(text)) return 'zh-CN'; // Han
    if (/[\uAC00-\uD7AF]/.test(text)) return 'ko'; // Hangul
    if (/[\u0400-\u04FF]/.test(text)) return 'ru'; // Cyrillic
    if (/[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF]/.test(text)) return 'ar'; // Arabic block (covers Persian/Urdu script)
    if (/[\u0E00-\u0E7F]/.test(text)) return 'th'; // Thai
    if (/[\u0900-\u097F]/.test(text)) return 'hi'; // Devanagari
    if (/[\u0980-\u09FF]/.test(text)) return 'bn'; // Bengali
    if (/[\u0A80-\u0AFF]/.test(text)) return 'gu'; // Gujarati
    if (/[\u0A00-\u0A7F]/.test(text)) return 'pa'; // Gurmukhi
    if (/[\u0D80-\u0DFF]/.test(text)) return 'si'; // Sinhala
    if (/[\u1000-\u109F]/.test(text)) return 'my'; // Myanmar
    if (/[\u0C80-\u0CFF]/.test(text)) return 'kn'; // Kannada
    if (/[\u0D00-\u0D7F]/.test(text)) return 'ml'; // Malayalam
    if (/[\u0B80-\u0BFF]/.test(text)) return 'ta'; // Tamil
    if (/[\u0C00-\u0C7F]/.test(text)) return 'te'; // Telugu
    if (/[\u1780-\u17FF]/.test(text)) return 'km'; // Khmer
    if (/[\u0E80-\u0EFF]/.test(text)) return 'lo'; // Lao
    if (/[\u10A0-\u10FF]/.test(text)) return 'ka'; // Georgian
    // fallback: contains any non-ASCII? then und
    if (/[^-]/.test(text)) return 'und';
    return 'en';
  }

  function simpleExtractLatin(str) {
    // extract contiguous Latin (including diacritics) sequences
    const re = /[A-Za-z\u00C0-\u024F\u1E00-\u1EFF'’ː\-]+(?:[\s\u00C0-\u024F\u1E00-\u1EFF'’ː\-]+[A-Za-z\u00C0-\u024F\u1E00-\u1EFF'’ː\-]+)*/g;
    const matches = Array.from(String(str).matchAll(re)).map((m) => m[0].trim());
    return matches.join(' ');
  }

  function romanize(text, source_language = 'auto', options = { skip_if_identical: true }) {
    return new Promise((resolve) => {
      const original = String(text || '');
      const notes = [];
      if (!original || original.trim() === '' || /^[\s♪♫]+$/.test(original)) {
        return resolve({ original_text: original, source_language: source_language || 'auto', romanized_text: null, notes: 'empty or musical symbols' });
      }

      let detected = source_language || 'auto';
      if (!detected || detected === 'auto') {
        detected = detectLangFromText(original) || 'und';
        notes.push(`detected: ${detected}`);
      }

      // decide whether to attempt romanization
      const hasNonLatin = /[^\u0000-\u007f]/.test(original);
      const wantRomanize = romanizationLanguages.has(detected) || hasNonLatin || detected === 'und';
      if (!wantRomanize) {
        return resolve({ original_text: original, source_language: detected, romanized_text: null, notes: 'no non-Latin script detected' });
      }

      // Try Google Translate undocumented endpoint for transliteration
      try {
        const sl = (source_language && source_language !== 'auto') ? source_language : 'auto';
        const tl = (detected && detected !== 'und') ? `${detected}-Latn` : 'auto-Latn';
        const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${encodeURIComponent(sl)}&tl=${encodeURIComponent(tl)}&dt=rm&q=${encodeURIComponent(original)}`;
        gmXhr({ method: 'GET', url, onload: (resp) => {
          try {
            const body = resp?.responseText || '';
            let romanized = null;
            try {
              const j = JSON.parse(body);
              // recursively walk parsed JSON and collect Latin-like strings
              const pieces = [];
              const walker = (v) => {
                if (!v && v !== 0) return;
                if (typeof v === 'string') {
                  const ex = simpleExtractLatin(v);
                  if (ex && ex.length > 1 && ex.toLowerCase() !== 'null') pieces.push(ex);
                  return;
                }
                if (Array.isArray(v)) return v.forEach(walker);
                if (typeof v === 'object') return Object.values(v).forEach(walker);
              };
              walker(j);
              if (pieces.length) {
                // join with space and collapse duplicates/short artifacts
                const uniq = Array.from(new Set(pieces.map((s) => s.trim()))).filter(Boolean);
                // filter out tokens that look like language tags or very short codes (e.g., 'fa', 'en', 'pa-Arab')
                const cleaned = uniq
                  .map((s) => s.replace(/^\s+|\s+$/g, ''))
                  .filter((s) => !/^[a-z]{1,3}(-[A-Za-z0-9]+)?$/i.test(s));
                const joined = cleaned.join(' ');
                const extracted = simpleExtractLatin(joined);
                if (extracted && extracted.length > 0) romanized = extracted;
              }
            } catch (e) {
              // fallback: extract from raw
              const extracted = simpleExtractLatin(body);
              if (extracted && extracted.length > 0) romanized = extracted;
            }

            // normalize spaces; try to map back to lines roughly
            if (romanized) {
              // try to respect original line breaks if possible
              const origLines = original.split(/\r?\n/);
              const romanLines = romanized.split(/\s*\n\s*/).join(' ');
              // simple attempt: if original had multiple lines, split romanized into same count by spaces
              let final = romanized;
              if (origLines.length > 1) {
                // split tokens and distribute
                const tokens = romanized.split(/\s+/).filter(Boolean);
                const per = Math.ceil(tokens.length / origLines.length) || 1;
                const groups = [];
                for (let i = 0; i < origLines.length; i++) groups.push(tokens.slice(i * per, (i + 1) * per).join(' '));
                final = groups.join('\n').trim();
              }

              // optional ascii-only post-processing: strip diacritics / combining marks
              if (options && options.ascii) {
                try {
                  // normalize and remove combining diacritics
                  final = final.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
                  // remove any remaining non-ASCII characters except whitespace and basic punctuation
                  final = final.replace(/[^\x00-\x7F\s'’\-\n]/g, '');
                } catch (e) {
                  // fallback: remove common combining range if normalize isn't available
                  final = final.replace(/[\u0300-\u036f]/g, '');
                }
              }

              // skip_if_identical check (case-insensitive)
              if (options && options.skip_if_identical && final.toLowerCase().trim() === original.toLowerCase().trim()) {
                return resolve({ original_text: original, source_language: detected, romanized_text: null, notes: 'identical to input' });
              }

              // notes: add language-specific hints
              let note = '';
              if (detected.startsWith('zh')) note = 'pinyin with tone marks possible';
              else if (detected === 'ja') note = 'Japanese → romaji';
              else if (detected === 'ru') note = 'Cyrillic → Latin transliteration';
              else if (detected === 'th') note = 'Thai → Latin transliteration';
              else if (detected === 'ar' || detected === 'fa' || detected === 'ur') note = 'Arabic script → Latin transliteration';
              else if (detected === 'ko') note = 'Korean → Latin transliteration (romanization)';

              return resolve({ original_text: original, source_language: detected, romanized_text: final, notes: note });
            }
          } catch (err) {
            // fall through to local fallback
          }
          // fallback: attempt simple extraction from original
          const fallback = simpleExtractLatin(original);
          if (fallback && fallback.length > 0 && !(options && options.skip_if_identical && fallback.toLowerCase() === original.toLowerCase())) {
            return resolve({ original_text: original, source_language: detected, romanized_text: fallback, notes: 'extracted Latin substrings (fallback)' });
          }
          return resolve({ original_text: original, source_language: detected, romanized_text: null, notes: 'romanization not available' });
        }, onerror: () => {
          const fallback = simpleExtractLatin(original);
          if (fallback && fallback.length > 0) return resolve({ original_text: original, source_language: detected, romanized_text: fallback, notes: 'extracted Latin substrings (fallback)' });
          return resolve({ original_text: original, source_language: detected, romanized_text: null, notes: 'request failed' });
        } });
      } catch (e) {
        const fallback = simpleExtractLatin(original);
        if (fallback && fallback.length > 0) return resolve({ original_text: original, source_language: detected, romanized_text: fallback, notes: 'extracted Latin substrings (fallback)' });
        return resolve({ original_text: original, source_language: detected, romanized_text: null, notes: 'error' });
      }
    });
  }

  // --- Translation helper (returns English translation) ---
  function translateToEnglish(text) {
    return new Promise((resolve) => {
      if (!text || !text.trim()) return resolve(null);
      try {
        const q = encodeURIComponent(String(text));
        const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=en&dt=t&q=${q}`;
        gmXhr({ method: 'GET', url, onload: (resp) => {
          try {
            const body = resp?.responseText || '';
            const j = JSON.parse(body);
            if (Array.isArray(j) && Array.isArray(j[0])) {
              const txt = j[0].map((seg) => seg[0]).filter(Boolean).join(' ').trim();
              return resolve(txt || null);
            }
          } catch (e) {}
          return resolve(null);
        }, onerror: () => resolve(null) });
      } catch (e) { return resolve(null); }
    });
  }

  // Shared translation cache and generic translate helper (top-level so buildLyrics can access)
  let __ytm_translation_cache = {};
  async function translate(text, target) {
    if (!text || !text.trim()) return null;
    if (!target || target === 'en') return translateToEnglish(text);
    return new Promise((resolve) => {
      try {
        const q = encodeURIComponent(String(text));
        const tl = encodeURIComponent(String(target));
        const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${tl}&dt=t&q=${q}`;
        gmXhr({ method: 'GET', url, onload: (resp) => {
          try {
            const body = resp?.responseText || '';
            const j = JSON.parse(body);
            if (Array.isArray(j) && Array.isArray(j[0])) {
              const txt = j[0].map((seg) => seg[0]).filter(Boolean).join(' ').trim();
              return resolve(txt || null);
            }
          } catch (e) {}
          return resolve(null);
        }, onerror: () => resolve(null) });
      } catch (e) { resolve(null); }
    });
  }

  // --- Lyrics fetching/parsing ---
  function fetchLyrics(title, artist, album, year, reroll = false) {
    const base = (
      title +
      ' ' +
      artist +
      (reroll ? ' ' + album : '') +
      ' ' +
      year
    )
      .replaceAll('/', '-')
      .replaceAll('%', '%25');
    gmXhr({
      method: 'GET',
      url: `${REST_URL}/request-lyrics/${base}`,
      onload: (r) => parseLyricsResponse(r?.responseText || '' , year),
      onerror: () => {
        lyrics = ['Failed to fetch lyrics'];
        times = [0];
        buildLyrics();
      },
    });
  }
  function parseLyricsResponse(text, songDuration) {
    // coerce songDuration to a number when possible; sometimes callers pass non-numeric (e.g. likes string)
    try {
      const s = Number(songDuration);
      if (!isNaN(s) && s > 0) songDuration = s;
      else {
        const np = nowPlaying();
        if (np && np.total) songDuration = np.total;
      }
    } catch (e) {}
    logDebug('parseLyricsResponse: got response length', text?.length || 0, 'songDuration', songDuration);
    // store last raw response for diagnostics
    try {
      window._ytm_last_lyrics_response = text;
    } catch (e) {}

    if (!text || text.trim() === '' || text === 'no_lyrics_found') {
      lyrics = ['No lyrics available'];
      times = [0];
      return buildLyrics();
    }

    // If the response looks like an HTML error page, report nicely
    if (/<html|<head|<title|doctype html/i.test(text) && /500|error|not found|service unavailable/i.test(text)) {
      lyrics = ['No lyrics available (server error)'];
      times = [0];
      return buildLyrics();
    }

    // If the response looks like an LRC file (timestamps [mm:ss] or [mm:ss.xx]) - handle directly
    if (/^\s*\[\d{1,2}:\d{2}(?:[\.:]\d{1,3})?\]/m.test(text)) {
      return parseLRC(text, songDuration);
    }

    // Try JSON parse and be tolerant to shapes
    try {
      const res = JSON.parse(text);
      logDebug('parseLyricsResponse: parsed JSON root keys', Object.keys(res || {}));
      // Common fields: res.lrc can be string (LRC), object, or array
  if (res.lrc && typeof res.lrc === 'string') return parseLRC(res.lrc, songDuration);
  if (res.lrc && Array.isArray(res.lrc)) return parseYtm(res.lrc, songDuration);
      // sometimes the payload is directly an array
  if (Array.isArray(res)) return parseYtm(res, songDuration);
      // sometimes it's nested: {data:{lines: [...]}}
      const maybe = res.lines || res.data?.lines || res.data?.lrc || res.lyrics || res.result;
  if (Array.isArray(maybe)) return parseYtm(maybe, songDuration);
      // fallback: if res has text properties, try to extract joined text
      if (typeof res === 'object') {
        const collected = [];
        const walker = (v) => {
          if (!v) return;
          if (typeof v === 'string') collected.push(v);
          else if (Array.isArray(v)) v.forEach(walker);
          else if (typeof v === 'object') Object.values(v).forEach(walker);
        };
        walker(res);
  const joined = collected.join('\n');
  if (/^\s*\[\d{1,2}:\d{2}/m.test(joined)) return parseLRC(joined, songDuration);
      }
    } catch (e) {}

    // after parsing we'll normalize times if we have a duration

    // last resort: try to extract Latin or text lines
    const extracted = simpleExtractLatin(text);
    if (extracted && extracted.length > 0) {
      lyrics = extracted.split(/\n+/).map((s) => s.trim()).filter(Boolean);
      if (lyrics.length) {
        times = lyrics.map(() => 0);
        // normalize (no duration available here)
        times = normalizeTimes(times, songDuration);
        return buildLyrics();
      }
    }

    lyrics = ['Lyrics parsing failed'];
    times = [0];
    buildLyrics();
  }
  function parseLRC(txtLrc, songDuration) {
    const lines = String(txtLrc).split(/\r?\n/);
    lyrics = [];
    times = [];
    try { window._ytm_raw_lines = lines.slice(0,200); } catch (e) {}
    // support metadata tags [ti:..] [ar:..] [al:..] etc. ignore them
    const tsRe = /\[(\d{1,2}):(\d{2})(?:[\.:](\d{1,3}))?\]/g;
    lines.forEach((l) => {
      if (!l || !l.trim()) return;
      // ignore metadata
      if (/^\s*\[(ti|ar|al|by|offset)[:]/i.test(l)) return;
      // find all timestamps in the line
      const timesFound = [];
      let m;
      while ((m = tsRe.exec(l)) !== null) {
        const mm = parseInt(m[1] || '0', 10);
        const ss = parseInt(m[2] || '0', 10);
        const ms = parseInt((m[3] || '0').padEnd(3, '0'), 10);
        const total = mm * 60 + ss + ms / 1000;
        timesFound.push(total);
      }
      // strip timestamps from text
      const text = l.replace(tsRe, '').trim();
      if (timesFound.length) {
        timesFound.forEach((t) => {
          times.push(Math.floor(t));
          lyrics.push(text || '♪♪');
        });
      } else if (/^[^\[]+$/.test(l.trim())) {
        // no timestamp but plain text line: append as unlabeled
        times.push(0);
        lyrics.push(l.trim() || '♪♪');
      }
    });
    // normalize times based on song duration if provided
    logDebug('parseLRC: parsed', times.length, 'lines, sample times', times.slice(0,6));
    times = normalizeTimes(times, songDuration);
    logDebug('parseLRC: normalized sample times', times.slice(0,6));
    sanitizeAndBuild();
  }
  // normalize times array using song duration heuristics
  function normalizeTimes(arrTimes, songDuration) {
    try {
      if (!Array.isArray(arrTimes) || arrTimes.length === 0) return arrTimes;
      const timesCopy = arrTimes.slice();
      const maxT = Math.max(...timesCopy);
      const median = (() => {
        const s = timesCopy.slice().sort((a,b) => a-b);
        const mid = Math.floor(s.length/2);
        return s.length % 2 === 1 ? s[mid] : (s[mid-1]+s[mid])/2;
      })();
      // if we have a sensible song duration, use it to decide
      if (songDuration && songDuration > 1) {
        logDebug('normalizeTimes: median', median, 'max', maxT, 'songDuration', songDuration);
        if (median > songDuration * 1.2 || maxT > songDuration * 1.2) {
          logDebug('normalizeTimes: applying ms->s scaling');
          // likely milliseconds -> divide by 1000
          const scaled = timesCopy.map((v) => Math.floor(Number(v)/1000));
          try { window._ytm_parsed_times = scaled; } catch (e) {}
          return scaled;
        }
      }
      // fallback: if times are huge (>100000) treat as ms
      if (maxT > 100000) {
        const scaled = timesCopy.map((v) => Math.floor(Number(v)/1000));
        try { window._ytm_parsed_times = scaled; } catch (e) {}
        return scaled;
      }
      try { window._ytm_parsed_times = timesCopy; } catch (e) {}
      return timesCopy;
    } catch (e) { return arrTimes; }
  }
  function parseYtm(arr, songDuration) {
    try {
      // array of {text,time} or nested shapes
      if (!Array.isArray(arr)) arr = [arr];
      const outLyrics = [];
      const outTimes = [];
      arr.forEach((a) => {
        if (!a) return;
        if (typeof a === 'string') {
          outLyrics.push(a.trim() || '♪♪');
          outTimes.push(0);
          return;
        }
        // common structures: {text:'', time:123} or {lines:[{text:'',time:...}]}
        if (a.text || a.lyric) {
          outLyrics.push((a.text || a.lyric).trim() || '♪♪');
          // time may be in seconds or milliseconds; coerce safely
          let raw = a.time || a.t || 0;
          let num = Number(raw) || 0;
          if (num > 100000) num = Math.round(num / 1000); // likely milliseconds
          outTimes.push(Math.floor(num || 0));
          return;
        }
        if (Array.isArray(a.lines)) {
          a.lines.forEach((ln) => {
            outLyrics.push((ln.text || ln.lyric || '').trim() || '♪♪');
            let raw = ln.time || ln.t || 0;
            let num = Number(raw) || 0;
            if (num > 100000) num = Math.round(num / 1000);
            outTimes.push(Math.floor(num || 0));
          });
          return;
        }
        // nested objects: try to extract string values
        const walkerTexts = [];
        const walker = (v) => {
          if (!v) return;
          if (typeof v === 'string') walkerTexts.push(v);
          else if (Array.isArray(v)) v.forEach(walker);
          else if (typeof v === 'object') Object.values(v).forEach(walker);
        };
        walker(a);
        if (walkerTexts.length) {
          outLyrics.push(walkerTexts.join(' ').trim() || '♪♪');
          // try to extract a numeric time from the object (time, t)
          let rawT = a.time || a.t || 0;
          let nT = Number(rawT) || 0;
          if (nT > 100000) nT = Math.round(nT / 1000);
          outTimes.push(Math.floor(nT || 0));
        }
      });
  try { window._ytm_raw_parsed = arr; } catch (e) {}
  logDebug('parseYtm: extracted', outLyrics.length, 'lines, sample times', outTimes.slice(0,6));
  if (!outLyrics.length) throw new Error('no lyrics parsed');
      lyrics = outLyrics;
      times = outTimes;
      // normalize times using song duration heuristic
      times = normalizeTimes(times, songDuration);
  logDebug('parseYtm: normalized sample times', times.slice(0,6));
      sanitizeAndBuild();
    } catch (e) {
      // fallback: if arr is a string containing lrc
      if (typeof arr === 'string') return parseLRC(arr);
      lyrics = ['Lyrics parsing failed'];
      times = [0];
      buildLyrics();
    }
  }
  function sanitizeAndBuild() {
    if (lyrics.length === 0) {
      lyrics = ['Lyrics parsing failed'];
      times = [0];
    }
    buildLyrics();
  }

  // --- UI styles (minified-ish) ---
  gmStyle(`@import url('https://fonts.googleapis.com/css2?family=Host+Grotesk:ital,wght@0,300..800;1,300..800&display=swap');
#ytm-lyrics-card{position:fixed;top:20px;right:20px;width:350px;max-height:90vh;background:rgba(0,0,0,.85);backdrop-filter:blur(10px);border:1px solid rgba(255,255,255,.08);border-radius:16px;font-family:Host Grotesk,serif;color:#fff;z-index:10000;display:none;flex-direction:column;box-shadow:0 8px 32px rgba(0,0,0,.3);transition:all .3s;resize:both;overflow:auto;min-width:260px;min-height:120px;max-width:calc(100% - 16px);}
#ytm-lyrics-card.active{display:flex}
/* header: allow wrapping and flexible layout so title/artist/stats fit on small screens */
#ytm-lyrics-header{padding:12px 16px;border-bottom:1px solid rgba(255,255,255,.08);display:flex;flex-direction:column;align-items:stretch;cursor:grab;gap:6px;position:relative}
#ytm-lyrics-header > div{min-width:0}
#ytm-song-info{flex:0 0 auto;min-width:0;display:flex;flex-direction:column;width:100%}
#ytm-lyrics-controls{flex:0 0 auto;min-width:0;width:100%;display:flex;gap:8px;align-items:center;flex-wrap:wrap;justify-content:flex-end}
#ytm-song-title{font-size:14px;font-weight:600;white-space:normal;overflow:visible;max-width:100%;word-break:normal;overflow-wrap:break-word;hyphens:auto}
#ytm-song-artist{font-size:12px;opacity:.7;max-width:100%;white-space:normal;overflow:visible}
#ytm-song-stats{font-size:12px;opacity:.9;margin-left:8px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ytm-mini-control{width:auto;height:30px;min-width:28px;border-radius:8px;background:rgba(255,255,255,.08);border:none;color:#fff;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;font-size:13px;padding:0 6px}
#ytm-romanize-btn[aria-pressed="true"]{background:linear-gradient(135deg,#ffd46f,#ffb86b);color:#000}
#ytm-romanize-btn{transition:all .18s}
/* header controls: allow wrapping when space is insufficient */
#ytm-lyrics-controls{display:flex;gap:8px;align-items:center;flex:0 0 auto;flex-wrap:wrap;justify-content:flex-end;width:100%}
#ytm-lyrics-controls > *{flex:0 1 auto;min-width:0}
/* resize row: compact single horizontal row under header */
#ytm-resize-row{display:flex;gap:8px;padding:6px 16px 0 16px;justify-content:flex-end;align-items:center}
#ytm-resize-row .ytm-mini-control{width:30px;height:28px;font-size:12px}
#ytm-lyrics-controls .ytm-mini-control.active,#ytm-romanize-btn.active{background:linear-gradient(135deg,#ffd46f,#ffb86b);color:#000}
#ytm-lyrics-card{--ytm-font-size:14px}
#ytm-header-actions{position:absolute;right:12px;top:12px;display:flex;gap:8px;align-items:center;z-index:10002}
#ytm-header-actions .ytm-mini-control{background:rgba(255,255,255,0.06)}
#ytm-lyrics-card *{box-sizing:border-box}
#ytm-lyrics-content{flex:1;overflow:auto;padding:20px;text-align:center}
.ytm-lyric-line{font-size:var(--ytm-font-size);opacity:.4;margin:12px 0;transition:all .25s;cursor:pointer;padding:8px 12px;border-radius:8px}
.ytm-lyric-line.active{opacity:1;font-weight:600;color:#ff6b6b;transform:scale(1.03);background:rgba(255,107,107,.06)}
.ytm-romanized{display:block;font-size:calc(var(--ytm-font-size) * 0.85);opacity:.75;margin-top:6px;font-style:italic}
.ytm-translated{display:block;font-size:calc(var(--ytm-font-size) * 0.9);opacity:.85;margin-top:6px;color:#9fe0ff}
#ytm-sync-btn{width:28px;height:28px;font-size:12px;margin-left:8px}
.ytm-sync-feedback{display:inline-block;margin-left:8px;color:#8ef0a1;opacity:0;transition:opacity .3s}
#ytm-translate-btn{width:36px;height:28px;font-size:11px;margin-left:6px}
#ytm-launcher{position:fixed;top:100px;right:20px;background:linear-gradient(135deg,#ff6b6b,#ff5252);color:#fff;border:none;border-radius:999px;padding:10px 14px;font-weight:700;cursor:pointer;z-index:99999;display:inline-flex;align-items:center;gap:10px;backdrop-filter:blur(6px);box-shadow:0 8px 30px rgba(0,0,0,.35)}
#ytm-launcher.active{transform:translateY(-1px);box-shadow:0 10px 36px rgba(0,0,0,.45)}
/* Small-screen responsive tweaks */
@media(max-width:768px){
  #ytm-lyrics-card{width:320px;right:10px;top:10px;max-height:70vh}
  #ytm-launcher{top:10px;right:10px;padding:8px 12px}
}
@media(max-width:480px){
  /* make card nearly full-width and move to top-left margin */
  #ytm-lyrics-card{width:calc(100% - 16px);right:8px;left:8px;top:8px;border-radius:12px}
  /* stack header items vertically to avoid truncation */
  #ytm-lyrics-header{flex-direction:column;align-items:flex-start;padding:10px 12px;gap:6px}
  #ytm-lyrics-controls{width:100%;display:flex;flex-wrap:wrap;gap:6px;justify-content:flex-end}
  /* allow title/artist to wrap and show multiple lines */
  #ytm-song-title{white-space:normal;overflow:visible;max-width:100%;font-size:15px}
  #ytm-song-artist{white-space:normal;overflow:visible;max-width:100%;font-size:13px}
  #ytm-song-stats{font-size:12px;margin-top:6px}
  /* reduce control sizes to fit */
  .ytm-mini-control{width:28px;height:28px;font-size:12px;padding:0 5px}
  /* hide some controls when the controls container has the compact class (moved to overflow) */
  #ytm-lyrics-controls.compact #ytm-translate-lang,#ytm-lyrics-controls.compact #ytm-translate-lang-input{display:none}
  #ytm-resize-row{display:none}
  #ytm-romanize-btn{order:0}
}
/* At moderate narrow widths, ensure controls drop below the title instead of squeezing it */
@media(max-width:680px){
  #ytm-lyrics-controls{flex-basis:100%;justify-content:flex-end;flex-wrap:wrap}
}
@media(max-width:360px){
  /* hide less important controls on very small screens */
  #ytm-translate-all, [id^="ytm-tr-"], [id^="ytm-sync-"]{display:none}
  .ytm-mini-control{width:26px;height:26px;font-size:11px}
}
  /* overflow menu styling */
  #ytm-overflow-menu{font-size:13px}
  #ytm-overflow-list > div > *{display:inline-flex;align-items:center;gap:8px}
  #ytm-overflow-list .ytm-mini-control{margin:0;padding:6px 8px;background:rgba(255,255,255,0.04);border-radius:6px}
`);

  // --- v2.3 overrides: tiny launcher + offset row ---
  gmStyle(`#ytm-launcher{top:auto!important;bottom:150px!important;right:6px!important;width:30px!important;height:30px!important;padding:0!important;gap:0!important;justify-content:center!important;border-radius:50%!important;background:rgba(255,82,82,.55)!important;box-shadow:none!important;opacity:.45;transition:opacity .2s!important;backdrop-filter:none!important;font-size:0!important}
#ytm-launcher:active,#ytm-launcher.active{opacity:.95;transform:none!important}
#ytm-offset-row{display:flex;align-items:center;justify-content:center;gap:6px;flex:1 1 100%;width:100%}
#ytm-offset-row #ytm-offset-label{min-width:84px;text-align:center;font-size:12px;opacity:.9;margin:0}
#ytm-offset-row .ytm-offset-btn{width:34px;height:30px;font-size:18px;font-weight:700;line-height:1}
#ytm-offset-row .ytm-offset-reset{width:auto;padding:0 10px;font-size:12px}
#ytm-offset-row .ytm-sync-feedback{margin-left:4px}`);

  // small extra styles for song stats (views / likes)
  gmStyle(`#ytm-song-stats{font-size:12px;opacity:.9;margin-top:6px;color:#dfe7ee;display:flex;align-items:center;gap:8px;flex-wrap:wrap;white-space:normal}
#ytm-song-stats .ytm-stat{margin-right:0;opacity:.9}
#ytm-song-stats a{color:inherit;text-decoration:underline;opacity:.85}
/* allow a larger refresh button that isn't constrained by the default 30px width */
.ytm-mini-control.ytm-refresh{width:auto;min-width:0;padding:4px 8px;font-size:11px}
@media(max-width:480px){
  /* ensure stats wrap nicely on small screens */
  #ytm-song-stats{width:100%;margin-top:6px}
  .ytm-mini-control.ytm-refresh{padding:4px 6px}
}`);

  // --- Build UI ---
  function buildLyricsCard() {
    const old = document.getElementById('ytm-lyrics-card');
    if (old) old.remove();
    const card = document.createElement('div');
    card.id = 'ytm-lyrics-card';
    const header = document.createElement('div');
    header.id = 'ytm-lyrics-header';
    const info = document.createElement('div');
    info.id = 'ytm-song-info';
    info.style.minWidth = 0;
    const t = document.createElement('div');
    t.id = 'ytm-song-title';
    t.textContent = 'No song playing';
    const a = document.createElement('div');
    a.id = 'ytm-song-artist';
    a.textContent = 'YouTube Music';
  // place for views / likes; populated by updateSongStats
  const stats = document.createElement('div');
    stats.id = 'ytm-song-stats';
    stats.textContent = '';
  info.appendChild(t);
  info.appendChild(a);
  info.appendChild(stats);
    
    const ctr = document.createElement('div');
    ctr.id = 'ytm-lyrics-controls';
    // reset offset button (header)
    const resetOffsetBtn = Object.assign(document.createElement('button'), {
      className: 'ytm-mini-control',
      id: 'ytm-reset-offset',
      title: 'Reset subtitle offset for this song',
      textContent: '⤶',
    });
    // current offset label
    const offsetLabel = Object.assign(document.createElement('span'), {
      id: 'ytm-offset-label',
      textContent: '',
      style: 'margin-left:10px;font-size:12px;opacity:0.9',
    });
    // undo offset button
    const undoOffsetBtn = Object.assign(document.createElement('button'), {
      className: 'ytm-mini-control',
      id: 'ytm-undo-offset',
      title: 'Undo last offset change',
      textContent: '↶',
    });
    // Romanize toggle
    const romanBtn = Object.assign(document.createElement('button'), {
      className: 'ytm-mini-control',
      id: 'ytm-romanize-btn',
      title: romanizeEnabled ? 'Romanization: ON' : 'Romanization: OFF',
      textContent: 'Aa',
      'aria-pressed': romanizeEnabled ? 'true' : 'false',
    });
  if (romanizeEnabled) romanBtn.classList.add('active');
  ctr.appendChild(romanBtn);
    // Translate ALL lines button (beside romanize) and target language selector
    const langSelect = Object.assign(document.createElement('select'), {
      className: 'ytm-mini-control',
      id: 'ytm-translate-lang',
      title: 'Translation target language',
    });
    // small compact options: English default + some common languages
    const langs = [
      ['en', 'EN'],
      ['auto', 'Auto'],
      ['hi', 'HI'],
      ['ur', 'UR'],
      ['es', 'ES'],
      ['fr', 'FR'],
      ['de', 'DE'],
      ['ja', 'JA'],
      ['ko', 'KO'],
      ['zh-CN', 'ZH-CN'],
    ];
    langs.forEach(([code, label]) => {
      const op = document.createElement('option');
      op.value = code;
      op.textContent = label;
      langSelect.appendChild(op);
    });
    // restore persisted translate language
    try {
      const savedLang = gmGet('translate_lang', null) || null;
      langSelect.value = savedLang || 'en';
    } catch (e) { langSelect.value = 'en'; }
    langSelect.style.minWidth = '56px';
    langSelect.style.padding = '0 6px';
    langSelect.style.height = '30px';
    langSelect.style.borderRadius = '8px';
    langSelect.style.background = 'rgba(255,255,255,.04)';
    langSelect.style.color = '#fff';
    ctr.appendChild(langSelect);
    // custom language input (freeform) - small textbox
    const langInput = Object.assign(document.createElement('input'), {
      className: 'ytm-mini-control',
      id: 'ytm-translate-lang-input',
      title: 'Type a language code (e.g. pt, hi, ur) and press Enter',
      placeholder: 'code',
      type: 'text',
    });
    langInput.style.width = '56px';
    langInput.style.padding = '4px 6px';
    langInput.style.background = 'rgba(255,255,255,.04)';
    langInput.style.color = '#fff';
    langInput.style.border = 'none';
    langInput.style.borderRadius = '8px';
    langInput.style.fontSize = '12px';
    ctr.appendChild(langInput);
    const translateAllBtn = Object.assign(document.createElement('button'), {
      className: 'ytm-mini-control',
      id: 'ytm-translate-all',
      title: 'Translate all lines to the selected language',
      textContent: 'T→all'
    });
    translateAllBtn.style.marginLeft = '6px';
    ctr.appendChild(translateAllBtn);
    // update per-line translate button labels when language changes
    langSelect.onchange = () => {
      try {
        const target = langSelect.value || 'en';
        try { gmSet('translate_lang', target); } catch (e) {}
        const label = target === 'auto' ? 'Auto' : (target.length > 2 ? target : target.toUpperCase());
        document.querySelectorAll('[id^="ytm-tr-"]').forEach((b) => {
          try { b.textContent = `T→${label}`; b.title = `Translate to ${target}`; } catch (e) {}
        });
        translateAllBtn.title = `Translate all lines to ${target}`;
      } catch (e) {}
    };
    // handle freeform input: add/select on Enter or blur
    const applyLangInput = (val) => {
      try {
        if (!val) return;
        const code = String(val).trim();
        if (!code) return;
        // if option exists, select it; otherwise add it
        let opt = Array.from(langSelect.options).find((o) => o.value === code);
        if (!opt) {
          opt = document.createElement('option');
          opt.value = code;
          opt.textContent = code.length > 2 ? code : code.toUpperCase();
          langSelect.appendChild(opt);
        }
        langSelect.value = code;
        try { gmSet('translate_lang', code); } catch (e) {}
        // trigger onchange to update labels
        langSelect.onchange && langSelect.onchange();
      } catch (e) {}
    };
    langInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        applyLangInput(langInput.value);
        langInput.value = '';
      }
    });
    langInput.addEventListener('blur', () => {
      if (langInput.value && langInput.value.trim()) {
        applyLangInput(langInput.value);
        langInput.value = '';
      }
    });
    // font size controls (order: romanize, increase, decrease)
    const decBtn = Object.assign(document.createElement('button'), {
      className: 'ytm-mini-control',
      id: 'ytm-font-dec',
      title: 'Decrease font size',
      'aria-label': 'Decrease font size',
      textContent: 'A˅',
    });
    const incBtn = Object.assign(document.createElement('button'), {
      className: 'ytm-mini-control',
      id: 'ytm-font-inc',
      title: 'Increase font size',
      'aria-label': 'Increase font size',
      textContent: 'A˄',
    });
    // append in desired visual order: romanize (already appended), increase, decrease
    ctr.appendChild(incBtn);
    ctr.appendChild(decBtn);
    const minB = Object.assign(document.createElement('button'), {
      className: 'ytm-mini-control',
      id: 'ytm-minimize-btn',
      title: 'Minimize',
      textContent: '−',
    });
    const closeB = Object.assign(document.createElement('button'), {
      className: 'ytm-mini-control',
      id: 'ytm-close-btn',
      title: 'Close',
      textContent: '×',
    });
    // create a header-top actions container and place minimize/close there (top-right)
    const headerActions = document.createElement('div');
    headerActions.id = 'ytm-header-actions';
    headerActions.style.cssText = 'position:absolute;right:12px;top:12px;display:flex;gap:8px;align-items:center;z-index:10002';
    header.appendChild(headerActions);
    headerActions.appendChild(minB);
    headerActions.appendChild(closeB);
  // append reset offset to controls (right aligned)
    // dedicated offset row:  [ − ]  offset: +0s  [ + ]  [ reset ]
    const OFFSET_STEP = 0.5;
    const offsetRow = document.createElement('div');
    offsetRow.id = 'ytm-offset-row';
    const offMinus = Object.assign(document.createElement('button'), {
      className: 'ytm-mini-control ytm-offset-btn',
      id: 'ytm-offset-minus',
      title: 'Lyrics earlier (-' + OFFSET_STEP + 's)',
      textContent: '\u2212',
    });
    const offPlus = Object.assign(document.createElement('button'), {
      className: 'ytm-mini-control ytm-offset-btn',
      id: 'ytm-offset-plus',
      title: 'Lyrics later (+' + OFFSET_STEP + 's)',
      textContent: '+',
    });
    resetOffsetBtn.textContent = 'Reset';
    resetOffsetBtn.className = 'ytm-mini-control ytm-offset-reset';
    resetOffsetBtn.title = 'Reset lyrics offset to 0';
    offsetLabel.removeAttribute('style');
    const bumpOffset = (delta) => {
      try {
        offsetSec = Math.round(((offsetSec || 0) + delta) * 10) / 10;
        updateOffsetLabel();
        const sec = (currentSong && currentSong.elapsed ? currentSong.elapsed : 0);
        try { updateLyricsDisplay(sec - offsetSec); } catch (e) {}
      } catch (e) {}
    };
    offMinus.onclick = (ev) => { ev.stopPropagation(); bumpOffset(-OFFSET_STEP); };
    offPlus.onclick = (ev) => { ev.stopPropagation(); bumpOffset(OFFSET_STEP); };
    offsetRow.appendChild(offMinus);
    offsetRow.appendChild(offsetLabel);
    offsetRow.appendChild(offPlus);
    offsetRow.appendChild(resetOffsetBtn);
    ctr.appendChild(offsetRow);
    // overflow / hamburger menu for small screens
    const overflowBtn = Object.assign(document.createElement('button'), {
      className: 'ytm-mini-control',
      id: 'ytm-overflow-btn',
      title: 'More',
      textContent: '☰',
      'aria-expanded': 'false',
    });
    overflowBtn.style.marginLeft = '6px';
    // popup container (hidden by default)
    const overflowMenu = Object.assign(document.createElement('div'), {
      id: 'ytm-overflow-menu',
      style: 'position:absolute;right:12px;top:48px;background:rgba(10,10,10,0.95);border:1px solid rgba(255,255,255,0.06);border-radius:8px;padding:8px;display:none;z-index:10001;min-width:160px;box-shadow:0 8px 24px rgba(0,0,0,0.6)'
    });
    // build a placeholder list inside the menu where we will move optional controls
    const overflowList = document.createElement('div');
    overflowList.id = 'ytm-overflow-list';
    overflowMenu.appendChild(overflowList);
    // append overflow button to header controls (it will be shown only when needed)
    ctr.appendChild(overflowBtn);
    header.appendChild(overflowMenu);
  // resize buttons (inline with other header controls)
  const rwDec = Object.assign(document.createElement('button'), { className: 'ytm-mini-control', title: 'Decrease width (inverted)', textContent: '←' });
  const rwInc = Object.assign(document.createElement('button'), { className: 'ytm-mini-control', title: 'Increase width (inverted)', textContent: '→' });
  const rhDec = Object.assign(document.createElement('button'), { className: 'ytm-mini-control', title: 'Decrease height', textContent: '↑' });
  const rhInc = Object.assign(document.createElement('button'), { className: 'ytm-mini-control', title: 'Increase height', textContent: '↓' });
  const rReset = Object.assign(document.createElement('button'), { className: 'ytm-mini-control', title: 'Reset size', textContent: '⤢' });
    // romanize toggle handler
    romanBtn.onclick = () => {
      romanizeEnabled = !romanizeEnabled;
      romanBtn.setAttribute('aria-pressed', romanizeEnabled ? 'true' : 'false');
      if (romanizeEnabled) romanBtn.classList.add('active'); else romanBtn.classList.remove('active');
      romanBtn.title = romanizeEnabled ? 'Romanization: ON' : 'Romanization: OFF';
      gmSet('romanize_enabled', romanizeEnabled);
      // rebuild lines to show/hide romanized text
      buildLyrics();
    };
    // font size handlers
    const applyFontSize = (size) => {
      // allow larger font sizes (up to 48px)
      fontSize = Math.max(10, Math.min(48, Math.round(size)));
      gmSet('font_size', fontSize);
      try {
        const card = document.getElementById('ytm-lyrics-card');
        if (card) card.style.setProperty('--ytm-font-size', fontSize + 'px');
        // small reposition to ensure card fits
        if (card && card.classList.contains('active')) {
          const rect = document.getElementById('ytm-launcher')?.getBoundingClientRect();
          if (rect) {
            const computedRight = Math.max(8, Math.round(window.innerWidth - rect.right));
            const computedTop = rect.top > window.innerHeight / 2 ? 8 : Math.round(rect.bottom + 8);
            card.style.right = computedRight + 'px';
            card.style.top = Math.min(Math.max(8, computedTop), Math.max(8, window.innerHeight - (card.offsetHeight || 300) - 10)) + 'px';
          }
        }
      } catch (e) {}
    };
    decBtn.onclick = () => applyFontSize(fontSize - 1);
    incBtn.onclick = () => applyFontSize(fontSize + 1);
    // manual resize helper
    const applyManualResize = (dw = 0, dh = 0) => {
      try {
        const card = document.getElementById('ytm-lyrics-card');
        if (!card) return;
        const rect = card.getBoundingClientRect();
        const curW = rect.width;
        const curH = rect.height;
        const minW = 260;
        const minH = 120;
        const maxW = Math.max(300, window.innerWidth - 16);
        const maxH = Math.max(200, window.innerHeight - 16);
        const nw = Math.max(minW, Math.min(maxW, Math.round(curW + dw)));
        const nh = Math.max(minH, Math.min(maxH, Math.round(curH + dh)));
        card.style.width = nw + 'px';
        card.style.height = nh + 'px';
        try { gmSet('card_size', { w: nw, h: nh }); } catch (e) {}
      } catch (e) {}
    };
  // resize button handlers (adjust by pixels)
  // invert width button roles: left arrow increases, right arrow decreases
  rwDec.onclick = () => applyManualResize(40, 0);
  rwInc.onclick = () => applyManualResize(-40, 0);
    rhDec.onclick = () => applyManualResize(0, -30);
    rhInc.onclick = () => applyManualResize(0, 30);
    rReset.onclick = () => {
      try {
        const card = document.getElementById('ytm-lyrics-card');
        if (!card) return;
        card.style.width = '';
        card.style.height = '';
        gmSet('card_size', { w: null, h: null });
      } catch (e) {}
    };
    // reset offset handler
    resetOffsetBtn.onclick = () => {
      try {
  // store previous in-memory before clearing
  previousOffset = previousOffset ?? offsetSec;
  offsetSec = 0;
        updateOffsetLabel();
        // quick visual toast in header
        const fb = document.createElement('span');
        fb.className = 'ytm-sync-feedback';
        fb.textContent = 'offset reset';
        offsetRow.appendChild(fb);
        requestAnimationFrame(() => (fb.style.opacity = '1'));
        setTimeout(() => (fb.style.opacity = '0'), 1200);
        setTimeout(() => fb.remove(), 1600);
      } catch (e) {}
    };

    // undo handler
    undoOffsetBtn.onclick = () => {
      try {
        if (!currentSong) return;
        const id = (currentSong.title || '') + (currentSong.artist || '') + (currentSong.album || '');
        if (previousOffset === null) return;
  const curPrev = previousOffset;
  // consume previousOffset and clear it (in-memory only)
  previousOffset = null;
  offsetSec = curPrev;
        updateOffsetLabel();
        // feedback
        const fb = document.createElement('span');
        fb.className = 'ytm-sync-feedback';
        fb.textContent = `undo ${offsetSec >= 0 ? '+' : ''}${offsetSec}s`;
        ctr.appendChild(fb);
        requestAnimationFrame(() => (fb.style.opacity = '1'));
        setTimeout(() => (fb.style.opacity = '0'), 1200);
        setTimeout(() => fb.remove(), 1600);
      } catch (e) {}
    };
    // use top-level __ytm_translation_cache and translate()

    // translate-all handler (throttled, uses selected language)
    translateAllBtn.onclick = async () => {
      try {
        const content = document.getElementById('ytm-lyrics-content');
        if (!content) return;
        // gather lines
        const lines = Array.from(document.querySelectorAll('.ytm-lyric-line'));
        if (!lines.length) return;
        // disable button briefly
        translateAllBtn.disabled = true;
        const delay = (ms) => new Promise((r) => setTimeout(r, ms));
        const target = (document.getElementById('ytm-translate-lang')?.value) || 'en';
        for (let i = 0; i < lines.length; i++) {
          try {
            const l = lines[i];
            const idx = Number((l.id || '').replace('ytm-lyric-', ''));
            const text = (l.querySelector('span')?.textContent || '').trim();
            const outEl = document.getElementById(`ytm-trans-${idx}`);
            if (!outEl) continue;
            // show pending
            outEl.textContent = '…';
            // check cache
            const cacheKey = target + '|' + text;
            if (cacheKey in __ytm_translation_cache) {
              outEl.textContent = __ytm_translation_cache[cacheKey] || '';
              continue;
            }
            // call translator and throttle a bit to avoid hammering
            // eslint-disable-next-line no-await-in-loop
            const res = await translate(text, target);
            __ytm_translation_cache[cacheKey] = res || '';
            outEl.textContent = res || '';
            // throttle 180ms between calls
            // eslint-disable-next-line no-await-in-loop
            await delay(180);
          } catch (e) {
            try { const outEl = document.getElementById(`ytm-trans-${i}`); if (outEl) outEl.textContent = ''; } catch (e) {}
          }
        }
        translateAllBtn.disabled = false;
      } catch (e) { try { translateAllBtn.disabled = false; } catch (e) {} }
    };
    // overflow menu toggle
    overflowBtn.onclick = (e) => {
      try {
        e.stopPropagation();
        const open = overflowBtn.getAttribute('aria-expanded') === 'true';
        if (open) {
          overflowMenu.style.display = 'none';
          overflowBtn.setAttribute('aria-expanded', 'false');
        } else {
          // ensure overflow menu is visible and positioned within card bounds
          overflowMenu.style.display = 'block';
          overflowBtn.setAttribute('aria-expanded', 'true');
        }
      } catch (e) {}
    };
    // close overflow on outside click
    document.addEventListener('click', (ev) => {
      try {
        if (!overflowMenu || !overflowBtn) return;
        if (overflowBtn.contains(ev.target) || overflowMenu.contains(ev.target)) return;
        overflowMenu.style.display = 'none';
        overflowBtn.setAttribute('aria-expanded', 'false');
      } catch (e) {}
    });

    // helper to move controls into overflow list
    const moveToOverflow = (el) => {
      try {
        if (!el) return;
        // create a wrapper for the control inside the overflow list
        const wrapper = document.createElement('div');
        wrapper.style.margin = '6px 0';
        // clone node for safe placement (keep original hidden)
        const clone = el.cloneNode(true);
        clone.id = (clone.id || '') + '-overflow';
        wrapper.appendChild(clone);
        overflowList.appendChild(wrapper);
        // hide original in header controls
        el.style.display = 'none';
      } catch (e) {}
    };
    const restoreFromOverflow = () => {
      try {
        // show original controls
        Array.from(overflowList.children).forEach((w) => {
          try {
            const c = w.firstChild;
            if (!c) return;
            const origId = (c.id || '').replace('-overflow', '');
            const orig = document.getElementById(origId);
            if (orig) orig.style.display = '';
          } catch (e) {}
        });
        // clear overflowList
        overflowList.textContent = '';
      } catch (e) {}
    };

    // responsive toggle: when small, move less-critical controls into overflow
    const applyResponsiveOverflow = () => {
      try {
        const w = window.innerWidth;
        // threshold where we want a compact header
        const THRESH = 420;
        const controls = document.getElementById('ytm-lyrics-controls');
        if (!controls) return;
        if (w <= THRESH) {
          // mark compact class and move optional controls
          controls.classList.add('compact');
          // move translate select/input and translate-all into overflow
          moveToOverflow(document.getElementById('ytm-translate-lang'));
          moveToOverflow(document.getElementById('ytm-translate-lang-input'));
          moveToOverflow(document.getElementById('ytm-translate-all'));
          // also move reset/undo offset if very narrow
          // show the overflow button
          overflowBtn.style.display = '';
        } else {
          controls.classList.remove('compact');
          restoreFromOverflow();
          overflowBtn.style.display = 'none';
          overflowMenu.style.display = 'none';
          overflowBtn.setAttribute('aria-expanded', 'false');
        }
      } catch (e) {}
    };
    // run once to apply initial layout and on resize
    try { applyResponsiveOverflow(); } catch (e) {}
    window.addEventListener('resize', () => {
      try { applyResponsiveOverflow(); } catch (e) {}
    });
    // apply initial font size on the card so the variable cascades to romanized spans
  try { card.style.setProperty('--ytm-font-size', fontSize + 'px'); } catch (e) {}
  header.appendChild(info);
  header.appendChild(ctr);
  // build a single compact resize row placed under the header
  const resizeRow = Object.assign(document.createElement('div'), { id: 'ytm-resize-row' });
  // order: width-decrease (← increases due to inversion), width-increase (→ decreases), height-decrease (↑), height-increase (↓), reset
  resizeRow.appendChild(rwDec);
  resizeRow.appendChild(rwInc);
  resizeRow.appendChild(rhDec);
  resizeRow.appendChild(rhInc);
  resizeRow.appendChild(rReset);

    const content = document.createElement('div');
    content.id = 'ytm-lyrics-content';
    content.appendChild(
      Object.assign(document.createElement('div'), {
        className: 'ytm-lyric-line',
        textContent: '🎵 Loading lyrics...',
      })
    );
  card.appendChild(header);
  card.appendChild(resizeRow);
  card.appendChild(content);
    document.body.appendChild(card);
    containerEl = card;
    // restore persisted card size if available
    try {
      const sz = gmGet('card_size', null) || null;
      if (sz && sz.w) {
        // clamp persisted width to viewport so mobile isn't forced wider than screen
        const w = Math.max(260, Math.min(window.innerWidth - 16, Number(sz.w) || 260));
        card.style.width = w + 'px';
      }
      if (sz && sz.h) {
        const h = Math.max(120, Math.min(window.innerHeight - 16, Number(sz.h) || 300));
        card.style.height = h + 'px';
      }
    } catch (e) {}

    // dragging
    let dragging = false,
      ix = 0,
      iy = 0,
      xo = 0,
      yo = 0;
    header.addEventListener('mousedown', (e) => {
      ix = e.clientX - xo;
      iy = e.clientY - yo;
      if (e.target === header || e.target.closest('#ytm-song-title'))
        dragging = true;
    });
    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      e.preventDefault();
      const cx = e.clientX - ix,
        cy = e.clientY - iy;
      xo = cx;
      yo = cy;
      card.style.transform = `translate3d(${cx}px, ${cy}px,0)`;
    });
    document.addEventListener('mouseup', () => (dragging = false));

    closeB.onclick = hide;
    minB.onclick = () => {
      const c = document.getElementById('ytm-lyrics-content');
      if (!c) return;
      if (c.style.display === 'none') {
        c.style.display = 'block';
        minB.textContent = '−';
        minB.title = 'Minimize';
      } else {
        c.style.display = 'none';
        minB.textContent = '+';
        minB.title = 'Expand';
      }
    };
    return card;
  }

  // --- Video ID extraction and stats fetching ---
  const __ytm_stats_cache = {};

  function formatNumber(n) {
    try { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ','); } catch (e) { return n; }
  }

  function getVideoIdFromPage() {
    try {
      // try canonical link
      const can = document.querySelector('link[rel="canonical"]')?.href || '';
      let m = can && can.match(/[?&]v=([^&]+)/);
      if (m && m[1]) return m[1];
      // try location
      m = window.location.href.match(/[?&]v=([^&]+)/);
      if (m && m[1]) return m[1];
      // find any anchor with a watch link
      const a = Array.from(document.querySelectorAll('a[href*="/watch?v="]')).find(Boolean);
      if (a) {
        m = a.href.match(/[?&]v=([^&]+)/);
        if (m && m[1]) return m[1];
      }
      // sometimes music.youtube contains data-watch-id attributes on thumbnails
      const thumb = document.querySelector('[data-watch-id]') || document.querySelector('[data-video-id]');
      if (thumb) return thumb.getAttribute('data-watch-id') || thumb.getAttribute('data-video-id') || null;
    } catch (e) {}
    return null;
  }

  function fetchYouTubeCounts(videoId) {
    return new Promise((resolve) => {
      if (!videoId) return resolve(null);
      if (__ytm_stats_cache[videoId]) return resolve(__ytm_stats_cache[videoId]);
      try {
        const url = 'https://www.youtube.com/youtubei/v1/player';
        const body = JSON.stringify({
          videoId: videoId,
          context: { client: { clientName: 'WEB', clientVersion: '2.20231101.00.00' } }
        });
        // helper: parse the player response for views/likes
        const parseCounts = (txt) => {
          try {
            const j = typeof txt === 'string' && txt.length ? JSON.parse(txt) : (txt || {});
            const views = j?.videoDetails?.viewCount || j?.videoDetails?.view_count || null;
            const likes = j?.microformat?.playerMicroformatRenderer?.likeCount || j?.videoDetails?.likes || null;
            if (views == null && likes == null) return null;
            return { views: views ? Number(views) : null, likes: likes ? Number(likes) : null };
          } catch (e) { return null; }
        };

        // Try gmXhr first (if available). If it fails or returns unusable JSON, try the pageFetch once.
        try {
          if (typeof gmXhr === 'function') {
            gmXhr({
              method: 'POST',
              url,
              headers: { 'Content-Type': 'application/json' },
              data: body,
              onload: (resp) => {
                const txt = resp?.responseText || '';
                const parsed = parseCounts(txt);
                if (parsed) {
                  __ytm_stats_cache[videoId] = parsed;
                  return resolve(parsed);
                }
                // fall back to pageFetch
                pageFetch(url, body).then((txt2) => {
                  const p2 = parseCounts(txt2);
                  if (p2) {
                    __ytm_stats_cache[videoId] = p2;
                    return resolve(p2);
                  }
                  return resolve(null);
                }).catch(() => resolve(null));
              },
              onerror: () => {
                pageFetch(url, body).then((txt2) => {
                  const p2 = parseCounts(txt2);
                  if (p2) {
                    __ytm_stats_cache[videoId] = p2;
                    return resolve(p2);
                  }
                  return resolve(null);
                }).catch(() => resolve(null));
              },
            });
            return;
          }
        } catch (e) {}

        // last attempt: try pageFetch directly
        pageFetch(url, body).then((txt) => {
          const parsed = parseCounts(txt);
          if (parsed) {
            __ytm_stats_cache[videoId] = parsed;
            return resolve(parsed);
          }
          return resolve(null);
        }).catch(() => resolve(null));
      } catch (e) { return resolve(null); }
    });
  }

  // Inject a small helper into the page that performs same-origin fetches and returns results via postMessage
  function ensurePageFetcherInjected() {
    try {
      if (window.__ytm_beautifier_page_fetcher_installed) return;
      const src = `(() => {
        if (window.__ytm_beautifier_page_fetcher_installed) return;
        window.__ytm_beautifier_page_fetcher_installed = true;
        window.addEventListener('message', async (ev) => {
          try {
            const d = ev.data || {};
            if (!d || d.source !== 'ytm-beautifier-page-fetch') return;
            const { id, url, body } = d;
            try {
              const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body });
              const txt = await res.text();
              window.postMessage({ source: 'ytm-beautifier-page-fetch-response', id, ok: true, text: txt }, '*');
            } catch (err) {
              window.postMessage({ source: 'ytm-beautifier-page-fetch-response', id, ok: false, error: String(err) }, '*');
            }
          } catch (e) {}
        }, false);
      })();`;
      const s = document.createElement('script');
      s.textContent = src;
      (document.head || document.documentElement).appendChild(s);
      s.parentNode && s.parentNode.removeChild(s);
      window.__ytm_beautifier_page_fetcher_installed = true;
    } catch (e) {}
  }

  function pageFetch(url, body) {
    return new Promise((resolve, reject) => {
      try {
        ensurePageFetcherInjected();
        const id = Math.random().toString(36).slice(2);
        const onmsg = (ev) => {
          try {
            const d = ev.data || {};
            if (!d || d.source !== 'ytm-beautifier-page-fetch-response' || d.id !== id) return;
            window.removeEventListener('message', onmsg);
            if (d.ok) return resolve(d.text || '');
            return reject(d.error || 'fetch-failed');
          } catch (e) { try { window.removeEventListener('message', onmsg); } catch (e) {} reject(e); }
        };
        window.addEventListener('message', onmsg, false);
        // send request to page
        window.postMessage({ source: 'ytm-beautifier-page-fetch', id, url, body }, '*');
        // timeout
        setTimeout(() => {
          try { window.removeEventListener('message', onmsg); } catch (e) {}
          reject('timeout');
        }, 6000);
      } catch (e) { reject(e); }
    });
  }

  async function updateSongStats(song) {
    try {
      const statsEl = document.getElementById('ytm-song-stats');
      if (!statsEl) return;
      statsEl.textContent = '';
      // discover video id from a few known places (canonical URL, location, anchors, data attributes)
      let vid = getVideoIdFromPage();
      if (!vid) {
        const anchors = Array.from(document.querySelectorAll('a[href]')).map((a) => a.href).filter(Boolean);
        for (const h of anchors) {
          try {
            const m = h.match(/[?&]v=([^&]+)/);
            if (m && m[1]) { vid = m[1]; break; }
          } catch (e) {}
        }
      }
      if (!vid) {
        // nothing we can do
        statsEl.textContent = '';
        return;
      }
  // fetch counts (best-effort)
  const res = await fetchYouTubeCounts(vid);
      // build safe DOM: counts area, link, id, refresh button, optional hint
      statsEl.textContent = '';
      // counts container (may be empty)
      const countsContainer = document.createElement('span');
      countsContainer.id = 'ytm-stats-counts';
      countsContainer.style.marginRight = '8px';
      if (res) {
        if (res.views != null) {
          const vspan = document.createElement('span');
          vspan.className = 'ytm-stat';
          vspan.textContent = `👁 ${formatNumber(res.views)}`;
          countsContainer.appendChild(vspan);
        }
        if (res.likes != null) {
          const lspan = document.createElement('span');
          lspan.className = 'ytm-stat';
          lspan.style.marginLeft = '8px';
          lspan.textContent = `👍 ${formatNumber(res.likes)}`;
          countsContainer.appendChild(lspan);
        }
      }
      statsEl.appendChild(countsContainer);

      // always include Open on YouTube link

  // NOTE: intentionally not showing video ID to keep header compact

      // refresh button (always present)
      const refreshBtn = document.createElement('button');
  refreshBtn.id = 'ytm-refresh-stats';
  refreshBtn.className = 'ytm-mini-control ytm-refresh';
      refreshBtn.style.marginLeft = '8px';
      refreshBtn.style.padding = '4px 8px';
      refreshBtn.style.fontSize = '11px';
      refreshBtn.textContent = 'Refresh';
      refreshBtn.onclick = () => updateSongStats(song);
      statsEl.appendChild(refreshBtn);

      // optional hint when gmXhr unavailable and counts missing
      if (!res) {
        const hint = (typeof GM_xmlhttpRequest === 'undefined')
          ? ' (enable GM_xmlhttpRequest / cross-domain permission in your userscript manager to fetch counts)'
          : '';
        const hintDiv = document.createElement('div');
        hintDiv.style.fontSize = '11px';
        hintDiv.style.opacity = '.75';
        hintDiv.style.marginTop = '4px';
        hintDiv.textContent = hint;
        statsEl.appendChild(hintDiv);
      }
    } catch (e) {}
  }

  function createLauncher() {
    if (document.getElementById('ytm-launcher')) return;
    const btn = document.createElement('button');
    btn.id = 'ytm-launcher';
    btn.title = 'Show lyrics';
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', '14');
    svg.setAttribute('height', '14');
    svg.setAttribute('viewBox', '0 0 24 24');
    const p1 = document.createElementNS(svg.namespaceURI, 'path');
    p1.setAttribute('d', 'M4 6H20V18H8L4 22V6Z');
    p1.setAttribute('fill', 'white');
    p1.setAttribute('opacity', '0.95');
    const p2 = document.createElementNS(svg.namespaceURI, 'path');
    p2.setAttribute('d', 'M7 9H17');
    p2.setAttribute('stroke', 'rgba(0,0,0,0.12)');
    p2.setAttribute('stroke-width', '1.5');
    p2.setAttribute('stroke-linecap', 'round');
    svg.appendChild(p1);
    svg.appendChild(p2);
    btn.appendChild(svg);
    btn.onclick = () => {
      const card = document.getElementById('ytm-lyrics-card');
      if (card && card.classList.contains('active')) hide();
      else show();
    };
    document.body.appendChild(btn);
    return btn;
  }

  function buildLyrics() {
    const content = document.getElementById('ytm-lyrics-content');
    if (!content) return;
    content.textContent = '';
    for (let i = 0; i < 3; i++)
      content.appendChild(document.createElement('div'));
    lyrics.forEach((l, i) => {
      const d = document.createElement('div');
      d.className = 'ytm-lyric-line';
      d.id = `ytm-lyric-${i}`;
      // line container: text + small sync button
      const span = document.createElement('span');
      span.textContent = l;
      d.appendChild(span);
      const syncBtn = Object.assign(document.createElement('button'), { className: 'ytm-mini-control', id: `ytm-sync-${i}`, title: 'Set this line as current', textContent: '⤴' });
      syncBtn.style.marginLeft = '8px';
      syncBtn.style.minWidth = '30px';
      syncBtn.onclick = (ev) => {
        ev.stopPropagation();
        try {
          const song = currentSong || nowPlaying();
          if (!song) return;
          const id = (song.title || '') + (song.artist || '') + (song.album || '');
          const targetSec = times[i] || 0;
          // we want the clicked subtitle to be displayed now, so offset = currentMediaTime - targetSec
          const { cur: curRaw, curSource } = getPlaybackTime();
          const cur = Math.floor(curRaw || 0);
          const newOffset = cur - targetSec;
          logDebug('syncBtn clicked', { cur, curSource, targetSec, newOffset, previousOffsetBefore: previousOffset, songTitle: song.title });
          // save previous offset in-memory and apply new offset (do not persist)
          try { previousOffset = previousOffset ?? offsetSec; } catch (e) { previousOffset = offsetSec; }
          offsetSec = newOffset;
          updateOffsetLabel();
          // visual feedback next to the button
          const fb = document.createElement('span');
          fb.className = 'ytm-sync-feedback';
          fb.textContent = `offset ${newOffset >= 0 ? '+' : ''}${newOffset}s`;
          syncBtn.parentNode && syncBtn.parentNode.appendChild(fb);
          requestAnimationFrame(() => (fb.style.opacity = '1'));
          setTimeout(() => (fb.style.opacity = '0'), 1200);
          setTimeout(() => fb.remove(), 1600);
          // also update UI highlight immediately
          updateLyricsDisplay((song && song.elapsed ? Math.floor(song.elapsed) : cur) - offsetSec);
        } catch (e) {}
      };
      // translate button (per-line)
  const langLabel = (document.getElementById('ytm-translate-lang')?.value || 'en');
  const trLabel = langLabel === 'auto' ? 'T→Auto' : `T→${(langLabel.length > 2 ? langLabel : langLabel.toUpperCase())}`;
  const trBtn = Object.assign(document.createElement('button'), { className: 'ytm-mini-control', id: `ytm-tr-${i}`, title: `Translate to ${langLabel}`, textContent: trLabel });
      trBtn.style.marginLeft = '6px';
      trBtn.onclick = (ev) => {
        ev.stopPropagation();
        try {
          const el = document.getElementById(`ytm-trans-${i}`);
          if (!el) return;
          el.textContent = '…';
          const target = (document.getElementById('ytm-translate-lang')?.value) || 'en';
          const cacheKey = target + '|' + l;
          if (cacheKey in __ytm_translation_cache) {
            el.textContent = __ytm_translation_cache[cacheKey] || '';
          } else {
            translate(l, target).then((res) => {
              __ytm_translation_cache[cacheKey] = res || '';
              if (!res) el.textContent = '';
              else el.textContent = res;
            }).catch(() => (el.textContent = ''));
          }
        } catch (e) {}
      };
      d.title = `Click to seek to: ${pad(times[i] || 0)}`;
      d.onclick = () => seekTo(i);
      // if romanization enabled, append a small placeholder span for romanized text
      if (romanizeEnabled) {
        const r = document.createElement('span');
        r.className = 'ytm-romanized';
        r.id = `ytm-roman-${i}`;
        r.textContent = '…';
        d.appendChild(r);
        // request romanization (debounced per-line via setTimeout minimal)
        (function(idx, text) {
          setTimeout(() => {
            romanize(text, 'auto', { skip_if_identical: true }).then((res) => {
              const el = document.getElementById(`ytm-roman-${idx}`);
              if (!el) return;
              el.textContent = res.romanized_text || '';
              if (!res.romanized_text) el.style.display = 'none';
            }).catch(() => {
              const el = document.getElementById(`ytm-roman-${idx}`);
              if (el) el.style.display = 'none';
            });
          }, 60);
        })(i, l);
      }
  // translated text placeholder
  const tspan = document.createElement('span');
  tspan.className = 'ytm-translated';
  tspan.id = `ytm-trans-${i}`;
  tspan.textContent = '';
  d.appendChild(tspan);
      content.appendChild(d);
    });
    for (let i = 0; i < 3; i++)
      content.appendChild(document.createElement('div'));
    currentIndex = 0;
  }

  // --- Seeking helpers (attempts in order) ---
  function seekTo(i) {
    if (times[i] === undefined) return;
    const el = document.getElementById(`ytm-lyric-${i}`);
    if (el) {
      el.classList.add('seeking');
      setTimeout(() => el.classList.remove('seeking'), 500);
    }
    // prefer seeking method based on where we read the current playback time from
    try {
      const { curSource } = getPlaybackTime();
      simulateSeek(times[i], curSource);
    } catch (e) {
      simulateSeek(times[i]);
    }
    currentIndex = i;
    document
      .querySelectorAll('.ytm-lyric-line')
      .forEach((n) => n.classList.remove('active'));
    if (el) {
      el.classList.add('active');
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }

  // determine current playback time and its source (media element, player-bar DOM, or song.elapsed)
  function getPlaybackTime() {
    let cur = 0;
    let curSource = 'none';
    try {
      // 1) try visible media element
  const media = getVisibleMediaElement();
      if (media && !isNaN(media.currentTime)) {
        cur = Math.floor(media.currentTime || 0);
        curSource = 'media';
        return { cur, curSource };
      }
    } catch (e) {}
    try {
      // 2) try parsing the player-bar time DOM directly (more immediate)
      const left = document.querySelector('ytmusic-player-bar .left-controls');
      const timeStr = left?.querySelector('span.time-info.ytmusic-player-bar')?.innerHTML?.trim();
      if (timeStr) {
        const [elapsedStr] = (timeStr.split(' / ') || []);
        const parsed = toSec(elapsedStr || '0:00');
        if (!isNaN(parsed)) {
          cur = Math.floor(parsed || 0);
          curSource = 'player-bar-dom';
          return { cur, curSource };
        }
      }
    } catch (e) {}
    try {
      // 3) fallback to song.elapsed from nowPlaying
      const song = nowPlaying();
      if (song && song.elapsed) {
        cur = Math.floor(song.elapsed || 0);
        curSource = 'song.elapsed';
        return { cur, curSource };
      }
    } catch (e) {}
    return { cur: 0, curSource };
  }

  function simulateSeek(target, preferredSource) {
    const song = nowPlaying();
    if (!song) return;
    const curElapsed = song.elapsed || 0;
    const diff = target - curElapsed;
    if (Math.abs(diff) < 0.8) return;
    // decide attempt order based on preferredSource
    logDebug('simulateSeek: target', target, 'preferredSource', preferredSource, 'diff', diff);
    // Prefer native/media/video/app seeks first (they are generally more precise).
    // Use the progress/slider approach only as a last resort because it can be
    // imprecise due to UI rounding or different coordinate mapping.
    const attempts = ['media', 'video', 'app', 'progress'];
    for (const at of attempts) {
      try {
        logDebug('simulateSeek: trying', at);
        if (at === 'media' && tryMediaSeek(target)) return;
        if (at === 'app' && tryAppAPI(target)) return;
        if (at === 'progress' && tryProgressSeek(target, song.total)) return;
        if (at === 'video' && tryVideoSeek(target)) return;
      } catch (e) {}
    }
    // final fallback: keyboard
    keyboardFallback(diff);
  }

  function tryMediaSeek(target) {
    try {
      const media = getVisibleMediaElement();
      if (!media) return false;
      try {
        // Try a direct set on the media element. Some players/containers may
        // snap the requested time to a previous keyframe/segment which can
        // make the effective seek land a little earlier (commonly ~1-3s).
        // Set it once, then verify shortly after and reapply if necessary.
        media.currentTime = target;
      } catch (e) {}
      ['seeking', 'timeupdate', 'seeked'].forEach((evt) =>
        media.dispatchEvent(new Event(evt))
      );
      // brief verification: if the actual currentTime is still noticeably
      // earlier than requested, try setting it again once (handles keyframe
      // snapping or player-side adjustments)
      try {
        setTimeout(() => {
          try {
            const actual = Math.floor(media.currentTime || 0);
            if (actual < Math.floor(target) - 1) {
              try {
                media.currentTime = target;
              } catch (e) {}
            }
          } catch (e) {}
        }, 180);
      } catch (e) {}
      return true;
    } catch (e) {
      return false;
    }
  }

  function tryAppAPI(target) {
    try {
      const app = document.querySelector('ytmusic-app');
      const cands = [
        app?.playerApi_,
        app?.player_,
        app?.playerApi,
        app?.appContext_?.playerApi,
        window.ytplayer,
        window.yt?.player,
      ];
      for (const api of cands) {
        if (!api) continue;
        if (typeof api.seekTo === 'function') {
          try {
            api.seekTo(target);
            return true;
          } catch (e) {}
        }
        if (typeof api.setCurrentTime === 'function') {
          try {
            api.setCurrentTime(target);
            return true;
          } catch (e) {}
        }
        if (api.player && typeof api.player.seekTo === 'function') {
          try {
            api.player.seekTo(target);
            return true;
          } catch (e) {}
        }
      }
    } catch (e) {}
    return false;
  }

  function tryProgressSeek(target, total) {
    if (!total || total <= 0) return false;
    const pct = Math.max(0, Math.min(1, target / total));
    const tried = [];
    // helper to attempt manipulating a slider-like element
    const attemptOnEl = (el) => {
      if (!el) return false;
      tried.push(el);
      try {
        logDebug('tryProgressSeek: attempting on element', el);
        const v = pct * 100;
        // set common properties
        if (el.value !== undefined) {
          el.value = v;
          el.setAttribute && el.setAttribute('value', String(v));
          el.dispatchEvent && el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent && el.dispatchEvent(new Event('change', { bubbles: true }));
          if (el.value == v) return true;
        }
        if (typeof el._setValue === 'function') {
          el._setValue(v);
          return true;
        }
        if (el.immediateValue !== undefined) {
          el.immediateValue = v;
          el.value = v;
          el.dispatchEvent && el.dispatchEvent(new Event('input', { bubbles: true }));
          return true;
        }
        // aria updates
        try { el.setAttribute && el.setAttribute('aria-valuenow', String(v)); } catch (e) {}
        // fallback: try click at computed position using elementFromPoint
        try {
          const r = el.getBoundingClientRect();
          const x = Math.round(r.left + r.width * pct);
          const y = Math.round(r.top + Math.max(2, r.height / 2));
          const elAt = document.elementFromPoint(x, y) || el;
          const dispatchPointer = (type) => {
            const ev = new PointerEvent(type, {
              bubbles: true,
              cancelable: true,
              clientX: x,
              clientY: y,
              isPrimary: true,
              pointerId: 1,
            });
            (elAt || el).dispatchEvent(ev);
          };
          ['pointerdown', 'pointermove', 'pointerup', 'click'].forEach((t) => dispatchPointer(t));
          return true;
        } catch (e) {}
      } catch (e) {}
      return false;
    };

    // search DOM and simple shadow roots for slider controls
    const candidates = [];
    // common selectors
    ['#progress-bar', '.progress-bar', 'tp-yt-paper-slider#progress-bar', '.ytmusic-player-bar #progress-bar', '[role="slider"]'].forEach((s) => {
      try { document.querySelectorAll(s).forEach((n) => candidates.push(n)); } catch (e) {}
    });
    // search inside ytmusic-player-bar shadow root if present
    try {
      const bar = document.querySelector('ytmusic-player-bar');
      if (bar && bar.shadowRoot) {
        bar.shadowRoot.querySelectorAll('[role="slider"]').forEach((n) => candidates.push(n));
        bar.shadowRoot.querySelectorAll('tp-yt-paper-slider').forEach((n) => candidates.push(n));
      }
    } catch (e) {}
    // search inside ytmusic-app's shadow root
    try {
      const app = document.querySelector('ytmusic-app');
      if (app && app.shadowRoot) {
        app.shadowRoot.querySelectorAll('[role="slider"]').forEach((n) => candidates.push(n));
        app.shadowRoot.querySelectorAll('tp-yt-paper-slider').forEach((n) => candidates.push(n));
      }
    } catch (e) {}

    // unique candidates
    const uniq = Array.from(new Set(candidates.filter(Boolean)));
    for (const el of uniq) if (attemptOnEl(el)) return true;

    // finally, probe element at expected progress x coordinate on the player bar area
    try {
      const playerBar = document.querySelector('ytmusic-player-bar');
      const rect = playerBar ? playerBar.getBoundingClientRect() : null;
      if (rect) {
        const x = Math.round(rect.left + rect.width * pct);
        const y = Math.round(rect.top + rect.height / 2);
        const elAt = document.elementFromPoint(x, y);
        if (elAt && attemptOnEl(elAt)) return true;
      }
    } catch (e) {}

    // if nothing worked
    logDebug('tryProgressSeek: failed after trying', tried.length, 'elements');
    return false;
  }

  function tryVideoSeek(target) {
    try {
      const videos = document.querySelectorAll('video');
      for (const v of videos) {
        if (v && !isNaN(v.duration) && v.duration > 0) {
          try {
            v.currentTime = target;
            v.dispatchEvent(new Event('timeupdate'));
            v.dispatchEvent(new Event('seeked'));
            return true;
          } catch (e) {}
        }
      }
      // try youtube API fallbacks
      const players = document.querySelectorAll('[data-player-name]');
      for (const p of players)
        if (typeof p.seekTo === 'function') {
          try {
            p.seekTo(target);
            return true;
          } catch (e) {}
        }
      if (window.ytplayer?.seekTo) {
        try {
          window.ytplayer.seekTo(target);
          return true;
        } catch (e) {}
      }
    } catch (e) {}
    return false;
  }

  function keyboardFallback(diff) {
    const interval = 10,
      count = Math.min(10, Math.floor(Math.abs(diff) / interval));
    if (count === 0) return;
    const key = diff > 0 ? 'ArrowRight' : 'ArrowLeft';
    const target =
      document.querySelector('ytmusic-player-bar') || document.body;
    for (let i = 0; i < count; i++)
      setTimeout(
        () =>
          target.dispatchEvent(
            new KeyboardEvent('keydown', {
              key,
              code: key,
              bubbles: true,
              cancelable: true,
            })
          ),
        i * 100
      );
  }

  // --- Lyrics update & media listener attachment ---
  function updateLyricsDisplay(sec) {
    if (!times.length) return;
    const lines = document.querySelectorAll('.ytm-lyric-line');
    let idx = 0;
    for (let i = 0; i < times.length; i++) {
      if (sec >= times[i]) idx = i;
      else break;
    }
    if (idx !== currentIndex) {
      lines.forEach((l) => l.classList.remove('active'));
      if (lines[idx]) {
        lines[idx].classList.add('active');
        lines[idx].scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }
    currentIndex = idx;
  }

  function attachMediaListeners() {
    try {
      const media = getVisibleMediaElement();
      if (media === attachedMedia) return;
      if (attachedMedia)
        try {
          attachedMedia.removeEventListener('timeupdate', onMediaTime);
          attachedMedia.removeEventListener('seeked', onMediaSeek);
        } catch (e) {}
      attachedMedia = media;
      if (!attachedMedia) return;
      attachedMedia.addEventListener('timeupdate', onMediaTime);
      attachedMedia.addEventListener('seeked', onMediaSeek);
    } catch (e) {}
  }
  function onMediaTime(e) {
    try {
      const t = Math.floor(e.target.currentTime || 0);
      updateLyricsDisplay(t - offsetSec);
      if (currentSong) currentSong.elapsed = t;
      updateOffsetLabel();
    } catch (e) {}
  }
  function onMediaSeek(e) {
    try {
      const t = Math.floor(e.target.currentTime || 0);
      currentIndex = 0;
      updateLyricsDisplay(t - offsetSec);
      if (currentSong) currentSong.elapsed = t;
    } catch (e) {}
  }

  function updateOffsetLabel() {
    try {
      const lbl = document.getElementById('ytm-offset-label');
      if (!lbl) return;
      const id = (currentSong.title || '') + (currentSong.artist || '') + (currentSong.album || '');
  const val = Math.round((offsetSec || 0) * 10) / 10;
      lbl.textContent = `offset: ${val >= 0 ? '+' : ''}${val}s`;
    } catch (e) {}
  }

  // --- UI show/hide/update ---
  function show() {
    if (!containerEl) buildLyricsCard();
    const launcher = document.getElementById('ytm-launcher');
    if (launcher) {
      launcher.classList.add('active');
      launcher.setAttribute('aria-pressed', 'true');
    }
    if (launcher && containerEl) {
      const rect = launcher.getBoundingClientRect(),
        margin = 8;
      containerEl.classList.add('active');
      containerEl.style.transform = 'none';
      const computedRight = Math.max(
        8,
        Math.round(window.innerWidth - rect.right)
      );
      let computedTop = rect.top > window.innerHeight / 2 ? 8 : Math.round(rect.bottom + margin);
      const cardH = containerEl.offsetHeight || 300,
        maxTop = Math.max(8, window.innerHeight - cardH - 10);
      if (computedTop > maxTop) computedTop = maxTop;
      containerEl.style.top = computedTop + 'px';
      containerEl.style.right = computedRight + 'px';
    } else containerEl && containerEl.classList.add('active');
    const song = nowPlaying();
    if (song) updateUI(song);
  }
  function hide() {
    containerEl && containerEl.classList.remove('active');
    const launcher = document.getElementById('ytm-launcher');
    if (launcher) {
      launcher.classList.remove('active');
      launcher.setAttribute('aria-pressed', 'false');
    }
  }

  function updateUI(song) {
    if (!song) return;
    const titleEl = document.getElementById('ytm-song-title'),
      artistEl = document.getElementById('ytm-song-artist');
    if (titleEl) titleEl.textContent = song.title || 'Unknown Title';
    if (artistEl) artistEl.textContent = song.artist || 'Unknown Artist';
    const adjusted = (song.elapsed || 0) - offsetSec;
    updateLyricsDisplay(adjusted);
    const id = (song.title || '') + (song.artist || '') + (song.album || '');
    if (
      (currentSong?.title || '') +
        (currentSong?.artist || '') +
        (currentSong?.album || '') !==
      id
    ) {
      currentSong = song;
      lyrics = [];
      times = [];
      fetchLyrics(song.title, song.artist, song.album, song.date);
      // update views/likes for the new song (best-effort)
      try { updateSongStats(song); } catch (e) {}
      // clear offsets on new song (do not persist per-song offsets anymore)
      previousOffset = null;
      offsetSec = 0;
      try {
        // clear translation cache if present
        if (typeof __ytm_translation_cache !== 'undefined') {
          for (const k in __ytm_translation_cache) delete __ytm_translation_cache[k];
        }
      } catch (e) {}
      // update label for this song
      updateOffsetLabel();
    }
  }

  // --- Monitor & init ---
  function monitor() {
    const s = nowPlaying();
    if (s && containerEl && containerEl.classList.contains('active'))
      updateUI(s);
    attachMediaListeners();
  }

  function init() {
    createLauncher();
    setInterval(monitor, 2000);
    const bar = document.querySelector('ytmusic-player-bar');
    if (bar) {
      let to;
      new MutationObserver(() => {
        clearTimeout(to);
        to = setTimeout(() => {
          monitor();
        }, 500);
      }).observe(bar, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['aria-label', 'src'],
      });
    }
    attachMediaListeners();
  }

  if (document.readyState === 'loading')
    document.addEventListener('DOMContentLoaded', init);
  else setTimeout(init, 1000);

  // keyboard
  document.addEventListener('keydown', (e) => {
    if (!containerEl || !containerEl.classList.contains('active')) return;
    if (e.key === 'Escape') hide();
    if ((e.key === 'l' || e.key === 'L') && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      show();
    }
  });

  // exposed API for debugging/testing
  window.ytmBeautifier = {
    show,
    hide,
    getNowPlaying: nowPlaying,
    getSongLyrics: fetchLyrics,
    romanize: (text, source_language = 'auto', options = { skip_if_identical: true }) => romanize(text, source_language, options),
    reattachMedia: () => {
      attachMediaListeners();
      console.log('reattachMedia called');
    },
    setDebug: (v) => { try { window._ytm_debug = !!v; console.log('ytm debug set to', !!v); } catch (e) {} },
    debugSeek: (target) => {
      console.log('Target', target);
      [
        '#progress-bar',
        '.progress-bar',
        'tp-yt-paper-slider#progress-bar',
        '.ytmusic-player-bar #progress-bar',
        '[role="slider"]',
      ].forEach((s) => console.log(s, document.querySelector(s)));
      document
        .querySelectorAll('video')
        .forEach((v, i) => console.log(i, v.currentTime, v.duration, v.paused));
      console.log(
        'ytplayer',
        window.ytplayer,
        'ytmusic-app',
        document.querySelector('ytmusic-app')
      );
      console.log('song', nowPlaying());
    },
    testSeek: (t = 60) => {
      console.log('Testing seek to', t);
      const s = nowPlaying();
      if (s) {
        tryProgressSeek(t, s.total);
        setTimeout(() => tryVideoSeek(t), 800);
        setTimeout(() => {
          try {
            document
              .querySelector('tp-yt-paper-slider')
              ?.setAttribute('value', ((t / s.total) * 100).toString());
          } catch (e) {}
        }, 1600);
      }
    },
  };
})();

}
