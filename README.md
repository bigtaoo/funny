# Notebook Wars

A **hand-drawn turn-based strategy game**, playable in the browser and as a WeChat Mini Game, with a companion toolchain of standalone editors.

Beyond the core 1v1 battle described below, the game ships a full meta layer: an SLG open world (`worldsvc`), social systems including families and sects (`socialsvc`), a player-driven auction house (`auctionsvc`), gacha, equipment, and account progression — see [`design/README.md`](design/README.md) for the authoritative design index.

---

## Gameplay

Each side holds a base and fights to destroy the opponent's base by playing cards to deploy soldiers and construct buildings.

- **Hand system**: 6 cards that auto-rotate (a card unused for 30 s is automatically refreshed), played by spending ink
- **Units**: Infantry (cheap, swarm), ShieldBearer (high HP, slow), Archer (ranged)
- **Buildings**: Barracks (continuously produces units), Arrow Tower (attacks all enemies within range, in every direction)
- **Spells**: Haste Charge (speeds up your own units), Meteor Strike (instantly kills everything in a 2×2 area)
- **Base upgrades**: spend ink to raise your ink regen rate, up to 3 times
- **Time acceleration**: ink regen speeds up as the match runs long (three tiers at 3 / 6 / 10 minutes); after 13 minutes every unit's attack doubles; at 17 minutes the match is force-drawn

### Battlefield rules

```
Row 17 ── Enemy building row
Row 16 ── Enemy spawn row
  …         Combat zone (14 rows)
Row  1 ── Your spawn row
Row  0 ── Your building row (base occupies the central 2 columns)
```

Units advance vertically along their own column, then cross horizontally once they reach the enemy building row, finally reaching the base column to deal damage.

---

## Technical scope

### Main game (`client/`)

| Layer | Technology |
|---|---|
| Rendering | PixiJS Legacy (compatible with WeChat Mini Game WebGL) |
| Game logic | Pure TypeScript, fixed-point arithmetic, fully decoupled from rendering |
| Randomness | LCG deterministic PRNG; `Math.random()` is banned inside game logic |
| Platforms | Web / WeChat Mini Game / CrazyGames, multi-entry Webpack builds |
| Input | Manual hit-testing, no PIXI interactive, supports touch drag-to-play |

**Core systems:**

- `MovementSystem`: fixed-point advance, friendly-radius collision, cross-over logic
- `CombatSystem`: unit & tower attacks; tower finds targets omnidirectionally within Chebyshev range
- `BuildingProductionSystem`: timed unit production from barracks
- `ResourceSystem`: multi-tier accelerated ink regen
- `AISystem`: opponent AI, threat-driven decisions (defense / economy / upgrade planning, tiered difficulty), deterministic PRNG
- `SpellSystem`: spell effect handling

### Editor toolchain (`tools/`)

Standalone TypeScript tools that back the game's content pipeline:

| Tool | Port | Purpose |
|---|---|---|
| `animator` | 9091 | Skeletal-animation editor (`.tao` character animations) |
| `level-editor` | 9092 | Campaign level editor |
| `ops` | 9093 | Ops-console frontend |
| `vfx-editor` | 9094 | Combat VFX editor |
| `map-editor` | 9095 | SLG world-map editor |

The animation editor is the most developed:

- **11 fixed bones**, forward kinematics (FK)
- Keyframe timeline with multi-clip management
- Undo/Redo command pattern (100 steps)
- Exports `.tao` (a ZIP of spritesheet + animation.json) for the game runtime (`StickmanRuntime`; Infantry already wired up)

```bash
cd tools/animator
npm run start   # dev server, port 9091
```

---

## Quick start

### Option 1: Docker full stack in one command (recommended, mirrors a real deployment)

Requires Docker Desktop. A single command rebuilds the latest code and brings up **all 10 server processes + the main client + 3 tools + MongoDB + Redis**:

```powershell
./docker/local-up.ps1            # rebuild and start; browser opens http://localhost:8088
./docker/local-up.ps1 -Fresh     # wipe the database first, then start
./docker/local-up.ps1 -Port 9000 # change the main-game entry port (baked into the client at build time, requires --build rebuild)
./docker/local-down.ps1          # stop (data preserved); -Fresh also wipes data
```

> Every `up` runs `--build`, i.e. rebuilds the images from the current code — just re-run after editing code and it takes effect.
> Containers run from an image snapshot; editing local code does not affect running containers until the next re-run (rebuild).

**Frontend URLs** (opened in the browser after startup):

| URL | Description |
|---|---|
| http://localhost:8088 | **Main game** — nginx serves the SPA same-origin and reverse-proxies `/api` (REST), `/gw` (control-plane WS), `/ws` (battle data-plane WS), `/world` `/auction` (SLG open world), `/social` (fifth public-facing plane: social, incl. clans), `/analytics` (telemetry) |
| http://localhost:9091 | **Animation editor** animator |
| http://localhost:9092 | **Level editor** level-editor |
| http://localhost:9093 | **Ops console** ops (cross-origin calls to the admin backend at http://localhost:18083; seed account `admin` / `admin123`) |

**The ten server processes** (all run the same image `nw-server:local`, the process is selected by `command`):
`metaserver` (REST) · `commercial` (wallet) · `gateway` (control-plane WS) · `matchsvc` (matchmaking) · `gameserver` (battle data-plane WS) · `worldsvc` (SLG) · `auctionsvc` (auction house, separate DB) · `socialsvc` (social) · `admin` (ops) · `analyticsvc` (telemetry).
The only entry exposed to players is the main game at `:8088` (same-origin); the rest are reachable only via the nginx reverse proxy or on the internal network. An eleventh service, `botsvc` (bot players, internal admin plane on `:18087`), lives in the codebase but is not part of the local Docker stack.

See the orchestration in [`docker/docker-compose.local.yml`](docker/docker-compose.local.yml).

### Option 2: single-module dev server (fastest hot-reload when working on the frontend)

```bash
cd client && npm install && npm run start              # main game, port 9090
cd tools/animator && npm install && npm run start      # animation editor, port 9091
cd tools/level-editor && npm install && npm run start  # level editor, port 9092
cd tools/ops && npm install && npm run start           # ops console, port 9093
cd tools/vfx-editor && npm install && npm run start    # VFX editor, port 9094
cd tools/map-editor && npm install && npm run start    # SLG map editor, port 9095
```

The dev server defaults to a locally bare-run backend (see the default URLs injected in `client/webpack.config.js`); for full backend integration, Option 1 is still recommended.

---

## Directory structure

```
funny/
├── client/        Main game (TypeScript + PixiJS)
├── tools/
│   ├── animator/      Skeletal-animation editor (TypeScript + PixiJS)
│   ├── level-editor/  Campaign level editor (TypeScript + pure Canvas)
│   ├── ops/           Ops-console frontend (TypeScript)
│   ├── vfx-editor/    Combat VFX editor (TypeScript + PixiJS)
│   └── map-editor/    SLG world-map editor (TypeScript)
├── server/        Node.js backend (npm workspaces; 11 services + engine/contracts/shared)
├── art/           Map & character concept art
├── design/        Product, game & tool design docs (see design/README.md)
└── claudedocs/    Module-level quick-reference docs
```
