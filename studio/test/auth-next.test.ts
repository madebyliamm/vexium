// auth.html honours ?next= only for same-site /studio/ paths. Run the REAL function from the page against hostile input.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const html = readFileSync(new URL('../../auth.html', import.meta.url), 'utf8');
const src = /function postAuthDest\(\) \{[\s\S]*?\n  \}\n/.exec(html)?.[0];

function dest(search: string): string {
  assert.ok(src, 'postAuthDest() not found in auth.html');
  return new Function('location', src + '; return postAuthDest();')({ search }) as string;
}

test('studio paths are honoured (hash routes included)', () => {
  assert.equal(dest('?next=' + encodeURIComponent('/studio/')), '/studio/');
  assert.equal(dest('?next=' + encodeURIComponent('/studio/#/p/abc123')), '/studio/#/p/abc123');
  assert.equal(dest('?tab=signin&next=' + encodeURIComponent('/studio/#/system')), '/studio/#/system');
});

test('everything else falls back to home.html (no open redirect)', () => {
  for (const bad of [
    '', '?next=', '?next=home.html', '?next=/home.html', '?next=/studio', '?next=//evil.com', '?next=/studio//evil.com',
    '?next=https://evil.com/studio/', '?next=' + encodeURIComponent('//evil.com/studio/'), '?next=' + encodeURIComponent('/studio/\\evil.com'),
    '?next=' + encodeURIComponent('javascript:alert(1)'), '?next=' + encodeURIComponent('/studio/ x'), '?next=' + encodeURIComponent('/studio/<script>'),
  ]) assert.equal(dest(bad), 'home.html', bad);
});
