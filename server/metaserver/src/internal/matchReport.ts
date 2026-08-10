// End-of-match settlement (M19): gameserver reports the result here; meta reconciles, settles ranked ELO
// (including Phase C peer-judge adjudication on hash mismatch), and archives the match + replay.
//
// ── Split (2026-08-10, independent function module range 6) ──
// This file was already a Fastify route-registration function (registerMatchReportRoutes) plus a set
// of mutually-independent free-function helpers sharing no class/instance state — a textbook
// independent-function-module split, by concern: `matchReport/{types,statSanitize,peerJudge,
// cardStats,eloSettlement,reportRoute,miscRoutes}.ts`. This file keeps only the top-level
// registration entry point, matching the sibling `internal/*Routes.ts` files' shape.
import type { FastifyInstance } from 'fastify';
import type { InternalCtx } from './context.js';
import { registerReportRoute } from './matchReport/reportRoute.js';
import { registerMiscMatchReportRoutes } from './matchReport/miscRoutes.js';

export function registerMatchReportRoutes(app: FastifyInstance, ctx: InternalCtx): void {
  registerReportRoute(app, ctx);
  registerMiscMatchReportRoutes(app, ctx);
}
