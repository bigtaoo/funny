// Hidden-input overlay for the family scene: text entry for the create form fields and channel send box.
import { ui as C } from '../../render/sketchUi';
import { type Constructor, type FamilySceneBaseCtor } from './base';

export interface InputHandlers {
  openInputFor(field: 'name' | 'tag'): void;
  openSendInput(): void;
}

export function InputMixin<TBase extends FamilySceneBaseCtor>(Base: TBase): TBase & Constructor<InputHandlers> {
  return class extends Base {
    openInputFor(field: 'name' | 'tag'): void {
      this.createField = field;
      this.caretOn = true;
      this.caretTimer = 0;
      const inp = document.createElement('input');
      inp.type = 'text';
      inp.value = field === 'name' ? this.createName : this.createTag;
      inp.maxLength = field === 'name' ? 24 : 5;
      inp.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0;';
      document.body.appendChild(inp);
      inp.focus();
      inp.addEventListener('input', () => {
        if (field === 'name') this.createName = inp.value;
        else this.createTag = inp.value.toUpperCase();
        if (!this.destroyed) this.render();
      });
      inp.addEventListener('blur', () => {
        this.createField = null;
        document.body.removeChild(inp);
        if (!this.destroyed) this.render();
      });
      this.hiddenInput = inp;
    }

    openSendInput(): void {
      const inp = document.createElement('input');
      inp.type = 'text';
      inp.maxLength = 200;
      inp.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0;';
      document.body.appendChild(inp);
      inp.focus();
      inp.addEventListener('keydown', async (e) => {
        if (e.key === 'Enter') {
          const body = inp.value.trim();
          inp.remove();
          if (body && this.family) {
            try {
              await this.cb.worldApi.sendFamilyMessage(this.family.familyId, body, this.cb.playerName);
              await this.loadChannel();
              if (!this.destroyed) this.render();
            } catch (err) {
              this.showToast(this.errorMsg(err), C.red);
            }
          }
        }
      });
      inp.addEventListener('blur', () => { inp.remove(); });
    }
  };
}
