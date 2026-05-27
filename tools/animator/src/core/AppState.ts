import type { SpriteBinding } from './types';
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

  // ── Preview / view options ────────────────────────────────────────────────

  private _previewMode:         'skeleton' | 'sprite' = 'skeleton';
  private _showSkeletonOverlay  = true;
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
}
