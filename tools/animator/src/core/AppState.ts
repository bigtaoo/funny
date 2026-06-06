import type { SpriteBinding, AttachmentPoint } from './types';
import type { EventBus, AppEvents } from './EventBus';

export class AppState {
  constructor(private readonly bus: EventBus<AppEvents>) {}

  // ── UI state ──────────────────────────────────────────────────────────────

  private _selectedBone: string | null = null;
  private _currentTime   = 0;
  private _isPlaying     = false;
  private _playSpeed     = 1;
  private _looping       = true;
  private _panOffsetX    = 0;
  private _panOffsetY    = 0;
  private _selectedKfTime: number | null = null;
  private _rootX = 0;
  private _rootY = 0;

  get selectedBone():   string | null { return this._selectedBone; }
  get currentTime():    number        { return this._currentTime; }
  get isPlaying():      boolean       { return this._isPlaying; }
  get playSpeed():      number        { return this._playSpeed; }
  get looping():        boolean       { return this._looping; }
  get panOffsetX():     number        { return this._panOffsetX; }
  get panOffsetY():     number        { return this._panOffsetY; }
  get selectedKfTime(): number | null { return this._selectedKfTime; }
  get rootX():          number        { return this._rootX; }
  get rootY():          number        { return this._rootY; }

  setSelectedBone(id: string | null): void {
    this._selectedBone = id;
    this.bus.emit('bone:select', id);
  }

  setCurrentTime(t: number): void {
    this._currentTime = t;
    this.bus.emit('time:change', t);
  }

  setPlaying(v: boolean): void {
    this._isPlaying = v;
    this.bus.emit('play:state', v);
  }

  setPlaySpeed(v: number): void  { this._playSpeed = v; }
  setLooping(v: boolean): void   { this._looping = v; }

  setPanOffset(x: number, y: number): void {
    this._panOffsetX = x;
    this._panOffsetY = y;
  }

  setRootPos(x: number, y: number): void {
    this._rootX = x;
    this._rootY = y;
  }

  setSelectedKfTime(t: number | null): void { this._selectedKfTime = t; }

  // ── Editor mode ───────────────────────────────────────────────────────────

  private _editorMode: 'skin' | 'animate' = 'animate';

  get editorMode(): 'skin' | 'animate' { return this._editorMode; }

  setEditorMode(mode: 'skin' | 'animate'): void {
    this._editorMode = mode;
    this.bus.emit('editor:mode', mode);
  }

  // ── Preview / view options ────────────────────────────────────────────────

  private _previewMode:         'skeleton' | 'sprite' = 'skeleton';
  private _showSkeletonOverlay  = false;
  private _showJoints           = true;
  private _showOnion            = false;
  private _showGuide            = false;
  private _showPivots           = false;
  private _backgroundColor      = 0xF5F0E8;

  get previewMode():        'skeleton' | 'sprite' { return this._previewMode; }
  get showSkeletonOverlay(): boolean               { return this._showSkeletonOverlay; }
  get showJoints():          boolean               { return this._showJoints; }
  get showOnion():           boolean               { return this._showOnion; }
  get showGuide():           boolean               { return this._showGuide; }
  get showPivots():          boolean               { return this._showPivots; }
  get backgroundColor():     number                { return this._backgroundColor; }

  setPreviewMode(mode: 'skeleton' | 'sprite'): void {
    this._previewMode = mode;
    this.bus.emit('preview:mode', mode);
  }

  setShowSkeletonOverlay(v: boolean): void { this._showSkeletonOverlay = v; }
  setShowJoints(v: boolean): void          { this._showJoints = v; }
  setShowOnion(v: boolean): void           { this._showOnion = v; }
  setShowGuide(v: boolean): void           { this._showGuide = v; }
  setShowPivots(v: boolean): void          { this._showPivots = v; }
  setBackgroundColor(hex: number): void    { this._backgroundColor = hex; }

  // ── Bone length scales (rig setup, per character) ─────────────────────────

  private _boneLengthScales = new Map<string, number>();

  get boneLengthScales(): ReadonlyMap<string, number> { return this._boneLengthScales; }

  getLengthScale(boneId: string): number { return this._boneLengthScales.get(boneId) ?? 1; }

  setLengthScale(boneId: string, scale: number): void {
    if (scale <= 0) return;
    if (Math.abs(scale - 1) < 1e-6) {
      this._boneLengthScales.delete(boneId);   // keep map sparse — 1.0 = no override
    } else {
      this._boneLengthScales.set(boneId, scale);
    }
    this.bus.emit('rig:change');
  }

  setAllLengthScales(scales: Record<string, number>): void {
    this._boneLengthScales = new Map(Object.entries(scales).filter(([, v]) => Math.abs(v - 1) >= 1e-6));
    this.bus.emit('rig:change');
  }

  // ── Sprite bindings ───────────────────────────────────────────────────────

  private _bindings = new Map<string, SpriteBinding>();

  get boneBindings(): ReadonlyMap<string, SpriteBinding> { return this._bindings; }

  setBinding(boneId: string, binding: SpriteBinding): void {
    this._bindings.set(boneId, binding);
    this.bus.emit('binding:change', boneId);
  }

  removeBinding(boneId: string): void {
    this._bindings.delete(boneId);
    this.bus.emit('binding:change', boneId);
  }

  getBinding(boneId: string): SpriteBinding | undefined {
    return this._bindings.get(boneId);
  }

  // ── Attachment points ─────────────────────────────────────────────────────

  private _attachments = new Map<string, AttachmentPoint>([
    // shadow: follows root (hip), offset downward to ground level
    // shadowW/H left absent → Renderer auto-computes from Skeleton rest pose
    ['shadow', { id: 'shadow', label: '🔵 Shadow', parentBone: 'root',  offsetX: 0, offsetY: 52 }],
    // hit: follows spine tip (shoulder/neck area), offset upward to chest
    ['hit',    { id: 'hit',    label: '✦ Hit',     parentBone: 'spine', offsetX: 0, offsetY: -30 }],
  ]);

  get attachmentPoints(): ReadonlyMap<string, AttachmentPoint> { return this._attachments; }

  setAttachmentPoint(pt: AttachmentPoint): void {
    this._attachments.set(pt.id, { ...pt });
    this.bus.emit('attachment:change');
  }

  setAllAttachmentPoints(pts: AttachmentPoint[]): void {
    this._attachments.clear();
    for (const pt of pts) this._attachments.set(pt.id, { ...pt });
    this.bus.emit('attachment:change');
  }
}
