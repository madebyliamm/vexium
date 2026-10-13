/*! Vertly SDK v1 — served at /__vx/sdk/v1.js and injected into every published site.
 *  Source of truth: sdk/v1.js. After editing run `node scripts/build-sdk.mjs` (embeds it into the publisher Worker),
 *  then redeploy the Worker. v1 is additive-only: a breaking change ships as v2.js.
 *
 *    vx.auth.signup(email, password[, metadata]) / login(email, password) / logout() / user() / token() / me() / onChange(fn)
 *    vx.data.submit(collection, data) / list(collection[, {limit, before, mine}]) / update(collection, id, data) / remove(collection, id)
 *    vx.forms.submit(collection, data) / bind(selector, collection[, {onSuccess, onError}])
 *    vx.pay.buy(productId) / buyAmount(cents, name)
 *    vx.track.page([path])
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
  var forms = {
    submit: data.submit,
    // vx.forms.bind('form#contact', 'messages') — submits the form's named fields to the collection.
    // Sets data-vx-state="sending|sent|error" on the form, writes [data-vx-message] if present, fires vx:submitted / vx:error.
    bind: function (selector, collection, opts) {
      opts = opts || {};
      var nodes = typeof selector === 'string' ? document.querySelectorAll(selector) : [selector];
      Array.prototype.forEach.call(nodes, function (form) {
        if (!form || form.__vxBound) return;
        form.__vxBound = true;
        form.addEventListener('submit', function (ev) {
          ev.preventDefault();
          var btn = form.querySelector('[type=submit]');
          if (btn) btn.disabled = true;
          note(form, 'Sending…', 'sending');
          data.submit(collection, formToObject(form)).then(function (r) {
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
          });
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

  w.vx = {
    version: 1,
    config: function (c) { if (c && c.site) cfg.site = c.site; return cfg; },
    auth: auth, data: data, forms: forms, pay: pay, track: track
  };

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
})(window);
