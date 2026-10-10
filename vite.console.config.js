import {defineConfig} from 'vite';
export default defineConfig({publicDir:false,cacheDir:'node_modules/.vite-console',optimizeDeps:{entries:['console.html']},build:{outDir:'dist-console',rollupOptions:{input:'console.html'}}});
