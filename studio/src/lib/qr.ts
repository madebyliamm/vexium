// QR code for the live address (REVAMP Step 12). The library only produces the grid of dark/light squares; the screen draws them as an
// <svg> (no innerHTML), so nothing here can inject markup. Pure and unit-tested (test/launch-view.test.ts).
import qrcode from 'qrcode-generator';

/** The QR grid for `text` (true = dark). Error correction "M" survives a smudge on a printed flyer. Empty / too long input → null. */
export function qrModules(text: string): boolean[][] | null {
  if (!text || text.length > 400) return null;
  try {
    const qr = qrcode(0, 'M'); // type 0 = pick the smallest version that fits
    qr.addData(text);
    qr.make();
    const n = qr.getModuleCount();
    return Array.from({ length: n }, (_, r) => Array.from({ length: n }, (_, c) => qr.isDark(r, c)));
  } catch {
    return null;
  }
}

/** One SVG path for all the dark squares (1 unit per square), so the whole code is a single element. */
export function qrPath(modules: readonly (readonly boolean[])[]): string {
  const parts: string[] = [];
  modules.forEach((row, r) => {
    let c = 0;
    while (c < row.length) {
      if (!row[c]) { c++; continue; }
      const start = c;
      while (c < row.length && row[c]) c++;
      parts.push(`M${start} ${r}h${c - start}v1h-${c - start}z`); // a run of dark squares in one row
    }
  });
  return parts.join('');
}
