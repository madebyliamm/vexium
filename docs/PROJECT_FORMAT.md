# Project format v2 (Step 5)

What a Vertly project looks like on disk (`projects.files` jsonb → R2 on publish), and the contract between the AI that writes it,
the editor/studio that previews it, the publisher Worker that serves it and the Vertly SDK that runs in it.
Generated sites stay **build-free HTML/CSS/JS** — no bundler, no framework. Everything shared lives in three small files + the hosted SDK.

## 1. Files

| File | Who writes it | Purpose | Published? |
|---|---|---|---|
| `index.html`, `<page>.html` | AI | One page each. Flat namespace, lowercase, `-` separated (`about.html`, `our-menu.html`). | yes |
| `styles.css` | AI | **The one token source** + reset/base + shared components. | yes |
| `site.js` | AI | `window.SITE = {…}` — brand, nav, footer. **Config only, no logic.** | yes |
| `manifest.json` | AI (first build) | PWA manifest. Name + colors; icons only if the owner uploaded one. | yes |
| images (`png jpg webp svg ico gif`) | owner (uploads) | Real files only. The AI never invents image URLs. | yes |
| `_longterm` `_shortterm` `_pages` | AI | Project memory (see §6). | **no** (`_`-prefix) |
| `_backend` | AI | Backend rules: collections, auth, products (see §5). Stored on the deploy row, enforced by `site-api`. | **no** |

Rules: pages reference shared files **relatively** (`href="styles.css"`, `src="site.js"`) — that is what the editor preview inlines and what
`<base href="/slug/">` on `*.vexium.ai` resolves. No other `.css`/`.js` files; page-only behaviour is a small inline `<script>` at the end of that page.

## 2. `styles.css` — the single token source

First lines: the font `@import` (so a font change is one edit), then `:root`.

```css
@import url('https://fonts.googleapis.com/css2?family=…&display=swap');
:root {
  --bg: …;  --surface: …;  --surface-2: …;  --border: …;
  --text: …;  --text-muted: …;
  --accent: …;  --accent-contrast: …;      /* readable text ON --accent */
  --font-display: '…', system-ui, sans-serif;  --font-body: '…', system-ui, sans-serif;
  --radius: 12px;  --radius-lg: 20px;
  --shadow-sm: …;  --shadow-lg: …;
  --container: 1200px;  --nav-h: 68px;  --section-y: clamp(80px, 12vw, 160px);
}
```
Required names: everything above. More tokens are fine (`--accent-2`, `--success`, `--danger`, …). **Raw colors, fonts and radii appear only as the value of a custom property** — the `:root` tokens, or (for artwork such as a CSS-drawn candle) custom properties on that artwork's own wrapper (`.candle { --wax: #e8c090 }`).
Every real property — in `styles.css`, a page's own `<style>`, inline `style=""`, SVG fills — uses `var(--…)`/`currentColor`; tints and shadows are `color-mix(in srgb, var(--accent) 12%, transparent)`, shades `color-mix(in srgb, var(--accent) 85%, black)`. The Step 10 verifier checks exactly this.
That is what makes "change one token → every page re-themes" true, and what Step 9's vibe controls rely on (swap the `:root` block, no regeneration).
After `:root`: reset + base typography, layout primitives (`.container`, `.section`), buttons, form controls, cards, the SDK's chrome classes (§4), then shared components.
Page-specific CSS goes in that page's `<style>` (tokens only).

## 3. Page skeleton

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1.0"/>
  <title>Pricing — Brand</title>
  <meta name="description" content="one honest sentence"/>
  <link rel="stylesheet" href="styles.css"/>
  <style>/* only this page's own rules, var(--tokens) only */</style>
</head>
<body>
  <header data-vx-nav></header>
  <main> … </main>
  <footer data-vx-footer></footer>
  <script src="site.js"></script>
  <script>/* optional: page-only behaviour; vx.* is already loaded */</script>
</body>
</html>
```
`<link rel="manifest">` and `<meta name="theme-color">` are added by the SDK on published sites (from `manifest.json` / the computed `--bg`), so pages don't carry them.
Links between pages are plain relative filenames (`pricing.html`). Never `#` placeholders, never absolute paths, never `{{VEXIUM_PROJECT_ID}}` (the SDK is told the site id by the platform).

## 4. `site.js` and the SDK-rendered chrome

```js
window.SITE = {
  name: "Brand",
  logo: "logo.png",                       // optional — only an image the owner uploaded; otherwise the name is the logo
  nav: [
    { label: "Home",      href: "index.html" },
    { label: "Features",  href: "index.html#features" },   // anchor on the home page
    { label: "Pricing",   href: "pricing.html" },
    { label: "Log in",    href: "login.html",     show: "out" },   // show: "in" | "out" = by sign-in state (apps)
    { label: "Dashboard", href: "dashboard.html", show: "in" },
    { label: "Log out",   action: "logout",       show: "in" }
  ],
  cta: { label: "Get started", href: "signup.html", show: "out" },   // optional highlighted button
  footer: {
    tagline: "One line about the brand.",
    columns: [ { title: "Company", links: [ { label: "About", href: "about.html" } ] } ],
    social: [ { label: "Instagram", href: "https://instagram.com/…" } ],   // only real, owner-supplied URLs
    legal: "© {year} Brand"                                              // {year} → the current year, never hardcoded
  }
};
```
Adding a page = one new line in `nav` (and `footer.columns` if it belongs). The SDK (`sdk/v1.js`, `vx.site`) fills `[data-vx-nav]` / `[data-vx-footer]` on `DOMContentLoaded` and again on every sign-in/out:

* nav → `<header class="vx-nav"><div class="vx-nav-inner"><a class="vx-brand">(<img class="vx-logo">)<span class="vx-brand-name"></span></a><button class="vx-burger">…</button><nav class="vx-menu"><a class="vx-link" aria-current="page">…</a><a class="vx-link vx-cta">…</a></nav></div></header>`; the burger toggles `data-open="true"` on the header. Nav links are the *only* markup the AI doesn't write.
* footer → `<footer class="vx-footer"><div class="vx-footer-inner"><div class="vx-footer-brand">…<p class="vx-footer-tagline"></p></div><div class="vx-footer-cols"><div class="vx-footer-col"><h4 class="vx-footer-title"></h4><a class="vx-footer-link"></a></div></div><div class="vx-footer-bottom"><span class="vx-legal"></span><span class="vx-social">…</span></div></div></footer>`.
* The SDK ships **zero-specificity defaults** (`:where(…)`, using the tokens) so an unstyled nav is already usable; `styles.css` styles `.vx-nav / .vx-link / .vx-cta / .vx-footer …` to fit the design and overrides them by simply being written.
* A page that wants a different shell (e.g. an app sidebar) just doesn't include the placeholder and writes its own markup using the hooks in §5.
* In-page `#anchor` links scroll smoothly without leaving the page (works under `<base>`); external links open in a new tab with `rel="noopener noreferrer"`; `javascript:`/`data:` hrefs are dropped; all text is escaped.

## 5. Backend: `_backend` + SDK hooks

`_backend` is the Step 4 schema (see `docs/STEP4_DESIGN.md` §2): `collections[{id,label,fields[{key,type,required,max}],read,write,max_rows,notify_owner}]`, `auth{enabled}`, `products[{id,name,price_cents}]`.
Defaults when omitted: `write:"public"`; `read:"user"` if `auth.enabled` else `"owner"` (public reads must be asked for). Set `auth.enabled:true` whenever the site has accounts.
The AI must **merge** into the existing `_backend`, never replace it.

Pages talk to it through the SDK, declaratively first, JS API when custom logic is needed (all of it is already loaded in `<head>` — no helper code is ever pasted into a page):

| Need | Markup |
|---|---|
| Contact / waitlist / booking form | `<form data-vx-form="waitlist" data-vx-success="You're on the list.">` with named inputs + one `<p data-vx-message></p>`. SDK submits to the collection and sets `data-vx-state="sending|sent|error"` on the form. |
| Sign up / log in | `<form data-vx-auth="signup" data-vx-redirect="dashboard.html">` (`email`, `password`, optional extra named fields → profile metadata, optional `confirm`) / `data-vx-auth="login"`; errors land in `[data-vx-message]`. |
| Log out | `<button data-vx-logout data-vx-redirect="index.html">` |
| Show/hide by sign-in | `data-vx-show="in"` / `data-vx-show="out"` (any element). Show the user: `<span data-vx-user="email">` (or `name`, any metadata key). |
| Protect / bounce | `<html data-vx-require-auth="login.html">` (signed-out visitors are sent there) · `<html data-vx-skip-if-auth="dashboard.html">` (login/signup pages). |
| Buy button | `<button data-vx-buy="product-id">` (price comes from `_backend.products`, server-side) · pay-what-you-want/donation: `<button data-vx-buy-amount="500" data-vx-name="Donation">`. |
| "Payment received" banner | `<div data-vx-paid hidden>Payment received — thank you!</div>` (revealed on `?paid=1`). |
| Custom logic | `vx.auth.{signup,login,logout,user,token,me,onChange,guard}` · `vx.data.{submit,list,update,remove}` · `vx.forms.bind` · `vx.pay.{buy,buyAmount}` · `vx.go('page.html')` (navigate — use this, not `location.href`, so it also works in the editor preview) — each data call resolves to `{success,…}` or `{error}`, never throws. The SDK is loaded in `<head>`, so `vx` exists in any script. |

OAuth/social login is not offered. Payments need no account. The old pasted helpers (`vxCall`, `vxSignup`, `vxBuy`…) still exist as SDK aliases for projects built before v2.

## 6. Project memory (`_` files, never published)

* `_longterm` (JSON, merge — never delete fields): `{"kind":"site|app","brand":{"name","tagline","audience","tone"},"design":{"font_display","font_body","style":"3 words"},"decisions":[…],"never_change":[…],"needs_from_owner":[…]}`. **Colors/fonts values are NOT stored here** — `styles.css` is the only token source.
  * `kind`: `site` = marketing/content/store pages (forms, checkout); `app` = people sign in and use it (accounts, per-user data, dashboard). Chosen from what the owner asked for. Step 7 moves it into the Plan artifact.
  * `needs_from_owner`: the **launch-content checklist** — things the AI could not know and therefore left out (testimonials, client logos, real product photos, address/hours/phone, team bios, press, legal pages, real prices if not given). Plain English strings. Step 8 (PLAN), Step 10 (verifier) and Step 12 (LAUNCH) read it.
* `_shortterm`: `RECENT / TODO / CONTEXT`, overwritten each build, ≤ 8 lines.
* `_pages`: one line per HTML page with section → line ranges (lets edits target pages that aren't shown in full).

## 7. No fake content (locked decision)

The AI writes real copy for everything it can legitimately author (headlines, descriptions, features derived from what the owner said, FAQs about the product itself). It **omits** — and lists in `needs_from_owner` — anything that would be an invented fact about the real world: customer testimonials, client/press logos, review scores, user/customer counts, "trusted by", uptime/revenue/percentage stats, waitlist counters, team members, addresses/phones/hours, certifications, legal text. No `lorem ipsum`, no `FakeCo`, no `#` links, no dead forms, no placeholder prices. Prices and plans come from the owner (or `_backend.products`); if unknown the section is built without numbers or left out.
One exception, pure decoration: a product-preview mockup inside a hero (a CSS picture of the UI, illustrative sample data, no real-sounding customer names or results). Step 10's launch verifier enforces all of this mechanically.

## 8. Editing

* Edits are `<patch>` blocks against the file that owns the thing: colors/fonts/spacing/shared components → `styles.css`; nav/footer/brand → `site.js`; page content → that page. Patching `:root` re-themes every page.
* The tiny config files (`site.js`, `manifest.json`, `_backend`, `_longterm`, `_shortterm`, `_pages`) may be rewritten whole when a change touches several places (the one exception to patches-only); a whole `_backend` is required when adding accounts/collections/products.
* A new page = one `<file>` block for it **plus** a `site.js` update adding it to `nav` (when it belongs there). The client always sends `styles.css`, `site.js`, `manifest.json` in full so patches apply to real content.
* A patch block with no usable operation, or whose operations all fail to match, is reported as `patch_failed` (the editor then retries the file as a full rewrite) — never as an unchanged success. Opening tags are matched leniently (`<find">` typos still parse).
* Changing the palette or fonts also updates `manifest.json` (`theme_color`, `background_color`, `name`).

## 9. Preview vs published

| | Editor preview / `viewer.html` | Published (`*.vexium.ai`, custom domain) |
|---|---|---|
| `styles.css` / `site.js` | inlined into each page's HTML by the previewer | real files from R2 |
| SDK | `https://vexium.ai/sdk/v1.js?r=2` (repo copy on GitHub Pages) + `window.__VX={site,page,navigate}` injected at the start of `<head>` | `/__vx/sdk/v1.js?v=<hash>` + `window.__VX={site}` injected right after `<head>` (after `<base>`) by the Worker |
| Page-to-page links, redirects, guards | click interceptor + `__VX.navigate` → `#vexnav=<page>` (Chrome won't let a page intercept `location.href`) | real navigation under `<base href="/slug/">` |
| Uploaded images in `site.js` (`logo:`) | quoted filenames swapped for data URLs | real files |
| manifest / theme-color | not injected | injected by the SDK on `DOMContentLoaded` |
| Thumbnails (home / profile) | the main page with `styles.css` inlined, scripts disabled → no nav/footer | — |

## 10. Known limits / later

* No PWA icons unless the owner uploaded one (Step 12 can generate from the logo/initials). A manifest without icons gives theme color + name but not installability.
* Chrome (nav/footer) renders on `DOMContentLoaded`; the placeholder gets `min-height: var(--nav-h)` in the SDK defaults to avoid layout shift. The live "watch it build" preview strips scripts, so the nav appears when the file completes.
* `kind: app` has no special runtime yet beyond the auth hooks; a heavier "pro" tier (Cloudflare sandbox containers) is deliberately later.
