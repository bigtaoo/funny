// Analytics collection/sampling config (A9-2, phase-1 hardcoded; phase-2 DB-configurable). Split
// out of ./defs.ts 2026-09-24 (defs.ts hit the 500-line gate again) — same treatment as
// ./userAgent.ts's split on 2026-09-20. Re-exported from defs.ts so every existing
// `from './defs'` import keeps resolving.

export interface EventConfig {
  enabled?: boolean;
  sample?: number;
}

export interface AnalyticsConfig {
  enabled: boolean;
  defaultSample: number;
  events: Record<string, EventConfig>;
}

export const DEFAULT_CONFIG: AnalyticsConfig = {
  enabled: true,
  defaultSample: 0.1,
  events: {
    session_start:  { sample: 1.0 },
    session_end:    { sample: 1.0 },
    screen_view:    { sample: 0.05 },
    game_start:     { sample: 1.0 },
    game_end:       { sample: 1.0 },
    // Post-match badge/title distribution (ANALYTICS_DESIGN §5.8). Low-frequency (one per match),
    // high-value for balance monitoring — 100% sampled so the badge_dist dashboard isn't skewed.
    match_badges:   { sample: 1.0 },
    level_attempt:  { sample: 1.0 },
    level_complete: { sample: 1.0 },
    level_abandon:  { sample: 1.0 },
    card_play:      { enabled: false },
    // shop_open was 0.5 while shop_buy/shop_close are 1.0, which made the §9.3 economy funnel read
    // roughly double the real conversion — the denominator was half-sampled and the numerator was not.
    // Both ends of a funnel have to share a rate; the volume saved was never worth a wrong number.
    shop_open:      { sample: 1.0 },
    shop_buy:       { sample: 1.0 },
    shop_close:     { sample: 1.0 },
    gacha_draw:     { sample: 1.0 },
    friend_add:     { sample: 1.0 },
    pvp_room_create:{ sample: 1.0 },
    pvp_match_start:{ sample: 1.0 },
    // Ranked-queue drop-off (ANALYTICS_DESIGN §5.5): leaving the queue, a failed friend-code join, and
    // the bot fallback are the three ways a player who wanted a match does not get one.
    pvp_queue_cancel: { sample: 1.0 },
    pvp_room_join:    { sample: 1.0 },
    pvp_room_error:   { sample: 1.0 },
    pvp_match_bot:    { sample: 1.0 },
    // Login/registration outcome (ANALYTICS_DESIGN §5.6): the first hard wall a new player meets.
    login_submit:   { sample: 1.0 },
    login_ok:       { sample: 1.0 },
    login_fail:     { sample: 1.0 },
    login_skip:     { sample: 1.0 },
    // Purchases, ads and every retention claim (ANALYTICS_DESIGN §5.4). These were all missing from
    // this table until 2026-09-20 and therefore fell back to defaultSample (0.1) — a 10% sample of a
    // per-device de-duplicated funnel does not scale the bars down, it randomises whether a given
    // device looks like it checked in at all. They are discrete, player-initiated, low-frequency
    // actions: far below the ui_click volume that is already at 1.0.
    iap_purchase:             { sample: 1.0 },
    starter_buy:              { sample: 1.0 },
    battlepass_buy:           { sample: 1.0 },
    battlepass_claim:         { sample: 1.0 },
    recharge_milestone_claim: { sample: 1.0 },
    promo_redeem:             { sample: 1.0 },
    fate_redeem:              { sample: 1.0 },
    ads_reward:               { sample: 1.0 },
    daily_checkin:            { sample: 1.0 },
    daily_reward_claim:       { sample: 1.0 },
    weekly_chest_claim:       { sample: 1.0 },
    event_claim:              { sample: 1.0 },
    // Progression sinks — the "is anyone using this system" half of the retention question.
    equip_craft:    { sample: 1.0 },
    equip_enhance:  { sample: 1.0 },
    equip_reforge:  { sample: 1.0 },
    equip_salvage:  { sample: 1.0 },
    equip_equip:    { sample: 1.0 },
    card_fuse:      { sample: 1.0 },
    card_lock:      { sample: 1.0 },
    siege_replay:   { sample: 1.0 },
    // Startup / load timing (ANALYTICS_DESIGN §5.1b, client/src/analytics/bootTimeline.ts). One of
    // each per session at most, so the volume is `session_start`-class — and the whole value is in
    // the RATIO between them (`boot` without a matching `load_time` = abandoned while loading), which
    // any sampling below 1.0 would turn into noise rather than a smaller version of itself.
    boot:           { sample: 1.0 },
    first_frame:    { sample: 1.0 },
    load_time:      { sample: 1.0 },
    // The crash pipeline's analytics-side mirror (ANALYTICS_DESIGN §5.6c): reported once, on the
    // startup that follows an unclean exit. Rare by construction — sampling it would mostly delete it.
    prev_session_crash: { sample: 1.0 },
    // Account-lifecycle bookends. gdpr_consent is the only signal that the consent dialog was
    // accepted at all, so sampling it would leave the top of the funnel with no anchor whatsoever.
    gdpr_consent:   { sample: 1.0 },
    account_delete: { sample: 1.0 },
    // Achievement funnel (S9-8, ANALYTICS_DESIGN §5.7): unlock toast → view wall → claim; 100% sampled (low-frequency, high-value).
    achievement_unlock_toast: { sample: 1.0 },
    achievement_view_wall:    { sample: 1.0 },
    achievement_claim:        { sample: 1.0 },
    // Onboarding milestones — fully sampled so the first-session funnel (A9-8) is accurate and
    // comparable to session_start (100%); tutorial_start/complete were previously falling back to
    // defaultSample (0.1), which would have distorted the tutorial completion rate.
    tutorial_start:    { sample: 1.0 },
    tutorial_complete: { sample: 1.0 },
    tutorial_skip:  { sample: 1.0 },
    // Intro-story funnel node (ONBOARDING_DESIGN §7, design-doc-audit-2026-07): the only step in the
    // funnel enumeration that previously had zero data — IntroScene wrote the local nw_seen_intro flag
    // but never called analytics.track. 100% sampled like tutorial_start/complete, same rationale.
    intro_complete: { sample: 1.0 },
    intro_skip:     { sample: 1.0 },
    // First-time feature-guide funnel (ONBOARDING_DESIGN §4.1/§7): showFeatureGuide/withGuide
    // (client/src/app/nav/lobby.ts) previously had zero analytics.track calls. feature_guide_replay is
    // reserved for the per-page "?" re-open button, which is not wired yet (ONBOARDING_DESIGN §8/§10) —
    // config is added ahead of time so it isn't missed once that UI lands.
    feature_guide_shown:  { sample: 1.0 },
    feature_guide_closed: { sample: 1.0 },
    feature_guide_replay: { sample: 1.0 },
    // Fine-grained tutorial-step / nav funnels (A9-9): must be 100% sampled, same reasoning as
    // tutorial_start/complete above — sampling them would distort the step-by-step drop-off.
    tutorial_step:  { sample: 1.0 },
    nav_checkpoint: { sample: 1.0 },
    login_gate_hit: { sample: 1.0 },
    churn_signal:   { sample: 1.0 },
    // Client render/frame-rate profile (ADR-083 follow-up): a periodic aggregate of fps + paint rate +
    // the resolution the backbuffer actually got, tagged with the active scene. Bounded client-side to
    // at most 6 per session (cache/PerfMonitor.ts), so 1.0 here costs less than session_start; sampling
    // it would defeat the point, which is per-device/per-host comparison (iOS dpr cap, WeChat maxFPS).
    render_profile: { sample: 1.0 },
    // Button-level clicks (A9-8). Fully sampled for now so first-day "which button" analysis is exact;
    // dial down here if lobby-click volume becomes a concern.
    ui_click:       { sample: 1.0 },
  },
};

export function getConfig(): AnalyticsConfig {
  return DEFAULT_CONFIG;
}
