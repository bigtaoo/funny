// Hidden-DOM-input overlays: the create-form field editor (name/tag) and the channel message sender.
import { ORG_NAME_WIDTH_MAX, truncateOrgName } from '@nw/shared';
import { type Constructor, type SectSceneBaseCtor } from './base';

export interface InputHandlers {
  openInputFor(field: 'name' | 'tag'): void;
  openSendInput(): void;
}

export function InputMixin<TBase extends SectSceneBaseCtor>(Base: TBase): TBase & Constructor<InputHandlers> {
  return class extends Base {
    openInputFor(field: 'name' | 'tag'): void {
      this.createField = field;
      this.caretOn = true;
      this.caretTimer = 0;
      const inp = document.createElement('input');
      inp.type = 'text';
      inp.value = field === 'name' ? this.createName : this.createTag;
      // name is width-capped (full-width = 2, cap 12) in the input handler; tag is a plain 5-char cap.
      inp.maxLength = field === 'name' ? ORG_NAME_WIDTH_MAX : 5;
      inp.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0;';
      document.body.appendChild(inp);
      inp.focus();
      inp.addEventListener('input', () => {
        if (field === 'name') {
          const clipped = truncateOrgName(inp.value, ORG_NAME_WIDTH_MAX);
          if (clipped !== inp.value) inp.value = clipped;
          this.createName = clipped;
        } else {
          this.createTag = inp.value.toUpperCase();
        }
        if (!this.destroyed) this.render();
      });
      inp.addEventListener('blur', () => {
        this.createField = null;
        inp.remove();
        if (!this.destroyed) this.render();
      });
      this.hiddenInput = inp;
    }

    openSendInput(): void {
      if (this.hiddenInput) { this.hiddenInput.remove(); this.hiddenInput = null; }
      this.channelActive = true;
      this.caretOn = true;
      this.caretTimer = 0;
      const inp = document.createElement('input');
      inp.type = 'text';
      inp.maxLength = 200;
      inp.value = this.channelInput;
      inp.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0;';
      document.body.appendChild(inp);
      inp.focus();
      inp.addEventListener('input', () => {
        this.channelInput = inp.value;
        if (!this.destroyed) this.render();
      });
      inp.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') void this.doSendChannelMessage();
      });
      inp.addEventListener('blur', () => {
        this.channelActive = false;
        if (this.hiddenInput === inp) this.hiddenInput = null;
        inp.remove();
        if (!this.destroyed) this.render();
      });
      this.hiddenInput = inp;
    }
  };
}
