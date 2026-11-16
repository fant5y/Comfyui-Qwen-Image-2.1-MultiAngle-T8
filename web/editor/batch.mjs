import { guideSource } from './guides.mjs?v=20261116animals';

export function supportsCameraBatch(scene) {
  const kind = guideSource(scene).kind;
  return scene.source.kind !== 'empty' && (['scene', 'canny-scene', 'depth-scene'].includes(kind) || kind === 'pose' && scene.source.kind === 'human');
}

const wrapAngle = value => ((value + 180) % 360 + 360) % 360 - 180;

export function parseAngleList(value) {
  const values = typeof value === 'string' ? value.trim().split(/[,，、;；\s]+/).filter(Boolean).map(angle => Number(angle.replace(/°$/, '') || NaN)) : value;
  if (!Array.isArray(values) || !values.length || !values.every(angle => typeof angle === 'number' && Number.isFinite(angle)))
    throw new Error('Enter a list such as 45, -45, 90, -90. Separate angles with commas or spaces.');
  return [...values];
}

export function cameraBatchPlan(scene, settings) {
  if (!supportsCameraBatch(scene)) throw new Error('Batch views require a 3D subject with a coarse render, 3D mannequin skeleton, or 3D Canny guide. Source-derived guides keep the original view.');
  const base = structuredClone(scene);
  if (settings.mode === 'saved') {
    if (!base.shots.length) throw new Error('Save at least one camera view first.');
    return { count: base.shots.length, *views() {
      for (const shot of base.shots) yield { label: shot.name || 'Saved View', scene: { ...structuredClone(base),
        camera: { ...base.camera, ...shot.camera }, width: shot.width, height: shot.height,
        ...(Array.isArray(shot.cameraTarget) && shot.cameraTarget.length === 3 && shot.cameraTarget.every(Number.isFinite)
          ? { cameraTarget: structuredClone(shot.cameraTarget) } : {}) } };
    } };
  }
  if (settings.mode === 'angles') {
    const angles = parseAngleList(settings.angles);
    return { count: angles.length, *views() {
      for (const value of angles) {
        const angle = wrapAngle(value), current = structuredClone(base);
        current.camera.azimuth = angle;
        yield { label: `Azimuth ${Number(angle.toFixed(6))}°`, scene: current };
      }
    } };
  }
  const { start, end, step } = settings;
  if (![start, end, step].every(Number.isFinite) || step === 0 || (end - start) * step < 0)
    throw new Error('Enter finite start and end angles and a nonzero step in the same direction as the range.');
  let count = Math.floor((end - start) / step + 1e-9) + 1;
  if (!Number.isSafeInteger(count) || count < 1) throw new Error('Too many views to calculate. Adjust the step.');
  if (count > 1 && Math.abs(wrapAngle(start + (count - 1) * step) - wrapAngle(start)) < 1e-7) count--;
  return { count, *views() {
    for (let i = 0; i < count; i++) {
      const angle = wrapAngle(start + i * step), current = structuredClone(base);
      current.camera.azimuth = angle;
      yield { label: `Azimuth ${Number(angle.toFixed(6))}°`, scene: current };
    }
  } };
}

// Persist one guide at a time so a 360-view run never retains all PNGs in memory.
export async function runCameraBatch(plan, { capture, save, queue, signal, onProgress = () => {} }) {
  const result = { views: [], stopped: false, error: null };
  for (const view of plan.views()) {
    if (signal?.aborted) { result.stopped = true; break; }
    onProgress({ index: result.views.length, total: plan.count, label: view.label, phase: 'capture' });
    try {
      const png = await capture(view.scene, view);
      if (signal?.aborted) { result.stopped = true; break; }
      const snapshot = await save(view.scene, png);
      const entry = { label: view.label, snapshot, camera: view.scene.camera, width: view.scene.width, height: view.scene.height };
      if (view.poseId) { entry.poseId = view.poseId; entry.poseName = view.poseName; }
      if (view.gallerySource) entry.gallerySource = structuredClone(view.gallerySource);
      if (Array.isArray(view.scene.cameraTarget)) entry.cameraTarget = structuredClone(view.scene.cameraTarget);
      result.views.push(entry);
      if (signal?.aborted) { result.stopped = true; break; }
      if (queue) {
        const queued = await queue(snapshot);
        if (typeof queued === 'string') entry.prompt_id = queued;
        else { entry.prompt_id = queued.prompt_id; entry.encoding_plan = queued.encoding_plan; }
      }
      onProgress({ index: result.views.length, total: plan.count, label: view.label, phase: queue ? 'queued' : 'saved' });
    } catch (error) { result.error = error; break; }
  }
  return result;
}
