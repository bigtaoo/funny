// Single bot session (BOTSVC_DESIGN §3.2). This increment wires the parts that are pure REST and safe to
// drive headless today: login, family join/leave-on-low-activity, and payment-tier bootstrap. Matchmaking /
// battle (AISystem over a real gateway+gameserver WS connection, §1 B3) and SLG city actions (§3.2 slg_action)
// are the next increment — left as explicit extension points rather than faked, see BOTSVC_DESIGN §8.
import { MetaClient } from './metaClient';
import { SocialClient } from './socialClient';
import { CommercialClient } from './commercialClient';
import type { BotIdentity } from './pool';

/** Below this prosperity, a bot looks for a livelier family instead (mirrors a real player ditching a dead guild). */
const FAMILY_PROSPERITY_LEAVE_THRESHOLD = 10;

export type BotState = 'offline' | 'logging_in' | 'lobby_idle' | 'family_task';

export class BotSession {
  state: BotState = 'offline';
  private token: string | undefined;
  private accountId: string | undefined;
  private paymentBootstrapped = false;

  constructor(
    readonly identity: BotIdentity,
    private readonly meta: MetaClient,
    private readonly social: SocialClient,
    private readonly commercial: CommercialClient,
  ) {}

  async login(): Promise<void> {
    this.state = 'logging_in';
    const login = await this.meta.deviceLogin(this.identity.deviceId);
    this.token = login.token;
    this.accountId = login.accountId;
    if (!this.paymentBootstrapped) {
      await this.bootstrapPaymentTier();
      this.paymentBootstrapped = true;
    }
    this.state = 'lobby_idle';
  }

  logout(): void {
    this.token = undefined;
    this.accountId = undefined;
    this.state = 'offline';
  }

  /** Idempotent: safe to call again on every login (commercial dedupes on orderId; a real card is never re-bought). */
  private async bootstrapPaymentTier(): Promise<void> {
    if (!this.accountId) return;
    const orderId = `bot-${this.identity.deviceId}-${this.identity.paymentTier}`;
    if (this.identity.paymentTier === 'monthly_card') {
      await this.commercial.buyMonthlyCard(this.accountId, orderId);
    } else if (this.identity.paymentTier === 'starter_growth') {
      await this.commercial.buyStarterGrowth(this.accountId, orderId);
    }
  }

  /** One tick of family upkeep (§3.3): join if familyless, leave+re-search if the current family looks dead. */
  async tickFamily(): Promise<void> {
    if (!this.token) return;
    const mine = await this.social.myFamily(this.token);
    if (!mine) {
      const candidates = await this.social.searchFamilies(this.token, '');
      const pick = candidates[0];
      if (pick) await this.social.joinFamily(this.token, pick.tag);
      return;
    }
    if (mine.prosperity < FAMILY_PROSPERITY_LEAVE_THRESHOLD) {
      await this.social.leaveFamily(this.token);
    }
  }
}
