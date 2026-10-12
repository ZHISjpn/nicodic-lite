// ==UserScript==
// @name         ニコニコ大百科 軽量化 (nicodic-lite)
// @namespace    local.nicodic-lite
// @version      0.2.0
// @description  表示を変えずに軽くする: 計測系タグ(GTM/GA等)の読み込み抑止と画像の遅延読み込み。広告・Xの埋め込み・おすすめ等はそのまま動く
// @match        https://dic.nicovideo.jp/*
// @run-at       document-start
// @inject-into  page
// @grant        none
// ==/UserScript==

(() => {
  'use strict';

  /* ===================== 設定 (true = 有効) ===================== */
  const CFG = {
    blockTrackers: true,  // 表示に無関係な計測タグ(GTM/GA/Treasure Data等)の読み込みを止める
    lazyImages: true,     // 実URL付きの <img> に loading=lazy を付与 (画面外は後回し)
    debug: false,         // true でブロックしたURLをコンソールに出す
  };
  /* ============================================================== */

  // 広告配信(doubleclick/googlesyndication/adnxs等)、popIn/Logly(おすすめ)、
  // X(Twitter)ウィジェット、ニコニ広告は対象外 = 従来どおり動作する。
  const TRACKER_HOSTS = [
    'googletagmanager.com', 'google-analytics.com', 'analytics.google.com',
    'treasuredata.com', 'apm.yahoo.co.jp', 'static.ads-twitter.com',
  ];
  const hostIs = (h, list) => list.some((d) => h === d || h.endsWith('.' + d));

  const blocked = (u) => {
    if (!CFG.blockTrackers || !u) return false;
    let x;
    try { x = new URL(String(u), location.href); } catch (_) { return false; }
    if (x.protocol !== 'http:' && x.protocol !== 'https:') return false;
    const hit = hostIs(x.hostname.toLowerCase(), TRACKER_HOSTS);
    if (hit && CFG.debug) console.debug('[nicodic-lite] blocked', x.href);
    return hit;
  };

  /* 1. 動的に挿入される script/iframe/img(計測ピクセル含む)の src を横取り */
  const patchSrc = (proto) => {
    const d = Object.getOwnPropertyDescriptor(proto, 'src');
    if (!d || !d.set) return;
    Object.defineProperty(proto, 'src', {
      configurable: true, enumerable: d.enumerable, get: d.get,
      set(v) { if (!blocked(v)) d.set.call(this, v); },
    });
  };
  patchSrc(HTMLScriptElement.prototype);
  patchSrc(HTMLIFrameElement.prototype);
  patchSrc(HTMLImageElement.prototype);

  const origSetAttr = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function (name, value) {
    if (typeof name === 'string' && name.toLowerCase() === 'src' &&
        /^(SCRIPT|IFRAME|IMG)$/i.test(this.tagName) && blocked(value)) return;
    return origSetAttr.call(this, name, value);
  };

  /* 2. fetch / XHR / sendBeacon */
  if (window.fetch) {
    const of = window.fetch;
    window.fetch = function (input) {
      const u = (typeof input === 'string' || input instanceof URL) ? input : input && input.url;
      if (blocked(u)) return Promise.resolve(new Response('', { status: 204 }));
      return of.apply(this, arguments);
    };
  }
  const xo = XMLHttpRequest.prototype.open;
  const xs = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, u) { this.__nlBlocked = blocked(u); return xo.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function () { if (this.__nlBlocked) return; return xs.apply(this, arguments); };
  if (navigator.sendBeacon) {
    const ob = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = (u, d) => (blocked(u) ? true : ob(u, d));
  }

  /* 3. 追加された要素の後始末 + 画像の遅延読み込み */
  const lazy = (img) => {
    if (!CFG.lazyImages || img.hasAttribute('loading')) return;
    const s = img.getAttribute('src');
    if (s && !s.startsWith('data:')) { img.setAttribute('loading', 'lazy'); img.setAttribute('decoding', 'async'); }
  };
  const sweep = (n) => {
    if (n.nodeType !== 1) return;
    const t = n.tagName;
    if ((t === 'SCRIPT' || t === 'IFRAME') && n.src && blocked(n.src)) { n.remove(); return; }
    if (t === 'IMG') { if (n.src && blocked(n.src)) n.remove(); else lazy(n); return; }
    if (n.firstElementChild) {
      n.querySelectorAll('script[src],iframe[src],img[src]').forEach((c) => {
        if (blocked(c.src)) c.remove(); else if (c.tagName === 'IMG') lazy(c);
      });
    }
  };
  new MutationObserver((ms) => { for (const m of ms) m.addedNodes.forEach(sweep); })
    .observe(document, { childList: true, subtree: true });
})();
