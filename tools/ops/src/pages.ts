// Ops admin page renderers (OPS_DESIGN §7). Pure DOM; visibility is determined by capabilities in app.ts.
// Barrel: each page renderer lives in its own module under pages/; shared plumbing (Ctx, showErr,
// showOk, sparkline, ms↔datetime helpers) is in pages/shared.ts.
export type { Ctx } from './pages/shared';
export { pageMonitor } from './pages/monitor';
export { pageAnalytics } from './pages/analytics';
export { pagePlayer } from './pages/player';
export { pageSuspicions } from './pages/suspicions';
export { pageTickets } from './pages/tickets';
export { pageAudit } from './pages/audit';
export { pageAccounts } from './pages/accounts';
export { pageLadderSeason } from './pages/ladder';
export { pageFlags } from './pages/flags';
export { pageEvents } from './pages/events';
export { pageSLGSeason } from './pages/slgSeason';
export { pageAuctionAudit } from './pages/auctionAudit';
export { pageGachaPools } from './pages/gachaPools';
export { pageSlgShop } from './pages/slgShop';
