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
    const inp = document.createElement('input');
    inp.type = 'text';
    inp.value = field === 'name' ? core.createName : core.createTag;
    // name is width-capped (full-width = 2, cap 12) in the input handler; tag is a plain 5-char cap.
    inp.maxLength = field === 'name' ? ORG_NAME_WIDTH_MAX : 5;
    inp.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0;';
    document.body.appendChild(inp);
    inp.focus();
    inp.addEventListener('input', () => {
      if (field === 'name') {
        const clipped = truncateOrgName(inp.value, ORG_NAME_WIDTH_MAX);
        if (clipped !== inp.value) inp.value = clipped;
        core.createName = clipped;
      } else {
        core.createTag = inp.value.toUpperCase();
      }
      if (!core.destroyed) core.render();
    });
    inp.addEventListener('blur', () => {
      core.createField = null;
      inp.remove();
      if (!core.destroyed) core.render();
    });
    core.hiddenInput = inp;
  }

  openSendInput(): void {
    const core = this.core;
    if (core.hiddenInput) { core.hiddenInput.remove(); core.hiddenInput = null; }
    core.channelActive = true;
    core.caretOn = true;
    core.caretTimer = 0;
    const inp = document.createElement('input');
    inp.type = 'text';
    inp.maxLength = 200;
    inp.value = core.channelInput;
    inp.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0;';
    document.body.appendChild(inp);
    inp.focus();
    inp.addEventListener('input', () => {
      core.channelInput = inp.value;
      if (!core.destroyed) core.render();
    });
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') void this.actions.doSendChannelMessage();
    });
    inp.addEventListener('blur', () => {
      core.channelActive = false;
      if (core.hiddenInput === inp) core.hiddenInput = null;
      inp.remove();
      if (!core.destroyed) core.render();
    });
    core.hiddenInput = inp;
  }
}
