// worldsvc combat domain: march start / recall / listing + arrival processing & dispatch (S8-2).
// Thin assembly file, same convention as combatSiege.ts over ./combatSiege/*.
//
// The service is composed by holding three independent sibling instances — command (player-issued
// orders), arrival (scheduler-driven settlement, the only one that needs `siege`) and stationed
// (parked-team listing/recall) — each constructed with its own slice of `(core, siege)`. No shared
// base class, no mixin chain (2026-08-11: converted from the `XMixin(Base)` chain per
// claudedocs/server.md's "拆分形态的优先级" 形态② — command/arrival/stationed never called each
// other's methods, so the inheritance chain bought nothing here). MarchService stays exported HERE
// so importers (`from './combatMarch'` in combat.ts) keep resolving to this file, not the directory.
// To add a handler: find the matching domain class or add a new one — do NOT grow this file, and do
// NOT let the domains import each other.
import { WorldCore } from './core';
import type { SiegeService } from './combatSiege';
import { CommandService } from './combatMarch/command';
import { ArrivalService } from './combatMarch/arrival';
import { StationedService } from './combatMarch/stationed';

/**
 * MarchService — march lifecycle: departure, in-flight recall, arrival settlement and stationing.
 * Constructed as `new MarchService(core, siege)`; composed from three independent sibling classes.
 */
export class MarchService {
  private readonly command: CommandService;
  private readonly arrival: ArrivalService;
  private readonly stationed: StationedService;

  constructor(core: WorldCore, siege: SiegeService) {
    this.command = new CommandService(core);
    this.arrival = new ArrivalService(core, siege);
    this.stationed = new StationedService(core);
  }

  // ── command ──
  startMarch(...args: Parameters<CommandService['startMarch']>) { return this.command.startMarch(...args); }
  recallMarch(...args: Parameters<CommandService['recallMarch']>) { return this.command.recallMarch(...args); }
  instantReturnMarch(...args: Parameters<CommandService['instantReturnMarch']>) { return this.command.instantReturnMarch(...args); }
  getMarches(...args: Parameters<CommandService['getMarches']>) { return this.command.getMarches(...args); }

  // ── arrival ──
  processDueArrivals(...args: Parameters<ArrivalService['processDueArrivals']>) { return this.arrival.processDueArrivals(...args); }

  // ── stationed ──
  recallStationed(...args: Parameters<StationedService['recallStationed']>) { return this.stationed.recallStationed(...args); }
  getStationed(...args: Parameters<StationedService['getStationed']>) { return this.stationed.getStationed(...args); }
}
