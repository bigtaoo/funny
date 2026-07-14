// Capacity signal (BOTSVC_DESIGN §4): polls gateway's EXISTING GET /internal/stats (OPS_DESIGN §4.1/§8
// admin monitoring endpoint) — no new gateway code needed, botsvc just reuses the same online-count.
export class CapacityClient {
  constructor(
    private readonly gatewayInternalUrl: string,
    private readonly internalKey: string,
  ) {}

  async onlineCount(): Promise<number> {
    const res = await fetch(`${this.gatewayInternalUrl}/internal/stats`, {
      headers: { 'x-internal-key': this.internalKey },
    });
    if (!res.ok) throw new Error(`gateway /internal/stats failed: ${res.status}`);
    const body = (await res.json()) as { online: number };
    return body.online;
  }
}

/**
 * Linear shedding curve (BOTSVC_DESIGN §4): full targetOnline below shedStartAt, ramps to 0 at shedFullAt,
 * clamped in between. Real players are never queued or kicked by this function — it only ever shrinks
 * the bot fleet's own footprint, which is the whole point of shedding bots first (B5).
 */
export function shedTarget(opts: {
  targetOnline: number;
  currentOnline: number;
  shedStartAt: number;
  shedFullAt: number;
}): number {
  const { targetOnline, currentOnline, shedStartAt, shedFullAt } = opts;
  if (currentOnline <= shedStartAt) return targetOnline;
  if (currentOnline >= shedFullAt) return 0;
  const ramp = (currentOnline - shedStartAt) / (shedFullAt - shedStartAt);
  return Math.round(targetOnline * (1 - ramp));
}
