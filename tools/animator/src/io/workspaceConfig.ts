// ── Workspace config ────────────────────────────────────────────────────────
// Supabase connection for the shared online workspace. Values are injected at
// build time by webpack DefinePlugin from NW_SUPABASE_URL / NW_SUPABASE_ANON_KEY.
// When unset (e.g. local dev with no Supabase project), both are '' and the
// workspace UI shows a "not configured" notice — the editor still works fully
// offline (IndexedDB auto-save + .tao/.tao.editor download).
//
// Design: design/tools/animator/WORKSPACE_SYNC.md §3

export const SUPABASE_URL      = __NW_SUPABASE_URL__;
export const SUPABASE_ANON_KEY = __NW_SUPABASE_ANON_KEY__;

/** Private Storage bucket holding all team animations. */
export const WORKSPACE_BUCKET  = 'animations';

/** Top-level prefix; objects live at `units/<unitKey>/<name>.tao(.editor)`. */
export const WORKSPACE_PREFIX  = 'units';

export function isWorkspaceConfigured(): boolean {
  return SUPABASE_URL.length > 0 && SUPABASE_ANON_KEY.length > 0;
}
