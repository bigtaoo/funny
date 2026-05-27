import type { EventBus, AppEvents } from '../core/EventBus';
import type { AtlasController } from '../atlas/AtlasController';

export class AtlasPanel {
  private jsonFile:  File | null = null;
  private imageFile: File | null = null;

  constructor(
    private readonly el: HTMLElement,
    private readonly bus: EventBus<AppEvents>,
    private readonly atlasCtrl: AtlasController,
  ) {
    bus.on('atlas:change', () => this.render());
    this.buildImportUI();
    this.render();
  }

  private buildImportUI(): void {
    const header = this.el.querySelector('.panel-header');

    const row = document.createElement('div');
    row.style.cssText = 'padding:8px;display:flex;flex-direction:column;gap:6px;border-bottom:1px solid var(--border)';

    const jsonBtn = document.createElement('button');
    jsonBtn.className = 'sm';
    jsonBtn.textContent = '📄 Select JSON…';
    const jsonLabel = document.createElement('span');
    jsonLabel.style.cssText = 'font-size:10px;color:var(--text-dim);word-break:break-all';
    jsonLabel.textContent = 'No JSON selected';

    const imgBtn = document.createElement('button');
    imgBtn.className = 'sm';
    imgBtn.textContent = '🖼 Select Image…';
    const imgLabel = document.createElement('span');
    imgLabel.style.cssText = 'font-size:10px;color:var(--text-dim);word-break:break-all';
    imgLabel.textContent = 'No image selected';

    const importBtn = document.createElement('button');
    importBtn.className = 'primary sm';
    importBtn.textContent = '⬆ Import Atlas';

    const jsonInput = document.createElement('input');
    jsonInput.type   = 'file';
    jsonInput.accept = '.json';
    jsonInput.style.display = 'none';

    const imgInput = document.createElement('input');
    imgInput.type   = 'file';
    imgInput.accept = 'image/*';
    imgInput.style.display = 'none';

    jsonBtn.addEventListener('click', () => jsonInput.click());
    imgBtn.addEventListener('click',  () => imgInput.click());

    jsonInput.addEventListener('change', () => {
      this.jsonFile = jsonInput.files?.[0] ?? null;
      jsonLabel.textContent = this.jsonFile?.name ?? 'No JSON selected';
    });
    imgInput.addEventListener('change', () => {
      this.imageFile = imgInput.files?.[0] ?? null;
      imgLabel.textContent = this.imageFile?.name ?? 'No image selected';
    });

    importBtn.addEventListener('click', async () => {
      if (!this.jsonFile || !this.imageFile) {
        this.bus.emit('status', 'Select both JSON and image first');
        return;
      }
      try {
        await this.atlasCtrl.importAtlas(this.jsonFile, this.imageFile);
        this.jsonFile = this.imageFile = null;
        jsonLabel.textContent = imgLabel.textContent = 'Done';
      } catch (err) {
        this.bus.emit('status', `Atlas import failed: ${(err as Error).message}`);
      }
    });

    row.append(jsonBtn, jsonLabel, imgBtn, imgLabel, importBtn, jsonInput, imgInput);
    if (header?.nextSibling) {
      this.el.insertBefore(row, header.nextSibling);
    } else {
      this.el.appendChild(row);
    }
  }

  private render(): void {
    let listEl = this.el.querySelector('#atlas-frame-list') as HTMLElement | null;
    if (!listEl) {
      listEl = document.createElement('div');
      listEl.id = 'atlas-frame-list';
      listEl.style.cssText = 'flex:1;overflow-y:auto;padding:4px';
      this.el.appendChild(listEl);
    }

    listEl.innerHTML = '';

    this.atlasCtrl.atlases.forEach((asset, atlasId) => {
      const header = document.createElement('div');
      header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:4px 8px;font-size:10px;font-weight:700;color:var(--text-dim);text-transform:uppercase;letter-spacing:1px';

      const label = document.createElement('span');
      label.textContent = atlasId;

      const removeBtn = document.createElement('button');
      removeBtn.className = 'sm danger';
      removeBtn.textContent = '✕';
      removeBtn.style.padding = '1px 5px';
      removeBtn.addEventListener('click', () => this.atlasCtrl.removeAtlas(atlasId));

      header.append(label, removeBtn);
      listEl!.appendChild(header);

      asset.frames.forEach((frame, frameId) => {
        const item = document.createElement('div');
        item.style.cssText = 'padding:2px 8px;font-size:11px;color:var(--text-dim);cursor:default;white-space:nowrap;overflow:hidden;text-overflow:ellipsis';
        item.title = `${frameId} (${frame.w}×${frame.h})`;
        item.textContent = frameId;
        listEl!.appendChild(item);
      });
    });

    if (this.atlasCtrl.atlases.size === 0) {
      const hint = document.createElement('div');
      hint.className = 'hint-text';
      hint.textContent = 'No atlases loaded';
      listEl.appendChild(hint);
    }
  }
}
