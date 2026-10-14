/*! Vertly SDK v1 — served at /__vx/sdk/v1.js and injected into every published site.
 *  Source of truth: sdk/v1.js. After editing run `node scripts/build-sdk.mjs` (embeds it into the publisher Worker),
 *  then redeploy the Worker. v1 is additive-only: a breaking change ships as v2.js.
 *
 *    vx.auth.signup(email, password[, metadata]) / login(email, password) / logout() / user() / token() / me() / onChange(fn)
 *    vx.data.submit(collection, data) / list(collection[, {limit, before, mine}]) / update(collection, id, data) / remove(collection, id)
 *    vx.forms.submit(collection, data) / bind(selector, collection[, {onSuccess, onError}])
 *    vx.pay.buy(productId) / buyAmount(cents, name)
 *    vx.track.page([path])
 *    vx.site.navHtml / footerHtml / refresh()   — nav + footer rendered from window.SITE into [data-vx-nav] / [data-vx-footer]
 *    vx.go('page.html')                          — navigate (works in the editor preview too; use instead of location.href)
 *
 *  Declarative hooks (no page JS needed; see docs/PROJECT_FORMAT.md §5):
 *    form[data-vx-form=collection]  form[data-vx-auth=login|signup][data-vx-redirect]  [data-vx-logout]  [data-vx-show=in|out]
 *    [data-vx-user=email|name|…]  [data-vx-buy=productId]  [data-vx-buy-amount=cents][data-vx-name]  [data-vx-paid]
 *    html|body[data-vx-require-auth=page]  html|body[data-vx-skip-if-auth=page]
 *
 *  Every call resolves to the server's JSON ({ success: true, ... } or { error, code }) — it never throws.
 *  The old helpers (vxCall, vxSignup, vxLogin, vxLogout, vxCurrentUser, vxGetToken, vxCheckout, vxBuy, vxBuyAmount)
 *  are kept as aliases. This file only ASSIGNS properties on window, so pages that still declare their own copies of
 *  those helpers (or `const SITE_ID`) do not break.
 */
(function (w) {
  'use strict';
  if (w.vx && w.vx.version) return; // already loaded

  var BASE = 'https://ciuqhxrxcznmgorjeumz.supabase.co/functions/v1/';
  var API = BASE + 'site-api';
  var PAY = BASE + 'stripe-site-checkout';
  var TRACK = BASE + 'track';
  var K_TOKEN = 'vx_token', K_USER = 'vx_user', K_EXP = 'vx_expires';

  var cfg = { site: (w.__VX && w.__VX.site) || '' };

  // ── storage (localStorage can throw in private mode: fall back to memory) ──────────────────────────
  var mem = {};
  function store(k, v) {
    try {
      if (v === undefined) return localStorage.getItem(k);
      if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v);
    } catch (e) {
      if (v === undefined) return mem[k] === undefined ? null : mem[k];
      if (v === null) delete mem[k]; else mem[k] = v;
    }
  }

  // ── events ─────────────────────────────────────────────────────────────────────────────────────────
  var listeners = [];
  function emit() {
    lastGuard = '';
    try { refreshChrome(); } catch (e) { /* chrome must never break auth */ }
    try { guard(); } catch (e) { /* ignore */ }
    var u = auth.user();
    for (var i = 0; i < listeners.length; i++) { try { listeners[i](u); } catch (e) { /* listener bug must not break the SDK */ } }
    try { w.dispatchEvent(new CustomEvent('vx:auth', { detail: u })); } catch (e) { /* old browsers */ }
  }
  w.addEventListener && w.addEventListener('storage', function (ev) {
    if (ev.key === K_TOKEN || ev.key === K_USER) emit(); // sign-in/out in another tab
  });

  function setSession(r) {
    store(K_TOKEN, r.token);
    store(K_USER, JSON.stringify(r.user || null));
    store(K_EXP, r.expires_at || null);
    emit();
  }
  function clearSession() {
    var had = store(K_TOKEN) !== null;
    store(K_TOKEN, null); store(K_USER, null); store(K_EXP, null);
    if (had) emit();
  }

  // ── transport ──────────────────────────────────────────────────────────────────────────────────────
  function post(url, body) {
    return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (res) {
        return res.json().catch(function () { return { error: 'Unexpected response' }; }).then(function (j) {
          if (!res.ok && !j.error) j.error = 'Request failed (' + res.status + ')';
          if (!res.ok) j.status = res.status;
          return j;
        });
      })
      .catch(function () { return { error: 'Network error — please check your connection and try again.', code: 'network' }; });
  }

  function call(action, payload) {
    var body = { project_id: cfg.site, action: action };
    for (var k in (payload || {})) if (Object.prototype.hasOwnProperty.call(payload, k)) body[k] = payload[k];
    if (body.token === undefined) { var t = auth.token(); if (t) body.token = t; }
    return post(API, body).then(function (j) {
      if (j && j.code === 'session_expired') clearSession(); // stale/expired token: drop it so the UI shows "signed out"
      return j;
    });
  }

  // ── auth ───────────────────────────────────────────────────────────────────────────────────────────
  var auth = {
    signup: function (email, password, metadata) {
      return post(API, { project_id: cfg.site, action: 'signup', email: email, password: password, metadata: metadata })
        .then(function (r) { if (r.token) setSession(r); return r; });
    },
    login: function (email, password) {
      return post(API, { project_id: cfg.site, action: 'login', email: email, password: password })
        .then(function (r) { if (r.token) setSession(r); return r; });
    },
    logout: function () {
      var t = store(K_TOKEN);
      clearSession(); // sign out locally first so the UI never waits on the network
      return t ? post(API, { project_id: cfg.site, action: 'logout', token: t }) : Promise.resolve({ success: true });
    },
    user: function () {
      if (!auth.token()) return null;
      try { return JSON.parse(store(K_USER) || 'null'); } catch (e) { return null; }
    },
    token: function () {
      var t = store(K_TOKEN);
      if (!t) return null;
      var exp = store(K_EXP);
      if (exp && Date.parse(exp) < Date.now()) { clearSession(); return null; }
      return t;
    },
    // Ask the server who the token belongs to (also refreshes the cached user). Resolves to the user or null.
    me: function () {
      if (!auth.token()) return Promise.resolve(null);
      return call('me').then(function (r) {
        if (r && r.user) { store(K_USER, JSON.stringify(r.user)); return r.user; }
        return null;
      });
    },
    onChange: function (fn) {
      listeners.push(fn);
      return function () { var i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); };
    }
  };

  // ── data ───────────────────────────────────────────────────────────────────────────────────────────
  var data = {
    submit: function (collection, d) { return call('submit', { collection: collection, data: d }); },
    list: function (collection, opts) {
      var p = { collection: collection };
      if (opts) { if (opts.limit) p.limit = opts.limit; if (opts.before) p.before = opts.before; if (opts.mine) p.mine = true; }
      return call('list', p);
    },
    update: function (collection, id, d) { return call('update', { collection: collection, id: id, data: d }); },
    remove: function (collection, id) { return call('delete', { collection: collection, id: id }); }
  };

  // ── forms ──────────────────────────────────────────────────────────────────────────────────────────
  function formToObject(form) {
    var out = {};
    var els = form.elements;
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (!el.name || el.disabled || el.type === 'file' || el.type === 'submit' || el.type === 'button') continue;
      if (el.type === 'checkbox') { out[el.name] = el.checked; continue; }
      if (el.type === 'radio') { if (el.checked) out[el.name] = el.value; continue; }
      if (el.tagName === 'SELECT' && el.multiple) {
        out[el.name] = Array.prototype.filter.call(el.options, function (o) { return o.selected; }).map(function (o) { return o.value; });
        continue;
      }
      out[el.name] = el.value;
    }
    return out;
  }
  function note(form, text, state) {
    form.setAttribute('data-vx-state', state);
    var m = form.querySelector('[data-vx-message]');
    if (m) m.textContent = text;
  }
  // Shared by vx.forms.bind and the [data-vx-form] hook: submit the form's named fields to a collection and report state on the form.
  function submitForm(form, collection, opts) {
    opts = opts || {};
    var btn = form.querySelector('[type=submit]');
    if (btn) btn.disabled = true;
    note(form, 'Sending…', 'sending');
    return data.submit(collection, formToObject(form)).then(function (r) {
      if (btn) btn.disabled = false;
      if (r && r.success) {
        note(form, opts.successMessage || 'Thanks — we got it.', 'sent');
        try { form.reset(); } catch (e) { /* ignore */ }
        try { form.dispatchEvent(new CustomEvent('vx:submitted', { bubbles: true, detail: r })); } catch (e) { /* ignore */ }
        if (opts.onSuccess) opts.onSuccess(r, form);
      } else {
        note(form, (r && r.error) || 'Something went wrong — please try again.', 'error');
        try { form.dispatchEvent(new CustomEvent('vx:error', { bubbles: true, detail: r })); } catch (e) { /* ignore */ }
        if (opts.onError) opts.onError(r, form);
      }
      return r;
    });
  }
  var forms = {
    submit: data.submit,
    // vx.forms.bind('form#contact', 'messages') — submits the form's named fields to the collection.
    // Sets data-vx-state="sending|sent|error" on the form, writes [data-vx-message] if present, fires vx:submitted / vx:error.
    bind: function (selector, collection, opts) {
      var nodes = typeof selector === 'string' ? document.querySelectorAll(selector) : [selector];
      Array.prototype.forEach.call(nodes, function (form) {
        if (!form || form.__vxBound) return;
        form.__vxBound = true;
        form.addEventListener('submit', function (ev) {
          ev.preventDefault();
          submitForm(form, collection, opts);
        });
      });
      return nodes.length;
    }
  };

  // ── payments ───────────────────────────────────────────────────────────────────────────────────────
  function checkout(payload, silent) {
    var body = { project_id: cfg.site, success_url: location.origin + location.pathname + '?paid=1', cancel_url: location.href };
    for (var k in payload) if (Object.prototype.hasOwnProperty.call(payload, k)) body[k] = payload[k];
    return post(PAY, body).then(function (r) {
      if (r && r.url) { location.href = r.url; return r; }
      if (!silent) { try { alert((r && r.error) || 'Payment could not be started.'); } catch (e) { /* ignore */ } }
      return r;
    });
  }
  var pay = {
    buy: function (productId, opts) { return checkout({ product_id: productId }, opts && opts.silent); },
    buyAmount: function (cents, name, opts) { return checkout({ amount_cents: cents, name: name }, opts && opts.silent); }
  };

  // ── tracking (same collector + ids as the automatic page-view tracker) ─────────────────────────────
  var track = {
    page: function (path) {
      try {
        var sid = sessionStorage.getItem('_vsid') || Math.random().toString(36).slice(2);
        sessionStorage.setItem('_vsid', sid);
        var vid = localStorage.getItem('_vvid') || Math.random().toString(36).slice(2);
        localStorage.setItem('_vvid', vid);
        return post(TRACK, { project_id: cfg.site, page: path || location.pathname, referrer: document.referrer, session_id: sid, visitor_id: vid });
      } catch (e) { return Promise.resolve({ error: 'tracking unavailable' }); }
    }
  };

  // ── site chrome: nav + footer rendered from window.SITE (config only; see docs/PROJECT_FORMAT.md) ──
  function esc(x) {
    return String(x == null ? '' : x).replace(/[&<>"']/g, function (c) {
      return c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;';
    });
  }
  function cleanHref(h) {
    h = String(h == null ? '' : h).trim();
    return /^(javascript|data|vbscript):/i.test(h.replace(/[\u0000- \u007f]+/g, '')) ? '#' : h;
  }
  // <img src> may be a data:image/* URL (the editor preview inlines uploaded images that way); everything else follows the link rules
  function cleanSrc(h) {
    h = String(h == null ? '' : h).trim();
    return /^data:image\/(png|jpe?g|gif|webp|avif|svg\+xml|x-icon|bmp);/i.test(h) ? h : cleanHref(h);
  }
  function isExternal(h) { return /^(https?:)?\/\//i.test(h) || /^(mailto|tel):/i.test(h); }
  // 'pricing.html#x' -> 'pricing.html'; '' or '/slug/' or an extension-less path -> 'index.html'
  function pageOf(h) {
    var last = String(h || '').split('#')[0].split('?')[0].split('/').pop();
    return /\.html?$/i.test(last) ? last : 'index.html';
  }
  function currentPage() { return (w.__VX && w.__VX.page) || pageOf(w.location && w.location.pathname); }
  function visible(it, user) { return it.show === 'in' ? !!user : it.show === 'out' ? !user : true; }
  function linkHtml(it, cls, current) {
    var label = esc(it.label);
    if (it.action === 'logout') return '<a class="' + cls + '" href="#" data-vx-logout>' + label + '</a>';
    var href = cleanHref(it.href);
    var attrs = ' class="' + cls + '" href="' + esc(href) + '"';
    if (/^(https?:)?\/\//i.test(href)) attrs += ' target="_blank" rel="noopener noreferrer"';
    else if (href && !isExternal(href) && href.indexOf('#') === -1 && pageOf(href) === current) attrs += ' aria-current="page"';
    return '<a' + attrs + '>' + label + '</a>';
  }
  function brandHtml(site) {
    var logo = site.logo ? '<img class="vx-logo" src="' + esc(cleanSrc(site.logo)) + '" alt="' + (site.logoOnly ? esc(site.name) : '') + '">' : '';
    var name = site.logoOnly && site.logo ? '' : '<span class="vx-brand-name">' + esc(site.name) + '</span>';
    return '<a class="vx-brand" href="index.html">' + logo + name + '</a>';
  }
  function navHtml(site, user, current) {
    site = site || {};
    var links = (site.nav || []).filter(function (it) { return it && it.label && visible(it, user); })
      .map(function (it) { return linkHtml(it, 'vx-link', current); }).join('');
    var cta = site.cta && site.cta.label && visible(site.cta, user) ? linkHtml(site.cta, 'vx-link vx-cta', current) : '';
    return '<div class="vx-nav-inner">' + brandHtml(site) +
      '<button class="vx-burger" type="button" aria-label="Menu" aria-expanded="false"><span></span><span></span><span></span></button>' +
      '<nav class="vx-menu" aria-label="Main">' + links + cta + '</nav></div>';
  }
  function footerHtml(site, user) {
    site = site || {};
    var f = site.footer || {};
    var cols = (f.columns || []).map(function (c) {
      var links = ((c && c.links) || []).filter(function (l) { return l && l.label && visible(l, user); })
        .map(function (l) { return linkHtml(l, 'vx-footer-link', ''); }).join('');
      return c && c.title ? '<div class="vx-footer-col"><h4 class="vx-footer-title">' + esc(c.title) + '</h4>' + links + '</div>' : '';
    }).join('');
    var social = (f.social || []).filter(function (l) { return l && l.label; }).map(function (l) { return linkHtml(l, 'vx-footer-link', ''); }).join('');
    return '<div class="vx-footer-inner"><div class="vx-footer-brand">' + brandHtml(site) +
      (f.tagline ? '<p class="vx-footer-tagline">' + esc(f.tagline) + '</p>' : '') + '</div>' +
      (cols ? '<div class="vx-footer-cols">' + cols + '</div>' : '') +
      '<div class="vx-footer-bottom"><span class="vx-legal">' + esc(String(f.legal == null ? '' : f.legal).replace(/\{year\}/g, new Date().getFullYear())) + '</span>' + (social ? '<span class="vx-social">' + social + '</span>' : '') + '</div></div>';
  }

  // Zero-specificity defaults (":where") built on the project's tokens: an unstyled nav/footer is already usable and
  // styles.css overrides any of it just by being written. Injected first in <head> so author CSS always wins.
  var BASE_CSS = '[hidden]{display:none!important}' +
    ':where([data-vx-nav]:empty){min-height:var(--nav-h,68px)}' +
    ':where(.vx-nav-inner){display:flex;align-items:center;justify-content:space-between;gap:24px;box-sizing:border-box;max-width:var(--container,1200px);margin:0 auto;padding:0 clamp(20px,5vw,60px);min-height:var(--nav-h,68px)}' +
    ':where(.vx-brand){display:inline-flex;align-items:center;gap:10px;font-weight:700;color:inherit;text-decoration:none;white-space:nowrap}' +
    ':where(.vx-logo){height:28px;width:auto}' +
    ':where(.vx-menu){display:flex;align-items:center;gap:24px}' +
    ':where(.vx-link){color:var(--text-muted,inherit);text-decoration:none;white-space:nowrap}' +
    ':where(.vx-link:hover,.vx-link[aria-current="page"]){color:var(--text,inherit)}' +
    ':where(.vx-cta){padding:.55em 1.1em;border-radius:var(--radius,10px);background:var(--accent,#4f46e5);color:var(--accent-contrast,#fff)}' +
    ':where(.vx-cta:hover){color:var(--accent-contrast,#fff)}' +
    ':where(.vx-burger){display:none;flex-direction:column;gap:5px;padding:10px;background:none;border:0;cursor:pointer;color:inherit}' +
    ':where(.vx-burger span){display:block;width:22px;height:2px;background:currentColor;border-radius:2px}' +
    '@media(max-width:860px){:where(.vx-burger){display:flex}' +
    ':where(.vx-menu){display:none;position:absolute;left:0;right:0;top:100%;flex-direction:column;align-items:stretch;gap:14px;padding:18px clamp(20px,5vw,60px) 26px;background:var(--bg,#fff);border-bottom:1px solid var(--border,#e5e7eb)}' +
    ':where([data-vx-nav]){position:relative}:where([data-vx-nav][data-open="true"] .vx-menu){display:flex}}' +
    ':where(.vx-footer-inner){box-sizing:border-box;max-width:var(--container,1200px);margin:0 auto;padding:48px clamp(20px,5vw,60px) 28px;display:grid;gap:36px}' +
    ':where(.vx-footer-cols){display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:28px}' +
    ':where(.vx-footer-col){display:flex;flex-direction:column;gap:10px}' +
    ':where(.vx-footer-title){margin:0 0 4px;font-size:.8rem;letter-spacing:.06em;text-transform:uppercase;color:var(--text-muted,inherit)}' +
    ':where(.vx-footer-link){color:var(--text-muted,inherit);text-decoration:none}:where(.vx-footer-link:hover){color:var(--text,inherit)}' +
    ':where(.vx-footer-tagline){margin:10px 0 0;color:var(--text-muted,inherit);max-width:38ch}' +
    ':where(.vx-footer-bottom){display:flex;flex-wrap:wrap;justify-content:space-between;gap:12px;padding-top:20px;border-top:1px solid var(--border,#e5e7eb);font-size:.875rem;color:var(--text-muted,inherit)}' +
    ':where(.vx-social){display:flex;flex-wrap:wrap;gap:16px}';

  function eachNode(sel, fn) {
    var d = w.document;
    if (!d || !d.querySelectorAll) return;
    Array.prototype.forEach.call(d.querySelectorAll(sel), fn);
  }
  function userField(user, key) {
    if (!user) return '';
    var v = user[key];
    if (v == null && user.metadata) v = user.metadata[key];
    return v == null ? '' : String(v);
  }
  function chromeSlot(el) { return el.__vxRendered || (!el.children.length && !String(el.textContent || '').trim()); }
  function refreshChrome() {
    if (!w.document || !w.document.querySelectorAll) return;
    var user = auth.user(), site = w.SITE, cur = currentPage();
    if (site) {
      eachNode('[data-vx-nav]', function (el) {
        if (!chromeSlot(el)) return;
        el.__vxRendered = true; el.classList.add('vx-nav');
        el.innerHTML = navHtml(site, user, cur);
      });
      eachNode('[data-vx-footer]', function (el) {
        if (!chromeSlot(el)) return;
        el.__vxRendered = true; el.classList.add('vx-footer');
        el.innerHTML = footerHtml(site, user);
      });
    }
    eachNode('[data-vx-show]', function (el) {
      var m = el.getAttribute('data-vx-show');
      el.hidden = m === 'in' ? !user : m === 'out' ? !!user : false;
    });
    eachNode('[data-vx-user]', function (el) { el.textContent = userField(user, el.getAttribute('data-vx-user') || 'email'); });
  }

  // ── auth guards: <html data-vx-require-auth="login.html"> / <html data-vx-skip-if-auth="dashboard.html"> ──
  var guardCfg = {}, lastGuard = '';
  function guard() {
    var d = w.document, req = guardCfg.signedOut, skip = guardCfg.signedIn;
    if (d) [d.documentElement, d.body].forEach(function (el) {
      if (!el || !el.getAttribute) return;
      req = req || el.getAttribute('data-vx-require-auth');
      skip = skip || el.getAttribute('data-vx-skip-if-auth');
    });
    var signedIn = !!auth.token();
    var to = !signedIn && req ? req : signedIn && skip ? skip : null;
    if (!to || pageOf(to) === currentPage() || lastGuard === to) return;
    lastGuard = to; // the head-time and DOMContentLoaded passes must not navigate twice
    go(to, true);
  }

  // Navigate to another page of the site. Previewers (editor / viewer.html run the site in a blob: document where relative
  // URLs can't resolve) provide window.__VX.navigate; on a published site this is a plain location change.
  function go(to, replace) {
    try {
      if (w.__VX && typeof w.__VX.navigate === 'function') w.__VX.navigate(to);
      else if (replace && w.location.replace) w.location.replace(to);
      else w.location.href = to;
    } catch (e) { /* ignore */ }
  }
  function toggleMenu(root, force) {
    var open = force === undefined ? root.getAttribute('data-open') !== 'true' : force;
    root.setAttribute('data-open', open ? 'true' : 'false');
    var b = root.querySelector('.vx-burger');
    if (b) b.setAttribute('aria-expanded', open ? 'true' : 'false');
  }
  function busy(el, p) {
    el.setAttribute('data-vx-state', 'loading');
    Promise.resolve(p).then(function () { el.removeAttribute('data-vx-state'); }, function () { el.removeAttribute('data-vx-state'); });
  }
  function authForm(f) {
    var mode = f.getAttribute('data-vx-auth') === 'signup' ? 'signup' : 'login';
    var o = formToObject(f), email = String(o.email || '').trim(), password = String(o.password || '');
    var confirmKey = ['confirm', 'password_confirm', 'confirm_password', 'password2'].filter(function (k) { return k in o; })[0];
    if (!email || !password) return note(f, 'Please enter your email and password.', 'error');
    if (mode === 'signup' && confirmKey && o[confirmKey] !== password) return note(f, "Passwords don't match.", 'error');
    var meta, has = false;
    if (mode === 'signup') {
      meta = {};
      for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k) && k !== 'email' && k !== 'password' && k !== confirmKey) { meta[k] = o[k]; has = true; }
    }
    var btn = f.querySelector('[type=submit]');
    if (btn) btn.disabled = true;
    note(f, mode === 'signup' ? 'Creating your account…' : 'Signing in…', 'sending');
    (mode === 'signup' ? auth.signup(email, password, has ? meta : undefined) : auth.login(email, password)).then(function (r) {
      if (btn) btn.disabled = false;
      if (r && r.token) {
        note(f, '', 'sent');
        var to = f.getAttribute('data-vx-redirect');
        if (to) go(to);
      } else {
        note(f, (r && r.error) || 'Something went wrong — please try again.', 'error');
      }
    });
  }
  function safeDecode(x) { try { return decodeURIComponent(x); } catch (e) { return x; } }
  function samePageHash(href) {
    if (!href || href.charAt(0) === '#') return href && href.length > 1 && href.indexOf('#vexnav=') !== 0 ? href.slice(1) : '';
    var i = href.indexOf('#');
    return i > -1 && !isExternal(href) && pageOf(href) === currentPage() ? href.slice(i + 1) : '';
  }
  function wireHooks(d) {
    d.addEventListener('click', function (ev) {
      var t = ev.target;
      if (!t || !t.closest) return;
      var el = t.closest('.vx-burger');
      if (el) { var root = el.closest('[data-vx-nav]'); if (root) toggleMenu(root); return; }
      if ((el = t.closest('[data-vx-logout]'))) {
        ev.preventDefault();
        var to = el.getAttribute('data-vx-redirect');
        auth.logout().then(function () { if (to) go(to); });
        return;
      }
      if ((el = t.closest('[data-vx-buy]'))) { ev.preventDefault(); busy(el, pay.buy(el.getAttribute('data-vx-buy'))); return; }
      if ((el = t.closest('[data-vx-buy-amount]'))) {
        ev.preventDefault();
        busy(el, pay.buyAmount(parseInt(el.getAttribute('data-vx-buy-amount'), 10), el.getAttribute('data-vx-name') || 'Payment'));
        return;
      }
      var menu = t.closest('.vx-menu');
      if (menu) { var r2 = menu.closest('[data-vx-nav]'); if (r2) toggleMenu(r2, false); }
      var a = t.closest('a[href]');
      if (a) {
        var id = samePageHash(a.getAttribute('href'));
        var target = id && d.getElementById(safeDecode(id));
        if (target) {
          ev.preventDefault();
          var calm = w.matchMedia && w.matchMedia('(prefers-reduced-motion: reduce)').matches;
          try { target.scrollIntoView({ behavior: calm ? 'auto' : 'smooth', block: 'start' }); } catch (e) { target.scrollIntoView(); }
          try { w.history.replaceState(null, '', '#' + id); } catch (e) { /* blob: previews and old browsers */ }
        }
      }
    });
    d.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape') eachNode('[data-vx-nav][data-open="true"]', function (root) { toggleMenu(root, false); });
    });
    d.addEventListener('submit', function (ev) {
      var f = ev.target;
      if (!f || !f.hasAttribute || f.__vxBound) return;
      if (f.hasAttribute('data-vx-auth')) { ev.preventDefault(); authForm(f); }
      else if (f.hasAttribute('data-vx-form')) {
        ev.preventDefault();
        submitForm(f, f.getAttribute('data-vx-form'), { successMessage: f.getAttribute('data-vx-success') || undefined });
      }
    });
  }
  function onReady(fn) {
    var d = w.document;
    if (!d || !d.addEventListener) return;
    if (d.readyState === 'loading') d.addEventListener('DOMContentLoaded', fn); else fn();
  }
  function init() {
    var d = w.document;
    if (!d) return;
    if (d.head && d.createElement) { // first in <head>: author CSS always wins
      var st = d.createElement('style');
      st.setAttribute('data-vx-base', '');
      st.textContent = BASE_CSS;
      d.head.insertBefore(st, d.head.firstChild);
    }
    try { guard(); } catch (e) { /* ignore */ }
    onReady(function () {
      try { guard(); } catch (e) { /* ignore */ }
      refreshChrome();
      wireHooks(d);
      if (w.SITE && d.head && d.createElement && w.location && w.location.protocol !== 'blob:') {
        if (!d.querySelector('link[rel="manifest"]')) {
          var m = d.createElement('link'); m.rel = 'manifest'; m.href = 'manifest.json'; d.head.appendChild(m);
        }
        if (!d.querySelector('meta[name="theme-color"]') && w.getComputedStyle) {
          var bg = String(w.getComputedStyle(d.documentElement).getPropertyValue('--bg') || '').trim();
          if (bg) { var tc = d.createElement('meta'); tc.name = 'theme-color'; tc.content = bg; d.head.appendChild(tc); }
        }
      }
      if (/[?&]paid=1(&|$)/.test((w.location && w.location.search) || '')) {
        eachNode('[data-vx-paid]', function (el) { el.hidden = false; el.setAttribute('data-vx-state', 'paid'); });
      }
    });
  }

  w.vx = {
    version: 1,
    revision: 2,
    config: function (c) { if (c && c.site) cfg.site = c.site; return cfg; },
    auth: auth, data: data, forms: forms, pay: pay, track: track,
    site: { navHtml: navHtml, footerHtml: footerHtml, refresh: refreshChrome },
    go: function (to) { go(to); }
  };
  auth.guard = function (opts) { guardCfg = opts || {}; guard(); };

  // ── back-compat aliases for helpers the AI used to paste into every page ───────────────────────────
  w.vxCall = call;
  w.vxSignup = auth.signup;
  w.vxLogin = auth.login;
  w.vxLogout = auth.logout;
  w.vxCurrentUser = auth.user;
  w.vxGetToken = auth.token;
  w.vxCheckout = function (payload) { return checkout(payload, false); };
  w.vxBuy = function (productId) { return pay.buy(productId); };
  w.vxBuyAmount = function (cents, name) { return pay.buyAmount(cents, name); };

  init();
})(window);
