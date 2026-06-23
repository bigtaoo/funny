// ── WorkspaceStore ──────────────────────────────────────────────────────────
// Supabase-backed shared workspace: auth (magic-link) + Storage read/write for
// the team's animations. Mirrors the shape of the local ProjectStore but the
// backend is a cloud bucket so edits sync across the editor / other people, and
// (via the GitHub Action bridge) back into the git repo.
//
// Objects live at `units/<unitKey>/<name>.tao.editor` (re-editable master) and
// `units/<unitKey>/<name>.tao` (browser-built runtime bundle). The `.tao.editor`
// drives the listing; the `.tao` is uploaded alongside on every save.
//
// Design: design/tools/animator/WORKSPACE_SYNC.md §3 / §6

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import {
  SUPABASE_URL, SUPABASE_ANON_KEY, WORKSPACE_BUCKET, WORKSPACE_PREFIX,
  isWorkspaceConfigured,
} from './workspaceConfig';

const EDITOR_EXT = '.tao.editor';
const TAO_EXT    = '.tao';

export interface WorkspaceFile {
  unitKey:    string;   // folder under units/, e.g. "archer"
  name:       string;   // base name without extension, e.g. "archer"
  editorPath: string;   // units/<unitKey>/<name>.tao.editor
  taoPath:    string;   // units/<unitKey>/<name>.tao
  updatedAt:  number;   // epoch ms (0 when unknown)
}

export class WorkspaceStore {
  private readonly client: SupabaseClient | null;

  constructor() {
    this.client = isWorkspaceConfigured()
      ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
      : null;
  }

  isConfigured(): boolean {
    return this.client !== null;
  }

  // ── Auth ────────────────────────────────────────────────────────────────

  /** Email of the signed-in user, or null if signed out / unconfigured. */
  async currentEmail(): Promise<string | null> {
    if (!this.client) return null;
    const { data } = await this.client.auth.getUser();
    return data.user?.email ?? null;
  }

  /** Send a magic-link to `email`. The user clicks it to complete sign-in;
   *  `onAuthChange` then fires with their email. */
  async signIn(email: string): Promise<void> {
    if (!this.client) throw new Error('Workspace not configured');
    const { error } = await this.client.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: window.location.origin },
    });
    if (error) throw error;
  }

  async signOut(): Promise<void> {
    await this.client?.auth.signOut();
  }

  /** Subscribe to sign-in/sign-out; callback gets the current email or null. */
  onAuthChange(cb: (email: string | null) => void): void {
    this.client?.auth.onAuthStateChange((_event, session) => {
      cb(session?.user?.email ?? null);
    });
  }

  // ── Storage ───────────────────────────────────────────────────────────────

  /** List every `.tao.editor` master across all unit folders. */
  async list(): Promise<WorkspaceFile[]> {
    if (!this.client) return [];
    const bucket = this.client.storage.from(WORKSPACE_BUCKET);

    // Immediate children of `units/` — folders show up with id === null.
    const { data: folders, error } = await bucket.list(WORKSPACE_PREFIX, { limit: 1000 });
    if (error) throw error;

    const files: WorkspaceFile[] = [];
    for (const folder of folders ?? []) {
      if (folder.id !== null) continue;            // skip stray files at top level
      const unitKey = folder.name;
      const { data: entries, error: e2 } =
        await bucket.list(`${WORKSPACE_PREFIX}/${unitKey}`, { limit: 1000 });
      if (e2) throw e2;
      for (const entry of entries ?? []) {
        if (!entry.name.endsWith(EDITOR_EXT)) continue;
        const name = entry.name.slice(0, -EDITOR_EXT.length);
        files.push({
          unitKey,
          name,
          editorPath: `${WORKSPACE_PREFIX}/${unitKey}/${entry.name}`,
          taoPath:    `${WORKSPACE_PREFIX}/${unitKey}/${name}${TAO_EXT}`,
          updatedAt:  entry.updated_at ? Date.parse(entry.updated_at) : 0,
        });
      }
    }
    return files.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async download(path: string): Promise<Blob> {
    if (!this.client) throw new Error('Workspace not configured');
    const { data, error } = await this.client.storage.from(WORKSPACE_BUCKET).download(path);
    if (error) throw error;
    if (!data) throw new Error(`No data at ${path}`);
    return data;
  }

  /** Upload (overwrite) the editor master + runtime bundle for one unit. */
  async save(unitKey: string, name: string, editorBlob: Blob, taoBlob: Blob): Promise<void> {
    if (!this.client) throw new Error('Workspace not configured');
    const bucket = this.client.storage.from(WORKSPACE_BUCKET);
    const base = `${WORKSPACE_PREFIX}/${unitKey}/${name}`;
    const up1 = await bucket.upload(`${base}${EDITOR_EXT}`, editorBlob, {
      upsert: true, contentType: 'application/octet-stream',
    });
    if (up1.error) throw up1.error;
    const up2 = await bucket.upload(`${base}${TAO_EXT}`, taoBlob, {
      upsert: true, contentType: 'application/octet-stream',
    });
    if (up2.error) throw up2.error;
  }
}
