// Build-time constants injected by webpack DefinePlugin (see webpack.config.js).
// Empty strings when unconfigured → the online workspace silently disables itself
// and the editor falls back to local-only (IndexedDB + file download).
declare const __NW_SUPABASE_URL__: string;
declare const __NW_SUPABASE_ANON_KEY__: string;

// Injected by the desktop shell (tools/desktop-shell) when this tool runs inside
// it as a BrowserView; undefined when run standalone (`npm start`). See
// design/tools/desktop-shell/DESIGN.md §3.
interface NwDesktopBridge {
  onRequestSave(cb: () => void | Promise<void>): () => void;
  onUpdateAvailable(cb: (info: { kind: 'app' | 'content'; toolId?: string }) => void): () => void;
}

interface Window {
  nwDesktop?: NwDesktopBridge;
}
