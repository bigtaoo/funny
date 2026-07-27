// DefenseEditorScene — SLG universal half-field deployment editor (S8-9 C3 + G3-2c generalized to offense/defense)
//
// Two modes, distinguished by target.mode:
//
// ① Defense (mode='defense'): edit the defense config for the home base (tileKey='base') or
//    allied/own territory (tileKey='{x}:{y}') = engine LevelDefinition restricted subset (U8/U10) —
//    defender (Top) half garrison + building row defenderBuildings + defenderBaseLevel(0..BASE_UPGRADE_COSTS.length).
//    Save via setDefense (overwrite).
//
// ② Attack (mode='attack', G3-2c §16.2 / A7 §16.5, migrated to CC-3 hero cards 2026-07-17): edit a
//    pre-deployment attack team template — attacker (Bottom) half with hero cards from the player's
//    roster (SaveData.cardInv) pre-placed; no buildings / no base upgrades (attacker places cards
//    only). A card can occupy only one cell (placing it elsewhere moves it); committed troops = sum
//    of each placed card's cardState.currentTroops (server-authoritative ledger, not a client HP
//    slider). Save via getTeams→replace slot→setTeams, entries are {cardInstanceId, col, row}.
//
//    Previously (pre-2026-07-17) this mode used the same raw "collected units" palette as defense
//    mode with a client-side 25%-100% HP slider (ArmyEntry.unitType/initialHp) — that path never
//    touched cardState, so combatMarch.ts's card-army exemption from the flat troop pool never
//    applied to teams built here, causing "team shows troops but march says insufficient troops"
//    (the legacy `pw.troops < troops` gate still fired). See slg-occupy-team-only-troops memory.
//
// "Collected units" constraint (U8, defense mode only): palette only lists unit/building types from
// card definitions (CARD_DEFINITIONS); PvE-only units naturally excluded. During a siege, worldsvc
// runs the engine headless with the attacker army + defender config to compute the authoritative
// result (§16.8).
//
// This file is a thin assembly — see ./DefenseEditorScene/base.ts for the shared state/render
// dispatcher and ./DefenseEditorScene/{data,render,input}.ts for the per-domain mixins. To add a
// handler: find the matching domain mixin or add a new one to the chain — do NOT grow this file.
// DefenseEditorCallbacks/DefenseEditorTarget are re-exported so existing importers
// (`from './DefenseEditorScene'`) keep resolving to this file, not the directory.
import type { Scene } from './SceneManager';
import { DefenseEditorSceneBase } from './DefenseEditorScene/base';
import { DataMixin } from './DefenseEditorScene/data';
import { RenderMixin } from './DefenseEditorScene/render';
import { InputMixin } from './DefenseEditorScene/input';

export type { DefenseEditorCallbacks, DefenseEditorTarget } from './DefenseEditorScene/base';

const Assembled = InputMixin(RenderMixin(DataMixin(DefenseEditorSceneBase)));

/**
 * DefenseEditorScene — the SLG defense/attack-team editor scene registered against SceneManager.
 * Assembled from the per-domain mixin chain over DefenseEditorSceneBase.
 */
export class DefenseEditorScene extends Assembled implements Scene {}
