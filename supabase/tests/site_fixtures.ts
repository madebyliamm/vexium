// Fixtures shared by the FULL BUILD tests (site_derive, verifier, build_handler).
import type { StyleSpec } from '../functions/_shared/artifacts.ts';

export const STYLE: StyleSpec = {
  schema: 1,
  locked: true,
  vibe: { theme: 'light', density: 'comfortable', tone: 'warm' },
  tokens: { '--bg': '#faf7f2', '--surface': '#ffffff', '--text': '#1f1a17', '--accent': '#b4532a', '--accent-contrast': '#ffffff' },
  fonts: { display: 'Fraunces', body: 'Inter', import_url: 'https://fonts.googleapis.com/css2?family=Fraunces&family=Inter&display=swap' },
};
export const EXAMPLE_CSS = `@import url('https://fonts.googleapis.com/css2?family=Lora&display=swap');
:root { --bg: #ffffff; --text: #000000; --accent: #00ff00; }
body { background: var(--bg); color: var(--text); }
`;

const head = (title: string) => `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/><meta name="description" content="Hand-poured soy candles from Wick &amp; Co."/><title>${title}</title><link rel="stylesheet" href="styles.css"/></head>`;
/** A complete, valid page: the shared files linked, the nav and footer slots, `main` inside. */
export const wrap = (title: string, main: string, tail = ''): string => `${head(title)}<body><header data-vx-nav></header><main>${main}</main><footer data-vx-footer></footer><script src="site.js"></script>${tail}</body></html>`;

/** The three pages of a small candle shop that pass every check: what a good model reply would be. */
export const HOME = wrap('Wick & Co', `<section class="hero" id="top"><h1>Candles poured by hand</h1><p>Small-batch soy candles in a handful of scents, poured one at a time and shipped to your door.</p><a class="btn" href="shop.html">Shop candles</a></section>
<section id="why"><h2>Why soy</h2><p>Soy wax burns cleanly and holds a scent well, so each candle fills a room without overpowering it.</p></section>`);
export const SHOP = wrap('Shop', `<section><h1>Shop</h1><article><h2>Amber candle</h2><p>Warm amber and cedar in a plain glass jar.</p><p class="price">$24</p><button data-vx-buy="candle">Buy now</button></article></section>`);
export const CONTACT = wrap('Contact', `<section><h1>Contact</h1><p>Questions about an order or a scent? Write to us and we will reply.</p><form data-vx-form="contact" data-vx-success="Thanks, we will be in touch."><label>Email <input type="email" name="email" required></label><label>Message <textarea name="message" required></textarea></label><button type="submit">Send</button><p data-vx-message></p></form></section>`);
