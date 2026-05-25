/**
 * HTML panel UI: animation list, bone info, toolbar controls, status bar.
 * Responds to events and wires DOM → animation/state actions.
 */
import { BONE_MAP } from './skeleton';
import { state, currentDeltas, resetDeltas } from './state';
import {
  getCurrentClip, getDuration, addKeyframeAtCurrentTime,
  deleteKeyframeAtCurrentTime, getPrevKeyframe, getNextKeyframe,
  startPlayback, pausePlayback, stopPlayback, togglePlayback,
  applyAnimationAtTime, setDuration, setLoop,
} from './animation';
import { PRESETS, clonePreset } from './presets';
import {
  emit, on,
  ANIM_SELECT, ANIM_LIST, BONE_SELECT, TIME_CHANGE, STATUS, PLAY_STATE,
} from './events';

// ── Status bar ────────────────────────────────────────────────────────────────

let statusTimer = 0;
const statusEl = (): HTMLElement => document.getElementById('status-text')!;

export function setStatus(msg: string): void {
  statusEl().textContent = msg;
  clearTimeout(statusTimer);
  statusTimer = window.setTimeout(() => { statusEl().textContent = 'Ready'; }, 3000);
}

// ── Time display ──────────────────────────────────────────────────────────────

export function updateTimeDisplay(): void {
  const dur = getDuration();
  const el = document.getElementById('time-display');
  if (el) el.textContent = `${state.currentTime.toFixed(3)}s / ${dur.toFixed(3)}s`;
}

// ── Animation list ────────────────────────────────────────────────────────────

export function renderAnimList(): void {
  const container = document.getElementById('anim-list')!;
  container.innerHTML = '';

  for (const name of Object.keys(state.animations)) {
    const item = document.createElement('div');
    item.className = 'anim-item' + (name === state.currentAnim ? ' active' : '');
    item.innerHTML = `<div class="dot"></div>${name}`;
    item.addEventListener('click', () => selectAnimation(name));
    container.appendChild(item);
  }
}

// ── Animation selection ───────────────────────────────────────────────────────

export function selectAnimation(name: string): void {
  if (state.isPlaying) pausePlayback();
  state.currentAnim = name;
  state.currentTime = 0;
  state.selectedKfTime = null;

  const clip = getCurrentClip();
  if (clip) {
    (document.getElementById('inp-duration') as HTMLInputElement).value = clip.duration.toFixed(2);
    (document.getElementById('chk-loop') as HTMLInputElement).checked = clip.loop;
    state.looping = clip.loop;
    applyAnimationAtTime(0);
  }

  renderAnimList();
  updateTimeDisplay();
  emit(ANIM_SELECT, name);
  emit(STATUS, `Animation: ${name}`);
}

export function createAnimation(name: string): void {
  if (!name.trim()) return;
  if (state.animations[name]) { emit(STATUS, `'${name}' already exists`); return; }
  state.animations[name] = { duration: 0.5, loop: true, keyframes: [] };
  selectAnimation(name);
  emit(ANIM_LIST);
}

function deleteCurrentAnimation(): void {
  if (!state.currentAnim) return;
  if (!confirm(`Delete '${state.currentAnim}'?`)) return;
  delete state.animations[state.currentAnim];
  const first = Object.keys(state.animations)[0] ?? '';
  state.currentAnim = first;
  if (first) selectAnimation(first);
  else renderAnimList();
  emit(ANIM_LIST);
}

function renameCurrentAnimation(): void {
  if (!state.currentAnim) return;
  const newName = prompt('Rename to:', state.currentAnim);
  if (!newName || newName === state.currentAnim) return;
  if (state.animations[newName]) { emit(STATUS, `'${newName}' already exists`); return; }
  state.animations[newName] = state.animations[state.currentAnim];
  delete state.animations[state.currentAnim];
  state.currentAnim = newName;
  renderAnimList();
  emit(STATUS, `Renamed to '${newName}'`);
}

// ── Bone info panel ────────────────────────────────────────────────────────────

export function renderBoneInfo(): void {
  const area = document.getElementById('bone-info-area')!;
  const boneId = state.selectedBone;

  if (!boneId) {
    area.innerHTML = '<div class="hint-text">Click a bone<br>on the canvas<br>to select it</div>';
    return;
  }

  const bone = BONE_MAP[boneId];
  const delta = currentDeltas[boneId] ?? 0;

  area.innerHTML = `
    <div class="bone-info" style="padding:8px">
      <div class="bone-name">${bone.label}</div>
      <div class="prop-row">
        <span class="prop-label">Local Δ</span>
        <span class="prop-value" id="lbl-delta">${delta.toFixed(1)}°</span>
      </div>
      <div class="prop-row">
        <span class="prop-label">World °</span>
        <span class="prop-value">${(bone.rwa + delta).toFixed(1)}°</span>
      </div>
      <div style="padding:4px 0 6px">
        <input type="range" id="bone-slider" min="-180" max="180" step="0.5" value="${delta.toFixed(1)}">
      </div>
      <div class="prop-row">
        <button class="sm" id="btn-reset-bone">Reset 0°</button>
        <button class="sm primary" id="btn-setkf-bone">Set KF</button>
      </div>
    </div>
  `;

  const slider = document.getElementById('bone-slider') as HTMLInputElement;
  slider.addEventListener('input', () => {
    currentDeltas[boneId] = parseFloat(slider.value);
    const lbl = document.getElementById('lbl-delta');
    if (lbl) lbl.textContent = `${currentDeltas[boneId].toFixed(1)}°`;
  });
  document.getElementById('btn-reset-bone')!.addEventListener('click', () => {
    currentDeltas[boneId] = 0;
    renderBoneInfo();
  });
  document.getElementById('btn-setkf-bone')!.addEventListener('click', addKeyframeAtCurrentTime);
}

// ── Preset loader ─────────────────────────────────────────────────────────────

function loadPreset(name: string): void {
  const clip = clonePreset(name);
  if (!clip) { emit(STATUS, `Unknown preset: ${name}`); return; }
  state.animations[name] = clip;
  selectAnimation(name);
  emit(ANIM_LIST);
  emit(STATUS, `Loaded preset: ${name}`);
}

// ── DOM wiring ────────────────────────────────────────────────────────────────

export function initUI(): void {
  // Playback buttons
  const btnPlay  = document.getElementById('btn-play')!;
  const btnPlay2 = document.getElementById('btn-play2')!;
  btnPlay.addEventListener('click',  togglePlayback);
  btnPlay2.addEventListener('click', togglePlayback);
  document.getElementById('btn-stop')!.addEventListener('click', stopPlayback);

  document.getElementById('btn-prev-kf')!.addEventListener('click', () => {
    const kf = getPrevKeyframe();
    if (kf) { state.currentTime = kf.time; state.selectedKfTime = kf.time; applyAnimationAtTime(kf.time); emit(TIME_CHANGE); }
  });
  document.getElementById('btn-next-kf')!.addEventListener('click', () => {
    const kf = getNextKeyframe();
    if (kf) { state.currentTime = kf.time; state.selectedKfTime = kf.time; applyAnimationAtTime(kf.time); emit(TIME_CHANGE); }
  });

  // Toolbar controls
  document.getElementById('sel-speed')!.addEventListener('change', e => {
    state.playSpeed = parseFloat((e.target as HTMLSelectElement).value);
  });
  document.getElementById('chk-loop')!.addEventListener('change', e => {
    setLoop((e.target as HTMLInputElement).checked);
  });
  document.getElementById('inp-duration')!.addEventListener('change', e => {
    setDuration(parseFloat((e.target as HTMLInputElement).value) || 0.5);
    updateTimeDisplay();
    emit(TIME_CHANGE);
  });
  document.getElementById('btn-add-kf')!.addEventListener('click', addKeyframeAtCurrentTime);
  document.getElementById('btn-del-kf')!.addEventListener('click', deleteKeyframeAtCurrentTime);

  // Animation list management
  document.getElementById('btn-new-anim')!.addEventListener('click', () => {
    const name = prompt('Animation name:', 'new_anim');
    if (name) createAnimation(name);
  });
  document.getElementById('btn-del-anim')!.addEventListener('click', deleteCurrentAnimation);
  document.getElementById('btn-ren-anim')!.addEventListener('click', renameCurrentAnimation);

  // View options
  document.getElementById('chk-joints')!.addEventListener('change', e => {
    state.showJoints = (e.target as HTMLInputElement).checked;
  });
  document.getElementById('chk-onion')!.addEventListener('change', e => {
    state.showOnion = (e.target as HTMLInputElement).checked;
  });
  document.getElementById('chk-guide')!.addEventListener('change', e => {
    state.showGuide = (e.target as HTMLInputElement).checked;
  });

  // Bottom bar
  document.getElementById('btn-reset-pose')!.addEventListener('click', () => {
    resetDeltas();
    emit(STATUS, 'Reset to rest pose');
  });
  document.getElementById('btn-presets')!.addEventListener('click', () => {
    const names = Object.keys(PRESETS).join(', ');
    const name = prompt(`Load preset (${names}):`, 'walk');
    if (name) loadPreset(name.trim());
  });

  // ── Subscribe to events ───────────────────────────────────────────────────
  on(BONE_SELECT, () => renderBoneInfo());
  on(TIME_CHANGE, () => updateTimeDisplay());
  on(ANIM_LIST,   () => renderAnimList());
  on(PLAY_STATE, () => {
    const isPlaying = state.isPlaying;
    btnPlay.textContent  = isPlaying ? '⏸ Pause' : '▶ Play';
    btnPlay2.textContent = isPlaying ? '⏸' : '▶';
  });
  on(STATUS, (msg: string) => setStatus(msg));
}
