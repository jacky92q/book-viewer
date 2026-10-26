import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// https://github.com/jacky92q/book-viewer 배포 주소(/book-viewer/)에 맞춘 설정
export default defineConfig({
  base: '/book-viewer/',
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon-192.svg', 'icon-512.svg'],
      manifest: {
        name: 'FoldBook - 나만의 3D 만화책 뷰어',
        short_name: 'FoldBook',
        description: '갤럭시 폴드 & 네이버 만화책 스타일 3D 책 넘김 모션을 지원하는 나만의 만화책 뷰어',
        theme_color: '#0f1117',
        background_color: '#0f1117',
        display: 'standalone',
        orientation: 'any',
        start_url: '/book-viewer/',
        scope: '/book-viewer/',
        icons: [
          {
            src: 'icon-192.svg',
            sizes: '192x192',
            type: 'image/svg+xml',
            purpose: 'any maskable'
          },
          {
            src: 'icon-512.svg',
            sizes: '512x512',
            type: 'image/svg+xml',
            purpose: 'any maskable'
          }
        ]
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,jpg,woff2}']
      }
    })
  ]
});
