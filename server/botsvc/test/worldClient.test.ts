import { describe, it, expect } from 'vitest';
import { WorldClient, type WorldTileSparseView } from '../src/worldClient';

const client = new WorldClient('http://unused');

describe('WorldClient.baseCoords', () => {
  it('parses {worldId}:{x}:{y} tileIds, including a worldId containing no digits', () => {
    expect(client.baseCoords({ joined: true, mainBaseTile: 's3-0:12:34' })).toEqual({ x: 12, y: 34 });
  });

  it('returns null when there is no base yet', () => {
    expect(client.baseCoords({ joined: true })).toBeNull();
  });

  it('returns null for a malformed tileId', () => {
    expect(client.baseCoords({ joined: true, mainBaseTile: 'not-a-tile-id' })).toBeNull();
  });
});

describe('WorldClient.pickAttackTarget', () => {
  const tile = (over: Partial<WorldTileSparseView>): WorldTileSparseView => ({
    x: 0,
    y: 0,
    type: 'territory',
    ...over,
  });

  it('picks the first occupied, non-mine attackable tile', () => {
    const tiles = [tile({ mine: true, x: 1, y: 1 }), tile({ mine: false, x: 2, y: 2 })];
    expect(client.pickAttackTarget(tiles)).toEqual({ x: 2, y: 2 });
  });

  it('ignores resource/neutral/obstacle tiles even when not mine', () => {
    const tiles = [
      tile({ type: 'resource', mine: false, x: 5, y: 5 }),
      tile({ type: 'neutral', mine: false, x: 6, y: 6 }),
      tile({ type: 'obstacle', mine: false, x: 7, y: 7 }),
    ];
    expect(client.pickAttackTarget(tiles)).toBeNull();
  });

  it('returns null when no candidates exist', () => {
    expect(client.pickAttackTarget([])).toBeNull();
  });
});
