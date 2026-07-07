// Internal calls from admin to business services (OPS_DESIGN §4.1). admin holds X-Internal-Key as a privileged internal caller.
// Same shape as commercialClient / gatewayClient: HTTP implementation + interface (easy to inject fakes in tests).
// Barrel: each backend service's client lives in its own file under ./clients/. Re-exported here so existing importers keep working.
export * from './clients/stats';
export * from './clients/player';
export * from './clients/anticheat';
export * from './clients/mismatch';
export * from './clients/suspiciousPve';
export * from './clients/analytics';
export * from './clients/mail';
export * from './clients/world';
export * from './clients/auction';
export * from './clients/ladder';
export * from './clients/events';
export * from './clients/gachaPools';
export * from './clients/promo';
