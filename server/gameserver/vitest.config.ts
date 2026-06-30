import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Pure logic unit tests (Room / RoomManager); no Mongo or real WS needed: inject a fake Connection.
    include: ['test/**/*.test.ts'],
  },
});
