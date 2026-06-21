// Re-export shim — this module's real source lives in @nw/engine (SLG_DESIGN §16.7).
// 装备 → 蓝图注入（EQUIPMENT_DESIGN §9，E1）。客户端/测试经此深引用，源码与服务端同字节。
export * from '@nw/engine/balance/equipment';
