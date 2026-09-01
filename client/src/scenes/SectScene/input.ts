// Hidden-DOM-input overlays: the create-form field editor (name/tag) and the channel message sender.
//
// InputPanel depends on ActionsPanel (via the narrow ActionHandlers subset it needs —
// doSendChannelMessage), which has no dependency back on Input: one-way, so a plain independent
// class over `core` + `actions` (2026-08-11 converted from the former `XMixin(Base)` inheritance
// chain, per claudedocs/client-modules.md's split-form priority note).
import { ORG_NAME_WIDTH_MAX, truncateOrgName } from '@nw/shared';
import type { SectSceneCore } from './core';

export interface InputHandlers {
  openInputFor(field: 'name' | 'tag'): void;
  openSendInput(): void;
}

/** Narrow slice of ActionsHandlers that InputPanel needs. */
export interface SendAction {
  doSendChannelMessage(): Promise<void>;
}

export class InputPanel implements InputHandlers {
  constructor(private readonly core: SectSceneCore, private readonly actions: SendAction) {}

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
    if (core.hiddenInput) { core.hiddenInput.close(); core.hiddenInput = null; }
    core.channelActive = true;
    core.caretOn = true;
    core.caretTimer = 0;
    const handle = core.cb.openTextInput({
      value: core.channelInput,
      maxLength: 200,
      onInput: (value) => {
        core.channelInput = value;
        // Same one-Text keystroke path as the create form above (see ./repaint.ts).
        if (!core.destroyed) core.repaint.setFieldValue(core.channelInput);
      },
      onConfirm: () => { void this.actions.doSendChannelMessage(); },
      onComplete: () => {
        core.channelActive = false;
        if (core.hiddenInput === handle) core.hiddenInput = null;
        if (!core.destroyed) core.render();
      },
    });
    core.hiddenInput = handle;
  }
}
