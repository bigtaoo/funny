import { IAssetsManager } from './IAssetsManager';

let instance: IAssetsManager;

export function setAssetsManager(manager: IAssetsManager) {
  instance = manager;
}

export function AssetsManager(): IAssetsManager {
  if (!instance) {
    throw new Error('AssetsManager not initialized');
  }
  return instance;
}
