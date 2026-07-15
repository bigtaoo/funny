// worldsvc core — shared-state kernel (WorldCore god-class split, 2026-07-03).
// The base layer of the WorldCore inheritance chain: clients, deps, in-process
// sequences, cached capitals, bounds/coord primitives and the tiny marchView mapper
// that every higher layer (yield / push / nation / spawn / vision / map) builds on.
// No behavior change — methods copied verbatim from the original core.ts.
import { provinceCapitalPositions, worldSeed, type SlgShopPriceCache } from '@nw/shared';
import type { MarchDoc } from './db';
import { nullWorldGatewayClient, type WorldGatewayClient } from './gatewayClient';
import { nullWorldMetaClient, type WorldMetaClient } from './metaClient';
import { nullWorldCommercialClient, type WorldCommercialClient } from './commercialClient';
import { nullWorldMailClient, type WorldMailClient } from './mailClient';
import { nullWorldSocialsvcClient, type WorldSocialsvcClient } from './socialsvcClient';
import type { MarchView, WorldServiceDeps } from './worldTypes';

export class WorldCoreKernel {
  readonly gateway: WorldGatewayClient;
  readonly meta: WorldMetaClient;
  readonly commercial: WorldCommercialClient;
  readonly mail: WorldMailClient;
  /** In-process monotonic sequence number — ensures marchIds do not collide when multiple marches depart within the same millisecond. */
  marchSeq = 0;
  /** In-process monotonic sequence number — ensures siegeIds do not collide when multiple sieges resolve within the same millisecond. */
  siegeSeq = 0;
  /** Cached province-capital coordinate list, keyed by worldId (ADR-034: capitals are now seed-derived, not fixed by map size alone). */
  private _capitalsByWorld = new Map<string, readonly [number, number][]>();

  readonly socialsvc: WorldSocialsvcClient;
  /** SLG shop price/effect override cache; undefined = always uses SLG_SHOP_ITEMS code defaults. */
  readonly shopPrices: SlgShopPriceCache | undefined;

  constructor(readonly deps: WorldServiceDeps) {
    this.gateway = deps.gateway ?? nullWorldGatewayClient;
    this.meta = deps.meta ?? nullWorldMetaClient;
    this.commercial = deps.commercial ?? nullWorldCommercialClient;
    this.mail = deps.mail ?? nullWorldMailClient;
    this.socialsvc = deps.socialsvc ?? nullWorldSocialsvcClient;
    this.shopPrices = deps.shopPrices;
  }

  /** Province-capital coordinates for a given world (ADR-034: seed-derived, so keyed per worldId rather than a single map-wide cache). */
  capitalsFor(worldId: string): readonly [number, number][] {
    let caps = this._capitalsByWorld.get(worldId);
    if (!caps) {
      caps = provinceCapitalPositions(this.deps.mapW, this.deps.mapH, worldSeed(worldId));
      this._capitalsByWorld.set(worldId, caps);
    }
    return caps;
  }

  inBounds(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.deps.mapW && y < this.deps.mapH;
  }

  // tileId = `{worldId}:{x}:{y}`; extract coordinates (worldId itself contains no ':', so take the last two segments).
  coordX(tid: string): number {
    const p = tid.split(':');
    return Number(p[p.length - 2]);
  }
  coordY(tid: string): number {
    const p = tid.split(':');
    return Number(p[p.length - 1]);
  }

  marchView(m: MarchDoc): MarchView {
    return {
      marchId: m._id,
      kind: m.kind,
      fromTile: m.fromTile,
      toTile: m.toTile,
      troops: m.troops,
      departAt: m.departAt,
      arriveAt: m.arriveAt,
      status: m.status,
      ...(m.teamId ? { teamId: m.teamId } : {}),
    };
  }
}
