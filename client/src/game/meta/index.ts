// Meta-system save module public API (S0-1~5).
export * from './SaveData';
export { migrate } from './migrate';
export { LocalSaveStore, type SaveStore } from './SaveStore';
export { SaveManager, type SaveManagerOpts } from './SaveManager';
export {
  ReplayStore,
  REPLAY_STORAGE_KEY,
  MAX_REPLAYS,
  type ReplayEntry,
} from './ReplayStore';
