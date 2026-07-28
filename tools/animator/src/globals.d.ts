// Build-time constants injected by webpack DefinePlugin (see webpack.config.js).
// Empty strings when unconfigured → the online workspace silently disables itself
// and the editor falls back to local-only (IndexedDB + file download).
declare const __NW_SUPABASE_URL__: string;
declare const __NW_SUPABASE_ANON_KEY__: string;

// Injected by the desktop shell (tools/desktop-shell) when this tool runs inside
// it as a BrowserView; undefined when run standalone (`npm start`). See
// design/tools/desktop-shell/DESIGN.md §3.
interface NwDesktopFileFilter {
  name: string;
  extensions: string[];
}

interface NwDesktopBridge {
  onRequestSave(cb: () => void | Promise<void>): () => void;
  onUpdateAvailable(cb: (info: { kind: 'app' | 'content'; toolId?: string }) => void): () => void;
  /** 本地磁盘文件读写（原生对话框 + 直接读写路径），见 design/tools/desktop-shell/DESIGN.md §3. */
  fs: {
    openFile(filters: NwDesktopFileFilter[]): Promise<{
      canceled: boolean;
      path?: string;
      data?: ArrayBuffer;
      error?: string;
    }>;
    writeFile(path: string, data: ArrayBuffer): Promise<{ ok: boolean; error?: string }>;
    saveFileAs(
      opts: { defaultPath?: string; filters: NwDesktopFileFilter[] },
      data: ArrayBuffer,
    ): Promise<{ canceled: boolean; path?: string; error?: string }>;
  };
}

interface Window {
  nwDesktop?: NwDesktopBridge;
}
