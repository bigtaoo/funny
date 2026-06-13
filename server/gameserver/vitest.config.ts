import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // 纯逻辑单测（Room / RoomManager），无需 Mongo / 真 WS：注入假 Connection。
    include: ['test/**/*.test.ts'],
  },
});
