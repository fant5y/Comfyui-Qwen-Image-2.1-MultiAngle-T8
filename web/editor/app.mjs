import { ANIMAL_SHAPES } from './animal-mannequin.mjs?v=20261116pawdrag';
import { StudioScene, defaultScene, restoreSceneDefaults, PRESETS, assetURL } from './scene.mjs?v=20261116bodyrange';
import { uuid } from '../uuid.mjs?v=20261116en';
import { updateReferences, sourceChanged, staleGuide } from './reference-library.mjs?v=20261116en';
import { installReferencesUI, refreshReferencesUI, setReferenceConnections } from './references-ui.mjs?v=20261116sources';
import { reconstruct, reconstructionConfig, selectedReconstructionModels, saveReconstructionModels } from './reconstruct.mjs?v=20261116en';
import { readSkeletonImage } from './openpose.mjs?v=20261116en';
import { GUIDE_LABELS, guideImageIndex, guideSource, cannyEdges, hasCannyEdges } from './guides.mjs?v=20261116animals';
import { supportsCameraBatch, cameraBatchPlan, runCameraBatch } from './batch.mjs?v=20261116animals';
import { installBatchPresets } from './batch-presets.mjs?v=20261116en';
import { randomPose } from './poses.mjs?v=20261116en';
import { installPoseLibrary } from './pose-library-ui.mjs?v=20261116bodyrange';
import { installGalleryActions } from './gallery-actions.mjs?v=20261116en';
import { poseCameraPlan, finishCatalogPose } from './pose-catalog.mjs?v=20261116rig';
import { installActorsUI, refreshActorsUI, updateActorReferences, selectRole, chooseDetectedPeople, randomRoles } from './actors-ui.mjs?v=20261116bodyrange';
import { activeActor, bindActor, createActor, saveActor } from './actors.mjs?v=20261116en';
import { buildManifest, actorMode, actorPrompt, scenePrompt } from './manifest.mjs?v=20261116en';

const $ = selector => document.querySelector(selector);
const clone = value => structuredClone(value);
const params = new URLSearchParams(location.search);
const embedded = params.has('session') && parent !== window;
const session = params.get('session');
let doc = defaultScene(), studio, revision = 0, busy = true, ready = false;
let undo = [], redo = [], previewTimer, previewRunning = false, selectedBone = '';
let selectedShot = null, snapshot = null;
let humanToolsReady = false;
let linkedReference = { connected: false };
let linkedStructure = { connected: false };
let unwiredAnyAngle = false;
let pendingReference = null;
let pendingStructure = null;
let pendingActors = null;
let pendingKeypoints = null;
let explicitStructureRead = false;
let overlayShown = false;
let previewVisible = false, previewGuide = null, previewRevision = -1;
let cannyWarningRevision = -1;
const EMPTY_CANNY_WARNING = 'No Canny edges detected. Lower the thresholds or check the frame. You can still output the blank guide.';
let batchRunning = false, batchController = null, batchViews = [], batchId = null;
const batchReplies = new Map();
const controls = new Map();

const workspace = $('#workspace');
for (const handle of workspace.querySelectorAll('[data-sidebar]')) {
  const side = handle.dataset.sidebar;
  const panel = workspace.querySelector(`.${side}-panel`);
  const widthProperty = `--${side}-sidebar-width`;
  const direction = side === 'left' ? 1 : -1;
  const storageKey = `anyangle-studio.sidebar-width.${side}`;
  try {
    const savedWidth = Number(localStorage.getItem(storageKey));
    if (Number.isFinite(savedWidth) && savedWidth >= 200)
      workspace.style.setProperty(widthProperty, `${savedWidth}px`);
  } catch { /* Studio can still resize without browser storage. */ }
  const saveWidth = () => {
    try {
      const width = parseFloat(workspace.style.getPropertyValue(widthProperty));
      if (Number.isFinite(width)) localStorage.setItem(storageKey, String(width));
      else localStorage.removeItem(storageKey);
    } catch { /* Browser storage is optional. */ }
  };
  const setWidth = width => {
    const maxWidth = Math.floor(workspace.clientWidth * 0.34);
    workspace.style.setProperty(widthProperty, `${Math.max(200, Math.min(maxWidth, width))}px`);
  };
  let drag;
  handle.onpointerdown = event => {
    if (event.button !== 0) return;
    drag = { x: event.clientX, width: panel.offsetWidth };
    handle.setPointerCapture(event.pointerId);
  };
  handle.onpointermove = event => {
    if (drag && handle.hasPointerCapture(event.pointerId))
      setWidth(drag.width + (event.clientX - drag.x) * direction);
  };
  handle.onlostpointercapture = () => { drag = null; saveWidth(); };
  const resetWidth = () => {
    workspace.style.removeProperty(widthProperty);
    saveWidth();
  };
  handle.ondblclick = resetWidth;
  handle.onkeydown = event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home'].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.key === 'Home') resetWidth();
    else {
      setWidth(panel.offsetWidth + (event.key === 'ArrowRight' ? 16 : -16) * direction);
      saveWidth();
    }
  };
}
let poseCatalog, galleryActions;

function toast(message) {
  $('#toast').textContent = message; $('#toast').hidden = false;
  clearTimeout(toast.timer); toast.timer = setTimeout(() => { $('#toast').hidden = true; }, 4500);
}
function showLoadError(error) {
  $('#loading').hidden = true;
  $('#load-error-message').textContent = error?.message || String(error);
  $('#repair-human').hidden = error?.name !== 'HumanAssetError';
  $('#load-error-help').hidden = error?.name !== 'HumanAssetError';
  $('#repair-state').textContent = error?.name === 'HumanAssetError'
    ? 'You can also run python install_assets.py in the node folder and restart ComfyUI.' : 'Resolve the error above, then retry loading.';
  const dialog = $('#load-error-dialog'); if (!dialog.open) dialog.showModal();
}
function error(error) {
  console.error(error); toast(error?.message || String(error));
  if (error?.name === 'HumanAssetError') showLoadError(error);
}
function currentGuide() { return doc.conditioning.model === 'anyangle' ? 'coarse' : doc.conditioning.guide; }
function usesLocalGuide(guide = currentGuide()) {
  return guide === 'pose' && (['dwpose', 'json', 'keypoints', 'gallery'].includes(doc.openpose?.origin) || doc.openpose?.useRig || doc.conditioning.mapOrigin === 'rig')
    || guide === 'depth' && ['da3', 'scene'].includes(doc.conditioning.mapOrigin)
    || guide === 'canny' && ['auto', 'reference'].includes(doc.conditioning.mapOrigin);
}
function requiresGuide() { return doc.version !== 3 || doc.referenceLibrary?.mode === 'guided'; }
function hasGuide() {
  if (!requiresGuide()) { const plan = buildManifest(doc); return !plan.missing.length && (plan.mode === 'text' || plan.references.length > 0); }
  if (doc.version === 3 && (staleGuide(doc) || doc.sourceStale && currentGuide() === 'coarse')) return false;
  const guide = currentGuide();
  if (linkedStructure.connected && doc.conditioning.model === 'base' && ['pose', 'depth', 'canny'].includes(guide)
      && !usesLocalGuide(guide)
      && linkedStructure.pending) return false;
  const source = guideSource(doc);
  return source.kind === 'image' || source.kind === 'canny-image' || source.kind === 'canny-scene'
    || source.kind === 'depth-scene'
    || source.kind === 'pose' && doc.source.kind === 'human' && doc.actors.some(actor => actor.visible !== false && actor.source.kind !== 'animal') || source.kind === 'scene' && doc.source.kind !== 'empty';
}
function applyDisabled() {
  return busy || !ready || !hasGuide() || !!linkedReference.pending;
}
function setBusy(value) {
  busy = value; $('#workspace').inert = value; $('#apply').disabled = applyDisabled();
  $('#clear-canvas').disabled = value || !ready || !canvasHasObjects();
  $('#undo').disabled = value || !undo.length; $('#redo').disabled = value || !redo.length;
  if (!value && pendingReference) queueMicrotask(readPendingReference);
  if (!value && pendingStructure) queueMicrotask(readPendingStructure);
  if (!value && pendingActors) queueMicrotask(readPendingActors);
  if (!value && pendingKeypoints) queueMicrotask(readPendingKeypoints);
}
function canvasHasObjects() {
  return doc.source.kind !== 'empty' || !!(doc.actors?.length || doc.props?.length);
}
async function run(task) {
  if (busy) return;
  studio?.finishDrag?.(false);
  setBusy(true);
  try {
    while (previewRunning) await new Promise(resolve => setTimeout(resolve, 30));
    await task();
  } catch (e) { error(e); }
  finally { setBusy(false); await renderPreview(); }
}
function begin() {
  if (!ready || studio.restoring) return;
  // Finish the previous gesture without overwriting this control's new DOM value.
  studio.finishDrag?.(false);
  const previousUndo = undo.slice(), previousRedo = redo;
  const undoDisabled = $('#undo').disabled, redoDisabled = $('#redo').disabled;
  studio.syncPose();
  const serialized = JSON.stringify(doc);
  if (JSON.stringify(undo.at(-1)) !== serialized) undo.push(clone(doc));
  if (undo.length > 40) undo.shift();
  redo = []; $('#undo').disabled = false; $('#redo').disabled = true;
  return () => {
    undo = previousUndo; redo = previousRedo;
    $('#undo').disabled = undoDisabled; $('#redo').disabled = redoDisabled;
  };
}
function changed(updatePreview = true, updateControls = true) {
  if (!ready || studio.restoring) return;
  studio.syncPose(); revision++; selectedShot = null;
  if (!updatePreview && previewRevision === revision - 1) previewRevision = revision;
  document.querySelectorAll('.preset-card.active').forEach(button => button.classList.remove('active'));
  document.querySelectorAll('.shot-thumb.active').forEach(button => button.classList.remove('active'));
  $('#status').textContent = 'Unsaved draft · Apply to update the node'; $('#status').dataset.state = 'dirty';
  if (updateControls) refresh();
  if (updatePreview) schedulePreview();
}
function schedulePreview() {
  clearTimeout(previewTimer);
  if (doc.interaction?.livePreview !== false) previewTimer = setTimeout(renderPreview, 450);
}
async function imageCanvas(source, width, height) {
  const image = new Image(); image.src = source; await image.decode();
  const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.fillStyle = '#000'; context.fillRect(0, 0, width, height);
  const scale = Math.min(width / image.naturalWidth, height / image.naturalHeight);
  const w = image.naturalWidth * scale, h = image.naturalHeight * scale;
  context.drawImage(image, (width - w) / 2, (height - h) / 2, w, h);
  return canvas;
}
async function captureGuide(width = doc.width, height = doc.height) {
  if (!requiresGuide()) return null;
  const input = guideSource(doc), captureRevision = revision;
  if (input.kind === 'pose') return studio.captureOpenPose(width, height);
  if (input.kind === 'image') return (await imageCanvas(assetURL(input.asset.name), width, height)).toDataURL('image/png');
  if (input.kind === 'missing') throw new Error('Generate, import, or connect the current guide first.');
  if (input.kind === 'scene') return studio.capture(width, height);
  if (input.kind === 'depth-scene') return studio.capture(width, height, { depth: true });
  const source = input.kind === 'canny-image' ? assetURL(input.asset.name) : await studio.capture(width, height, { canny: true });
  const decoded = new Image(); decoded.src = source; await decoded.decode();
  const scale = Math.min(1, 1536 / Math.max(decoded.naturalWidth, decoded.naturalHeight));
  const workWidth = Math.max(1, Math.round(decoded.naturalWidth * scale)), workHeight = Math.max(1, Math.round(decoded.naturalHeight * scale));
  const work = await imageCanvas(source, workWidth, workHeight);
  const context = work.getContext('2d', { willReadFrequently: true });
  const pixels = context.getImageData(0, 0, workWidth, workHeight);
  const edges = cannyEdges(pixels.data, workWidth, workHeight, doc.conditioning.cannyLow, doc.conditioning.cannyHigh);
  cannyWarningRevision = hasCannyEdges(edges) ? -1 : captureRevision;
  pixels.data.set(edges);
  context.putImageData(pixels, 0, 0);
  if (workWidth === width && workHeight === height) return work.toDataURL('image/png');
  return (await imageCanvas(work.toDataURL('image/png'), width, height)).toDataURL('image/png');
}
async function renderPreview() {
  if (!requiresGuide()) { refresh(); return; }
  if (!ready || !hasGuide() || busy) return;
  if (previewRunning) { schedulePreview(); return; }
  previewRunning = true;
  const version = revision;
  try {
    const scale = Math.min(1, 500 / Math.max(doc.width, doc.height));
    const png = await captureGuide(Math.round(doc.width * scale), Math.round(doc.height * scale));
    if (version === revision) {
      $('#guide').src = $('#stage-guide').src = png;
      previewRevision = version; refresh();
    }
  } catch (e) { previewRevision = -1; refresh(); $('#stage-guide-message').textContent = e.message || 'Preview generation failed. Try again.'; error(e); }
  finally { previewRunning = false; }
}
function refresh() {
  if (studio && (doc.source.kind === 'splat' || doc.source.kind === 'empty') &&
      (studio.mode !== 'camera' || $('#edit-mode').classList.contains('active'))) setMode('camera');
  if (linkedReference.asset) doc.reference = linkedReference.asset;
  const guide = currentGuide(), base = doc.conditioning.model === 'base', input = guideSource(doc);
  const manifest = buildManifest(doc), multi = actorMode(doc);
  const castMapping = doc.source.kind === 'human' && doc.conditioning.identityMode === 'actors' && base;
  const imageIndex = doc.version === 3 || castMapping ? manifest.guide?.index || 1 : guideImageIndex(doc.conditioning), promptMode = doc.conditioning.promptMode || 'default';
  const referenceIndex = castMapping ? manifest.references.find(reference => reference.asset.name === doc.reference?.name)?.index
    : promptMode === 'single' ? null : 3 - imageIndex;
  $('#reference-heading').innerHTML = `Source Image <small>· ${referenceIndex ? `image_${referenceIndex}` : 'Pose / Reconstruction Source'}</small>`;
  const staticGuide = input.kind === 'image' || input.kind === 'canny-image';
  const poseImage = guide === 'pose' && input.kind === 'image';
  if (previewGuide !== guide) { previewGuide = guide; previewVisible = guide !== 'coarse'; }
  $('#stage').classList.toggle('previewing-guide', previewVisible);
  $('#stage-guide-view').hidden = !previewVisible;
  $('#stage-guide-title').textContent = GUIDE_LABELS[guide];
  $('#stage-guide-detail').textContent = `Output · image_${imageIndex} · ${doc.width} × ${doc.height}`;
  $('#stage-guide').hidden = !hasGuide() || previewRevision !== revision;
  $('#stage-guide-empty').hidden = hasGuide() && previewRevision === revision;
  $('#stage-guide-message').textContent = hasGuide() ? 'Generating guide preview…'
    : guide === 'coarse' ? 'Rebuild the subject from the source first' : 'Generate or import a guide in the right panel';
  $('#view-detail').textContent = previewVisible ? `${GUIDE_LABELS[guide]} · Output` : '3D Workspace · Adjust camera and pose';
  for (const [id, active] of [['view-output', previewVisible], ['view-scene', !previewVisible]]) {
    $(`#${id}`).classList.toggle('active', active); $(`#${id}`).setAttribute('aria-pressed', String(active));
  }
  $('#view-scene').hidden = staticGuide || guide === 'depth' && input.kind !== 'depth-scene';
  $('#view-scene').disabled = doc.source.kind === 'empty';
  $('#lens-panel').hidden = staticGuide;
  $('#mouse-pitch').closest('section').hidden = staticGuide;
  $('#lens-mode').value = doc.camera.focalLength ? 'custom' : 'original';
  $('#lens-controls').hidden = !doc.camera.focalLength;
  const poseAnimal = studio?.animal ? activeActor(doc) : doc.source.kind === 'splat' ? animalPoseTarget() : null;
  $('#copy-photo-pose').textContent = poseAnimal ? 'Apply AnimalPose to Mannequin' : 'Copy Source Pose to Mannequin';
  $('#copy-photo-pose').disabled = poseAnimal
    ? poseAnimal.source.shape === 'owl' || poseAnimal.locked || poseAnimal.visible === false
    : !doc.reference?.name || !!linkedReference.pending;
  $('#pose-category').value = (doc.randomMaster || doc.poseRandom)?.category || 'mixed';
  if (document.activeElement !== $('#pose-seed')) $('#pose-seed').value = (doc.randomMaster || doc.poseRandom)?.seed || 0;
  for (const id of ['camera-heading', 'camera-eyebrow', 'camera-sliders', 'view-presets', 'shot-shelf', 'scene-panel']) $(`#${id}`).hidden = staticGuide;
  $('#stage-help').textContent = previewVisible ? staticGuide ? 'Source composition and structure · Apply to output this guide' : 'Guide from the current camera · Switch to 3D Workspace to adjust the view'
    : studio?.mode === 'position' ? 'Select a character · Drag to place · Right-drag to orbit · Middle-drag to pan'
    : studio?.mode === 'edit' && studio.animal ? 'Select a blue joint for rotation rings · Drag gold handles to pose limbs · Right-drag to orbit · Middle-drag to pan'
    : studio?.mode === 'edit' ? 'Select joints or drag IK handles · Right-drag to orbit · Middle-drag to pan'
      : 'Yellow frame marks the output · Drag to orbit · Middle-drag or Shift-drag to pan · Scroll to zoom';
  for (const control of controls.values()) control.refresh();
  $('#width').value = doc.width; $('#height').value = doc.height;
  $('#background').value = doc.background;
  const ratio = ['1:1', '16:9', '9:16', '4:3'].find(value => { const [w, h] = value.split(':').map(Number); return Math.abs(doc.width / doc.height - w / h) < 0.015; });
  $('#ratio').value = ratio || 'custom';
  $('#guide-size').textContent = `${doc.width} × ${doc.height}`;
  const mannequinScene = doc.source.kind === 'human';
  const animal = mannequinScene && activeActor(doc)?.source.kind === 'animal';
  const human = mannequinScene && !animal;
  const splat = doc.source.kind === 'splat', empty = doc.source.kind === 'empty';
  $('#front').disabled = $('#front-number').disabled = mannequinScene || splat || empty;
  $('#scale').disabled = $('#scale-number').disabled = splat || empty || mannequinScene && !!activeActor(doc)?.locked;
  $('#front').closest('.control').hidden = mannequinScene || splat || empty;
  $('#scale').closest('.control').hidden = splat || empty;
  $('#calibration-hint').textContent = splat
    ? 'The reconstructed subject is aligned with the estimated source camera. Use the camera to adjust the angle, zoom, and composition.'
    : empty ? 'Connect a source image and rebuild the subject, or import a GLB to adjust the scene.'
      : human ? 'Adjust mannequin scale here. Use Edit Scene to change poses, hand poses, and joints.'
        : animal ? 'Use Edit Scene to rotate joints or drag the gold limb handles.'
        : 'GLB uses Y-up by default. Rotate the asset to align its front. Asset scale and camera zoom adjust independently.';
  $('#asset-label').textContent = empty ? 'Waiting for source reconstruction' : human ? 'MakeHuman · Posable Mannequin' : animal ? ANIMAL_SHAPES[activeActor(doc).source.shape] + ' · Posable Mannequin' : doc.source.label || 'GLB Scene';
  $('#source-badge').textContent = empty ? 'PHOTO → 3D' : splat ? doc.source.keep_background ? 'TRIPOSPLAT · Background Included' : 'TRIPOSPLAT · Source Subject' : human ? 'HUMAN · Posable Mannequin' : animal ? ANIMAL_SHAPES[activeActor(doc).source.shape] + ' · Mannequin' : 'GLB · Scene';
  for (const id of ['pose-panel', 'hands-panel', 'body-panel', 'joint-panel']) {
    const available = human || animal && ['joint-panel', 'body-panel'].includes(id);
    const panel = document.getElementById(id);
    panel.classList.toggle('disabled-panel', !available);
    panel.inert = !available || mannequinScene && id !== 'pose-panel' && !!activeActor(doc)?.locked;
    panel.hidden = !available || staticGuide;
  }
  $('#body-sliders').hidden = animal;
  $('#male-anatomy').hidden = !human || Number(doc.mesh.gender) < 0.99;
  $('#show-genitals').checked = doc.mesh.show_genitals === true;
  $('#male-anatomy-controls').hidden = !$('#show-genitals').checked;
  for (const button of document.querySelectorAll('[data-body-shape]'))
    button.setAttribute('aria-pressed', String(doc.mesh.gender === Number(button.dataset.bodyShape)));
  $('#animal-body-sliders').hidden = !animal;
  $('#import-animal-pose').hidden = !animal || activeActor(doc)?.source.shape === 'owl';
  for (const id of ['presets', 'pose-actions', 'saved-poses']) $(`#${id}`).inert = !human || !!activeActor(doc)?.locked;
  $('#reference').hidden = !doc.reference; $('#reference-empty').hidden = !!doc.reference;
  if (doc.reference) $('#reference').src = assetURL(doc.reference.name);
  $('#reference-overlay-toggle').disabled = !doc.reference;
  $('#reference-overlay-toggle').classList.toggle('active', overlayShown && !!doc.reference);
  $('#reference-overlay').hidden = !overlayShown || !doc.reference;
  if (doc.reference) $('#reference-overlay').src = assetURL(doc.reference.name);
  $('#reference-button').disabled = $('#reference-drop').disabled = linkedReference.connected;
  $('#read-reference').hidden = !linkedReference.connected;
  $('#read-reference').disabled = !!linkedReference.pending;
  $('#clear-reference').hidden = !doc.reference;
  $('#clear-reference').disabled = linkedReference.connected;
  $('#clear-reference').title = linkedReference.connected ? 'Disconnect Scene Source Image on the node first.' : 'Remove the source image from this scene.';
  $('#reference-origin').textContent = linkedReference.connected ? linkedReference.message : 'Connect an IMAGE input on the node or upload a source image.';
  $('#reconstruction-state').hidden = !doc.reference;
  const keepBackground = doc.reconstruction.keepBackground;
  $('#keep-background').checked = keepBackground;
  $('#keep-background').disabled = !doc.reference || !!linkedReference.pending;
  const reconstructionChanged = splat && !!doc.source.keep_background !== keepBackground;
  $('#reconstruction-state').textContent = splat ? 'The reconstruction keeps its source pose. Move the camera for a different view or switch to a mannequin to edit the pose.' : 'Rebuild the subject from the source image, then adjust the camera.';
  const returnToCast = $('#return-to-cast');
  const glbScene = doc.source.kind === 'glb';
  returnToCast.hidden = !(splat || glbScene) || !doc.actors.length;
  returnToCast.textContent = glbScene ? 'Keep GLB as Prop and Restore Characters' : 'Return to Mannequins';
  $('#import-glb-label').textContent = mannequinScene ? 'Import GLB Prop' : 'Import GLB Scene';
  $('#reconstruct').disabled = !doc.reference || !!linkedReference.pending;
  if (reconstructionChanged) $('#reconstruction-state').textContent = 'Background setting changed · Rebuild to apply it. The preview shows the last result.';
  if (doc.reference && doc.actors.length) {
    $('#reconstruction-state').textContent += splat ? ' Your characters are saved. Choose Return to Mannequins to edit them.'
      : ' Rebuilding switches the canvas to the reconstruction. Your characters are saved.';
  }
  $('#reconstruct').textContent = reconstructionChanged ? 'Rebuild 3D with New Settings' : keepBackground ? 'Rebuild 3D with Background' : splat ? 'Reload Source Reconstruction' : 'Rebuild 3D from Source';
  $('#empty-scene').hidden = !empty;
  $('#coarse-inputs').hidden = guide !== 'coarse';
  $('#extract-coarse').disabled = !doc.reference || !!linkedReference.pending;
  $('#preview-coarse').disabled = empty;
  $('#coarse-status').textContent = splat ? doc.source.keep_background ? 'Reconstruction with background is ready. Preview it or adjust the camera. Large scenes are experimental.' : 'The reconstructed subject is ready. Preview it or adjust the camera.'
    : animal ? 'Render a guide from the animal’s current pose and camera angle.'
    : human ? 'The scene uses a posable mannequin. Rebuild the source to render its subject.'
      : empty ? 'Rebuild the subject from the source before rendering a camera view.' : 'Render a guide directly from the GLB scene.';
  $('#model-anyangle').classList.toggle('active', !base); $('#model-base').classList.toggle('active', base);
  $('#model-anyangle').disabled = promptMode === 'single';
  $('#model-anyangle').title = promptMode === 'single' ? 'Guide Image Only uses the Qwen Base Model.' : '';
  $('#model-badge').textContent = base ? 'QWEN 2.1' : 'ANYANGLE';
  document.querySelectorAll('[data-guide]').forEach(button => {
    button.classList.toggle('active', button.dataset.guide === guide);
    button.setAttribute('aria-pressed', String(button.dataset.guide === guide));
  });
  $('#openpose-panel').hidden = !base || guide !== 'pose';
  $('#pose-source-description').textContent = poseImage
    ? 'Output the source skeleton in its original composition. Copy visible joints to a mannequin while keeping off-frame limbs in their current pose.'
    : 'The 3D skeleton follows the pose, placement, and camera view. You can also extract or import a skeleton to copy to a mannequin.';
  $('#extract-pose').disabled = !doc.reference || !!linkedReference.pending;
  $('#map-inputs').hidden = !base || !['depth', 'canny'].includes(guide);
  $('#extract-depth').hidden = guide !== 'depth';
  $('#extract-depth').disabled = !doc.reference || !!linkedReference.pending;
  $('#generate-scene-depth').hidden = guide !== 'depth';
  $('#generate-scene-depth').disabled = !['human', 'glb', 'animal'].includes(doc.source.kind);
  $('#depth-invert-row').hidden = guide !== 'depth' || input.kind !== 'depth-scene';
  $('#depth-invert').checked = !!doc.conditioning.depthInvert;
  $('#pose-occlusion').value = doc.conditioning.poseOcclusion || 'all';
  $('#pose-hands').checked = !!doc.conditioning.poseHands;
  $('#pose-scene-options').hidden = poseImage;
  $('#pose-scene-options').inert = !human;
  $('#pose-hands').disabled = $('#pose-occlusion').disabled = !human || poseImage;
  $('#pose-static-options-hint').hidden = !poseImage;
  $('#generate-canny').hidden = guide !== 'canny';
  $('#generate-canny').disabled = !doc.reference || !!linkedReference.pending;
  $('#generate-scene-canny').hidden = guide !== 'canny';
  $('#generate-scene-canny').disabled = empty;
  $('#import-map').textContent = guide === 'depth' ? 'Import Depth Anything Map' : 'Import Canny Image';
  $('#read-map').hidden = !linkedStructure.connected;
  $('#read-map').disabled = !!linkedStructure.pending;
  $('#import-map').disabled = linkedStructure.connected;
  $('#map-status').textContent = guide === 'depth' && input.kind === 'depth-scene' ? 'Shared depth range across the scene · Updates with the camera in mesh scenes.'
    : guide === 'depth' && doc.conditioning.mapOrigin === 'da3' && doc.conditioning.map ? 'Depth was estimated from the source and matches its camera view.'
    : guide === 'canny' && input.kind === 'canny-image' ? 'Outputting Canny edges from the source.'
    : guide === 'canny' && input.kind === 'canny-scene' ? 'Outputting Canny edges from the 3D view.'
    : linkedStructure.connected ? linkedStructure.message || 'Structure guide connected'
    : doc.conditioning.map && doc.conditioning.mapKind === guide ? `Imported ${doc.conditioning.map.label || GUIDE_LABELS[guide]}`
      : guide === 'depth' ? 'Estimate from the source, connect a depth IMAGE, or import a PNG.'
        : 'Generate from the source or 3D view, or import a Canny image.';
  $('#canny-options').hidden = !base || guide !== 'canny' || !!doc.conditioning.map;
  $('#canny-low').value = doc.conditioning.cannyLow; $('#canny-high').value = doc.conditioning.cannyHigh;
  $('#guide-explanation').textContent = !base ? 'Use a coarse render of the new view with the AnyAngle LoRA.'
    : guide === 'depth' ? 'Depth guides spatial layering. Source depth keeps the original view.'
      : guide === 'pose' ? poseImage ? 'The center previews the source skeleton sent to the node.' : 'Output the 3D mannequin skeleton from the current view. Adjust the pose and camera as needed.'
        : guide === 'canny' ? input.kind === 'canny-scene' && !studio?.splat
          ? 'Extract outlines from a high-contrast render using the current camera and occlusion. Adjust thresholds as needed.'
          : 'The center shows the output edges. Adjust thresholds to update them.'
          : 'The base model uses the coarse render as guidance. Camera matching can vary.';
  $('#guide-heading').innerHTML = `${GUIDE_LABELS[guide]} <small>· image_${imageIndex}</small>`;
  $('#guide').alt = `Guide image sent to image_${imageIndex}`;
  $('#prompt-mode').value = promptMode; $('#image-order').value = manifest.imageOrder;
  $('#image-order-row').hidden = promptMode === 'single';
  const customPrompt = promptMode === 'custom';
  const promptEditor = $('#prompt-editor');
  $('#prompt-label').textContent = customPrompt ? 'Full Prompt' : 'Additional Description';
  promptEditor.placeholder = customPrompt ? 'Enter the full prompt' : 'Describe characters, setting, clothing, and style';
  const promptText = doc.conditioning[customPrompt ? 'customPrompt' : 'promptExtra'] ?? '';
  if (promptEditor.value !== promptText) promptEditor.value = promptText;
  $('#prompt-output').hidden = customPrompt;
  $('#reset-prompt').disabled = promptMode === 'default' && !doc.conditioning.customPrompt && !doc.conditioning.promptExtra;
  $('#image-wiring').textContent = promptMode === 'single' ? 'Current guide → image_1. Use Additional Description for characters, setting, and style.'
    : `Source → image_${3 - imageIndex} · Current guide → image_${imageIndex}. Update the encoder connections if you change the order.`;
  $('#prompt-mode-hint').textContent = promptMode === 'custom' ? 'Studio outputs the prompt as written, including image numbers. Leave it blank to build the prompt in the workflow.'
    : promptMode === 'single' ? 'Single-image mode disables the AnyAngle LoRA. Connect the strength output or remove the LoRA from the workflow.'
      : 'Use the two-image template with optional reordering and an additional description.';
  $('#mouse-pitch').checked = doc.interaction?.mousePitch !== false;
  $('#preview-quality').value = doc.interaction?.quality || 'balanced';
  $('#live-preview').checked = doc.interaction?.livePreview !== false;
  $('#prompt-preview').textContent = scenePrompt(doc, manifest);
  if (castMapping && !multi && !manifest.references.length && promptMode !== 'custom') {
    $('#image-wiring').textContent = 'Current structure guide → image_1. Generate from the guide and additional description. Character bindings are kept.';
    $('#prompt-mode-hint').textContent = 'The static guide uses the single-image template. Switch back to 3D guidance to restore the identity mapping.';
  }
  if (multi && doc.version !== 3) {
    $('#image-wiring').textContent = `Guide → image_${manifest.guide.index} · ${manifest.references.map(ref => `Character photo → image_${ref.index} (${ref.actorIds.length} characters share it)`).join(' · ') || 'Characters use text descriptions'}. Connect Multi-Image Encode to use these assignments.`;
    $('#prompt-mode-hint').textContent = `${manifest.guide.index === 1 ? `The first guide is aligned to a multiple of 32. Requested size: ${doc.width} × ${doc.height}.` : 'The first character photo and encoder reference budget determine the output size.'} See the actual size beside the encoder’s latent output.${doc.width % 32 || doc.height % 32 ? ' Use width and height that are multiples of 32.' : ''}`;
    $('#prompt-mode-hint').textContent += ` ${manifest.warnings.join(' ') || `${manifest.imageCount} references · Qwen recommends up to 10. Character assignments follow the actual image order.`}`;
    if (promptMode === 'custom') $('#prompt-mode-hint').textContent += ' Assign the source to a character to use it for identity. Custom prompts keep the image numbers you enter.';
  }
  $('#lora-hint').textContent = base ? 'LoRA strength 0 → Base model' : 'LoRA strength 1 → AnyAngle';
  $('#protocol-hint').textContent = base && unwiredAnyAngle ? 'The workflow still uses a fixed AnyAngle LoRA strength. Connect Studio’s strength output or remove the LoRA loader.'
    : base ? `The base model uses image_${imageIndex} as a guide. Structure matching can vary.`
    : human ? 'Use Qwen Base Model with Pose guidance to change poses. Use AnyAngle to change the camera angle.'
      : 'For AnyAngle, put the clear source image first and the camera render second. Reversing them may weaken camera matching. Connect the LoRA strength output to its loader.';
  $('#protocol-hint').classList.toggle('wiring-warning', base && unwiredAnyAngle);
  $('#openpose-status').textContent = doc.openpose ? poseImage ? doc.openpose.fullBody === false
    ? 'Visible joints extracted. Cropped or occluded photos can output the source pose directly.' : 'Source skeleton ready. Output it directly or edit the pose in 3D.'
    : 'Outputting the 3D mannequin skeleton · Adjust the pose and camera as needed.' : 'Extract a pose from the source or import a skeleton. You can also pose the mannequin by hand.';
  $('#retarget-pose').hidden = animal ? activeActor(doc).source.shape === 'owl' : !doc.openpose?.rawAsset && !doc.conditioning.map;
  $('#retarget-pose').textContent = animal ? 'Apply AnimalPose to Mannequin' : poseImage ? 'Adjust Pose on 3D Mannequin' : 'Copy Photo Pose Again';
  $('#retarget-pose').disabled = false;
  $('#retarget-pose').title = animal ? 'Use AnimalPose keypoints to pose the selected animal' : 'Copy visible joints. Extract older partial-body skeletons again.';
  $('#pose-copy-mode').value = doc.openpose?.retargetMode || (doc.openpose?.origin === 'import' ? 'estimated' : 'conservative');
  $('#pose-copy-mode').querySelector('[value="estimated"]').disabled = doc.openpose?.fullBody === false;
  $('#pose-original').hidden = !doc.openpose?.rawAsset || poseImage;
  const poseSource = activeActor(doc)?.poseSource ?? (doc.actors?.length > 1 ? null : doc.openpose);
  $('#pose-flips').hidden = !poseSource?.points || poseSource.fullBody === false || poseImage || poseSource.retargetMode === 'conservative';
  $('#pose-flips').inert = !!activeActor(doc)?.locked;
  document.querySelectorAll('[data-flip]').forEach(button => button.classList.toggle('on', !!poseSource?.flips?.[button.dataset.flip]));
  $('#read-openpose').hidden = !linkedStructure.connected;
  $('#read-openpose').disabled = !!linkedStructure.pending;
  $('#guide').hidden = !hasGuide() || previewRevision !== revision;
  const emptyCanny = ['canny-scene', 'canny-image'].includes(input.kind) && cannyWarningRevision === revision;
  $('#guide-state').classList.toggle('wiring-warning', emptyCanny);
  $('#guide-state').textContent = emptyCanny ? EMPTY_CANNY_WARNING : !hasGuide() ? guide === 'pose' ? 'Connect a source to extract a pose, or import an OpenPose image.'
    : guide === 'depth' ? 'Estimate depth from the source, or import or connect a depth map.'
      : guide === 'canny' ? 'Connect a source, load a 3D subject, or import a Canny image.'
        : 'Load a 3D subject first.'
    : guide === 'coarse' ? 'The render excludes the workspace grid and controls.' : `Preview of the guide sent to image_${imageIndex}.`;
  $('#save-shot').disabled = $('#fit-frame').disabled = empty;
  $('#open-batch').disabled = !supportsCameraBatch(doc);
  $('#open-batch').title = supportsCameraBatch(doc) ? 'Render or generate a batch from a range or saved views.'
    : 'Use a 3D coarse render, mannequin skeleton, or 3D Canny guide for this feature. Extracted guides keep the source view.';
  $('#download-guide').disabled = !hasGuide();
  $('#apply').disabled = applyDisabled();
  $('#clear-canvas').disabled = busy || !ready || !canvasHasObjects();
  $('#edit-mode').disabled = splat || empty;
  $('#position-mode').disabled = !mannequinScene;
  $('#edit-mode').title = splat ? 'Use Camera mode to change the view of a reconstructed subject.' : empty ? 'Load a 3D subject first.' : '';
  $('#mode-hint').hidden = !splat;
  $('#fit-frame').textContent = splat ? 'Return to Source Camera' : 'Fit to Frame';
  $('.eyebrow').textContent = `${splat ? 'Estimated Source Camera' : 'Scene Front'} · Y-Up · Perspective`;
  $('[data-angle="0"]').textContent = splat ? 'Source Camera' : 'Front';
  const boneSelect = $('#bone-select');
  const bones = animal ? [...(studio?.animal?.joints.keys() || [])] : human ? studio?.viewer.boneList?.map(bone => bone.name) || [] : [];
  const boneList = JSON.stringify(bones);
  if (boneSelect.dataset.bones !== boneList) {
    boneSelect.replaceChildren(new Option('Choose Joint', ''), ...bones.map(name => new Option(animal ? animalJointLabel(name) : name, name)));
    boneSelect.dataset.bones = boneList;
  }
  if (!bones.includes(selectedBone)) selectedBone = '';
  $('#joint-hint').textContent = animal
    ? 'Select a joint to show its rotation rings, or choose it below. Drag a gold handle to move the whole limb.'
    : 'Switch to Edit Scene, then select a joint or drag an IK hand or foot control.';
  $('#bone-name').textContent = selectedBone ? animal ? animalJointLabel(selectedBone) : selectedBone : 'None Selected';
  $('#bone-select').value = selectedBone;
  for (const axis of ['x', 'y', 'z']) controls.get(`bone-${axis}`)?.refresh();
  refreshActorsUI();
  refreshReferencesUI();
}

function animalJointLabel(name) {
  if (name === 'Torso') return 'Spine (Torso)';
  return name.replace(/foreleg joint 1$/, 'elbow').replace(/foreleg joint 2$/, 'wrist')
    .replace(/hind leg joint 1$/, 'knee').replace(/hind leg joint 2$/, 'hock');
}

function makeControl(container, { id, label, min, max, step = 1, unit = '', resetValue, read, write, commit }) {
  const wrap = document.createElement('div'); wrap.className = 'control';
  const top = document.createElement('div'); top.className = 'control-top';
  const title = document.createElement('label'); title.textContent = label; title.htmlFor = `${id}-number`;
  const value = document.createElement('div'); value.className = 'control-value';
  const number = document.createElement('input'); Object.assign(number, { id: `${id}-number`, type: 'number', min, max, step });
  const suffix = document.createElement('span'); suffix.textContent = unit; value.append(number, suffix); top.append(title, value);
  const range = document.createElement('input'); Object.assign(range, { id, type: 'range', min, max, step }); range.setAttribute('aria-label', label);
  const endpoints = document.createElement('div'); endpoints.className = 'control-range-labels';
  for (const text of [`${min}${unit}`, `${max}${unit}`]) { const span = document.createElement('span'); span.textContent = text; endpoints.append(span); }
  if (resetValue !== undefined) {
    const reset = document.createElement('button');
    Object.assign(reset, { type: 'button', className: 'icon-button control-reset', title: `Reset ${label}` });
    reset.setAttribute('aria-label', reset.title);
    const icon = document.createElement('img');
    Object.assign(icon, { src: '../icons/refresh.svg', alt: '' });
    reset.append(icon);
    value.append(reset);
    reset.onclick = () => run(async () => {
      if (Number(read()) === resetValue) return;
      begin();
      write(resetValue);
      if (commit) await commit();
      changed();
    });
  }
  wrap.append(top, range, endpoints); $(container).append(wrap);
  let gesture = false;
  const start = () => { if (!gesture) { begin(); gesture = true; } };
  const update = raw => {
    const input = Number(raw); if (!Number.isFinite(input)) return;
    write(Math.min(max, Math.max(min, input))); changed();
  };
  range.oninput = () => { start(); update(range.value); };
  range.onchange = () => { gesture = false; if (commit) run(async () => { await commit(); changed(); }); };
  number.oninput = () => { if (number.value === '' || !Number.isFinite(number.valueAsNumber)) return; start(); update(number.value); };
  number.onblur = () => {
    const edited = gesture; gesture = false;
    if (edited && commit) run(async () => { await commit(); changed(); });
    control.refresh();
  };
  const control = { refresh() { const v = Number(read()); range.value = v; if (document.activeElement !== number) number.value = Number(v.toFixed(step < 1 ? 2 : 1)); } };
  controls.set(id, control); control.refresh();
}

for (const [key, label, min, max, step, unit] of [
  ['azimuth', 'Azimuth', -180, 180, 0.1, '°'], ['elevation', 'Pitch', -89, 89, 0.1, '°'],
  ['zoom', 'Composition Zoom', 0.1, 8, 0.01, '×'],
]) makeControl('#camera-sliders', { id: key, label, min, max, step, unit,
  read: () => doc.camera[key], write: value => { doc.camera[key] = value; studio.updateShot(); } });
makeControl('#focal-sliders', { id: 'focal-length', label: 'Focal Length', min: 12, max: 200, step: 1, unit: 'mm',
  read: () => doc.camera.focalLength || 50, write: value => { doc.camera.focalLength = value; studio.updateShot(); } });
$('#lens-mode').onchange = event => {
  begin(); doc.camera.focalLength = event.target.value === 'custom' ? 50 : 0; studio.updateShot(true); changed();
};
document.querySelectorAll('[data-focal]').forEach(button => { button.onclick = () => {
  begin(); doc.camera.focalLength = Number(button.dataset.focal); studio.updateShot(true); changed();
}; });
for (const button of document.querySelectorAll('[data-body-shape]')) button.onclick = () => run(async () => {
  const actor = activeActor(doc), gender = Number(button.dataset.bodyShape);
  if (actor?.source.kind !== 'human' || actor.locked || doc.mesh.gender === gender) return;
  begin(); doc.mesh.gender = gender;
  await studio.morph(); changed();
});
const defaultBodyShape = defaultScene().mesh;
for (const [key, label, min, max, step] of [
  ['age', 'Age', 18, 75, 1], ['gender', 'Female to Male', 0, 1, 0.01], ['breast_size', 'Breast Size', 0, 1.5, 0.01],
  ['weight', 'Weight', -0.15, 1.5, 0.01], ['muscle', 'Muscle', -0.15, 1.5, 0.01], ['height', 'Height', 0, 1, 0.01],
]) makeControl('#body-sliders', { id: `body-${key}`, label, min, max, step, resetValue: defaultBodyShape[key],
  read: () => doc.mesh[key], write: value => { doc.mesh[key] = value; }, commit: () => studio.morph() });
$('#reset-body-shape').onclick = () => run(async () => {
  const actor = activeActor(doc);
  if (doc.source.kind !== 'human' || actor?.locked) return;
  begin();
  for (const key of ['age', 'gender', 'breast_size', 'weight', 'muscle', 'height']) doc.mesh[key] = defaultBodyShape[key];
  await studio.morph();
  changed();
});
$('#reset-male-anatomy').onclick = () => run(async () => {
  const actor = activeActor(doc);
  if (doc.source.kind !== 'human' || actor?.locked) return;
  begin();
  for (const key of ['penis_len', 'penis_circ', 'penis_test', 'penis_tilt', 'penis_turn', 'genital_size']) delete doc.mesh[key];
  await studio.morph();
  changed();
});
$('#show-genitals').onchange = event => run(async () => {
  const visible = event.target.checked;
  begin(); doc.mesh.show_genitals = visible;
  await studio.morph(); changed();
});
for (const [key, label, max] of [['penis_len', 'Penis Length', 2.5], ['penis_circ', 'Penis Girth', 2.5], ['penis_test', 'Testicle Size', 1]])
  makeControl('#male-anatomy-sliders', { id: `body-${key}`, label, min: 0, max, step: 0.01, resetValue: 0.5,
    read: () => doc.mesh[key] ?? (key === 'penis_len' ? doc.mesh.genital_size : undefined) ?? 0.5,
    write: value => { doc.mesh[key] = value; }, commit: () => studio.morph() });
for (const [key, label, min, max] of [['penis_tilt', 'Penis Tilt', -45, 175], ['penis_turn', 'Penis Left / Right', -90, 90]])
  makeControl('#male-anatomy-sliders', { id: `body-${key}`, label, min, max, unit: '°', resetValue: 0,
    read: () => doc.mesh[key] ?? 0,
    write: value => { doc.mesh[key] = value; }, commit: () => studio.morph() });
makeControl('#animal-body-sliders', { id: 'animal-size', label: 'Size', min: 0.25, max: 4, step: 0.01, unit: '×',
  read: () => activeActor(doc)?.transform.scale ?? 1,
  write: value => {
    const actor = activeActor(doc);
    if (!studio.animal || !actor || actor.locked) return;
    doc.scale = actor.transform.scale = value;
    studio.updateActorTransform(actor);
  } });
makeControl('#animal-body-sliders', { id: 'animal-build', label: 'Body Build · Lean to Stocky', min: 0.65, max: 1.45, step: 0.01,
  read: () => activeActor(doc)?.animalBuild ?? 1,
  write: value => {
    const actor = activeActor(doc);
    if (!studio.animal || !actor || actor.locked) return;
    actor.animalBuild = value;
    studio.animal.setBuild(value);
    studio.viewer.requestRender();
  } });
for (const axis of ['x', 'y', 'z']) makeControl('#bone-sliders', { id: `bone-${axis}`, label: `Rotate ${axis.toUpperCase()}`, min: -180, max: 180, step: 1, unit: '°',
  read: () => ((studio?.animal ? studio.animal.joints.get(selectedBone) : studio?.viewer.bones[selectedBone])?.rotation[axis] || 0) * 180 / Math.PI,
  write: value => {
    const bone = studio.animal ? studio.animal.joints.get(selectedBone) : studio.viewer.bones[selectedBone];
    if (!bone) return;
    bone.rotation[axis] = value * Math.PI / 180;
    bone.updateMatrixWorld(true);
    if (studio.animal) studio.animal.update(selectedBone);
    else { studio.viewer.updateIKEffectorPositions(); studio.viewer.updateMarkers(); }
    studio.viewer.requestRender();
  } });
for (const [key, label, min, max, step, unit] of [['front', 'Front Alignment', -180, 180, 1, '°'], ['scale', 'Asset Scale', 0.25, 3, 0.01, '×']]) {
  makeControl('#scene-sliders', { id: key, label, min, max, step, unit, read: () => doc[key], write: value => { doc[key] = value; }, commit: async () => { studio.syncPose(); await studio.restore(doc); } });
}
for (const [key, label] of [['offsetX', 'Horizontal Framing Offset'], ['offsetY', 'Vertical Framing Offset']]) {
  makeControl('#scene-sliders', { id: key, label, min: -20, max: 20, step: 0.01,
    read: () => doc.camera[key], write: value => { doc.camera[key] = value; studio.updateShot(); } });
}

for (const [side, label] of [['l', 'Left Hand'], ['r', 'Right Hand']]) {
  const row = document.createElement('div'); row.className = 'hand-row';
  const title = document.createElement('h3'); title.textContent = label;
  const buttons = document.createElement('div'); buttons.className = 'three-buttons';
  for (const [key, text] of [['OPEN', 'Relaxed'], ['CHOP', 'Flat'], ['FIST', 'Fist']]) {
    const button = document.createElement('button'); button.textContent = text;
    button.onclick = () => { begin(); studio.hand(side, key); changed(); }; buttons.append(button);
  }
  row.append(title, buttons); $('#hands').append(row);
}

function setMode(mode) {
  studio.setMode(mode);
  mode = studio.mode;
  $('#camera-mode').classList.toggle('active', mode === 'camera'); $('#edit-mode').classList.toggle('active', mode === 'edit');
  $('#position-mode').classList.toggle('active', mode === 'position'); $('#position-mode').setAttribute('aria-pressed', String(mode === 'position'));
  $('#camera-mode').setAttribute('aria-pressed', String(mode === 'camera')); $('#edit-mode').setAttribute('aria-pressed', String(mode === 'edit'));
  $('#use-view').hidden = mode !== 'edit';
  $('#stage-help').textContent = mode === 'camera' ? 'Yellow frame marks the output · Drag to orbit · Middle-drag or Shift-drag to pan · Scroll to zoom'
    : mode === 'position' ? 'Select a character · Drag to place · Right-drag to orbit · Middle-drag to pan'
    : studio.animal ? 'Drag Pelvis to lower the hips · Drag knees or elbows to steer the bend · Click a joint for rotation rings'
    : doc.source.kind === 'human' ? 'Select joints or drag IK handles · Right-drag to orbit · Middle-drag to pan · Camera stays in place'
      : 'Right-drag to orbit · Middle-drag to pan · Set this view as the camera';
}
$('#view-output').onclick = () => { previewVisible = true; refresh(); renderPreview(); };
$('#view-scene').onclick = () => { previewVisible = false; setMode(studio.mode); refresh(); };
$('#camera-mode').onclick = () => setMode('camera'); $('#edit-mode').onclick = () => setMode('edit');
$('#position-mode').onclick = () => { previewVisible = false; setMode('position'); refresh(); };
$('#use-view').onclick = () => { begin(); studio.currentViewAsShot(); setMode('camera'); changed(); };
$('#fit-frame').onclick = () => { begin(); studio.fit(); changed(); };
document.querySelectorAll('[data-angle]').forEach(button => { button.onclick = () => { begin(); doc.camera.azimuth = Number(button.dataset.angle); doc.camera.elevation = 0; studio.updateShot(); changed(); }; });
$('#reset-camera').onclick = () => { begin(); doc.camera = doc.source.kind === 'splat' ? referenceCamera() : defaultScene().camera; studio.updateShot(true); changed(); };
$('#bone-select').onchange = event => {
  studio.finishDrag(false); selectedBone = event.target.value;
  if (studio.animal) {
    studio.selectAnimalJoint(selectedBone);
  } else studio.viewer.selectBoneByName(selectedBone);
  refresh();
};
$('#reset-bone').onclick = () => {
  if (!selectedBone) return;
  begin();
  if (studio.animal) {
    studio.animal.resetJoint(selectedBone);
    studio.animal.update(selectedBone);
    studio.viewer.requestRender();
  } else studio.viewer.resetSelectedBone();
  changed();
};
function dimensions(width, height) { begin(); doc.width = Math.round(Math.max(64, Math.min(4096, width))); doc.height = Math.round(Math.max(64, Math.min(4096, height))); studio.updateShot(); changed(); }
$('#width').oninput = event => { const value = Number(event.target.value); if (Number.isFinite(value) && value >= 64 && value <= 4096) dimensions(value, doc.height); };
$('#height').oninput = event => { const value = Number(event.target.value); if (Number.isFinite(value) && value >= 64 && value <= 4096) dimensions(doc.width, value); };
$('#ratio').onchange = event => {
  if (event.target.value === 'custom') return;
  const [a, b] = event.target.value.split(':').map(Number); const long = Math.max(doc.width, doc.height);
  dimensions(a >= b ? long : Math.round(long * a / b / 32) * 32, a >= b ? Math.round(long * b / a / 32) * 32 : long);
};
$('#background').onchange = event => { begin(); doc.background = event.target.value; changed(); };
$('#prompt-mode').onchange = event => {
  begin();
  if (event.target.value === 'custom' && doc.conditioning.customPrompt === undefined) {
    const customDoc = { ...doc, conditioning: { ...doc.conditioning, promptMode: 'custom' } };
    doc.conditioning.customPrompt = doc.version !== 3 && actorMode(customDoc) ? actorPrompt(doc, buildManifest(customDoc)) : scenePrompt(doc);
  }
  doc.conditioning.promptMode = event.target.value;
  if (event.target.value === 'single') doc.conditioning.model = 'base';
  changed();
};
$('#image-order').onchange = event => { begin(); doc.conditioning.imageOrder = event.target.value; changed(false); };
let editingPrompt = false;
$('#prompt-editor').onblur = () => { editingPrompt = false; };
$('#prompt-editor').oninput = event => {
  if (!editingPrompt) begin();
  editingPrompt = true;
  const key = doc.conditioning.promptMode === 'custom' ? 'customPrompt' : 'promptExtra';
  doc.conditioning[key] = event.target.value;
  changed(false);
};
$('#reset-prompt').onclick = () => {
  begin();
  doc.conditioning.promptMode = 'default';
  delete doc.conditioning.customPrompt;
  delete doc.conditioning.promptExtra;
  changed();
};
$('#mouse-pitch').onchange = event => { begin(); doc.interaction.mousePitch = event.target.checked; changed(false); };
$('#preview-quality').onchange = event => { begin(); doc.interaction.quality = event.target.value; studio.updatePerformance(); changed(false); };
$('#live-preview').onchange = event => { begin(); doc.interaction.livePreview = event.target.checked; changed(false); if (event.target.checked) schedulePreview(); else clearTimeout(previewTimer); };
$('#refresh-guide').onclick = () => renderPreview();
$('#model-anyangle').onclick = () => {
  const custom = doc.conditioning.promptMode === 'custom';
  if (doc.conditioning.model === 'anyangle' && (custom || doc.conditioning.imageOrder === 'reference-first')) return;
  begin(); doc.conditioning.model = 'anyangle';
  if (!custom) doc.conditioning.imageOrder = 'reference-first';
  changed();
};
$('#model-base').onclick = () => { if (doc.conditioning.model === 'base') return; begin(); doc.conditioning.model = 'base'; changed(); };
document.querySelectorAll('[data-guide]').forEach(button => button.onclick = () => run(async () => {
  const guide = button.dataset.guide;
  if (currentGuide() === guide) { previewVisible = guide !== 'coarse'; refresh(); return; }
  begin(); if (guide !== 'coarse') doc.conditioning.model = 'base'; doc.conditioning.guide = guide;
  if (doc.conditioning.mapKind !== guide) { doc.conditioning.map = null; doc.conditioning.mapKind = null; doc.conditioning.mapOrigin = null; }
  if (guide === 'canny' && !doc.conditioning.map) doc.conditioning.mapOrigin = doc.reference ? 'reference' : 'auto';
  if (guide === 'pose' && doc.openpose?.rawAsset && !doc.openpose.useRig) {
    doc.conditioning.map = doc.openpose.rawAsset; doc.conditioning.mapKind = 'pose';
    doc.conditioning.mapOrigin = doc.openpose.origin;
  }
  if (linkedStructure.asset && ['pose', 'depth', 'canny'].includes(guide) && !usesLocalGuide(guide)) await applyStructureAsset(linkedStructure.asset);
  else changed();
}));
for (const [id, key] of [['canny-low', 'cannyLow'], ['canny-high', 'cannyHigh']]) {
  $(`#${id}`).onchange = event => { begin(); doc.conditioning[key] = Math.max(0, Math.min(255, Number(event.target.value) || 0)); changed(); };
}
$('#reference-overlay-toggle').onclick = () => { overlayShown = !overlayShown; refresh(); };
async function undoRedo(source, target) {
  if (!source.length) return;
  const previous = doc, previousSource = source.slice(), previousTarget = target.slice();
  try {
    studio.syncPose(); target.push(clone(doc)); doc = clone(source.pop());
    if (linkedReference.asset) { const previous = doc.reference; doc.reference = linkedReference.asset; sourceChanged(doc, previous); }
    if (doc.version !== 3 && doc.source.kind === 'splat' && doc.source.reference?.name !== doc.reference?.name) doc.source = { kind: 'empty' };
    await studio.restore(doc); changed(); renderShots(); refresh();
  } catch (error) {
    doc = previous;
    source.splice(0, source.length, ...previousSource); target.splice(0, target.length, ...previousTarget);
    try { await studio.restore(doc); } catch { /* A rollback load failure must not replace the original error. */ }
    throw error;
  }
}
$('#undo').onclick = () => run(() => undoRedo(undo, redo)); $('#redo').onclick = () => run(() => undoRedo(redo, undo));
document.addEventListener('keydown', event => {
  if (event.target.closest('input,textarea,select,[contenteditable="true"]') || busy || document.querySelector('dialog[open]')) return;
  if (event.key === 'Escape' && studio.cancelDrag()) { event.preventDefault(); return; }
  if (event.ctrlKey || event.metaKey) {
    if (event.key.toLowerCase() === 'z') { event.preventDefault(); (event.shiftKey ? $('#redo') : $('#undo')).click(); }
    if (event.key.toLowerCase() === 'y') { event.preventDefault(); $('#redo').click(); }
  }
  if (doc.source.kind === 'human' && event.key === 'Delete') { event.preventDefault(); $('#delete-actor').click(); }
  if (doc.source.kind === 'human' && event.altKey && ['ArrowLeft','ArrowRight'].includes(event.key)) {
    event.preventDefault(); const actors = doc.actors, index = actors.findIndex(actor => actor.id === doc.activeActorId);
    if (actors.length) selectRole(actors[(index + (event.key === 'ArrowRight' ? 1 : -1) + actors.length) % actors.length].id);
  }
});

async function upload(file, preserveAlpha = false) {
  const form = new FormData(); form.append('file', file);
  const response = await fetch(`/anyangle-studio/assets${preserveAlpha ? '?alpha=preserve' : ''}`, { method: 'POST', body: form });
  const result = await response.json(); if (!response.ok) throw new Error(result.error || 'Import failed'); return result;
}
async function applyOpenPoseAsset(asset, detectedPoints = null, fullBody = null, visibleOnly = false) {
  begin();
  doc.openpose = { name: asset.label || 'OpenPose skeleton', sourceName: asset.name, rawAsset: asset,
    origin: detectedPoints ? 'dwpose' : 'import', points: detectedPoints, fullBody, visibleOnly,
    referenceName: detectedPoints ? doc.reference?.name : null, acceptStoredSource: false,
    retargetMode: detectedPoints ? 'conservative' : 'estimated', flips: {} };
  doc.conditioning.model = 'base'; doc.conditioning.guide = 'pose';
  doc.conditioning.map = asset; doc.conditioning.mapKind = 'pose'; doc.conditioning.mapOrigin = doc.openpose.origin;
  doc.derivedGuideStale = false;
  previewGuide = 'pose'; previewVisible = true; changed();
}
async function retargetPose() {
  if (studio.animal) throw new Error('AnimalPose needs AP-10K keypoints. Import its JSON or connect the POSE_KEYPOINT output.');
  if (doc.openpose?.people?.length) return chooseDetectedPeople(doc.openpose.people, doc.openpose.rawAsset, { reference: doc.openpose.origin === 'dwpose' ? doc.reference : null, origin: doc.openpose.origin });
  const mode = doc.openpose?.retargetMode || (doc.openpose?.origin === 'dwpose' ? 'conservative' : 'estimated');
  if (doc.openpose?.origin === 'dwpose' && doc.openpose.fullBody === false
      && (!doc.openpose.visibleOnly || mode === 'estimated'))
    throw new Error('Extract the partial-body pose again and choose 2D Transfer. Estimated 3D requires full-body joints.');
  const asset = doc.openpose?.rawAsset || doc.conditioning.map;
  if (!asset) throw new Error('Extract or import a skeleton first.');
  let people;
  if (doc.openpose?.points) people = [doc.openpose.points];
  else {
    const image = new Image(); image.src = assetURL(asset.name); await image.decode();
    people = readSkeletonImage(image);
  }
  if (people.length > 1) {
    const candidates = people.map((raw, i) => {
      const inferred = people.inferredByPerson?.[i] || people.inferredJoints || [], points = Object.fromEntries(Object.entries(raw).filter(([key])=>!inferred.includes(key))), values = Object.values(points);
      return { id: `png-${i}`, points, fullBody: !!(points.la && points.ra), canEstimate3D: !inferred.length, inferredJoints: inferred,
        warning: inferred.length ? 'Inferred keypoints are skipped. Missing limbs keep their pose.' : '', bbox: [Math.min(...values.map(p=>p[0])), Math.min(...values.map(p=>p[1])), Math.max(...values.map(p=>p[0])), Math.max(...values.map(p=>p[1]))], canvasWidth: asset.width, canvasHeight: asset.height };
    });
    return chooseDetectedPeople(candidates, asset, { origin: 'import' });
  }
  const inferred = people.inferredByPerson?.[0] || people.inferredJoints || [];
  const points = people[0] && Object.fromEntries(Object.entries(people[0]).filter(([key])=>!inferred.includes(key)));
  const copyMode = inferred.length ? 'conservative' : mode;
  if (!points) throw new Error('No usable OpenPose body skeleton found.');
  const previous = clone(doc), rollbackHistory = begin();
  try {
    if (doc.source.kind !== 'human') {
      doc.source = { kind: 'human' }; doc.front = 0; doc.scale = 1; doc.camera = defaultScene().camera;
      await studio.restore(doc); await ensureHumanTools();
    }
    doc.openpose = { ...doc.openpose, points, inferredJoints: inferred, retargetMode: copyMode, flips: {}, useRig: true };
    doc.conditioning.model = 'base'; doc.conditioning.guide = 'pose';
    doc.conditioning.map = null; doc.conditioning.mapKind = null; doc.conditioning.mapOrigin = null;
    const facingAway = studio.applyOpenPose(points, {}, copyMode);
    const role = activeActor(doc); if (role) role.poseSource = { ...clone(doc.openpose), points, retargetMode: copyMode };
    setMode('camera');
    previewVisible = false;
    changed();
    const notes = [copyMode === 'conservative' ? 'Copied visible orientations. Off-frame limbs kept their pose.' : facingAway ? 'Back view detected' : 'Front view detected'];
    if (inferred.length) notes.push('Inferred keypoints skipped');
    $('#openpose-status').textContent = `${asset.label || 'OpenPose skeleton'} · ${notes.join(' · ')}`;
    return true;
  } catch (error) {
    doc = previous; rollbackHistory?.();
    try { await studio.restore(doc); } catch { /* Keep the original pose-copy error. */ }
    throw error;
  }
}
$('#retarget-pose').onclick = () => studio.animal ? applySourceAnimalPose() : run(retargetPose);
$('#pose-copy-mode').onchange = event => {
  if (!doc.openpose) return;
  begin(); doc.openpose.retargetMode = event.target.value; changed(false);
};
$('#pose-original').onclick = () => {
  if (!doc.openpose?.rawAsset) return;
  begin(); doc.openpose.useRig = false;
  doc.conditioning.map = doc.openpose.rawAsset; doc.conditioning.mapKind = 'pose';
  doc.conditioning.mapOrigin = doc.openpose.origin; previewVisible = true; changed();
};
async function applyStructureAsset(asset) {
  if (currentGuide() === 'pose') return applyOpenPoseAsset(asset);
  begin(); doc.conditioning.map = asset; doc.conditioning.mapKind = currentGuide(); doc.conditioning.mapOrigin = 'import'; changed();
}
$('#import-openpose').onclick = () => $('#openpose-file').click();
async function extractPhotoPose(copyToHuman = false) {
  if (!doc.reference?.name) throw new Error('Connect or import a source image first.');
  $('#loading-text').textContent = 'Extracting pose from the source';
  $('#loading-detail').textContent = 'First use may require downloading the DWPose model.';
  $('#loading').hidden = false;
  try {
    const response = await fetch('/anyangle-studio/dwpose', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reference: doc.reference.name }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'DWPose extraction failed');
    await applyOpenPoseAsset(result.asset, result.points, result.fullBody, result.visibleOnly);
    doc.openpose.people = result.people || [];
    if (copyToHuman) { const copied = await retargetPose(); toast(copied ? 'Copied the visible pose to the mannequin. You can edit, undo, or save it.' : 'Pose transfer canceled. The source skeleton and scene characters are kept.'); }
    else toast(result.fullBody ? 'Source pose extracted. The center shows the output skeleton.' : 'Visible pose extracted. Hidden limbs keep their mannequin pose.');
  } finally { $('#loading').hidden = true; }
}
$('#extract-pose').onclick = () => run(() => extractPhotoPose());
$('#copy-photo-pose').onclick = () => {
  const actor = studio.animal ? activeActor(doc) : doc.source.kind === 'splat' ? animalPoseTarget() : null;
  if (actor) return applySourceAnimalPose(actor.id);
  return run(async () => {
    try { await extractPhotoPose(true); }
    catch (error) {
      if (!/detected no people|could not extract a clear body skeleton/i.test(error.message)) throw error;
      const target = animalPoseTarget();
      if (target && (!$('#read-animal-keypoints').hidden || cachedAnimalPose())) {
        if (cachedAnimalPose()) await applyAnimalKeypoints(cachedAnimalPose(), target.id);
        else requestAnimalPose(target.id);
      } else if (!$('#read-animal-keypoints').hidden) {
        throw new Error('DWPose found no person. Select a Canine, Feline, or Bunny mannequin to apply the connected AnimalPose.');
      } else throw error;
    }
  });
};
$('#import-map').onclick = () => $('#map-file').click();
$('#extract-depth').onclick = () => run(async () => {
  if (!doc.reference?.name) throw new Error('Connect or import a source image first.');
  $('#loading-text').textContent = 'Estimating source depth';
  $('#loading-detail').textContent = 'First use may require downloading the Depth Anything 3 Small model.';
  $('#loading').hidden = false;
  try {
    const response = await fetch('/anyangle-studio/depth', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reference: doc.reference.name }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Depth estimation failed');
    begin(); doc.conditioning.map = result.asset; doc.conditioning.mapKind = 'depth';
    doc.conditioning.mapOrigin = 'da3'; doc.conditioning.mapReference = doc.reference.name; doc.conditioning.acceptStoredSource = false;
    doc.derivedGuideStale = false; previewVisible = true; changed();
  } finally { $('#loading').hidden = true; }
});
async function generateCanny(origin) {
  await run(async () => {
    if (origin === 'reference' && !doc.reference) throw new Error('Connect or import a source image first.');
    if (origin === 'auto' && doc.source.kind === 'empty') throw new Error('Rebuild or load a 3D scene first.');
    begin(); doc.conditioning.map = null; doc.conditioning.mapKind = null;
    doc.conditioning.mapOrigin = origin; previewVisible = true; changed();
  });
  if (previewRevision === revision) toast(cannyWarningRevision === revision ? EMPTY_CANNY_WARNING : 'Canny edges generated. The center shows the output.');
}
$('#generate-canny').onclick = () => generateCanny('reference');
$('#generate-scene-canny').onclick = () => generateCanny('auto');
$('#generate-scene-depth').onclick = () => { begin(); doc.conditioning.map = null; doc.conditioning.mapKind = null; doc.conditioning.mapOrigin = 'scene'; previewVisible = true; changed(); };
$('#depth-invert').onchange = event => { begin(); doc.conditioning.depthInvert = event.target.checked; changed(); };
$('#pose-occlusion').onchange = event => { begin(); doc.conditioning.poseOcclusion = event.target.value; changed(); };
$('#pose-hands').onchange = event => { begin(); doc.conditioning.poseHands = event.target.checked; changed(); };
$('#import-animal-pose').onclick = () => { animalFileTarget = null; $('#animal-pose-file').click(); };
$('#read-animal-keypoints').onclick = () => send('anyangle-read-keypoints');
$('#animal-pose-file').onchange = event => run(async () => {
  const file = event.target.files[0]; event.target.value = '';
  const actorId = animalFileTarget; animalFileTarget = null;
  if (!file) return;
  const data = JSON.parse(await file.text());
  await applyAnimalKeypoints(Array.isArray(data) ? data[0] : data, actorId);
});
let latestAnimalKeypoints = null;
let animalFileTarget = null;
function animalPoseTarget() {
  const candidates = doc.actors.filter(actor => actor.source.kind === 'animal' && actor.source.shape !== 'owl' && !actor.locked && actor.visible !== false);
  return candidates.find(actor => actor.id === doc.activeActorId) || (candidates.length === 1 ? candidates[0] : null);
}
function cachedAnimalPose() {
  return latestAnimalKeypoints?.reference === (doc.reference?.name || null) ? latestAnimalKeypoints.frame : null;
}
function requestAnimalPose(actorId) {
  send('anyangle-read-keypoints', { animalActorId: actorId, sourceName: doc.reference?.name || null });
}
function applySourceAnimalPose(actorId) {
  if (!$('#read-animal-keypoints').hidden) requestAnimalPose(actorId);
  else if (cachedAnimalPose()) return run(() => applyAnimalKeypoints(cachedAnimalPose(), actorId));
  else { animalFileTarget = actorId; $('#animal-pose-file').click(); }
}
async function applyAnimalKeypoints(frame, actorId = null) {
  if (frame?.version !== 'ap10k') throw new Error('Choose an AP-10K JSON file from AnimalPose Estimator.');
  const actor = actorId ? doc.actors.find(item => item.id === actorId) : studio.animal ? activeActor(doc) : null;
  if (actor?.source.kind !== 'animal' || actor.source.shape === 'owl')
    throw new Error('Select an unlocked Canine, Feline, or Bunny mannequin before importing AP-10K.');
  if (actor.locked || actor.visible === false) throw new Error('Show and unlock the selected animal before importing its pose.');
  if (!Array.isArray(frame.animals) || frame.animals.length !== 1)
    throw new Error('Choose an AP-10K frame with one detected animal.');
  const values = frame.animals[0];
  if (!Array.isArray(values) || values.length !== 51 || !values.every(Number.isFinite))
    throw new Error('Invalid AP-10K pose. Expected 17 x, y, confidence triplets.');
  const points = Array.from({ length: 17 }, (_, index) => {
    const [x, y, confidence] = values.slice(index * 3, index * 3 + 3);
    return confidence > 0.2 ? [x, y] : null;
  });
  if (!points[3] || !points[4] || Math.hypot(points[3][0] - points[4][0], points[3][1] - points[4][1]) < 1)
    throw new Error('The AP-10K pose needs a visible neck and tail root.');
  const facing = points[3][0] < points[4][0] ? -1 : 1;
  const rollback = begin();
  if (!studio.animal || actor.id !== doc.activeActorId) {
    const previous = clone(doc);
    doc.source = { kind: 'human' };
    bindActor(doc, actor.id); doc.selectedActorIds = [actor.id];
    try { await studio.restore(doc); }
    catch (error) { doc = previous; rollback?.(); await studio.restore(doc); throw error; }
    selectedBone = '';
  }
  latestAnimalKeypoints = { frame, reference: doc.reference?.name || null };
  studio.animal.applyAP10K(points, facing);
  studio.groundActors([actor.id]);
  doc.conditioning.guide = 'coarse';
  doc.conditioning.map = null; doc.conditioning.mapKind = null; doc.conditioning.mapOrigin = 'auto';
  doc.camera.azimuth = ((actor.transform.yaw - facing * 87 + 540) % 360) - 180;
  doc.camera.elevation = 2;
  previewVisible = false;
  setMode('edit');
  studio.fit(true);
  $('#joint-panel').open = true;
  changed();
  toast('AP-10K pose applied. Drag the joints to refine it.');
}
$('#openpose-file').onchange = event => run(async () => {
  const file = event.target.files[0]; event.target.value = ''; if (!file) return;
  if (file.name.toLowerCase().endsWith('.json')) {
    const keypoints = JSON.parse(await file.text());
    const firstFrame = Array.isArray(keypoints) ? keypoints[0] : keypoints;
    if (firstFrame?.version === 'ap10k') {
      await applyAnimalKeypoints(firstFrame);
      return;
    }
    const photoCanvas = doc.reference?.width && doc.reference?.height;
    const canvasWidth = photoCanvas ? doc.reference.width : doc.width, canvasHeight = photoCanvas ? doc.reference.height : doc.height;
    const frame = Array.isArray(keypoints) ? keypoints[0] : keypoints;
    const missingCanvas = frame?.canvas_width == null && frame?.canvas_height == null;
    const response = await fetch('/anyangle-studio/pose-people', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keypoints, canvas_width: canvasWidth, canvas_height: canvasHeight }) });
    const result = await response.json(); if (!response.ok) throw new Error(result.error || 'Invalid skeleton JSON');
    await applyOpenPoseAsset(result.asset, result.points, result.fullBody, result.visibleOnly); doc.openpose.people = result.people; doc.openpose.origin = 'json'; changed();
    if (missingCanvas) toast(`The JSON has no canvas size. Importing in ${photoCanvas ? 'source image' : 'current output'} coordinates (${canvasWidth} × ${canvasHeight}). Check that the skeleton uses the same coordinates.`);
    return;
  }
  await applyOpenPoseAsset(await upload(file));
});
$('#map-file').onchange = event => run(async () => {
  const file = event.target.files[0]; event.target.value = ''; if (!file) return;
  await applyStructureAsset(await upload(file));
});
$('#read-map').onclick = $('#read-openpose').onclick = () => {
  explicitStructureRead = true;
  linkedStructure = { ...linkedStructure, connected: true, pending: true, message: 'Reading connected structure guide…' };
  refresh(); send('anyangle-read-structure');
};
document.querySelectorAll('[data-flip]').forEach(button => {
  button.onclick = () => {
    if (studio.animal) return;
    const actor = activeActor(doc), source = actor?.poseSource ?? (doc.actors?.length > 1 ? null : doc.openpose);
    if (!source?.points || source.fullBody === false || source.retargetMode === 'conservative' || actor?.locked || doc.source.kind !== 'human') return;
    begin(); const key = button.dataset.flip;
    source.flips = { ...source.flips, [key]: !source.flips?.[key] };
    studio.applyOpenPose(source.points, source.flips, 'estimated'); changed();
  };
});
$('#reference-button').onclick = $('#reference-drop').onclick = () => $('#reference-file').click();
$('#read-reference').onclick = () => {
  linkedReference = { ...linkedReference, connected: true, pending: true, message: 'Reading connected image…' };
  refresh(); send('anyangle-read-reference');
};
async function clearSourceImage() {
  if (!doc.reference || linkedReference.connected) return;
  studio.syncPose();
  const previous = clone(doc), rollback = begin();
  doc.reference = null;
  const reconstructed = doc.source.kind === 'splat';
  if (reconstructed) {
    const actor = activeActor(doc) || doc.actors[0];
    doc.source = { kind: actor ? 'human' : 'empty' };
    if (actor) bindActor(doc, actor.id);
    doc.sourceStale = false;
  }
  sourceChanged(doc, previous.reference);
  if (reconstructed) {
    try { await studio.restore(doc); }
    catch (error) { doc = previous; rollback?.(); await studio.restore(doc); throw error; }
  }
  changed();
}
$('#clear-reference').onclick = () => run(clearSourceImage);
$('#return-to-cast').onclick = () => run(async () => {
  const glbScene = doc.source.kind === 'glb';
  if (!(glbScene || doc.source.kind === 'splat') || !doc.actors.length) return;
  const previous = clone(doc), rollback = begin();
  const actor = activeActor(doc) || doc.actors[0];
  if (glbScene) {
    const { kind, ...asset } = doc.source;
    (doc.props ||= []).push({
      id: `prop-${uuid()}`,
      label: asset.label || 'Imported GLB',
      asset,
      // Standalone GLBs normalize to 20 units and props to 10.
      transform: { x: 0, y: 0, z: 0, scale: doc.scale * 2, yaw: doc.front },
      visible: true,
      locked: false,
    });
  }
  doc.source = { kind: 'human' };
  doc.sourceStale = false;
  doc.camera = defaultScene().camera;
  bindActor(doc, actor.id);
  try { await studio.restore(doc); studio.fit(); }
  catch (error) { doc = previous; rollback?.(); await studio.restore(doc); throw error; }
  previewVisible = false;
  if (glbScene) {
    doc.conditioning.guide = 'coarse';
    previewGuide = 'coarse';
    $('#prop-list').closest('details').open = true;
  }
  setMode('position');
  changed();
});
$('#reference-file').onchange = event => run(async () => {
  const file = event.target.files[0]; event.target.value = ''; if (!file) return; const asset = await upload(file);
  begin(); const previous = doc.reference; doc.reference = asset; sourceChanged(doc, previous);
  if (doc.version !== 3 && doc.source.kind === 'splat') doc.source = { kind: 'empty' };
  await studio.restore(doc); changed();
  if (requiresGuide() && doc.source.kind === 'empty' && currentGuide() === 'coarse') await reconstructPhoto();
});
const referenceCamera = () => ({ azimuth: 0, elevation: 0, zoom: 1, offsetX: 0, offsetY: 0, offsetZ: 0 });
const reconstructionModelLabels = {
  background_removal: 'Background Removal · BiRefNet', clip_vision: 'Image Encoding · DINOv3', diffusion_models: '3D Reconstruction · TripoSplat',
  vae_encoder: 'Image VAE · Flux2', vae_decoder: '3D Decoding · TripoSplat VAE',
};
function showModelStatus(config) {
  $('#reconstruction-model-state').textContent = config.available ? `${doc.reconstruction.keepBackground ? '4 models ready · Including the background skips BiRefNet' : '5 models ready'} · Next reconstruction uses this selection`
    : `Select or install: ${config.missing.join(', ')}`;
}
async function loadReconstructionModels() {
  $('#reconstruction-model-state').textContent = 'Reading local models…';
  $('#reconstruction-model-save').disabled = true;
  try {
    const config = await reconstructionConfig({}, doc.reconstruction.keepBackground);
    if (!config.choices) throw new Error('Restart ComfyUI to enable the updated model selector.');
    const selected = selectedReconstructionModels(), fields = $('#reconstruction-model-fields');
    fields.replaceChildren();
    for (const [role, title] of Object.entries(reconstructionModelLabels)) {
      const label = document.createElement('label'), select = document.createElement('select');
      label.textContent = title; select.dataset.role = role; select.setAttribute('aria-label', title);
      if (role === 'background_removal' && doc.reconstruction.keepBackground) {
        label.textContent += ' · Unused in this mode'; select.disabled = true;
      }
      const automatic = document.createElement('option'); automatic.value = '';
      automatic.textContent = 'Auto-detect · ' + (config.ambiguous[role] ? 'Choose from duplicate filenames'
        : config.choices[role].includes(config.models[role]) ? config.models[role] : 'Missing');
      select.append(automatic);
      for (const name of config.choices[role]) {
        const option = document.createElement('option'); option.value = option.textContent = name; select.append(option);
      }
      if (selected[role] && !config.choices[role].includes(selected[role])) {
        const missing = document.createElement('option'); missing.value = selected[role];
        missing.textContent = `File moved · ${selected[role]}`; missing.disabled = true; select.append(missing);
      }
      select.value = selected[role] || ''; label.append(select); fields.append(label);
    }
    $('#reconstruction-model-save').disabled = false;
    const chosen = await reconstructionConfig(selected, doc.reconstruction.keepBackground);
    showModelStatus(chosen);
  } catch (e) { $('#reconstruction-model-state').textContent = e.message; throw e; }
}
$('#reconstruction-model-panel').ontoggle = () => {
  if ($('#reconstruction-model-panel').open && ready) run(loadReconstructionModels);
};
$('#reconstruction-model-refresh').onclick = () => run(loadReconstructionModels);
$('#reconstruction-model-save').onclick = () => run(async () => {
  const selections = {};
  for (const select of $('#reconstruction-model-fields').querySelectorAll('select'))
    if (select.value) selections[select.dataset.role] = select.value;
  const config = await saveReconstructionModels(selections, doc.reconstruction.keepBackground);
  showModelStatus(config); toast('Model selection saved. Choose Rebuild 3D from Source to use it.');
});
async function reconstructPhoto() {
  if (!doc.reference) return;
  clearTimeout(previewTimer);
  while (previewRunning) await new Promise(resolve => setTimeout(resolve, 30));
  const reference = clone(doc.reference), keepBackground = doc.reconstruction.keepBackground;
  const previous = clone(doc);
  let rollbackHistory;
  $('#loading').hidden = false;
  $('#loading-text').textContent = keepBackground ? 'Preparing reconstruction with background' : 'Preparing source subject reconstruction';
  $('#loading-detail').textContent = keepBackground ? 'Local TripoSplat · Full image → 3D reconstruction → Source camera alignment'
    : 'Local TripoSplat · Background removal → 3D reconstruction → Source camera alignment';
  try {
    const source = await reconstruct(reference, text => { $('#loading-text').textContent = text; }, true, keepBackground);
    if (doc.reference?.name !== reference.name) throw new Error('The source changed. Rebuild it again.');
    rollbackHistory = begin();
    if (doc.source.name !== source.name || !!doc.source.keep_background !== !!source.keep_background) doc.shots = [];
    doc.source = source; doc.front = 0; doc.scale = 1; doc.camera = referenceCamera();
    const outputScale = Math.min(1, 1536 / Math.max(reference.width, reference.height));
    doc.width = Math.max(64, Math.round(reference.width * outputScale));
    doc.height = Math.max(64, Math.round(reference.height * outputScale));
    $('#loading-text').textContent = 'Loading the 3D subject and source camera';
    await studio.restore(doc);
    doc.conditioning.guide = 'coarse';
    doc.sourceStale = false; doc.derivedGuideStale = false;
    previewGuide = 'coarse'; previewVisible = false; studio.setMode('camera');
    changed(); renderShots();
    $('#status').textContent = 'Reconstruction loaded · Adjust the camera, then apply';
  } catch (e) {
    doc = previous; rollbackHistory?.();
    try { await studio.restore(doc); } catch { /* Keep the original reconstruction error. */ }
    $('#status').textContent = 'Reconstruction incomplete · Retry available'; throw e;
  } finally { $('#loading').hidden = true; refresh(); schedulePreview(); }
}
$('#reconstruct').onclick = () => run(reconstructPhoto);
$('#keep-background').onchange = () => {
  begin(); doc.reconstruction.keepBackground = $('#keep-background').checked; changed();
  if ($('#reconstruction-model-panel').open) run(loadReconstructionModels);
};
$('#extract-coarse').onclick = () => run(reconstructPhoto);
$('#preview-coarse').onclick = () => { previewVisible = true; refresh(); renderPreview(); };
$('#import-glb').onclick = () => {
  if (doc.source.kind === 'human') {
    $('#prop-list').closest('details').open = true;
    $('#add-prop').click();
  } else $('#glb-file').click();
};
$('#glb-file').onchange = event => run(async () => {
  const file = event.target.files[0]; event.target.value = ''; if (!file) return;
  const asset = await upload(file), rollbackHistory = begin();
  const previous = clone(doc); doc.source = { kind: 'glb', ...asset }; doc.front = 0; doc.scale = 1; doc.camera = defaultScene().camera;
  try { await studio.restore(doc); studio.fit(); }
  catch (e) {
    doc = previous; rollbackHistory?.();
    try { await studio.restore(doc); } catch { /* Keep the original GLB error. */ }
    throw e;
  }
  changed(); toast('GLB loaded. Adjust its front alignment and scale under Scene and Composition.');
});
$('#animal-shapes').onclick = event => {
  const shape = event.target.closest('button[data-shape]')?.dataset.shape;
  return run(async () => {
    if (!Object.hasOwn(ANIMAL_SHAPES, shape)) return;
    const rollbackHistory = begin();
    const previous = clone(doc);
    studio.syncPose();
    const actor = createActor(doc.actors.length, { label: ANIMAL_SHAPES[shape], source: { kind: 'animal', shape }, animalPose: {} });
    doc.actors.push(actor);
    doc.source = { kind: 'human' };
    bindActor(doc, actor.id); doc.selectedActorIds = [actor.id];
    if (doc.conditioning.guide === 'pose') doc.conditioning.guide = 'coarse';
    try { await studio.restore(doc); studio.fit(); }
    catch (error) {
      doc = previous; rollbackHistory?.();
      await studio.restore(doc);
      throw error;
    }
    selectedBone = '';
    previewVisible = false;
    setMode('edit');
    $('#joint-panel').open = true;
    $('#body-panel').open = true;
    changed();
  });
};
$('#human').onclick = () => run(async () => {
  const rollbackHistory = begin();
  const previous = clone(doc);
  studio.syncPose();
  let person = doc.actors.find(actor => actor.source.kind === 'human');
  if (!person) { person = createActor(doc.actors.length); doc.actors.push(person); }
  doc.source = { kind: 'human' };
  bindActor(doc, person.id); doc.selectedActorIds = [person.id];
  try { await studio.restore(doc); await ensureHumanTools(); }
  catch (e) {
    doc = previous; rollbackHistory?.();
    try { await studio.restore(doc); } catch { /* Keep the original human-load error. */ }
    throw e;
  }
  changed();
});

async function applyRandomPose(seed) {
  if (doc.source.kind !== 'human') return;
  return randomRoles(seed, $('#pose-category').value);
}
$('#pose-category').onchange = $('#pose-seed').onchange = () => {
  if (!$('#pose-seed').reportValidity()) return;
  begin(); doc.randomMaster = { seed: Number($('#pose-seed').value), category: $('#pose-category').value }; changed(false);
};
$('#random-pose').onclick = () => run(() => applyRandomPose(crypto.getRandomValues(new Uint32Array(1))[0]));
$('#repeat-pose').onclick = () => run(() => applyRandomPose(Number($('#pose-seed').value)));

$('#load-error-close').onclick = () => closeWorkbench();
$('#load-error-dialog').oncancel = event => { if (!ready) event.preventDefault(); };
$('#retry-human').onclick = () => {
  $('#load-error-dialog').close(); if (ready) $('#human').onclick(); else location.reload();
};
$('#repair-human').onclick = async () => {
  $('#repair-human').disabled = $('#retry-human').disabled = true;
  $('#repair-state').textContent = 'Checking local assets and downloading missing files…';
  try {
    const response = await fetch('/anyangle-studio/repair-human', { method: 'POST' });
    const result = await response.json(); if (!response.ok) throw new Error(result.error || 'Asset repair failed');
    $('#repair-state').textContent = 'Assets verified. Reloading…'; $('#retry-human').onclick();
  } catch (e) { $('#repair-state').textContent = e.message || String(e); }
  finally { $('#repair-human').disabled = $('#retry-human').disabled = false; }
};

function askName(title, initial) {
  $('#name-title').textContent = title; $('#name-input').value = initial; $('#name-dialog').returnValue = '';
  $('#name-dialog').showModal(); $('#name-input').select();
  return new Promise(resolve => { $('#name-dialog').addEventListener('close', () => resolve($('#name-dialog').returnValue === 'ok' ? $('#name-input').value.trim() : null), { once: true }); });
}
function iconButton(icon, label) { const button = document.createElement('button'); button.className = 'icon-button'; button.title = label; button.setAttribute('aria-label', label); const image = document.createElement('img'); image.src = `../icons/${icon}.svg`; image.alt = ''; button.append(image); return button; }
function renderShots() {
  $('#shots').replaceChildren(); $('#shot-count').textContent = String(doc.shots.length);
  if (!doc.shots.length) { const note = document.createElement('p'); note.className = 'empty-note'; note.textContent = 'Save camera views here. Selecting a saved view keeps the current pose.'; $('#shots').append(note); }
  for (const shot of doc.shots) {
    const item = document.createElement('div'); item.className = 'shot';
    const thumb = document.createElement('button'); thumb.className = 'shot-thumb'; thumb.classList.toggle('active', selectedShot === shot.id); thumb.title = `Apply view ${shot.name}`;
    const image = document.createElement('img'); image.src = shot.thumbnail; image.alt = shot.name; thumb.append(image);
    thumb.onclick = () => {
      begin(); doc.camera = { ...defaultScene().camera, ...clone(shot.camera) };
      if (Array.isArray(shot.cameraTarget) && shot.cameraTarget.length === 3 && shot.cameraTarget.every(Number.isFinite)) doc.cameraTarget = clone(shot.cameraTarget);
      doc.width = shot.width; doc.height = shot.height; previewVisible = false; setMode('camera'); changed(); selectedShot = shot.id; renderShots();
    };
    const caption = document.createElement('div'); caption.className = 'shot-caption';
    const rename = document.createElement('button'); rename.className = 'rename'; rename.textContent = shot.name; rename.title = 'Rename View';
    rename.onclick = async () => { const name = await askName('Rename View', shot.name); if (name) { begin(); shot.name = name; changed(); renderShots(); } };
    const remove = iconButton('trash', `Delete view ${shot.name}`); remove.onclick = () => { begin(); doc.shots = doc.shots.filter(s => s.id !== shot.id); changed(); renderShots(); };
    caption.append(rename, remove); item.append(thumb, caption); $('#shots').append(item);
  }
}
$('#save-shot').onclick = async () => {
  const name = await askName('Save Current View', `View ${doc.shots.length + 1}`); if (!name) return;
  return run(async () => {
    const previous = clone(doc), previousMode = studio.mode, previousShot = selectedShot, rollbackHistory = begin();
    try {
      if (studio.mode === 'edit') studio.currentViewAsShot(); setMode('camera');
      const scale = 230 / Math.max(doc.width, doc.height); const thumbnail = await studio.capture(Math.round(doc.width * scale), Math.round(doc.height * scale));
      const shot = { id: uuid(), name, camera: clone(doc.camera), width: doc.width, height: doc.height, thumbnail };
      if (doc.source.kind === 'human') shot.cameraTarget = studio.baseTarget.toArray();
      doc.shots.push(shot); changed(); selectedShot = shot.id; renderShots();
      toast('View saved to draft. Apply to Node to keep it.');
    } catch (error) {
      doc = previous; rollbackHistory?.(); selectedShot = previousShot;
      try { await studio.restore(doc); } catch { /* Keep the original thumbnail error. */ }
      try { setMode(previousMode); renderShots(); } catch { /* Scene recovery may also be unavailable. */ }
      throw error;
    }
  });
};

function renderLibrary() { poseCatalog?.refresh(); }
function download(data, name) {
  const url = typeof data === 'string' ? data : URL.createObjectURL(data);
  const link = document.createElement('a'); link.href = url; link.download = name; link.hidden = true;
  document.body.append(link); link.click(); link.remove();
  if (typeof data !== 'string') setTimeout(() => URL.revokeObjectURL(url), 60000);
}
$('#export-pose').onclick = () => run(async () => {
  const poseSource = activeActor(doc)?.poseSource ?? (doc.actors?.length > 1 ? null : doc.openpose ?? null);
  const response = await fetch('/anyangle-studio/poses', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ version: 1, kind: 'anyangle-pose', mesh: doc.mesh, pose: studio.pose(), openpose: poseSource }) });
  const result = await response.json(); if (!response.ok) throw new Error(result.error || 'Pose export failed');
  download(`/anyangle-studio/poses/${encodeURIComponent(result.id)}`, 'anyangle-pose.json');
});
$('#download-guide').onclick = () => run(async () => {
  const png = await captureGuide();
  const blob = await (await fetch(png)).blob();
  const asset = await upload(new File([blob], 'anyangle-guide.png', { type: 'image/png' }));
  download(assetURL(asset.name), `${currentGuide()}-guide.png`);
  toast('Guide PNG exported');
});

function send(type, payload = {}) { parent.postMessage({ type, session, ...payload }, location.origin); }
function batchRequest(action, payload = {}) {
  const requestId = uuid();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { batchReplies.delete(requestId); reject(new Error('No confirmation received. Check the ComfyUI queue. Studio will skip automatic resubmission for this view.')); }, 60000);
    batchReplies.set(requestId, { resolve, reject, timer });
    send('anyangle-batch-request', { requestId, action, ...payload });
  });
}
function batchSettings() {
  return { mode: $('#batch-mode').value, angles: $('#batch-angles').value, start: Number($('#batch-start').value),
    end: Number($('#batch-end').value), step: Number($('#batch-step').value) };
}
function currentBatchPlan(scene) {
  const entries = $('#batch-pose-mode').value === 'library' ? poseCatalog.batchEntries() : [];
  if ($('#batch-pose-mode').value === 'library' && !entries.length) throw new Error('Add poses to the batch from the Pose Library first.');
  return entries.length ? poseCameraPlan(scene, batchSettings(), entries, poseCatalog.batchOptions(), cameraBatchPlan) : cameraBatchPlan(scene, batchSettings());
}
function updateBatchPlan() {
  $('#batch-range').hidden = $('#batch-mode').value !== 'range';
  $('#batch-fixed').hidden = $('#batch-mode').value !== 'angles';
  try {
    const plan = currentBatchPlan(doc);
    const posing = $('#batch-pose-mode').value === 'library';
    $('#batch-count').textContent = `${plan.count} ${posing ? 'jobs' : 'views'} · ${posing ? `${poseCatalog.batchEntries().length} poses × views. Keeps identity, pitch, and composition` : $('#batch-mode').value === 'saved' ? 'Uses saved camera settings and size with the current pose' : 'Keeps current pose, pitch, and composition'} · Uses workflow sampling settings`;
    $('#batch-guides').disabled = false; $('#batch-final').disabled = !embedded;
  } catch (e) {
    $('#batch-count').textContent = e.message; $('#batch-guides').disabled = $('#batch-final').disabled = true;
  }
}
$('#open-batch').onclick = () => { updateBatchPlan(); $('#batch-dialog').showModal(); };
for (const id of ['batch-mode', 'batch-angles', 'batch-start', 'batch-end', 'batch-step', 'batch-pose-mode']) $(`#${id}`).oninput = updateBatchPlan;
installBatchPresets({ askName, download, toast, onChange: updateBatchPlan });
$('#batch-close').onclick = () => { if (batchRunning) batchController.abort(); else $('#batch-dialog').close(); };
$('#batch-dialog').addEventListener('cancel', event => { if (batchRunning) { event.preventDefault(); batchController.abort(); } });
$('#batch-stop').onclick = () => batchController?.abort();
$('#batch-zip').onclick = () => { if (batchId) download(`/anyangle-studio/batch-guides/${batchId}`, 'anyangle-guides.zip'); };
$('#batch-manifest').onclick = () => download(new Blob([JSON.stringify({ version: 1, kind: 'anyangle-batch', views: batchViews }, null, 2)],
  { type: 'application/json' }), 'anyangle-batch.json');
function freezeReferenceInputs(scene) {
  for (const item of scene.referenceLibrary?.items || []) if (item.inputKey) { item.frozenInputKey = item.inputKey; item.inputKey = null; }
  return scene;
}
async function runGallery(task) {
  if (busy) throw new Error('Studio is busy. Try again shortly.');
  let failure;
  await run(async () => { try { await task(); } catch (error) { failure = error; } });
  if (failure) throw failure;
}
async function runGalleryBatch(plan, queueFinal, signal, onProgress) {
  clearTimeout(previewTimer); studio.syncPose();
  const original = doc;
  const save = async (scene, png) => {
    const response = await fetch('/anyangle-studio/snapshots', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scene, png }) });
    const saved = await response.json(); if (!response.ok) throw new Error(saved.error || 'Could not save the gallery scene'); return saved;
  };
  try {
    if (queueFinal) {
      const first = plan.views().next().value.scene; doc = first; studio.doc = first;
      const snapshot = await save(first, await captureGuide());
      if (signal.aborted) return { views: [], stopped: true, error: null };
      await batchRequest('prepare', { snapshot });
    }
    const result = await runCameraBatch(plan, { signal, onProgress,
      capture: async scene => { doc = scene; studio.doc = scene; return captureGuide(); }, save,
      queue: queueFinal ? snapshot => batchRequest('queue', { snapshot }) : null });
    if (result.views.length) {
      const response = await fetch('/anyangle-studio/batches', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ views: result.views }) });
      const saved = await response.json();
      if (!response.ok) result.error ||= new Error(saved.error || 'Could not save the batch receipt');
      else result.batchId = saved.id;
    }
    return result;
  } finally { doc = original; studio.doc = original; studio.updateShot(); refresh(); }
}
async function startCameraBatch(queueFinal) {
  clearTimeout(previewTimer); studio.syncPose();
  const plan = currentBatchPlan(freezeReferenceInputs(clone(doc))), original = doc, originalCannyWarning = cannyWarningRevision;
  const posing = $('#batch-pose-mode').value === 'library', floorY=studio.grid?.position.y;
  batchRunning = true; batchController = new AbortController(); batchViews = []; batchId = null;
  $('#batch-options').inert = true; $('#batch-stop').disabled = false; $('#batch-close').textContent = 'Stop Submitting';
  $('#batch-zip').disabled = $('#batch-manifest').disabled = true;
  $('#batch-state').textContent = queueFinal ? 'Preparing the workflow…' : 'Preparing the guide batch…';
  try {
    if (queueFinal) {
      const response = await fetch('/anyangle-studio/snapshots', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scene: freezeReferenceInputs(clone(doc)), png: await captureGuide() }) });
      const snapshot = await response.json(); if (!response.ok) throw new Error(snapshot.error || 'Could not capture a fixed scene for the batch');
      await batchRequest('prepare', { snapshot });
      $('#batch-state').textContent = 'References and prompts are fixed for the batch. Full Input reuses the supplied text. Studio Plus Input combines it with each view’s Studio prompt.';
    }
    const result = await runCameraBatch(plan, {
      signal: batchController.signal,
      capture: async (scene, view) => {
        doc = scene; studio.doc = doc;
        if (posing) { await studio.restore(doc); await finishCatalogPose(studio,view.preparation,{...view.preparation.options,floorY}); }
        studio.updateShot(); return captureGuide();
      },
      save: async (scene, png) => {
        const response = await fetch('/anyangle-studio/snapshots', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ scene, png }) });
        const saved = await response.json(); if (!response.ok) throw new Error(saved.error || 'Could not save the guide batch'); return saved;
      },
      queue: queueFinal ? async snapshot => await batchRequest('queue', { snapshot }) : null,
      onProgress: ({ index, total, label, phase }) => {
        $('#batch-state').textContent = phase === 'capture' ? `Rendering ${index + 1} / ${total} · ${label}`
          : `${phase === 'queued' ? 'Queued' : 'Saved'} ${index} / ${total} · ${label}`;
      },
    });
    batchViews = result.views;
    const queued = batchViews.filter(view => view.prompt_id).length;
    $('#batch-state').textContent = `${result.error ? 'Submission stopped' : result.stopped ? 'Stopped submitting views' : 'Batch prepared'} · ${batchViews.length} guides${queueFinal ? ` · ${queued} generation jobs queued` : ''}`;
    if (result.error) error(result.error);
    if (batchViews.length) {
      $('#batch-manifest').disabled = false;
      const response = await fetch('/anyangle-studio/batches', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ views: batchViews }) });
      const saved = await response.json(); if (!response.ok) throw new Error(saved.error || 'Could not save the batch manifest');
      batchId = saved.id; $('#batch-zip').disabled = false;
    }
  } catch (e) { $('#batch-state').textContent = e.message; throw e; }
  finally {
    doc = original; cannyWarningRevision = originalCannyWarning; studio.doc = doc;
    try {
      if (posing) await studio.restore(original);
      studio.updateShot();
    } finally {
      batchRunning = false; $('#batch-options').inert = false; $('#batch-stop').disabled = true;
      $('#batch-close').textContent = 'Close'; refresh(); updateBatchPlan();
    }
  }
}
$('#batch-guides').onclick = () => run(() => startCameraBatch(false));
$('#batch-final').onclick = () => run(() => startCameraBatch(true));
function closeWorkbench() { if (embedded) send('anyangle-close'); else location.reload(); }
$('#cancel').onclick = closeWorkbench;
$('#clear-canvas').onclick = () => run(async () => {
  if (!canvasHasObjects()) return;
  const rollback = begin(), previous = doc;
  const defaults = defaultScene();
  doc = { ...doc, source: defaults.source, actors: [], props: [], contacts: [], activeActorId: null,
    selectedActorIds: [], cameraTarget: null, mesh: defaults.mesh, pose: defaults.pose, front: 0, scale: 1,
    sourceStale: false, derivedGuideStale: false, derivedGuideSource: null, openpose: null,
    conditioning: { ...doc.conditioning, guide: 'coarse', map: null, mapKind: null, mapOrigin: 'auto' } };
  try { await studio.restore(doc); }
  catch (error) { doc = previous; rollback?.(); await studio.restore(doc); throw error; }
  selectedBone = '';
  previewVisible = false;
  setMode('camera'); changed();
});
$('#apply').onclick = () => run(async () => {
  clearTimeout(previewTimer); studio.syncPose();
  const frozen = clone(doc), appliedRevision = revision;
  const png = await captureGuide();
  const response = await fetch('/anyangle-studio/snapshots', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scene: frozen, png }) });
  const result = await response.json(); if (!response.ok) throw new Error(result.error || 'Save failed');
  if (revision !== appliedRevision) throw new Error('The scene changed while saving. Apply it again.');
  snapshot = result;
  if (embedded) send('anyangle-apply', { snapshot: result, revision: appliedRevision });
  else { const url = new URL(location.href); url.searchParams.set('snapshot', result.id); history.replaceState(null, '', url); toast('Snapshot saved. You can load this scene from the ComfyUI node.'); }
  $('#status').textContent = embedded ? 'Snapshot saved · Applying to node' : 'Scene snapshot saved'; $('#status').dataset.state = embedded ? 'dirty' : 'saved';
});

async function buildPresetCards() {
  const working = studio.doc;
  const savedPose = studio.pose(); const savedCamera = clone(working.camera); const mode = studio.mode;
  const savedWidth = working.width, savedHeight = working.height;
  const savedSelection = working.selectedActorIds;
  studio.restoring = true;
  $('#presets').replaceChildren();
  try {
    for (const preset of PRESETS) {
      studio.setPreset(preset); working.camera = { azimuth: 25, elevation: 3, zoom: 1.1, offsetX: 0, offsetY: 0, offsetZ: 0 };
      working.width = 150; working.height = 170; working.selectedActorIds = [working.activeActorId]; studio.fit(true);
      const png = await studio.capture(150, 170, { actorIds: [working.activeActorId] });
      const button = document.createElement('button'); button.className = 'preset-card';
      const image = document.createElement('img'); image.src = png; image.alt = '';
      const label = document.createElement('span'); label.textContent = preset.name; button.append(image, label);
      button.onclick = () => { begin(); studio.setPreset(preset); changed(); document.querySelectorAll('.preset-card').forEach(b => b.classList.toggle('active', b === button)); };
      $('#presets').append(button);
    }
  } finally {
    studio.viewer.setPose(savedPose, true); working.pose = savedPose; saveActor(working, savedPose); working.camera = savedCamera;
    working.selectedActorIds = savedSelection;
    working.width = savedWidth; working.height = savedHeight; studio.setMode(mode); studio.restoring = false;
  }
}

async function ensureHumanTools() {
  if (humanToolsReady || studio.animal || doc.source.kind !== 'human') return;
  // Pose thumbnails require the human rig; never load it just to open a photo scene.
  await buildPresetCards();
  humanToolsReady = true;
}

async function start(token, reference = { connected: false }, structure = { connected: false }, needsWiring = false, initialSettings = null) {
  try {
    if (token?.id) {
      const response = await fetch(`/anyangle-studio/snapshots/${encodeURIComponent(token.id)}`);
      const saved = await response.json().catch(() => ({}));
      if (response.ok) { doc = saved.scene; snapshot = token; }
      else if (response.status === 404) toast('The last applied scene is missing on this computer. Rebuild the subject or import a GLB, then apply the new scene.');
      else throw new Error(saved.error || `Could not load snapshot (HTTP ${response.status})`);
    }
    restoreSceneDefaults(doc);
    if (!snapshot && doc.version === 3 && initialSettings?.model === 'base') {
      doc.conditioning.model = 'base'; doc.conditioning.imageOrder = 'guide-first';
      if (['guided','references-only','text'].includes(initialSettings.mode)) doc.referenceLibrary.mode = initialSettings.mode;
    }
    linkedReference = reference;
    linkedStructure = structure;
    unwiredAnyAngle = needsWiring;
    const referenceChanged = reference.connected && !!reference.asset && reference.asset.name !== doc.reference?.name;
    if (reference.asset) { const previous = doc.reference; doc.reference = reference.asset; sourceChanged(doc, previous); }
    if (doc.version !== 3 && doc.source.kind === 'splat' && doc.source.reference?.name !== doc.reference?.name) doc.source = { kind: 'empty' };
    studio = new StudioScene($('#viewport'), { begin, change: changed, camera: () => { revision++; refresh(); schedulePreview(); $('#status').textContent = 'Camera draft · Apply to save'; $('#status').dataset.state = 'dirty'; }, pick: selectRole, select: (name, updateControls = true) => {
      selectedBone = name || '';
      if (studio.animal) {
        studio.selectAnimalJoint(selectedBone);
      }
      if (updateControls) refresh();
    }, error });
    await studio.init(doc);
    if (doc.actors.some(actor => actor.source.kind === 'human')) await ensureHumanTools();
    if (structure.asset && doc.conditioning.model === 'base' && ['pose', 'depth', 'canny'].includes(doc.conditioning.guide)
        && !usesLocalGuide())
      await applyStructureAsset(structure.asset);
    selectedShot = doc.shots.find(shot => shot.width === doc.width && shot.height === doc.height
      && Object.keys(doc.camera).every(key => Number(shot.camera[key] || 0) === Number(doc.camera[key] || 0)))?.id || null;
    ready = true; $('#loading').hidden = true; refresh(); renderShots(); renderLibrary();
    $('#status').textContent = snapshot ? 'Loaded last applied scene' : 'Connect or upload a source image to rebuild the subject in 3D';
    $('#status').dataset.state = snapshot ? 'saved' : 'dirty';
    if (referenceChanged) { $('#status').textContent = 'Connected source updated · Apply to save it to the scene'; $('#status').dataset.state = 'dirty'; }
    setBusy(false); await renderPreview();
  } catch (e) { showLoadError(e); error(e); }
}
function readPendingReference() {
  if (busy || !pendingReference) return;
  const reference = pendingReference; pendingReference = null;
  run(async () => {
    const sameAsset = !!reference.asset && reference.asset.name === doc.reference?.name;
    linkedReference = reference;
    if (reference.error) toast(reference.error);
    if (sameAsset || reference.pending || reference.error) { refresh(); return; }
    begin(); const previous = doc.reference; doc.reference = reference.asset || null; sourceChanged(doc, previous);
    if (doc.version !== 3 && doc.source.kind === 'splat') doc.source = { kind: 'empty' };
    await studio.restore(doc); changed();
    if (requiresGuide() && doc.reference && doc.source.kind === 'empty' && currentGuide() === 'coarse') await reconstructPhoto();
  });
}
function readPendingStructure() {
  if (busy || !pendingStructure) return;
  const structure = pendingStructure; pendingStructure = null;
  const applyLinked = explicitStructureRead || !usesLocalGuide();
  explicitStructureRead = false;
  run(async () => {
    const oldAsset = linkedStructure.asset?.name;
    linkedStructure = structure;
    if (structure.error) toast(structure.error);
    if (!structure.connected && oldAsset && doc.conditioning.map?.name === oldAsset) {
      begin(); doc.conditioning.map = null; doc.conditioning.mapKind = null; changed();
    }
    if (applyLinked && structure.asset && doc.conditioning.model === 'base' && ['pose', 'depth', 'canny'].includes(doc.conditioning.guide))
      await applyStructureAsset(structure.asset);
    refresh(); schedulePreview();
  });
}
function readPendingActors() {
  if (busy || !ready || !pendingActors) return;
  const message = pendingActors; pendingActors = null;
  run(async () => {
    setReferenceConnections(message.actorReferences);
    if (doc.version === 3) { begin(); updateReferences(doc, message.actorReferences || []); changed(false); }
    else updateActorReferences(message.actorReferences);
    if (message.error) toast(message.error);
  });
}
function readPendingKeypoints() {
  if (busy || !ready || !pendingKeypoints) return;
  const message = pendingKeypoints; pendingKeypoints = null;
  run(async () => {
    if (message.error) { toast(message.error); return; }
    const result = message.posePeople;
    if (message.animalActorId && message.sourceName !== (doc.reference?.name || null))
      throw new Error('The source image changed. Read AnimalPose again.');
    if (result?.animalFrame) { await applyAnimalKeypoints(result.animalFrame, message.animalActorId); return; }
    if (message.animalActorId) throw new Error('Connect the AP-10K AnimalPose Estimator to Pose Keypoints.');
    if (!result || doc.openpose?.origin === 'keypoints' && !doc.openpose.useRig && doc.openpose.inputSignature === result.signature && doc.openpose.inputPlanSignature === result.planSignature && doc.openpose.sourceName === result.asset?.name) return;
    await applyOpenPoseAsset(result.asset, result.people?.[0]?.points, result.people?.[0]?.fullBody);
    doc.openpose.people = result.people; doc.openpose.origin = 'keypoints'; doc.openpose.inputSignature = result.signature; doc.openpose.inputPlanSignature = result.planSignature; changed();
  });
}

installActorsUI({ doc: () => doc, replace: value => { doc = value; }, studio: () => studio, run, begin, changed, refresh,
  ensureHumanTools, askName, upload, captureGuide, toast, send, downloadURL: download, downloadBlob: download,
  showScene: () => { previewVisible = false; setMode('camera'); } });
installReferencesUI({ doc: () => doc, sourceConnected: () => linkedReference.connected, run, begin, changed, askName, upload, send, toast,
  clearSource: () => run(clearSourceImage),
  setSource: asset => run(async () => {
    if (linkedReference.connected || !asset?.name || doc.reference?.name === asset.name) return;
    begin();
    const previous = doc.reference;
    doc.reference = asset;
    sourceChanged(doc, previous);
    changed();
    toast('Scene Source Image set. Open Scene Objects to rebuild or extract its pose.');
  }) });
if (embedded) {
  let started = false;
  window.addEventListener('message', async event => {
    if (event.source !== parent || event.origin !== location.origin || event.data?.session !== session) return;
    if (event.data.type === 'anyangle-load' && !started) {
      started = true; await start(event.data.snapshot, event.data.reference, event.data.structure, event.data.unwiredAnyAngle, event.data.initialSettings);
      if (!ready) return;
      setReferenceConnections(event.data.actorReferences);
      if (event.data.inputError) toast(event.data.inputError);
      refresh();
      $('#read-pose-keypoints').hidden = !event.data.keypointsConnected;
      $('#read-animal-keypoints').hidden = !event.data.keypointsConnected;
    } else if (event.data.type === 'anyangle-actors' && ready) {
      pendingActors = event.data; readPendingActors();
    } else if (event.data.type === 'anyangle-keypoints' && ready) {
      pendingKeypoints = event.data; readPendingKeypoints();
    } else if (event.data.type === 'anyangle-reference' && ready) {
      pendingReference = event.data.reference; readPendingReference();
    } else if (event.data.type === 'anyangle-structure' && ready) {
      pendingStructure = event.data.structure; readPendingStructure();
    } else if (event.data.type === 'anyangle-batch-reply') {
      const pending = batchReplies.get(event.data.requestId);
      if (pending) {
        clearTimeout(pending.timer); batchReplies.delete(event.data.requestId);
        if (event.data.error) pending.reject(new Error(event.data.error)); else pending.resolve(event.data.result);
      }
    } else if (event.data.type === 'anyangle-apply-error') {
      $('#status').textContent = 'Apply to update the node'; $('#status').dataset.state = 'dirty'; toast(event.data.message);
    }
  });
  send('anyangle-ready');
} else {
  $('#apply').lastChild.textContent = 'Save Scene'; $('#cancel').textContent = 'Reload';
  start(params.has('snapshot') ? { version: 1, id: params.get('snapshot') } : null);
}
window.addEventListener('pagehide', () => {
  poseCatalog?.destroy();
  galleryActions?.destroy();
  batchController?.abort();
  for (const pending of batchReplies.values()) { clearTimeout(pending.timer); pending.reject(new Error('Studio closed')); }
  batchReplies.clear(); clearTimeout(previewTimer); studio?.dispose();
});

const galleryContext = { doc: () => doc, replace: value => { doc = value; }, studio: () => studio, run: runGallery, begin, changed, ensureHumanTools, toast, download };
galleryActions = installGalleryActions({ ...galleryContext, canQueue: embedded, runBatch: runGalleryBatch });
poseCatalog = installPoseLibrary({ ...galleryContext, askName, batchChanged: () => updateBatchPlan(), galleryExtract: galleryActions.extract, galleryBatch: galleryActions.batch });
