// Hidden-input overlay + send flow for the family scene: text entry for the create form fields and
// the channel send box, plus actually sending whatever the send box collected.
//
// openSendInput()/submitMessage()/doSendMsg() are one unit on purpose: doSendMsg() (the Send button)
// opens the hidden input when there's no draft yet and submits it otherwise, and the Enter key inside
// the hidden input submits directly — "open" and "submit" are two faces of the same text-entry flow,
// not two domains. Splitting them across Input/Actions (as the pre-conversion mixin chain did) created
// a genuine bidirectional dependency (actions.ts→input.ts for openSendInput, input.ts→actions.ts for
// submitMessage); merging them here removes it entirely — InputPanel now depends only on DataPanel
// (loadChannel(), to reconcile the optimistic echo after sending), and nothing depends back on Input.
// (2026-08-11 converted from the former `XMixin(Base)` inheritance chain, per
// claudedocs/client-modules.md's split-form priority note — this is FamilyScene's one genuine
// bidirectional pair, called out in the task brief.)
import { ORG_NAME_WIDTH_MAX, truncateOrgName } from '@nw/shared';
import { ui as C } from '../../render/sketchUi';
import type { FamilyMessageView } from '../../net/WorldApiClient';
import { withTimeout } from '../../ui/busyTracker';
import type { FamilySceneCore } from './core';
import type { DataHandlers } from './data';

export interface InputHandlers {
  openInputFor(field: 'name' | 'tag'): void;
  openSendInput(): void;
  doSendMsg(): Promise<void>;
}

export class InputPanel implements InputHandlers {
  constructor(private readonly core: FamilySceneCore, private readonly data: DataHandlers) {}

  openInputFor(field: 'name' | 'tag'): void {
    const core = this.core;
    core.createField = field;
    core.caretOn = true;
    core.caretTimer = 0;
    const handle = core.cb.openTextInput({
      value: field === 'name' ? core.createName : core.createTag,
      // name is width-capped (full-width = 2, cap 12) in the input handler; tag is a plain 5-char cap.
      maxLength: field === 'name' ? ORG_NAME_WIDTH_MAX : 5,
      onInput: (value) => {
        if (field === 'name') {
          const clipped = truncateOrgName(value, ORG_NAME_WIDTH_MAX);
          if (clipped !== value) handle.setValue(clipped);
          core.createName = clipped;
        } else {
          core.createTag = value.toUpperCase();
        }
        // Only this field's string changed, and its panel/hit rect are fixed-width — rewrite that one
        // Text rather than rebuilding the form per keystroke (falls back to render() if the Text is
        // gone; see ./repaint.ts).
        if (!core.destroyed) core.repaint.setFieldValue(field === 'name' ? core.createName : core.createTag);
      },
      onComplete: () => {
        core.createField = null;
        if (core.hiddenInput === handle) core.hiddenInput = null;
        if (!core.destroyed) core.render();
      },
    });
    core.hiddenInput = handle;
  }

  openSendInput(): void {
    const core = this.core;
    core.caretOn = true;
    core.caretTimer = 0;
    const handle = core.cb.openTextInput({
      value: core.sendText,
      maxLength: 200,
      // Mirror the field into `sendText` so the on-canvas field shows the typed text + caret.
      // Without this the field stayed on the placeholder and typing looked like a no-op.
      onInput: (value) => {
        core.sendText = value;
        // Same one-Text keystroke path as the create form above (see ./repaint.ts).
        if (!core.destroyed) core.repaint.setFieldValue(core.sendText);
      },
      onConfirm: (value) => {
        const body = value.trim();
        handle.close();
        core.sendText = '';
        void this.submitMessage(body);
      },
      onComplete: () => {
        if (core.sendInput === handle) core.sendInput = null;
        if (!core.destroyed) core.render();
      },
    });
    core.sendInput = handle;
  }

  async doSendMsg(): Promise<void> {
    const core = this.core;
    // Source the body from core.sendText, not by reading the live session — tapping Send closes
    // the text-entry session first (its onComplete already nulled core.sendInput by the time this
    // click handler runs), so sendInput can be null here even though the user has typed text.
    // sendText mirrors the session's value on every keystroke, so it's always current regardless
    // of focus state.
    const body = core.sendText.trim();
    if (core.sendInput) { core.sendInput.close(); core.sendInput = null; }
    core.sendText = '';
    if (body) {
      await this.submitMessage(body);
    } else {
      this.openSendInput();
    }
  }

  async submitMessage(body: string): Promise<void> {
    const core = this.core;
    if (!body || !core.family || core.bt.busy) return;
    // Optimistic echo: show the sender's own message instantly instead of blocking on
    // POST + full channel refetch (two sequential round-trips ≈ 2–3s of frozen UI — the
    // "Send does nothing" complaint). The channel is stored newest-first (server sorts ts
    // desc) but rendered oldest-at-top, so prepend and scroll to the bottom so the new line
    // is in view. bt still guards against a second send firing mid-flight (e.g. Enter mashed
    // right after tapping Send) which used to insert duplicate optimistic lines.
    const optimistic: FamilyMessageView = {
      id: `pending-${body.length}-${core.messages.length}`,
      senderId: core.cb.myAccountId,
      senderName: core.cb.playerName,
      body,
      ts: Number.MAX_SAFE_INTEGER,
    };
    core.messages = [optimistic, ...core.messages];
    core.channelStick = true; // sending always snaps to the newest line (renderChannel pins to bottom)
    core.bt.start();
    if (!core.destroyed) core.render();
    try {
      await withTimeout(core.cb.worldApi.sendFamilyMessage(core.family.familyId, body, core.cb.playerName));
      await this.data.loadChannel(); // replaces the optimistic echo with the authoritative list
    } catch (err) {
      // Roll back the echo and surface the error.
      core.messages = core.messages.filter((m) => m !== optimistic);
      core.showToast(core.errorMsg(err), C.red);
    } finally {
      core.bt.stop();
    }
    if (!core.destroyed) core.render();
  }
}
