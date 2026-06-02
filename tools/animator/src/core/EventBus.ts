// ── AppEvents ─────────────────────────────────────────────────────────────────

export interface AppEvents {
  // Bone interaction
  'bone:select':    string | null;
  'bone:rotate':    { id: string; delta: number };

  // Time / playback
  'time:change':    number;
  'play:state':     boolean;

  // Animation management
  'anim:select':    string;
  'anim:list':      void;
  'kf:change':      void;

  // Atlas / binding
  'atlas:change':   void;
  'binding:change': string;          // boneId

  // Preview mode
  'preview:mode':   'skeleton' | 'sprite';

  // Undo/Redo
  'history:change': { canUndo: boolean; canRedo: boolean; label: string };

  // Attachment points
  'attachment:change': void;

  // Misc
  'status':         string;
  'pose:reset':     void;
}

// ── EventBus<T> ───────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Listener<P> = (payload: P) => void;

/** When the event payload is void, the emit call takes no payload argument. */
type EmitArgs<T extends object, K extends keyof T> =
  T[K] extends void ? [event: K] : [event: K, payload: T[K]];

export class EventBus<T extends object> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly registry = new Map<keyof T, Set<Listener<any>>>();

  /** Subscribe to an event. Returns an unsubscribe function. */
  on<K extends keyof T>(event: K, fn: Listener<T[K]>): () => void {
    let set = this.registry.get(event);
    if (!set) { set = new Set(); this.registry.set(event, set); }
    set.add(fn);
    return () => this.off(event, fn);
  }

  off<K extends keyof T>(event: K, fn: Listener<T[K]>): void {
    this.registry.get(event)?.delete(fn);
  }

  emit<K extends keyof T>(...args: EmitArgs<T, K>): void {
    const [event, payload] = args as [K, T[K]];
    this.registry.get(event)?.forEach(fn => fn(payload));
  }
}
