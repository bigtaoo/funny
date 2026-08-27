#!/usr/bin/env node
// mergeAssetAtlases.js — the specific atlas-merge jobs for client/src/assets
// (2026-07-27 asset cleanup). See mergeAtlasPages.js for the shared packer.
// Run: NODE_PATH="$(pwd)/client/node_modules" node art/scripts/mergeAssetAtlases.js
const path = require('path');
const { mergeGroup } = require('./mergeAtlasPages');

const ASSETS = path.resolve(__dirname, '../../client/src/assets');

async function main() {
  // L0 boot decor group: the two hand-drawn doodle atlases + the 4 standalone
  // battle corner-labels, all loaded together at app boot (bootManifest.ts).
  await mergeGroup({
    name: 'decor',
    outDir: path.join(ASSETS, 'decor'),
    outBase: 'decor_merged_atlas',
    maxWidth: 1024,
    sources: [
      { png: path.join(ASSETS, 'decor/battle/decor_atlas.png'), json: path.join(ASSETS, 'decor/battle/decor_atlas.json') },
      { png: path.join(ASSETS, 'decor/decor_c_atlas.png'), json: path.join(ASSETS, 'decor/decor_c_atlas.json') },
      { png: path.join(ASSETS, 'decor/battle/label_boss.png'), frameName: 'label_boss' },
      { png: path.join(ASSETS, 'decor/battle/label_start.png'), frameName: 'label_start' },
      { png: path.join(ASSETS, 'decor/battle/label_win.png'), frameName: 'label_win' },
      { png: path.join(ASSETS, 'decor/battle/label_arrow_here.png'), frameName: 'label_arrow_here' },
    ],
  });

  // L0 boot icon group: equipment/material/faction icon atlases — all small, all loaded
  // together at app boot. The avatars/ source that used to be a fourth entry here is gone:
  // presetAvatarArt.ts replaced those 8 white-line frames with standalone bust PNGs, and the
  // 2026-08-27 repack evicted them from the page (ASSET_PACKAGING.md §16.2). `maxWidth: 2048`
  // is kept for the record but is NOT what the shipped page uses — at 2048 these 17 frames
  // shelf-pack into one long row at 49.9% utilisation; the page was reflowed at 520
  // (93.1%, 1.54 MB of texture instead of 2.88).
  await mergeGroup({
    name: 'icons',
    outDir: path.join(ASSETS, 'icons'),
    outBase: 'icons_atlas',
    maxWidth: 2048,
    sources: [
      { png: path.join(ASSETS, 'equipment/equipment.png'), json: path.join(ASSETS, 'equipment/equipment.json') },
      { png: path.join(ASSETS, 'material/material.png'), json: path.join(ASSETS, 'material/material.json') },
      { png: path.join(ASSETS, 'factions/factions.png'), json: path.join(ASSETS, 'factions/factions.json') },
    ],
  });

  // World-map scene group: terrain/city/playerbase/res/building all load together
  // in WorldMapRenderer/lifecycle.ts's Promise.all; city_bld_atlas is CityScene's
  // (loads alongside res_atlas there) but shares the same merged page/cache.
  await mergeGroup({
    name: 'world',
    outDir: path.join(ASSETS, 'slg'),
    outBase: 'world_atlas',
    maxWidth: 2048,
    sources: [
      { png: path.join(ASSETS, 'slg/terrain_atlas.png'), json: path.join(ASSETS, 'slg/terrain_atlas.json') },
      { png: path.join(ASSETS, 'slg/city_atlas.png'), json: path.join(ASSETS, 'slg/city_atlas.json') },
      { png: path.join(ASSETS, 'slg/playerbase_atlas.png'), json: path.join(ASSETS, 'slg/playerbase_atlas.json') },
      { png: path.join(ASSETS, 'slg/res_atlas.png'), json: path.join(ASSETS, 'slg/res_atlas.json') },
      { png: path.join(ASSETS, 'slg/building_atlas.png'), json: path.join(ASSETS, 'slg/building_atlas.json') },
      { png: path.join(ASSETS, 'slg/city_bld_atlas.png'), json: path.join(ASSETS, 'slg/city_bld_atlas.json') },
    ],
  });
}

main().catch((err) => { console.error(err); process.exit(1); });
