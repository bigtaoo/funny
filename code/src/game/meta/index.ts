// 元系统存档模块公共 API（S0-1~5）。
export * from './SaveData';
export { migrate } from './migrate';
export { LocalSaveStore, type SaveStore } from './SaveStore';
export { SaveManager, type SaveManagerOpts } from './SaveManager';
