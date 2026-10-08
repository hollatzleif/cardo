import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';
import {
  WEB_VIEWPORT,
  buildCsp,
  buildHeadTags,
  buildManifest,
  renderServiceWorker,
} from '../src/web/pwaBuild';

/**
 * Turns the `vite build --mode web` output into an installable iPhone
 * home-screen app: manifest, icons, head tags with a CSP, and a service
 * worker that precaches the shell. Only active in web mode – the Tauri build
 * never sees any of it.
 */
const ICONS: Array<[string, string]> = [
  ['icons/icon-180.png', '../src-tauri/icons/ios/AppIcon-60x60@3x.png'],
  ['icons/icon-512.png', '../src-tauri/icons/icon.png'],
  ['icons/icon-1024.png', '../src-tauri/icons/ios/AppIcon-512@2x.png'],
];

function readJson<T>(relative: string): T {
  return JSON.parse(readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')) as T;
}

export function cardoPwa(): Plugin {
  // Shell colors come from the default theme, so there is no color literal here.
  const theme = readJson<{ palette: Record<string, string> }>(
    '../../../packages/themes/catppuccin-mocha.json',
  );
  const pkg = readJson<{ version: string }>('../package.json');
  const themeColor = theme.palette['base'] ?? '';

  return {
    name: 'cardo-pwa',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler(html) {
        const tags = buildHeadTags({ title: 'Cardo', themeColor, csp: buildCsp() });
        return html
          .replace(/<meta name="viewport"[^>]*>/, `<meta name="viewport" content="${WEB_VIEWPORT}" />`)
          .replace(/(<meta charset="[^"]*" \/>)/, `$1\n    ${tags}`);
      },
    },
    generateBundle(_options, bundle) {
      this.emitFile({
        type: 'asset',
        fileName: 'manifest.webmanifest',
        source: JSON.stringify(
          buildManifest({
            name: 'Cardo',
            shortName: 'Cardo',
            description: 'Cardo – dein Dreh- und Angelpunkt. Local-first Dashboard.',
            themeColor,
            backgroundColor: themeColor,
            lang: 'de',
          }),
          null,
          2,
        ),
      });
      for (const [fileName, source] of ICONS) {
        this.emitFile({
          type: 'asset',
          fileName,
          source: readFileSync(fileURLToPath(new URL(source, import.meta.url))),
        });
      }
      const files = Object.keys(bundle).filter((f) => !f.endsWith('.map'));
      const precache = ['./', ...files, 'manifest.webmanifest', ...ICONS.map(([f]) => f)];
      const version = `${pkg.version}-${createHash('sha256').update(files.sort().join('|')).digest('hex').slice(0, 10)}`;
      this.emitFile({ type: 'asset', fileName: 'sw.js', source: renderServiceWorker(version, precache) });
      this.emitFile({ type: 'asset', fileName: 'version.json', source: JSON.stringify({ version }) });
    },
  };
}
