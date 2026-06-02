/**
 * Attachment Points panel — edits shadow / hit offsets.
 * Each point follows a parent bone; offset is relative to that bone's tip.
 *
 * DOM is built once; attachment:change only syncs values so focus is preserved.
 */
import type { EventBus, AppEvents } from '../core/EventBus';
import type { AppState } from '../core/AppState';
import type { AttachmentPoint } from '../core/types';
import { Skeleton } from '../skeleton/Skeleton';

// Bones available as parent (excludes root since it's implicit for shadow anyway)
const BONE_OPTIONS = ['root', 'spine', 'head',
  'r_upper_arm', 'r_lower_arm', 'l_upper_arm', 'l_lower_arm',
  'r_upper_leg', 'r_lower_leg', 'l_upper_leg', 'l_lower_leg',
];

export class AttachmentPanel {
  private builtIds = new Set<string>();

  constructor(
    private readonly el: HTMLElement,
    private readonly bus: EventBus<AppEvents>,
    private readonly state: AppState,
  ) {
    this.build();
    bus.on('attachment:change', () => this.syncValues());
  }

  // ── Build (once) ──────────────────────────────────────────────────────────

  private build(): void {
    this.el.innerHTML = '';
    this.builtIds.clear();

    this.state.attachmentPoints.forEach(pt => {
      this.builtIds.add(pt.id);
      const section = document.createElement('div');
      section.dataset.ptId = pt.id;
      section.style.cssText = 'padding:8px;border-bottom:1px solid var(--border)';

      const isShadow = pt.id === 'shadow';

      section.innerHTML = `
        <div class="bone-name" style="font-size:12px;margin-bottom:6px">${pt.label}</div>
        <div class="prop-row">
          <span class="prop-label">Parent Bone</span>
          <select id="apt-${pt.id}-bone" style="flex:1;font-size:11px">
            ${BONE_OPTIONS.map(b => {
              const def = Skeleton.BONE_MAP.get(b);
              return `<option value="${b}"${b === pt.parentBone ? ' selected' : ''}>${def?.label ?? b}</option>`;
            }).join('')}
          </select>
        </div>
        <div class="prop-row">
          <span class="prop-label">Offset X</span>
          <input class="prop-input" type="number"
            id="apt-${pt.id}-x" value="${pt.offsetX}" step="1" style="width:55px">
        </div>
        <div class="prop-row">
          <span class="prop-label">Offset Y</span>
          <input class="prop-input" type="number"
            id="apt-${pt.id}-y" value="${pt.offsetY}" step="1" style="width:55px">
        </div>
        ${isShadow ? `
        <div class="prop-row" style="margin-top:4px">
          <span class="prop-label" style="font-size:10px;color:var(--text-dim)">Shadow W</span>
          <input class="prop-input" type="number"
            id="apt-${pt.id}-sw" value="${pt.shadowW ?? ''}" placeholder="auto"
            step="1" style="width:55px" title="Ellipse half-width; leave empty for auto">
        </div>
        <div class="prop-row">
          <span class="prop-label" style="font-size:10px;color:var(--text-dim)">Shadow H</span>
          <input class="prop-input" type="number"
            id="apt-${pt.id}-sh" value="${pt.shadowH ?? ''}" placeholder="auto"
            step="1" style="width:55px" title="Ellipse half-height; leave empty for auto">
        </div>
        ` : ''}
      `;

      this.wireListeners(section, pt.id, isShadow);
      this.el.appendChild(section);
    });
  }

  private wireListeners(section: HTMLElement, ptId: string, isShadow: boolean): void {
    const commit = () => {
      const existing = this.state.attachmentPoints.get(ptId);
      if (!existing) return;

      const boneEl = section.querySelector<HTMLSelectElement>(`#apt-${ptId}-bone`);
      const xEl    = section.querySelector<HTMLInputElement>(`#apt-${ptId}-x`);
      const yEl    = section.querySelector<HTMLInputElement>(`#apt-${ptId}-y`);

      const updated: AttachmentPoint = {
        ...existing,
        parentBone: boneEl?.value ?? existing.parentBone,
        offsetX:    parseNum(xEl?.value, existing.offsetX),
        offsetY:    parseNum(yEl?.value, existing.offsetY),
      };

      if (isShadow) {
        const swEl = section.querySelector<HTMLInputElement>(`#apt-${ptId}-sw`);
        const shEl = section.querySelector<HTMLInputElement>(`#apt-${ptId}-sh`);
        const sw = swEl?.value.trim();
        const sh = shEl?.value.trim();
        updated.shadowW = sw ? parseFloat(sw) || undefined : undefined;
        updated.shadowH = sh ? parseFloat(sh) || undefined : undefined;
      }

      this.state.setAttachmentPoint(updated);
    };

    section.querySelectorAll<HTMLElement>('input, select').forEach(el => {
      el.addEventListener('change', commit);
    });
  }

  // ── Sync without rebuilding DOM ───────────────────────────────────────────

  private syncValues(): void {
    const pts = this.state.attachmentPoints;
    const newIds = [...pts.keys()];
    const same = newIds.length === this.builtIds.size && newIds.every(id => this.builtIds.has(id));
    if (!same) { this.build(); return; }

    pts.forEach(pt => {
      syncInput(`apt-${pt.id}-x`,    String(pt.offsetX));
      syncInput(`apt-${pt.id}-y`,    String(pt.offsetY));
      syncSelect(`apt-${pt.id}-bone`, pt.parentBone);
      if (pt.id === 'shadow') {
        syncInput(`apt-${pt.id}-sw`, pt.shadowW != null ? String(pt.shadowW) : '');
        syncInput(`apt-${pt.id}-sh`, pt.shadowH != null ? String(pt.shadowH) : '');
      }
    });
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseNum(val: string | undefined, fallback: number): number {
  if (val === undefined) return fallback;
  const n = parseFloat(val);
  return isNaN(n) ? fallback : n;
}

function syncInput(id: string, value: string): void {
  const el = document.getElementById(id) as HTMLInputElement | null;
  if (el && document.activeElement !== el) el.value = value;
}

function syncSelect(id: string, value: string): void {
  const el = document.getElementById(id) as HTMLSelectElement | null;
  if (el && document.activeElement !== el) el.value = value;
}
