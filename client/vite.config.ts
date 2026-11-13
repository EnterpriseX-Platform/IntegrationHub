import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'
import { readFileSync, existsSync } from 'fs'

// Read version from root package.json (falls back to client package.json in Docker)
function getAppVersion(): string {
  const rootPkg = resolve(__dirname, '../package.json')
  const localPkg = resolve(__dirname, 'package.json')
  try {
    const pkgPath = existsSync(rootPkg) ? rootPkg : localPkg
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
    return pkg.version || '0.0.0'
  } catch {
    return '0.0.0'
  }
}

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  // Load env file based on mode
  const env = loadEnv(mode, process.cwd(), '')

  return {
    plugins: [react()],
    define: {
      __APP_VERSION__: JSON.stringify(getAppVersion()),
    },
    base: env.VITE_BASE_PATH || '/integration',
    build: {
      outDir: 'dist',
      sourcemap: true,
      minify: 'esbuild',
      rollupOptions: {
        output: {
          manualChunks: {
            vendor: ['react', 'react-dom', 'react-router-dom'],
            ui: ['lucide-react'],
          },
          chunkFileNames: 'assets/js/[name]-[hash].js',
          entryFileNames: 'assets/js/[name]-[hash].js',
          assetFileNames: (assetInfo) => {
            const info = assetInfo.name.split('.')
            const ext = info[info.length - 1]
            if (/\.(png|jpe?g|gif|svg|webp|ico)$/i.test(assetInfo.name)) {
              return 'assets/images/[name]-[hash][extname]'
            }
            if (/\.css$/i.test(assetInfo.name)) {
              return 'assets/css/[name]-[hash][extname]'
            }
            return 'assets/[name]-[hash][extname]'
          },
        },
      },
      chunkSizeWarningLimit: 1000,
    },
    resolve: {
      alias: {
        '@': resolve(__dirname, './src'),
        '@components': resolve(__dirname, './src/components'),
        '@pages': resolve(__dirname, './src/pages'),
        '@hooks': resolve(__dirname, './src/hooks'),
        '@utils': resolve(__dirname, './src/utils'),
        '@types': resolve(__dirname, './src/types'),
      },
    },
    server: {
      port: 5173,
      host: true,
      proxy: {
        '/int/': {
          target: 'http://localhost:8137',
          changeOrigin: true,
        },
        '/deh/': {
          target: 'http://localhost:8137',
          changeOrigin: true,
        },
        '/health': {
          target: 'http://localhost:8137',
          changeOrigin: true,
        },
      },
    },
    preview: {
      port: 4173,
      host: true,
    },
  }
})
