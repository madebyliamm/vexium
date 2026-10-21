// Style tokens + vibe controls — run:  node --test supabase/tests/style.test.ts
// The pure module the studio (live re-skin) and ai-chat (spec from CSS) share: supabase/functions/_shared/style.ts.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isSafeFontUrl, isSafeTokenValue, validateArtifact, type StyleSpec } from '../functions/_shared/artifacts.ts';
import {
  ACCENTS,
  applyStyleSpec,
  applyTokens,
  contrastRatio,
  DENSITIES,
  densityOf,
  deriveStyleSpec,
  FONT_PAIRINGS,
  hexOf,
  manifestWithStyle,
  mergeFontUrls,
  pairingOf,
  parseColor,
  parseTokens,
  readableOn,
  readFontImport,
  readVibe,
  setFontImport,
  themeOf,
  themeTokens,
  TONES,
  withVibe,
} from '../functions/_shared/style.ts';

const CSS = `@import url('https://fonts.googleapis.com/css2?family=Fraunces:wght@400;700&family=Inter:wght@400;600&display=swap');
/* brand tokens */
:root {
  --bg: #f6f1e9;  --surface: #ffffff;  --surface-2: #efe8dc;  --border: #e2d8c8;
  --text: #1f1a17;  --text-muted: #6b6258;
  --accent: #b4532a;  --accent-contrast: #ffffff;
  --font-display: 'Fraunces', Georgia, serif;  --font-body: 'Inter', system-ui, sans-serif;
  --radius: 12px;  --radius-lg: 20px;
  --shadow-sm: 0 1px 2px rgba(0,0,0,.06);  --shadow-lg: 0 20px 50px -12px rgba(0,0,0,.2);
  --container: 1200px;  --nav-h: 68px;  --section-y: clamp(80px, 12vw, 160px)
}
* { box-sizing: border-box; }
body { background: var(--bg); color: var(--text); font-family: var(--font-body); }
@media (max-width: 700px) { :root { --nav-h: 56px; } .hero { padding: 0; } }
.card { --wax: #e8c090; background: var(--surface); }
`;

describe('colour helpers', () => {
  it('parses hex, rgb and hsl', () => {
    assert.deepEqual(parseColor('#fff'), { r: 255, g: 255, b: 255 });
    assert.deepEqual(parseColor('#1F1A17'), { r: 31, g: 26, b: 23 });
    assert.deepEqual(parseColor('rgb(10, 20, 30)'), { r: 10, g: 20, b: 30 });
    assert.deepEqual(parseColor('rgb(10 20 30 / 50%)'), { r: 10, g: 20, b: 30 });
    assert.equal(hexOf('hsl(0 100% 50%)'), '#ff0000');
    assert.equal(hexOf('hsl(120, 100%, 25%)'), '#008000');
  });
  it('returns null for anything that is not a plain colour', () => {
    for (const v of ['red', 'var(--x)', 'color-mix(in srgb, red 10%, blue)', '', '#12', 'linear-gradient(red, blue)']) assert.equal(parseColor(v), null, v);
    assert.equal(hexOf(undefined), null);
  });
  it('picks the readable text colour', () => {
    assert.equal(readableOn('#4f46e5'), '#ffffff');
    assert.equal(readableOn('#f59e0b'), '#111111');
    assert.equal(readableOn('#ffffff'), '#111111');
    assert.equal(readableOn('#000000'), '#ffffff');
  });
});

describe('parseTokens', () => {
  it('reads the :root block, ignoring :root inside @media and tokens on other selectors', () => {
    const t = parseTokens(CSS);
    assert.equal(t['--accent'], '#b4532a');
    assert.equal(t['--section-y'], 'clamp(80px, 12vw, 160px)');
    assert.equal(t['--font-display'], "'Fraunces', Georgia, serif");
    assert.equal(t['--nav-h'], '68px', 'the @media :root must not override');
    assert.equal(t['--wax'], undefined, 'artwork tokens on .card are not site tokens');
  });
  it('handles comments, strings with semicolons, and a missing final semicolon', () => {
    const t = parseTokens(`:root{ /* a */ --a: 1px /* b */; --b: "x;y"; --c: url(data:image/svg+xml;utf8,<svg/>) ; --d: 4px }`);
    assert.deepEqual(t, { '--a': '1px', '--b': '"x;y"', '--c': 'url(data:image/svg+xml;utf8,<svg/>)', '--d': '4px' });
  });
  it('merges several top-level :root rules (later wins)', () => {
    assert.deepEqual(parseTokens(':root{--a:1} body{x:y} :root{--a:2;--b:3}'), { '--a': '2', '--b': '3' });
  });
  it('returns nothing for a stylesheet without :root, or an unterminated one', () => {
    assert.deepEqual(parseTokens('body{color:red}'), {});
    assert.deepEqual(parseTokens(':root{--a:1'), { '--a': '1' });
    assert.deepEqual(parseTokens(''), {});
  });
});

describe('applyTokens', () => {
  it('replaces values in place and touches nothing else', () => {
    const out = applyTokens(CSS, { '--accent': '#112233', '--radius': '4px' });
    assert.equal(out, CSS.replace('--accent: #b4532a', '--accent: #112233').replace('--radius: 12px', '--radius: 4px'));
  });
  it('is a no-op when the values are already there', () => {
    assert.equal(applyTokens(CSS, parseTokens(CSS)), CSS);
  });
  it('is idempotent', () => {
    const once = applyTokens(CSS, { '--accent': '#112233', '--new': '1px' });
    assert.equal(applyTokens(once, { '--accent': '#112233', '--new': '1px' }), once);
  });
  it('appends missing tokens to the first :root, adding the missing semicolon', () => {
    const out = applyTokens(CSS, { '--extra': '3px' });
    assert.ok(out.includes('--section-y: clamp(80px, 12vw, 160px);\n  --extra: 3px;\n}'), out);
    assert.equal(parseTokens(out)['--extra'], '3px');
    assert.equal(parseTokens(out)['--section-y'], 'clamp(80px, 12vw, 160px)');
  });
  it('appends to an empty :root', () => {
    assert.equal(parseTokens(applyTokens(':root{}', { '--a': '1' }))['--a'], '1');
  });
  it('creates a :root after the @import lines when there is none', () => {
    const out = applyTokens("@import url('https://fonts.googleapis.com/css2?family=Inter');\nbody{margin:0}", { '--a': '1' });
    assert.ok(out.startsWith("@import url('https://fonts.googleapis.com/css2?family=Inter');\n:root {\n  --a: 1;\n}"), out);
    assert.deepEqual(parseTokens(out), { '--a': '1' });
    assert.ok(applyTokens('body{margin:0}', { '--a': '1' }).startsWith(':root {\n  --a: 1;\n}\n\nbody'));
  });
  it('updates a token in every top-level :root that declares it, but leaves the @media one alone', () => {
    const out = applyTokens(':root{--a:1} :root{--a:2} @media (x){:root{--a:9}}', { '--a': '5' });
    assert.equal(out, ':root{--a:5} :root{--a:5} @media (x){:root{--a:9}}');
  });
  it('ignores names and values that are not safe', () => {
    const bad = { 'bad name': '1', '--ok': 'red; } body { display: none', '--c': 'a /* b', '--d': 'x}', '--e': 'v\nw', '--f': 'a'.repeat(201), '--g': '' };
    assert.equal(applyTokens(CSS, bad), CSS);
  });
  it('survives a comment that contains braces and colons', () => {
    const css = '/* :root { --evil: 1 } */\n:root { --a: 1; }';
    assert.equal(applyTokens(css, { '--a': '2' }), '/* :root { --evil: 1 } */\n:root { --a: 2; }');
  });
});

describe('font import', () => {
  it('reads the import and merges several into one', () => {
    assert.equal(readFontImport(CSS), 'https://fonts.googleapis.com/css2?family=Fraunces:wght@400;700&family=Inter:wght@400;600&display=swap');
    const two = `@import url("https://fonts.googleapis.com/css2?family=A:wght@400&display=swap");\n@import url(https://fonts.googleapis.com/css2?family=B:wght@500;700&display=swap);\nbody{}`;
    assert.equal(readFontImport(two), 'https://fonts.googleapis.com/css2?family=A:wght@400&family=B:wght@500;700&display=swap');
    assert.equal(readFontImport('body{}'), undefined);
    assert.equal(mergeFontUrls([]), undefined);
  });
  it('replaces the import (all of them) with exactly one at the top', () => {
    const url = 'https://fonts.googleapis.com/css2?family=Poppins:wght@500&display=swap';
    const out = setFontImport(CSS, url);
    assert.ok(out.startsWith(`@import url('${url}');\n`));
    assert.equal(out.match(/@import/g)!.length, 1);
    assert.equal(setFontImport(out, url), out, 'idempotent');
    assert.ok(out.includes(':root {'), 'the rest of the file is intact');
  });
  it('removes it when there is no font url, and keeps @charset first', () => {
    assert.ok(!setFontImport(CSS, undefined).includes('@import'));
    const out = setFontImport('@charset "utf-8";\nbody{}', 'https://fonts.googleapis.com/css2?family=Inter');
    assert.ok(out.startsWith('@charset "utf-8";\n@import url('), out);
  });
  it('never writes a url that could break out of the @import', () => {
    for (const u of ["https://fonts.googleapis.com/css2?family=A');body{display:none}/*", 'https://evil.example/x.css', 'https://fonts.googleapis.com/a b', 'https://fonts.googleapis.com/a\\b']) {
      assert.equal(isSafeFontUrl(u), false, u);
      assert.ok(!setFontImport('body{}', u).includes('@import'), u);
    }
  });
});

describe('density, theme, pairing', () => {
  it('derives density from the largest length in --section-y', () => {
    assert.equal(densityOf('clamp(80px, 12vw, 160px)'), 'airy');
    assert.equal(densityOf('96px'), 'compact');
    assert.equal(densityOf('6rem'), 'compact');
    assert.equal(densityOf('7rem'), 'comfortable');
    assert.equal(densityOf('var(--x)'), 'comfortable');
    assert.equal(densityOf(undefined), 'comfortable');
    for (const d of DENSITIES) assert.equal(densityOf(d.sectionY), d.id, `${d.id} round-trips`);
  });
  it('derives the theme from the background', () => {
    assert.equal(themeOf('#f6f1e9'), 'light');
    assert.equal(themeOf('#0b0b14'), 'dark');
    assert.equal(themeOf('hsl(220 20% 8%)'), 'dark');
    assert.equal(themeOf('var(--x)'), 'light');
    assert.equal(themeOf(undefined), 'light');
  });
  it('knows its font pairings', () => {
    assert.equal(pairingOf({ display: 'Fraunces', body: 'Inter' }), 'editorial');
    assert.equal(pairingOf({ display: ' fraunces ', body: 'INTER' }), 'editorial');
    assert.equal(pairingOf({ display: 'Lobster', body: 'Inter' }), null);
    for (const p of FONT_PAIRINGS) {
      assert.equal(isSafeFontUrl(p.importUrl), true, p.id);
      assert.equal(isSafeTokenValue(p.displayStack) && isSafeTokenValue(p.bodyStack), true, p.id);
      assert.equal(pairingOf(p), p.id);
    }
  });
});

describe('deriveStyleSpec', () => {
  it('reads tokens, fonts, theme and density from the CSS — the CSS is the truth', () => {
    const { spec, problems } = deriveStyleSpec(CSS, { tone: 'warm and friendly', voice: 'Talk like a neighbour.' });
    assert.deepEqual(problems, []);
    assert.equal(spec.locked, false);
    assert.equal(spec.tokens['--accent'], '#b4532a');
    assert.deepEqual(spec.fonts, { display: 'Fraunces', body: 'Inter', import_url: 'https://fonts.googleapis.com/css2?family=Fraunces:wght@400;700&family=Inter:wght@400;600&display=swap' });
    assert.deepEqual(spec.vibe, { theme: 'light', density: 'airy', tone: 'warm and friendly' });
    assert.equal(spec.voice, 'Talk like a neighbour.');
    assert.deepEqual(validateArtifact('style_spec', spec), { ok: true, value: spec });
  });
  it('fills in the standard tokens the model left out, so the spec is complete', () => {
    const { spec, problems } = deriveStyleSpec(':root{--bg:#0b0b14;--text:#eee;--accent:#7c3aed}');
    assert.deepEqual(problems, []);
    assert.equal(spec.vibe.theme, 'dark');
    for (const k of ['--surface', '--surface-2', '--border', '--text-muted', '--accent-contrast', '--font-display', '--font-body', '--radius', '--radius-lg', '--shadow-sm', '--shadow-lg', '--container', '--nav-h', '--section-y']) {
      assert.ok(spec.tokens[k], k);
    }
    assert.equal(spec.tokens['--accent-contrast'], '#ffffff');
    assert.equal(spec.vibe.tone, 'clear and confident', 'a default tone when the model gave none');
    assert.equal(validateArtifact('style_spec', spec).ok, true);
    // …and writing it back puts them in the stylesheet
    const written = applyStyleSpec(':root{--bg:#0b0b14;--text:#eee;--accent:#7c3aed}', spec);
    assert.deepEqual(parseTokens(written), spec.tokens);
  });
  it('reports a stylesheet that has no usable style', () => {
    assert.deepEqual(deriveStyleSpec('body{color:red}').problems, ['the stylesheet has no --bg colour', 'the stylesheet has no --text colour', 'the stylesheet has no --accent colour']);
    assert.equal(deriveStyleSpec(':root{--bg:#fff;--text:#000}').problems.length, 1);
  });
  it('drops unsafe token values instead of copying them', () => {
    const { spec } = deriveStyleSpec(':root{--bg:#fff;--text:#000;--accent:#00f;--evil:"a}b";--ok2:3px}');
    assert.equal(spec.tokens['--evil'], undefined);
    assert.equal(spec.tokens['--ok2'], '3px');
  });
  it('treats the model\'s tone / voice / art direction as untrusted', () => {
    const base = ':root{--bg:#fff;--text:#000;--accent:#00f}';
    assert.equal(deriveStyleSpec(base, { tone: 42, voice: ['x'], art_direction: 'nope' }).spec.vibe.tone, 'clear and confident');
    const s = deriveStyleSpec(base, { tone: 'x'.repeat(500), voice: 'y'.repeat(900), art_direction: { archetype: 'split hero' } }).spec;
    assert.equal(s.vibe.tone.length, 80);
    assert.equal(s.voice!.length, 300);
    assert.deepEqual(s.art_direction, { archetype: 'split hero' });
    assert.equal(deriveStyleSpec(base, { art_direction: { big: 'z'.repeat(5000) } }).spec.art_direction, undefined);
    assert.equal(deriveStyleSpec(base, { art_direction: [1] }).spec.art_direction, undefined);
  });
  it('takes the font names from the font tokens, whatever the quoting', () => {
    const { spec } = deriveStyleSpec(`:root{--bg:#fff;--text:#000;--accent:#00f;--font-display:"DM Sans",sans-serif;--font-body:Inter}`);
    assert.deepEqual(spec.fonts, { display: 'DM Sans', body: 'Inter' });
  });
});

describe('withVibe — the vibe controls are pure token swaps', () => {
  const spec = (): StyleSpec => deriveStyleSpec(CSS, { tone: 'a gentle, bookish feel' }).spec;

  it('reads the controls from a spec', () => {
    assert.deepEqual(readVibe(spec()), { theme: 'light', accent: '#b4532a', pairing: 'editorial', density: 'airy', tone: null });
  });
  it('changes only the accent when the colour changes', () => {
    const a = spec();
    const b = withVibe(a, { accent: '#2563eb' });
    assert.equal(b.tokens['--accent'], '#2563eb');
    assert.equal(b.tokens['--accent-contrast'], readableOn('#2563eb'));
    assert.equal(b.tokens['--bg'], a.tokens['--bg'], 'the neutrals stay');
    assert.deepEqual(b.fonts, a.fonts);
  });
  it('switches the neutrals with the theme, tinted by the accent', () => {
    const dark = withVibe(spec(), { theme: 'dark' });
    assert.equal(dark.vibe.theme, 'dark');
    assert.equal(themeOf(dark.tokens['--bg']), 'dark');
    assert.equal(dark.tokens['--accent'], '#b4532a', 'the accent is kept');
    assert.equal(dark.tokens['--text'], themeTokens('dark', '#b4532a')['--text']);
    const back = withVibe(dark, { theme: 'light' });
    assert.equal(themeOf(back.tokens['--bg']), 'light');
    assert.equal(back.vibe.theme, 'light');
  });
  it('does not reset the AI\'s own palette when the theme is "changed" to what it already is', () => {
    const a = spec();
    assert.deepEqual(withVibe(a, { theme: 'light' }), a);
  });
  it('swaps fonts everywhere they are recorded', () => {
    const b = withVibe(spec(), { pairing: 'technical' });
    assert.equal(b.tokens['--font-display'], FONT_PAIRINGS.find((p) => p.id === 'technical')!.displayStack);
    assert.deepEqual(b.fonts, { display: 'Space Grotesk', body: 'DM Sans', import_url: FONT_PAIRINGS.find((p) => p.id === 'technical')!.importUrl });
    assert.equal(readVibe(b).pairing, 'technical');
    // …and the stylesheet follows
    const css = applyStyleSpec(CSS, b);
    assert.equal(readFontImport(css), b.fonts.import_url);
    assert.equal(parseTokens(css)['--font-display'], b.tokens['--font-display']);
    assert.ok(!css.includes('Fraunces'));
  });
  it('sets density and tone, and tone also records the voice', () => {
    const b = withVibe(spec(), { density: 'compact', tone: 'playful' });
    assert.equal(b.tokens['--section-y'], DENSITIES[0]!.sectionY);
    assert.equal(b.vibe.density, 'compact');
    assert.equal(b.vibe.tone, 'playful and fun');
    assert.equal(b.tokens['--radius'], '20px');
    assert.equal(b.voice, TONES.find((t) => t.id === 'playful')!.voice);
    assert.equal(readVibe(b).tone, 'playful');
    assert.equal(readVibe(b).density, 'compact');
  });
  it('ignores unknown ids and colours it cannot read, never mutates its input, and keeps `locked`', () => {
    const a = spec();
    const frozen = JSON.stringify(a);
    const b = withVibe({ ...a, locked: true }, { pairing: 'nope', density: 'huge' as never, tone: 'nope', accent: 'red', theme: 'purple' as never });
    assert.equal(JSON.stringify(a), frozen);
    assert.equal(b.locked, true);
    assert.deepEqual({ ...b, locked: false }, a);
  });
  it('every result passes the artifact validator and is safe to write into a stylesheet', () => {
    for (const theme of ['light', 'dark'] as const)
      for (const accent of ACCENTS)
        for (const p of FONT_PAIRINGS) {
          const s = withVibe(spec(), { theme, accent: accent.hex, pairing: p.id, density: 'airy', tone: 'bold' });
          assert.equal(validateArtifact('style_spec', s).ok, true, `${theme} ${accent.id} ${p.id}`);
        }
  });
  it('keeps text readable on every theme and accent', () => {
    for (const theme of ['light', 'dark'] as const)
      for (const accent of ACCENTS) {
        const s = withVibe(deriveStyleSpec(CSS).spec, { theme, accent: accent.hex });
        const c = (k: string) => parseColor(s.tokens[k]!)!;
        assert.ok(contrastRatio(c('--text'), c('--bg')) >= 7, `text on bg ${theme}`);
        assert.ok(contrastRatio(c('--text-muted'), c('--bg')) >= 4.5, `muted on bg ${theme}`);
        assert.ok(contrastRatio(c('--text-muted'), c('--surface')) >= 4.5, `muted on surface ${theme}`);
        assert.ok(contrastRatio(c('--accent-contrast'), c('--accent')) >= 4.5, `${accent.id}: text on accent`);
      }
  });
  it('re-skinning the stylesheet leaves every rule outside :root exactly as it was', () => {
    const b = withVibe(spec(), { theme: 'dark', accent: '#7c3aed', density: 'compact', pairing: 'bold', tone: 'elegant' });
    const out = applyStyleSpec(CSS, b);
    const rules = (s: string) => s.slice(s.indexOf('* { box-sizing'));
    assert.equal(rules(out), rules(CSS));
    assert.ok(out.includes('/* brand tokens */'));
    assert.deepEqual(parseTokens(out), { ...parseTokens(CSS), ...b.tokens });
  });
});

describe('manifestWithStyle', () => {
  it('follows the palette', () => {
    const out = JSON.parse(manifestWithStyle('{"name":"Bean","background_color":"#fff","theme_color":"#000"}', { tokens: { '--bg': 'rgb(1, 2, 3)', '--accent': '#7c3aed' } }));
    assert.deepEqual(out, { name: 'Bean', background_color: '#010203', theme_color: '#7c3aed' });
  });
  it('keeps the old colour when the token is not a plain colour, and leaves unreadable JSON alone', () => {
    const out = JSON.parse(manifestWithStyle('{"background_color":"#fff"}', { tokens: { '--bg': 'color-mix(in srgb, red, blue)' } }));
    assert.equal(out.background_color, '#fff');
    assert.equal(manifestWithStyle('not json', { tokens: {} }), 'not json');
    assert.equal(manifestWithStyle('[1]', { tokens: {} }), '[1]');
  });
});

describe('validateStyleSpec hardening', () => {
  const ok = (): StyleSpec => deriveStyleSpec(CSS).spec;
  it('refuses token values that could close a rule or a comment', () => {
    for (const v of ['red; } body{display:none', 'a /* b', 'x */ y', '1px\n2px', 'a\\b', '<x>']) {
      const s = ok();
      s.tokens['--x'] = v;
      assert.equal(validateArtifact('style_spec', s).ok, false, JSON.stringify(v));
    }
  });
  it('refuses a font url that could break out of the @import', () => {
    const s = ok();
    s.fonts.import_url = "https://fonts.googleapis.com/css2?family=A');body{}";
    assert.equal(validateArtifact('style_spec', s).ok, false);
  });
  it('accepts the stock font urls', () => {
    for (const p of FONT_PAIRINGS) assert.equal(validateArtifact('style_spec', withVibe(ok(), { pairing: p.id })).ok, true, p.id);
  });
});
