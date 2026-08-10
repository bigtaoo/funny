// Engine type declarations — enums, config/command shapes, blueprints, runtime/event shapes, and the
// public IGameEngine interface. Pure declarations, no logic (the deterministic core lives in game/).
//
// Split 2026-08-10 (server.md "单文件 500 行收敛", independent-function-modules shape, same pattern as
// shared/src/mongo.ts / worldsvc/src/db.ts): declarations grouped by domain into types/*.ts, each
// self-contained and importing only from lower-level domain files (enums → coords/blueprints/runtime →
// config/events → replay/engineInterface — a DAG, no cycles). This file is a thin re-export shell —
// external `from '@nw/engine'` / `from './types'` / `from '../types'` import paths are unchanged.
export * from './types/enums';
export * from './types/coords';
export * from './types/config';
export * from './types/replay';
export * from './types/blueprints';
export * from './types/runtime';
export * from './types/events';
export * from './types/engineInterface';
