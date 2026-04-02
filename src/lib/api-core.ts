import { invoke } from '@tauri-apps/api/core';
import { handlePreviewInvoke } from '@/lib/api-preview-mocks';

const isDev = import.meta.env.DEV;

function isTauriDesktopRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (typeof error === 'object' && error !== null) {
    const anyErr = error as Record<string, unknown>;
    if (typeof anyErr.message === 'string' && anyErr.message) return anyErr.message;
    if (typeof anyErr.error === 'string' && anyErr.error) return anyErr.error;
    if (typeof anyErr.err === 'string' && anyErr.err) return anyErr.err;
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }

  return String(error);
}

export async function safeInvoke<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  try {
    if (isTauriDesktopRuntime()) {
      return await invoke<T>(command, args);
    }

    if (isDev) console.warn(`[Preview] invoking ${command}`);
    return await handlePreviewInvoke<T>(command, args);
  } catch (error) {
    if (isDev) console.error(`Raw invoke error for ${command}:`, error);
    const message = getErrorMessage(error);
    if (isDev) console.error(`Processed error message for ${command}:`, message);
    throw new Error(message || 'Unknown error (empty message)');
  }
}