// ==UserScript==
// @name         ニコニコ大百科 軽量化 (nicodic-lite)
// @namespace    local.nicodic-lite
// @version      0.3.0
// @description  表示を変えずに軽くする: 計測系タグの抑止・画像の遅延読み込み・画面外の広告枠の遅延読み込み(サイト標準のlazy機能を有効化)。広告・Xの埋め込み等は残る
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
    lazyAds: true,        // 広告枠を「画面に近づいたら読み込む」にする。広告は消さない(下記参照)
    lazyAdsMargin: '300px', // 画面の何px手前から読み込み始めるか
    debug: false,         // true でブロックしたURLをコンソールに出す
  };
  /* ============================================================== */

  // 目印: DevTools で <html data-nicodic-lite="..."> が付いていればこのスクリプトは動作中
  try { document.documentElement && document.documentElement.setAttribute('data-nicodic-lite', '0.3.0'); } catch (_) {}

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

  /* 2.5 広告枠の遅延読み込み
     ads2.js には Advertisement のオプション forceLazyLoad / lazyLoadViewMargin があり、
     有効にすると広告本体(iframe/img/video)の src が「画面に近づいた時点」で設定される。
     サイト標準の仕組みを有効にするだけで、広告自体は削除・改変しない。
     ads2.js は最後に window.Ads = {...} を代入するので、その代入を捕まえて
     Advertisement をラップする。 */
  if (CFG.lazyAds) {
    const wrap = (ads) => {
      const Orig = ads && ads.Advertisement;
      if (typeof Orig !== 'function' || Orig.__nlWrapped) return ads;
      const Adv = function (opts) {
        if (opts && typeof opts === 'object') {
          if (typeof opts.forceLazyLoad !== 'boolean') opts.forceLazyLoad = true;
          if (typeof opts.lazyLoadViewMargin !== 'string') opts.lazyLoadViewMargin = CFG.lazyAdsMargin;
        }
        return new Orig(opts);
      };
      Adv.prototype = Orig.prototype;
      Object.keys(Orig).forEach((k) => { try { Adv[k] = Orig[k]; } catch (_) {} });
      Adv.__nlWrapped = true;
      ads.Advertisement = Adv;
      return ads;
    };
    try {
      if (window.Ads) {
        wrap(window.Ads);                       // 既に定義済み(注入が遅れた場合の保険)
      } else {
        let cur;
        Object.defineProperty(window, 'Ads', {
          configurable: true, enumerable: true,
          get() { return cur; },
          set(v) {
            cur = wrap(v);
            // 通常のデータプロパティに戻す
            Object.defineProperty(window, 'Ads', { value: cur, writable: true, configurable: true, enumerable: true });
          },
        });
      }
    } catch (e) { if (CFG.debug) console.debug('[nicodic-lite] lazyAds failed', e); }
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
