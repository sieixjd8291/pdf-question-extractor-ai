import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import {createHash} from 'crypto';
import fs from 'fs';
import path from 'path';
import {defineConfig, type Plugin} from 'vite';

function listPublicFiles(dir: string, base = ''): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, {withFileTypes: true}).flatMap((entry) => {
    const rel = `${base}/${entry.name}`;
    return entry.isDirectory() ? listPublicFiles(path.join(dir, entry.name), rel) : [rel];
  });
}

/** Emits /sw.js with every built chunk and public asset listed for precaching. */
function offlineServiceWorker(): Plugin {
  return {
    name: 'pdf-studio-offline-sw',
    apply: 'build',
    generateBundle(_options, bundle) {
      const builtFiles = Object.keys(bundle)
        .filter((file) => !file.endsWith('.map') && file !== 'index.html')
        .map((file) => `/${file}`);
      const publicFiles = listPublicFiles(path.resolve(__dirname, 'public')).filter(
        (file) => !file.endsWith('.map') && file !== '/sw.js'
      );
      const urls = [...new Set([...builtFiles, ...publicFiles])].sort();
      const version = createHash('sha256').update(urls.join('\n')).digest('hex').slice(0, 12);
      const template = fs.readFileSync(path.resolve(__dirname, 'scripts/sw-template.js'), 'utf8');
      this.emitFile({
        type: 'asset',
        fileName: 'sw.js',
        source: template
          .replace('__VERSION__', version)
          .replace('__PRECACHE__', JSON.stringify(urls.map(encodeURI))),
      });
    },
  };
}

export default defineConfig(() => {
  return {
    plugins: [react(), tailwindcss(), offlineServiceWorker()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, 'src'),
      },
      dedupe: ['react', 'react-dom'],
    },
    optimizeDeps: {
      // Lazily loaded tools import these; pre-bundling them up front prevents a
      // mid-session re-optimization that leaves the page with two React copies.
      include: [
        'react',
        'react-dom',
        'react-dom/client',
        'react/jsx-runtime',
        'react/jsx-dev-runtime',
        '@supabase/supabase-js',
        'jspdf',
        'jszip',
        'lucide-react',
        'onnxruntime-web/wasm',
        'pdf-lib',
        'pdfjs-dist',
        'zod',
      ],
    },
    build: {
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (!id.includes('node_modules')) return;
            if (/\/(?:react|react-dom|scheduler)\//.test(id)) return 'react-vendor';
          },
        },
      },
    },
    server: {
      allowedHosts: true,
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify—file watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
