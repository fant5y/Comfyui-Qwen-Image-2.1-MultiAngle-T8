import { createActor, activeActor, ensureActors, bindActor, cloneActor, removeActor, editableActors, actorSeed, applySceneTemplate } from './actors.mjs?v=20261116en';
import { randomPose } from './poses.mjs?v=20261116en';
import { uuid } from '../uuid.mjs?v=20261116en';
import { installCastTools } from './cast-tools.mjs?v=20261116canvasprompt';
import { poseCopyIssue, ORDER } from './openpose.mjs?v=20261116en';
import { guideSource } from './guides.mjs?v=20261116en';
import { addReference, newUse } from './reference-library.mjs?v=20261116canvasprompt';

let context, renderKey, renderedDoc, renderedRoles = [], references = [];
const $ = id => document.getElementById(id);
const clone = value => structuredClone(value);
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
function button(text, action, title = text) { const node = document.createElement('button'); node.textContent = text; node.title = title; node.onclick = action; return node; }
async function atomic(action) {
  return context.run(() => editTransaction(action));
}
async function editTransaction(action) {
  const previous = clone(context.doc()), rollbackHistory = context.begin();
  try { await action(); context.changed(); }
  catch (error) {
    context.replace(previous); rollbackHistory?.();
    try { await context.studio().restore(previous); } catch { /* Keep the original edit error. */ }
    throw error;
  }
}
export function addCharacter({ label, onAdded } = {}) {
  return atomic(async () => {
    const doc = context.doc(), wasEmpty = doc.source.kind === 'empty' && !doc.actors?.length;
    context.studio().syncPose(); ensureActors(doc); const actor = createActor(doc.actors.length, label ? { label } : {});
    doc.actors.push(actor); doc.activeActorId = actor.id; doc.selectedActorIds = [actor.id]; doc.source = { kind: 'human' };
    onAdded?.(actor);
    bindActor(doc); if (wasEmpty) { doc.conditioning.model = 'base'; doc.conditioning.identityMode = 'actors'; doc.conditioning.imageOrder = 'guide-first'; }
    const studio = context.studio();
    studio.selectedModelId = null; studio.modelJoint = null; studio.selectedPlacementAsset = null;
    await studio.restore(doc, { preserveView: !!onAdded && !wasEmpty }); await context.ensureHumanTools();
    if (onAdded) context.editScene();
    else context.showScene();
    $('actors-panel').open = true;
    context.toast(onAdded ? 'Character added with its reference.' : 'Character added.');
  });
}

export function installActorsUI(options) {
  context = options;
  $('actors-panel').innerHTML = `<summary class="section-heading collapsible-heading"><h2>Scene Characters <small id="actor-count">0</small></h2><span class="tag">CAST</span></summary>
    <div class="actor-toolbar"><button id="add-actor" class="accent-button">＋ Add Character</button><button id="clone-actor">Duplicate</button><button id="delete-actor">Delete</button></div>
    <p class="hint">Select an item to edit. Ctrl-click to select multiple characters. Visibility controls output. Locking protects poses and positions.</p><div id="actor-list" class="actor-list"></div>
    <div id="active-actor-controls"><label>Scale<input id="actor-scale" type="number" min="0.01" step="0.01" title="Resize the whole selection uniformly"></label>
    <div class="compact-actions"><button id="ground-actors" title="Move the selection down or up until it touches the floor">Ground</button><button id="fit-actors" title="Frame the selection with the camera">Fit</button><button id="rotate-model" title="Show rotation rings in Edit Scene">Rotate</button></div>
    <details class="actor-precision"><summary>Details</summary><label>Drag Plane<select id="actor-plane"><option value="screen">View Plane · Up / Down / Left / Right</option><option value="ground">Ground Plane · Forward / Back / Left / Right</option></select></label><label>Name<input id="actor-label" maxlength="255"></label><label>Guide Color<input id="actor-color" type="color"></label>
    <div class="actor-position"><label>X<input id="actor-x" type="number" step="0.1"></label><label>Y<input id="actor-y" type="number" step="0.1"></label><label>Z<input id="actor-z" type="number" step="0.1"></label></div>
    <div class="dimensions"><label>Facing °<input id="actor-yaw" type="number" step="1"></label></div>
    <div id="model-size" class="actor-position" hidden><label>Size X<input id="model-scaleX" type="number" min="0.01" step="0.01"></label><label>Size Y<input id="model-scaleY" type="number" min="0.01" step="0.01"></label><label>Size Z<input id="model-scaleZ" type="number" min="0.01" step="0.01"></label></div>
    <div id="model-rotation" class="dimensions" hidden><label>Pitch °<input id="model-pitch" type="number" step="1"></label><label>Roll °<input id="model-roll" type="number" step="1"></label></div>
    <label id="model-joint-row" hidden>Rotation Target<select id="model-joint"></select></label>
    <div class="actor-identity"><h3>Identity Reference <small>Separate from pose source</small></h3><label>Source<select id="actor-reference"><option value="text">Text Description</option><option value="upload">Upload Character Photo…</option><option value="reference">Use Scene Source Image</option></select></label><img id="actor-reference-preview" alt="Character identity photo" hidden><label>Describe Character in Group Photo<input id="actor-source-person" placeholder="For example, the person with glasses on the left"></label><label>Appearance / Clothing<textarea id="actor-description" rows="3" maxlength="16000" placeholder="Character appearance, clothing, and style"></textarea></label><p id="actor-binding-state" class="hint"></p></div></details></div>
    <label class="option-toggle"><input id="actor-identities" type="checkbox"><span>Assign Each Character an Identity<small>Use the Qwen Base Model with Multi-Image Encode.</small></span></label>
    <label class="option-toggle"><input id="color-actors" type="checkbox"><span>Use Guide Colors in Coarse Render<small>Distinguishes characters and models. Pose guides keep standard joint colors.</small></span></label>`;
  const identityFile = document.createElement('input'); identityFile.type = 'file'; identityFile.accept = 'image/*'; identityFile.hidden = true; identityFile.id = 'actor-identity-file'; document.body.append(identityFile);
  const readReferences = button('Read Connected Character Photos', () => context.send('anyangle-read-actors')); readReferences.id = 'read-actor-references'; readReferences.className = 'wide-button'; $('actors-panel').append(readReferences);
  const readKeypoints = button('Read Connected Pose Keypoints', () => context.send('anyangle-read-keypoints')); readKeypoints.id = 'read-pose-keypoints'; readKeypoints.className = 'wide-button'; readKeypoints.hidden = true; $('openpose-panel').prepend(readKeypoints);
  $('add-actor').onclick = () => addCharacter();
  $('clone-actor').onclick = () => context.studio().selectedModel() ? context.duplicateModel() : atomic(async () => {
    const doc = context.doc(); context.studio().syncPose(); const actor = cloneActor(doc);
    doc.activeActorId = actor.id; doc.selectedActorIds = [actor.id]; bindActor(doc); await context.studio().restore(doc);
  });
  $('delete-actor').onclick = () => context.studio().selectedModel() ? context.deleteModel() : atomic(async () => { const doc = context.doc(); removeActor(doc, doc.activeActorId); await context.studio().restore(doc); });
  const selected = () => context.studio().selectedModel() || activeActor(context.doc());
  for (const [id, key] of [['actor-x', 'x'], ['actor-y', 'y'], ['actor-z', 'z'], ['actor-yaw', 'yaw'], ['actor-scale', 'scale'], ...['scaleX', 'scaleY', 'scaleZ'].map(key => ['model-' + key, key]), ['model-pitch', 'pitch'], ['model-roll', 'roll']]) $(id).onchange = () => {
    const studio = context.studio(), item = selected(), value = $(id).valueAsNumber;
    if (!item || item.locked || !Number.isFinite(value) || key.startsWith('scale') && value <= 0) {
      refreshActorsUI();
      if (item) $(id).value = Number((item.transform[key] ?? (key.startsWith('scale') ? 1 : 0)).toFixed(3));
      return;
    }
    context.begin();
    item.transform[key] = value;
    if (studio.selectedModel()) studio.updateProp(item);
    else { bindActor(context.doc()); studio.updateActorTransform(item); }
    context.changed();
  };
  $('actor-label').onchange = () => {
    const item = selected();
    if (!item) return;
    context.begin(); item.label = $('actor-label').value.trim() || item.label; context.changed(false);
  };
  $('actor-color').onchange = () => {
    const studio = context.studio(), item = selected();
    if (!item) return;
    context.begin(); item.editorColor = $('actor-color').value;
    if (!studio.selectedModel()) {
      if (item.source.kind === 'animal') studio.updateActorTransform(item);
      else studio.viewer.setActiveCharacterAppearance({ color: item.editorColor });
    }
    context.changed();
  };
  $('actor-plane').onchange = () => { context.begin(); context.doc().interaction.movePlane = $('actor-plane').value; context.changed(false); };
  $('ground-actors').onclick = () => {
    const studio = context.studio(), model = studio.selectedModel();
    context.begin();
    if (model) studio.groundModel(model);
    else studio.groundActors(context.doc().selectedActorIds);
    context.changed();
  };
  $('fit-actors').onclick = () => { context.begin(); context.studio().fit(true); context.changed(); };
  $('rotate-model').onclick = () => context.editScene();
  $('model-joint').onchange = event => {
    const studio = context.studio();
    studio.finishDrag();
    studio.modelJoint = event.target.value === '' ? null : Number(event.target.value);
    context.editScene();
  };
  $('actor-description').onchange = () => {
    const item = selected();
    if (!item) return;
    context.begin();
    (context.studio().selectedModel() ? item : item.identity).description = $('actor-description').value;
    context.changed(false);
  };
  $('actor-source-person').onchange = () => { const actor = activeActor(context.doc()); if (!actor) return; context.begin(); const description = $('actor-source-person').value.trim(); actor.identity.sourcePerson = actor.identity.sourcePerson && typeof actor.identity.sourcePerson === 'object' ? { ...actor.identity.sourcePerson, description } : description || null; context.changed(false); };
  $('actor-identities').onchange = () => { context.begin(); context.doc().conditioning.identityMode = $('actor-identities').checked ? 'actors' : 'scene'; context.changed(false); };
  $('color-actors').onchange = () => { context.begin(); context.doc().conditioning.colorActors = $('color-actors').checked; context.changed(); };
  $('actor-reference').onchange = () => {
    const actor = activeActor(context.doc()); if (!actor) return; const value = $('actor-reference').value;
    if (value === 'upload') { identityFile.dataset.actorId = actor.id; identityFile.click(); return; }
    context.begin(); actor.identity.inputKey = value.startsWith('actor_reference_') ? value : null;
    actor.identity.asset = value === 'reference' ? context.doc().reference : references.find(ref => ref.inputKey === value)?.asset || null;
    actor.identity.sourcePerson = null; context.changed(false);
  };
  identityFile.onchange = () => { const file = identityFile.files[0], id = identityFile.dataset.actorId; identityFile.value = ''; if (!file) return;
    atomic(async () => { const asset = await context.upload(file), actor = context.doc().actors.find(item => item.id === id); if (!actor) throw new Error('This character was deleted.'); actor.identity.asset = asset; actor.identity.inputKey = null; actor.identity.sourcePerson = null; });
  };
  $('random-scope').onchange = () => { context.begin(); context.doc().randomScope = $('random-scope').value; context.changed(false); };
  $('save-composition').onclick = async () => {
    const name = await context.askName('Save Scene Template', 'Group Composition'); if (!name) return;
    context.begin(); context.studio().syncPose(); const doc = context.doc(); doc.compositionTemplates ||= [];
    doc.compositionTemplates.push({ id: uuid(), name, actors: clone(doc.actors).map(actor => ({ ...actor, identity: { asset: null, inputKey: null, sourcePerson: null, description: '' } })), props: clone(doc.props || []), contacts: clone(doc.contacts || []), camera: clone(doc.camera), cameraTarget: clone(doc.cameraTarget) }); context.changed(false);
  };
  $('apply-composition').onclick = () => atomic(async () => {
    const doc = context.doc(), template = doc.compositionTemplates?.find(item => item.id === $('composition-list').value);
    if (!template) throw new Error('Select a scene template first.');
    if (doc.actors.some(actor => actor.locked)) throw new Error('Unlock characters before applying a scene template.');
    if (template.props && doc.props?.some(prop => prop.locked)) throw new Error('Unlock props before applying a scene template.');
    applySceneTemplate(doc, template); await context.studio().restore(doc); context.studio().useRigPose(); await context.ensureHumanTools();
  });
  $('export-scene').onclick = () => context.run(async () => {
    context.studio().syncPose(); const response = await fetch('/anyangle-studio/portable-scenes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scene: context.doc(), png: await context.captureGuide() }) });
    const result = await response.json(); if (!response.ok) throw new Error(result.error || 'Export failed');
    const archive = await fetch(result.url);
    if (!archive.ok) { const failure = await archive.json().catch(() => ({})); throw new Error(failure.error || `Scene download failed (HTTP ${archive.status})`); }
    context.downloadBlob(await archive.blob(), 'AnyAngle-scene.zip');
  });
  $('import-scene').onclick = () => $('scene-file').click();
  $('scene-file').onchange = event => { const file = event.target.files[0]; event.target.value = ''; if (!file) return;
    atomic(async () => {
      const form = new FormData(); form.append('file', file); const response = await fetch('/anyangle-studio/import-scene', { method: 'POST', body: form });
      const result = await response.json(); if (!response.ok) throw new Error(result.error || 'Import failed');
      context.replace(result.scene); await context.studio().restore(result.scene); if (result.scene.source.kind === 'human') await context.ensureHumanTools(); context.toast('Scene imported. Characters and assets restored.');
    });
  };
  $('export-keypoints').onclick = () => { const json = context.studio().poseJSON(); context.downloadBlob(new Blob([JSON.stringify(json, null, 2)], { type: 'application/json' }), 'AnyAngle-OpenPose.json'); };
  context.selectModel = selectModel;
  installCastTools(context); refreshActorsUI();
}
export function updateActorReferences(value) {
  references = value || []; renderKey = null;
  if (!context) return;
  let updated = false;
  for (const actor of context.doc().actors || []) {
    const reference = references.find(item => item.inputKey === actor.identity.inputKey);
    if (reference?.asset && reference.asset.name !== actor.identity.asset?.name) {
      if (!updated) context.begin(); actor.identity.asset = reference.asset; updated = true;
    }
  }
  if (updated) context.changed(false); refreshActorsUI();
}
export function importModel() {
  context.importModel();
}
export function selectModel(id) {
  const studio = context.studio();
  studio.selectedPlacementAsset = null;
  if (studio.selectedModelId !== id) {
    studio.finishDrag();
    studio.modelJoint = null;
    studio.selectedModelId = id;
    if (studio.mode === "edit") studio.setMode("edit");
  }
  $('actors-panel').open = true;
  if (studio.mode === 'camera') context.placeScene();
  context.refresh();
}
export function clearSelection() {
  const doc = context.doc(), studio = context.studio();
  if (!studio.selectedPlacementAsset && !studio.selectedModelId && !doc.selectedActorIds?.length) return;
  studio.selectedPlacementAsset = null;
  doc.selectedActorIds = [];
  studio.selectedModelId = null;
  studio.modelJoint = null;
  studio.setMode(studio.mode);
  context.refresh();
}
export async function selectRole(id, additive = false) {
  await context.run(async () => {
    const doc = context.doc();
    if (additive) doc.selectedActorIds = doc.selectedActorIds?.includes(id) ? doc.selectedActorIds.filter(value => value !== id) : [...doc.selectedActorIds || [], id];
    else doc.selectedActorIds = [id];
    const studio = context.studio();
    studio.selectedPlacementAsset = null;
    const updateMode = id === doc.activeActorId || !!studio.selectedModel();
    studio.finishDrag();
    studio.selectedModelId = null; studio.modelJoint = null;
    await studio.selectActor(id);
    if (updateMode) studio.setMode(studio.mode);
    await context.ensureHumanTools();
    context.refresh();
  });
}
function sceneEntries(doc) {
  const entries = new Map([
    ...(doc.actors || []).map(item => [item.id, { item, model: false }]),
    ...(doc.props || []).map(item => [item.id, { item, model: true }]),
  ]);
  const ordered = [];
  for (const id of doc.sceneOrder || []) {
    if (entries.has(id)) { ordered.push(entries.get(id)); entries.delete(id); }
  }
  return [...ordered, ...entries.values()];
}
export function refreshActorsUI() {
  if (!context) return;
  const doc = context.doc(), actor = activeActor(doc), human = doc.source.kind === 'human';
  const studio = context.studio(), model = studio?.selectedModel(), entries = sceneEntries(doc);
  const identity = $('actor-reference').closest('.actor-identity');
  const photo = !!model?.asset.name.endsWith('.png');
  identity.hidden = photo;
  for (const element of identity.children) element.hidden = (doc.version === 3 || !!model) && element !== $('actor-description').closest('label');
  $('actor-identities').closest('label').hidden = doc.version === 3;
  const staticGuide = doc.conditioning.promptMode !== 'custom' && ['image', 'canny-image'].includes(guideSource(doc).kind);
  $('actors-panel').classList.toggle('cast-inactive', !human && !entries.some(entry => entry.model && entry.item.asset.name.endsWith('.png')));
  $('read-actor-references').hidden = doc.version === 3 || !references.length;
  const key = JSON.stringify([human, entries.map(({ item: { id, label, editorColor, visible, locked, identity } }) => ({ id, label, editorColor, visible, locked, identity })), doc.activeActorId, doc.selectedActorIds, model?.id, references]);
  if (key !== renderKey || doc !== renderedDoc || entries.some(({ item }, index) => item !== renderedRoles[index])) {
    renderKey = key; renderedDoc = doc; renderedRoles = entries.map(({ item }) => item);
    $('actor-list').replaceChildren();
    for (const [index, entry] of entries.entries()) {
      const item = entry.item;
      const selected = model ? model.id === item.id : doc.selectedActorIds?.includes(item.id);
      const card = document.createElement('div');
      card.className = 'actor-card';
      card.classList.toggle('active', !!selected && (entry.model || doc.activeActorId === item.id));
      card.classList.toggle('selected', !!selected);
      card.style.setProperty('--actor-color', item.editorColor || '#8da8b6');
      const choose = button(`${String(index + 1).padStart(2, '0')}  ${item.label}`, event => {
        if (entry.model) selectModel(item.id);
        else selectRole(item.id, event.ctrlKey || event.metaKey);
      });
      choose.className = 'actor-name';
      choose.setAttribute('aria-pressed', String(!!selected));
      const controls = document.createElement('div');
      controls.className = 'actor-card-actions';
      controls.append(button(item.visible === false ? '○' : '◉', () => {
        context.begin();
        item.visible = item.visible === false;
        if (entry.model) studio.updateProp(item);
        else studio.updateActorTransform(item);
        studio.setMode(studio.mode);
        context.changed();
      }, item.visible === false ? 'Show' : 'Hide'), button(item.locked ? 'Locked' : 'Lock', () => {
        context.begin(); item.locked = !item.locked; studio.setMode(studio.mode); context.changed(false);
      }, item.locked ? 'Unlock' : 'Lock'));
      for (const [offset, label, title] of [[-1, '↑', 'Move Up'], [1, '↓', 'Move Down']]) {
        const destination = index + offset;
        const move = button(label, () => {
          context.begin();
          const ordered = entries.slice();
          ordered.splice(index, 1);
          ordered.splice(destination, 0, entry);
          doc.sceneOrder = ordered.map(({ item }) => item.id);
          doc.actors = ordered.filter(entry => !entry.model).map(({ item }) => item);
          doc.props = ordered.filter(entry => entry.model).map(({ item }) => item);
          context.changed(false);
        }, title);
        move.disabled = destination < 0 || destination >= entries.length;
        controls.append(move);
      }
      card.inert = !human && !(entry.model && item.asset.name.endsWith('.png'));
      card.append(choose, controls);
      $('actor-list').append(card);
    }
    const selector = $('actor-reference'); selector.innerHTML = '<option value="text">Text Description</option><option value="upload">Upload / Replace Photo…</option><option value="reference">Use Scene Source Image</option>';
    if (actor?.identity.asset && !actor.identity.inputKey && actor.identity.asset.name !== doc.reference?.name) selector.append(new Option('Uploaded Character Photo', 'asset'));
    for (const ref of references) selector.append(new Option(`${ref.inputKey}${ref.asset ? '' : ' · Unread'}`, ref.inputKey));
    if (actor?.identity.inputKey && !references.some(ref => ref.inputKey === actor.identity.inputKey)) selector.append(new Option(`${actor.identity.inputKey} · Saved assignment`, actor.identity.inputKey));
    selector.value = actor?.identity.inputKey || (actor?.identity.asset ? actor.identity.asset.name === doc.reference?.name ? 'reference' : 'asset' : 'text');
  }
  $('actor-count').textContent = `${entries.filter(({ item }) => item.visible !== false).length} / ${entries.length}`;
  const selected = model || (doc.selectedActorIds?.includes(actor?.id) ? actor : null);
  $('active-actor-controls').hidden = !selected || (!human && !model);
  $('clone-actor').disabled = $('delete-actor').disabled = !selected || (!human && !model);
  $('actor-color').closest('label').hidden = photo;
  $('model-scaleZ').closest('label').hidden = photo;
  $('model-size').hidden = $('model-rotation').hidden = $('rotate-model').hidden = !model;
  $('rotate-model').disabled = !model || model.locked || model.visible === false;
  $('ground-actors').disabled = !!model && (model.locked || model.visible === false);
  $('fit-actors').disabled = model?.visible === false;
  const joints = model ? studio.modelJoints() : [];
  const jointSelect = $('model-joint');
  $('model-joint-row').hidden = !joints.length;
  if (joints.length) {
    const names = joints.map(({ bone }, index) => bone.name || 'Joint ' + (index + 1));
    const key = JSON.stringify(names);
    if (jointSelect.dataset.key !== key) {
      jointSelect.dataset.key = key;
      jointSelect.replaceChildren(new Option('Whole Model', ''), ...names.map((name, index) => new Option(name, index)));
    }
    jointSelect.value = String(studio.modelJoint ?? '');
    jointSelect.disabled = $('rotate-model').disabled;
  }
  if (selected) {
    $('actor-label').maxLength = model ? 255 : 48;
    const fields = [['actor-label', selected.label], ['actor-color', selected.editorColor || '#8da8b6'],
      ['actor-description', model ? model.description || '' : selected.identity.description]];
    for (const key of ['x', 'y', 'z', 'yaw', 'scale', 'scaleX', 'scaleY', 'scaleZ', 'pitch', 'roll']) {
      const id = ['scaleX', 'scaleY', 'scaleZ', 'pitch', 'roll'].includes(key) ? 'model-' + key : 'actor-' + key;
      $(id).disabled = selected.locked;
      fields.push([id, Number((selected.transform[key] ?? (key.startsWith('scale') ? 1 : 0)).toFixed(3))]);
    }
    for (const [id, value] of fields) if (document.activeElement !== $(id)) $(id).value = value;
  }
  if (actor) {
    if (document.activeElement !== $('actor-source-person')) $('actor-source-person').value = typeof actor.identity.sourcePerson === 'string' ? actor.identity.sourcePerson : actor.identity.sourcePerson?.description || '';
    const image = $('actor-reference-preview'); image.hidden = doc.version === 3 || !actor.identity.asset;
    if (actor.identity.asset) image.src = `/anyangle-studio/assets/${encodeURIComponent(actor.identity.asset.name)}`;
    $('actor-binding-state').textContent = staticGuide ? `${doc.reference ? 'Source guidance uses the shared source image' : 'Currently using the structure guide and text'}. Character assignments take effect when you return to 3D guidance.`
      : actor.identity.inputKey ? `Connected ${actor.identity.inputKey} · Updating the photo keeps the current pose` : actor.identity.asset ? 'Identity photo assigned. Multi-Image Encode will use it.' : 'Text-only identity';
  }
  $('actor-plane').value = doc.interaction?.movePlane || 'screen'; $('actor-identities').checked = doc.conditioning.identityMode === 'actors'; $('color-actors').checked = !!doc.conditioning.colorActors;
  $('actor-identities').disabled = staticGuide;
  $('random-scope').value = doc.randomScope || 'current';
  for (const id of ['random-pose', 'repeat-pose']) $(id).disabled = !human || !editableActors(doc, doc.randomScope || 'current').filter(role => role.source.kind !== 'animal').length;
  const templateKey = JSON.stringify(doc.compositionTemplates?.map(item => [item.id, item.name]));
  if ($('composition-list').dataset.key !== templateKey) { $('composition-list').dataset.key = templateKey; $('composition-list').replaceChildren(new Option('Choose Scene Template', '')); for (const template of doc.compositionTemplates || []) $('composition-list').append(new Option(template.name, template.id)); }
  const staticOutput = ['image', 'canny-image'].includes(guideSource(doc).kind);
  $('export-keypoints').disabled = !human || staticOutput || !doc.actors.some(role => role.visible !== false && role.source.kind !== 'animal');
  $('export-keypoints').title = staticOutput ? 'Studio is outputting the source skeleton. Switch to a 3D mannequin pose to export its JSON.' : 'Export the 3D skeleton from the current camera.';
}
export async function randomRoles(seed, category) {
  return editTransaction(async () => {
    const doc = context.doc(), roles = editableActors(doc, doc.randomScope || 'current').filter(role => role.source.kind !== 'animal');
    if (!roles.length) throw new Error('Unlock at least one character to randomize its pose.');
    context.studio().syncPose(); const active = doc.activeActorId;
    for (const role of roles) {
      const derived = actorSeed(seed, role.id); role.pose = randomPose(derived, category); role.poseRandom = { seed, derivedSeed: derived, category };
    }
    bindActor(doc, active); doc.randomMaster = { seed, category }; await context.studio().restore(doc); context.studio().useRigPose(); context.showScene(); context.toast(`Updated ${roles.length} character poses · Main seed ${seed}`);
  });
}

export async function chooseDetectedPeople(people, asset, options = {}) {
  if (!people?.length) throw new Error('No usable characters detected.');
  const dialog = $('people-dialog'), choices = $('people-choices'); choices.replaceChildren();
  const image = $('people-photo'), sourceImage = options.reference || asset; image.hidden = !sourceImage;
  if (sourceImage) image.src = `/anyangle-studio/assets/${encodeURIComponent(sourceImage.name)}`;
  const overlay = $('people-overlay'); overlay.replaceChildren();
  for (const [index, person] of people.entries()) {
    const row = document.createElement('label'); row.className = 'person-choice';
    const issue = poseCopyIssue(person.points || {}), usable = !issue;
    const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.value = index; checkbox.checked = usable; checkbox.disabled = !usable;
    row.append(checkbox, document.createTextNode(`Person ${index + 1}${!usable ? ` · ${issue}` : person.fullBody === false ? ' · Partial body / Occluded' : ''}${person.lowConfidence ? ' · Low confidence' : ''}${person.warning ? ` · ${person.warning}` : ''}`)); choices.append(row);
    const box = person.bbox, w = person.canvasWidth || options.reference?.width, h = person.canvasHeight || options.reference?.height;
    if (box && w && h) { const marker = document.createElement('button'); marker.type = 'button'; marker.textContent = String(index + 1); marker.disabled = checkbox.disabled; marker.classList.toggle('excluded', !checkbox.checked); marker.style.cssText = `left:${box[0]/w*100}%;top:${box[1]/h*100}%;width:${(box[2]-box[0])/w*100}%;height:${(box[3]-box[1])/h*100}%`; marker.onclick = () => { if (checkbox.disabled) return; checkbox.checked = !checkbox.checked; marker.classList.toggle('excluded', !checkbox.checked); }; overlay.append(marker); }
  }
  $('people-count').textContent = `${people.length} people · Source skeleton retained. Choose how to transfer the pose.`;
  $('people-bind-photo').checked = false; $('people-match-layout').checked = true;
  $('people-bind-photo').closest('label').hidden = !options.reference;
  dialog.returnValue = ''; dialog.showModal();
  const action = await new Promise(resolve => dialog.addEventListener('close', () => resolve(dialog.returnValue), { once: true }));
  if (!['current', 'all'].includes(action)) return false;
  const selected = [...choices.querySelectorAll('input:checked')].map(input => people[Number(input.value)]);
  if (!selected.length) throw new Error('Select at least one person.');
  if (action === 'current' && selected.length !== 1) throw new Error('Select one person to copy to the current character.');
  const doc = context.doc(), previous = clone(doc), rollbackHistory = context.begin();
  try {
  context.studio().syncPose(); doc.source = { kind: 'human' }; ensureActors(doc, action === 'current');
  let roles;
  if (action === 'all') {
    roles = selected.map((person, i) => createActor(doc.actors.length + i)); doc.actors.push(...roles);
    if ($('people-match-layout').checked) {
      const fullHeights = selected.filter(person => person.fullBody && person.bbox).map(person => person.bbox[3]-person.bbox[1]).filter(height => height > 0);
      const scale = fullHeights.length ? 20 / Math.max(...fullHeights) : 30 / (selected[0].canvasHeight || options.reference?.height || 1024);
      for (const [i, person] of selected.entries()) { const b = person.bbox, w = person.canvasWidth || options.reference?.width || 1024;
        if (b) { roles[i].transform.x = ((b[0]+b[2])/2 - w/2)*scale; if (person.fullBody) roles[i].transform.scale = Math.max(.25, (b[3]-b[1])*scale/20); }
      }
    }
  } else { roles = [activeActor(doc)]; if (roles[0].locked) throw new Error('Unlock the current character first.'); }
  doc.activeActorId = roles[0].id; doc.selectedActorIds = roles.map(role => role.id); bindActor(doc);
  await context.studio().restore(doc); await context.ensureHumanTools();
  const previousActive = roles[0].id;
  for (const [i, role] of roles.entries()) {
    await context.studio().selectActor(role.id); const person = selected[i];
    const mode = person.fullBody === false || person.canEstimate3D === false || ORDER.some(key => !person.points?.[key]) ? 'conservative' : doc.openpose?.retargetMode || 'conservative';
    context.studio().applyOpenPose(person.points, {}, mode);
    role.poseSource = { origin: options.origin || 'dwpose', detectionId: person.id, points: clone(person.points), fullBody: person.fullBody, visibleOnly: person.visibleOnly, retargetMode: mode, rawAsset: asset };
    if ($('people-bind-photo').checked && options.reference) role.identity = { ...role.identity, asset: options.reference, inputKey: null, sourcePerson: { id: person.id, bbox: person.bbox, canvasWidth: person.canvasWidth || options.reference.width, canvasHeight: person.canvasHeight || options.reference.height, description: `person ${people.indexOf(person)+1} in the source photo` } };
    if (doc.version === 3 && $('people-bind-photo').checked && options.reference) {
      let material = doc.referenceLibrary.items.find(item => item.asset?.name === options.reference.name);
      if (!material) material = addReference(doc, options.reference, { label: 'Group Identity Reference', usages: [] });
      const usage = newUse('identity', { kind: 'actors', ids: [role.id], text: '' });
      usage.sourceText = `person ${people.indexOf(person)+1} in the source photo${person.bbox ? `, pixel region [${person.bbox.join(', ')}] in ${person.canvasWidth || options.reference.width} x ${person.canvasHeight || options.reference.height}` : ''}`;
      material.usages.push(usage);
    }
  }
  await context.studio().selectActor(previousActive); doc.conditioning.model = 'base'; doc.conditioning.guide = 'pose'; doc.conditioning.map = null; doc.conditioning.mapKind = null; doc.conditioning.mapOrigin = 'rig';
  if ($('people-bind-photo').checked || action === 'all' && doc.actors.length > 1) { doc.conditioning.identityMode = 'actors'; doc.conditioning.imageOrder = 'guide-first'; }
  if (doc.openpose) doc.openpose.useRig = true;
  if (action === 'all' && $('people-match-layout').checked) { context.studio().groundActors(roles.map(role => role.id)); doc.camera.azimuth = 0; doc.camera.elevation = 0; context.studio().fit(); }
  context.showScene(); context.changed(); context.toast(`Copied ${roles.length} poses. Matching source positions also resets the camera.`);
  return true;
  } catch (error) {
    context.replace(previous); rollbackHistory?.();
    try { await context.studio().restore(previous); } catch { /* Keep the original pose-copy error. */ }
    throw error;
  }
}
