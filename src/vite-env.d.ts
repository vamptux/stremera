/// <reference types="vite/client" />

declare module '@tauri-apps/plugin-opener' {
  export function openUrl(url: string | URL, openWith?: 'inAppBrowser' | string): Promise<void>;
  export function openPath(path: string, openWith?: string): Promise<void>;
  export function revealItemInDir(path: string | string[]): Promise<void>;
}
