import {defineConfig} from 'vite';
export default defineConfig({
  optimizeDeps: {entries: ['index.html']},
  build: {
    assetsInlineLimit: 0,
    rollupOptions: {
      output: {
        manualChunks: {
          math: ['katex', 'rehype-katex', 'remark-math'],
          markdown: ['react-markdown']
        }
      }
    }
  }
});
