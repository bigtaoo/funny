/**
 * Timeline canvas: ruler, keyframe diamonds, playhead.
 * Also handles click/drag to scrub and keyframe selection.
 */
import { BONE_MAP, TIMELINE_BONES } from './skeleton';
import { state, applyDeltas } from './state';
import { getCurrentClip, getDuration, applyAnimationAtTime } from './animation';
import { emit, TIME_CHANGE, BONE_SELECT } from './events';

const ROW_H    = 26;
const RULER_H  = 20;

let canvas: HTMLCanvasElement;
let ctx: CanvasRenderingContext2D;
let labelContainer: HTMLElement;
let isScrubbing = false;

// ── Rendering ─────────────────────────────────────────────────────────────────

export function renderTimeline(): void {
  const W = canvas.parentElement!.clientWidth;
  const H = canvas.parentElement!.clientHeight;
  if (canvas.width !== W || canvas.height !== H) {
    canvas.width  = W;
    canvas.height = H;
  }

  const dur = getDuration();
  const clip = getCurrentClip();

  ctx.clearRect(0, 0, W, H);

  // Background
  ctx.fillStyle = '#1a1a2e';
  ctx.fillRect(0, 0, W, H);

  // Ruler
  ctx.fillStyle = '#2e2e46';
  ctx.fillRect(0, 0, W, RULER_H);
  ctx.strokeStyle = '#3a3a58';
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(0, RULER_H); ctx.lineTo(W, RULER_H); ctx.stroke();

  // Ruler ticks (10 divisions)
  for (let i = 0; i <= 10; i++) {
    const x = (i / 10) * W;
    const t = (i / 10) * dur;
    ctx.strokeStyle = '#6e6e8a';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x, RULER_H - 8); ctx.lineTo(x, RULER_H); ctx.stroke();
    ctx.fillStyle = '#89899a';
    ctx.font = '9px monospace';
    ctx.fillText(t.toFixed(2), x + 2, 13);
  }

  // Bone rows
  TIMELINE_BONES.forEach((boneId, ri) => {
    const y = RULER_H + ri * ROW_H;
    ctx.fillStyle = ri % 2 === 0 ? '#1e1e30' : '#1a1a2e';
    ctx.fillRect(0, y, W, ROW_H);
    ctx.strokeStyle = '#2a2a40';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, y + ROW_H); ctx.lineTo(W, y + ROW_H); ctx.stroke();

    if (!clip) return;

    // Keyframe diamonds
    clip.keyframes.forEach(kf => {
      const hasDelta = kf.bones[boneId] != null && Math.abs(kf.bones[boneId]) > 0.01;
      if (!hasDelta) return;

      const kx = (kf.time / Math.max(dur, 0.001)) * W;
      const ky = y + ROW_H / 2;
      const isSelected = state.selectedKfTime != null && Math.abs(kf.time - state.selectedKfTime) < 0.001;

      ctx.fillStyle = isSelected ? '#74c7ec' : '#f9e2af';
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(kx, ky - 6); ctx.lineTo(kx + 5, ky);
      ctx.lineTo(kx, ky + 6); ctx.lineTo(kx - 5, ky);
      ctx.closePath();
      ctx.fill(); ctx.stroke();
    });
  });

  // Playhead
  const px = (state.currentTime / Math.max(dur, 0.001)) * W;
  ctx.strokeStyle = '#f38ba8';
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(px, 0); ctx.lineTo(px, H); ctx.stroke();
  ctx.fillStyle = '#f38ba8';
  ctx.fillRect(px - 4, 0, 8, RULER_H);

  // Update HTML bone labels
  renderLabels();
}

function renderLabels(): void {
  labelContainer.innerHTML = '<div class="tl-label-spacer"></div>';
  const clip = getCurrentClip();

  TIMELINE_BONES.forEach(boneId => {
    const bone = BONE_MAP[boneId];
    const hasKf = clip?.keyframes.some(
      kf => kf.bones[boneId] != null && Math.abs(kf.bones[boneId]) > 0.01,
    ) ?? false;

    const row = document.createElement('div');
    row.className = 'tl-label-row' + (boneId === state.selectedBone ? ' active' : '');
    row.innerHTML = `<div class="tl-label-dot" style="opacity:${hasKf ? 1 : 0.3}"></div>${bone.label}`;
    row.addEventListener('click', () => {
      state.selectedBone = boneId;
      emit(BONE_SELECT, boneId);
    });
    labelContainer.appendChild(row);
  });
}

// ── Scrub interaction ─────────────────────────────────────────────────────────

function getTimeFromX(clientX: number): number {
  const rect = canvas.getBoundingClientRect();
  const x = clientX - rect.left;
  const dur = getDuration();
  return Math.max(0, Math.min(dur, (x / canvas.width) * dur));
}

function handleScrub(clientX: number, clientY: number): void {
  const rect = canvas.getBoundingClientRect();
  const x = clientX - rect.left;
  const y = clientY - rect.top;
  const dur = getDuration();
  const clip = getCurrentClip();
  const ri = Math.floor((y - RULER_H) / ROW_H);

  if (y < RULER_H || ri < 0 || ri >= TIMELINE_BONES.length) {
    // Ruler or outside rows — just scrub time
    state.currentTime = getTimeFromX(clientX);
    state.selectedKfTime = null;
  } else {
    const boneId = TIMELINE_BONES[ri];
    state.selectedBone = boneId;
    emit(BONE_SELECT, boneId);

    // Check if we hit a keyframe diamond (±8px)
    if (clip) {
      const hitKf = clip.keyframes.find(kf => {
        if (!kf.bones[boneId] || Math.abs(kf.bones[boneId]) < 0.01) return false;
        const kx = (kf.time / Math.max(dur, 0.001)) * canvas.width;
        return Math.abs(kx - x) < 8;
      });
      if (hitKf) {
        state.currentTime = hitKf.time;
        state.selectedKfTime = hitKf.time;
        applyDeltas(hitKf.bones);
        emit(TIME_CHANGE);
        return;
      }
    }

    state.currentTime = getTimeFromX(clientX);
    state.selectedKfTime = null;
  }

  if (!state.isPlaying) applyAnimationAtTime(state.currentTime);
  emit(TIME_CHANGE);
}

// ── Init ──────────────────────────────────────────────────────────────────────

export function initTimeline(): void {
  canvas         = document.getElementById('timeline-canvas') as HTMLCanvasElement;
  ctx            = canvas.getContext('2d')!;
  labelContainer = document.getElementById('tl-labels')!;

  canvas.addEventListener('mousedown', e => {
    isScrubbing = true;
    handleScrub(e.clientX, e.clientY);
  });
  canvas.addEventListener('mousemove', e => {
    if (!isScrubbing || state.isPlaying) return;
    state.currentTime = getTimeFromX(e.clientX);
    state.selectedKfTime = null;
    if (!state.isPlaying) applyAnimationAtTime(state.currentTime);
    emit(TIME_CHANGE);
  });
  canvas.addEventListener('mouseup',    () => { isScrubbing = false; });
  canvas.addEventListener('mouseleave', () => { isScrubbing = false; });
}
