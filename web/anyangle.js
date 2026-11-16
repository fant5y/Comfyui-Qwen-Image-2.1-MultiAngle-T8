import { app } from '../../scripts/app.js';
import { api } from '../../scripts/api.js';
import { uuid } from './uuid.mjs?v=20261116en';
import { referencePlan, executeReference } from './reference.mjs?v=20261116tempreferences';
import { promptForSnapshot } from './batch-queue.mjs?v=20261116en';

let graphRevision = 0;
let closeActive = null;
const extensionURL = new URL('./editor/index.html', import.meta.url);
extensionURL.searchParams.set('v', '20261116modelrotation');

function openEditor(node, widget) {
  closeActive?.();
  const session = uuid(), graph = app.graph, revision = graphRevision, initial = widget.value;
  let initialSnapshot = null;
  try { initialSnapshot = initial ? JSON.parse(initial) : null; } catch { /* Studio can replace a damaged widget. */ }
  const dialog = document.createElement('dialog');
  Object.assign(dialog.style, { width: '96vw', height: '94vh', maxWidth: 'none', maxHeight: 'none', padding: '0', border: '1px solid #3a5265', borderRadius: '12px', background: '#101920', overflow: 'hidden' });
  const frame = document.createElement('iframe');
  const url = new URL(extensionURL); url.searchParams.set('session', session);
  url.searchParams.set('hostTextSize', getComputedStyle(document.body).fontSize);
  frame.src = url; frame.title = 'AnyAngle Studio · 3D Camera and Pose Editor';
  Object.assign(frame.style, { width: '100%', height: '100%', border: '0', display: 'block' });
  dialog.append(frame); document.body.append(dialog);
  let active = true;
  let reference = { connected: false }, referenceSignature = null, readingReference = false;
  let structure = { connected: false }, structureSignature = null, readingStructure = false;
  let batchGraph = null, frozenPrompts = null;
  let actorReferences = [], actorSignatures = new Map(), posePeople = null, poseSignature = null;
  const batchRequests = new Map();
  const unwiredAnyAngleLoader = () => {
    const strength = node.outputs?.find(output => output.name === 'anyangle_lora_strength');
    return graph._nodes.some(candidate => {
      if (!['LoraLoaderModelOnly', 'AnyAngleOptionalLoRAT8'].includes(candidate.type)
          || !candidate.outputs?.some(output => output.name === 'MODEL' && output.links?.length)) return false;
      const filename = candidate.widgets?.find(item => item.name === 'lora_name')?.value;
      if (!/anyangle/i.test(String(filename || ''))) return false;
      const input = candidate.inputs?.find(item => item.name === 'strength_model');
      return !input?.link || !strength?.links?.includes(input.link);
    });
  };
  const send = (type, payload = {}) => { if (valid()) frame.contentWindow.postMessage({ type, session, ...payload }, location.origin); };
  const getPlan = async () => {
    const { output } = await app.graphToPrompt();
    const plan = referencePlan(output, node.id);
    if (!plan && node.inputs?.find(input => input.name === 'reference_image')?.link != null) throw new Error('Could not resolve the reference image connection. Check whether the upstream node is disabled.');
    return plan;
  };
  const getStructurePlan = async () => {
    const { output } = await app.graphToPrompt();
    const plan = referencePlan(output, node.id, 'structure_image');
    if (!plan && node.inputs?.find(input => input.name === 'structure_image')?.link != null) throw new Error('Could not resolve the structure guide connection. Check whether the upstream node is disabled.');
    return plan;
  };
  const readReference = async (execute = false) => {
    if (readingReference) return;
    readingReference = true;
    const previous = reference, previousSignature = referenceSignature;
    const connected = node.inputs?.find(input => input.name === 'reference_image')?.link != null;
    let sameSignature = false;
    reference = { connected, pending: true, ...(connected && previous.asset ? { asset: previous.asset } : {}) };
    try {
      const plan = await getPlan();
      sameSignature = !!plan && plan.signature === previousSignature;
      referenceSignature = plan?.signature || null;
      if (!plan) reference = { connected: false };
      else if (execute) {
        if (!sameSignature) reference = { connected: true, pending: true };
        send('anyangle-reference', { reference: { ...reference, message: plan.filename ? 'Reading connected source image…' : 'Running upstream nodes for the reference image…' } });
        // Use ComfyUI's decoder for direct images too: JPEG decoding can differ
        // from browser/Pillow import even when the filename ends in .png.
        const asset = await executeReference(plan, valid);
        if (!valid()) return;
        if ((await getPlan())?.signature !== plan.signature) throw new Error('The upstream connection changed. Read the image again.');
        reference = { connected: true, asset, message: 'Connected IMAGE · First image' };
      } else reference = { connected: true, message: 'Read the connected source image to update the scene.' };
    } catch (error) {
      reference = { connected, ...(sameSignature && previous.asset ? { asset: previous.asset } : {}),
        pending: false, error: error.message, message: error.message };
    }
    finally { readingReference = false; }
  };
  const readStructure = async (execute = false) => {
    if (readingStructure) return;
    readingStructure = true;
    const previous = structure, previousSignature = structureSignature;
    const connected = node.inputs?.find(input => input.name === 'structure_image')?.link != null;
    let sameSignature = false;
    structure = { connected, pending: true, ...(connected && previous.asset ? { asset: previous.asset } : {}) };
    try {
      const plan = await getStructurePlan();
      sameSignature = !!plan && plan.signature === previousSignature;
      structureSignature = plan?.signature || null;
      if (!plan) structure = { connected: false };
      else if (execute) {
        if (!sameSignature) structure = { connected: true, pending: true };
        send('anyangle-structure', { structure: { ...structure, message: 'Reading connected structure guide…' } });
        const asset = await executeReference(plan, valid);
        if (!valid()) return;
        if ((await getStructurePlan())?.signature !== plan.signature) throw new Error('The upstream structure guide changed. Read it again.');
        structure = { connected: true, asset, message: 'Connected IMAGE · First structure guide' };
      } else structure = { connected: true, message: 'Read the upstream structure guide' };
    } catch (error) {
      structure = { connected, ...(sameSignature && previous.asset ? { asset: previous.asset } : {}),
        pending: false, error: error.message, message: error.message };
    } finally { readingStructure = false; }
  };
  const actorPlans = async () => {
    const { output } = await app.graphToPrompt(), inputs = output[String(node.id)]?.inputs || {};
    const keys = new Set([...Object.keys(inputs), ...Object.keys(inputs.actor_references || {}), ...(node.inputs || []).map(input => input.name)].map(key => key.replace(/^actor_references\./, '')).filter(key => /^actor_reference_[1-9][0-9]*$/.test(key)));
    return [...keys].sort((a,b) => Number(a.split('_').at(-1))-Number(b.split('_').at(-1))).map(inputKey => ({ inputKey, plan: referencePlan(output, node.id, inputKey) })).filter(item => item.plan);
  };
  const readActors = async (execute = false) => {
    const plans = await actorPlans(), previous = new Map(actorReferences.map(item => [item.inputKey, item]));
    const result = [];
    for (const { inputKey, plan } of plans) {
      let asset = actorSignatures.get(inputKey) === plan.signature ? previous.get(inputKey)?.asset : null;
      let batch = asset ? previous.get(inputKey) : null, readError = null;
      try { if (execute) { batch = await executeReference(plan, valid, 'batch'); asset = batch?.asset; } }
      catch (error) { readError = error.message; asset = null; batch = null; }
      if (!valid()) return;
      result.push({ inputKey, asset, assets: batch?.assets, batchCount: batch?.batchCount || 1, error: readError, message: readError || (asset ? 'Connected IMAGE · First image' : 'Read the references to run their upstream nodes.') });
    }
    const current = await actorPlans();
    if (JSON.stringify(current.map(item => [item.inputKey,item.plan.signature])) !== JSON.stringify(plans.map(item => [item.inputKey,item.plan.signature]))) throw new Error('The upstream photo input changed. Read it again.');
    actorReferences = result; actorSignatures = new Map(plans.map(item => [item.inputKey,item.plan.signature]));
    const failed = result.filter(item => item.error); if (failed.length) throw new Error(failed.map(item => `${item.inputKey}: ${item.error}`).join('\n'));
  };
  const readKeypoints = async (execute = false) => {
    const { output } = await app.graphToPrompt(), plan = referencePlan(output, node.id, 'pose_keypoints');
    if (!plan) { posePeople = null; poseSignature = null; return; }
    if (execute) {
      const result = await executeReference(plan, valid, 'keypoints');
      const latest = referencePlan((await app.graphToPrompt()).output, node.id, 'pose_keypoints');
      if (latest?.signature !== plan.signature) throw new Error('The upstream pose keypoints changed. Read them again.');
      posePeople = { ...result, planSignature: plan.signature };
    }
    poseSignature = plan.signature;
  };
  const close = () => { if (!active) return; active = false; window.removeEventListener('message', receive); dialog.remove(); if (closeActive === close) closeActive = null; };
  const valid = () => active && app.graph === graph && graphRevision === revision && graph.getNodeById(node.id) === node && widget.value === initial;
  const validateSnapshot = async token => {
    if (token?.version !== 1 || !/^[a-f0-9]{64}$/.test(token.id)) throw new Error('Invalid scene snapshot');
    if (((await getPlan())?.signature || null) !== referenceSignature) throw new Error('The upstream connection changed. Reopen Studio and read the source image again.');
    if (((await getStructurePlan())?.signature || null) !== structureSignature) throw new Error('The upstream structure guide changed. Read it again.');
    const response = await fetch(`/anyangle-studio/snapshots/${token.id}`);
    if (!response.ok) throw new Error('Could not verify the saved scene. Apply it again.');
    const saved = await response.json(), scene = saved.scene, settings = scene.conditioning || {};
    let previous = null;
    if (/^[a-f0-9]{64}$/.test(initialSnapshot?.id || '')) {
      const original = initialSnapshot.id === token.id ? response : await fetch(`/anyangle-studio/snapshots/${initialSnapshot.id}`);
      if (original.ok) previous = original === response ? scene : (await original.json()).scene;
    }
    const plans = await actorPlans();
    if (JSON.stringify(plans.map(item => [item.inputKey,item.plan.signature])) !== JSON.stringify([...actorSignatures])) throw new Error('The connected photos changed. Read them again.');
    for (const actor of scene.version === 3 ? [] : scene.actors || []) if (actor.identity?.inputKey) {
      const reference = actorReferences.find(item => item.inputKey === actor.identity.inputKey);
      const savedIdentity = previous?.actors?.find(item => item.id === actor.id && item.identity?.inputKey === actor.identity.inputKey)?.identity;
      if (reference && actor.identity.asset?.name !== (reference.asset || savedIdentity?.asset)?.name)
        throw new Error(`Read ${actor.identity.inputKey} again and apply the identity assignment.`);
    }
    const sentReferences = new Set(scene.manifest?.references?.flatMap(reference => reference.referenceIds || []) || []);
    for (const item of scene.referenceLibrary?.items || []) if (item.inputKey && sentReferences.has(item.id)) {
      const current = actorReferences.find(value => value.inputKey === item.inputKey);
      const savedItem = previous?.referenceLibrary?.items?.find(value => value.inputKey === item.inputKey && (value.batchIndex || 0) === (item.batchIndex || 0));
      const asset = current?.asset ? current.assets?.[item.batchIndex || 0] || (!item.batchIndex ? current.asset : null)
        : current && savedItem?.asset;
      if (!asset || item.asset?.name !== asset.name) throw new Error(`Read ${item.label} again and apply its reference role.`);
    }
    if (settings.model === 'base' && unwiredAnyAngleLoader())
      throw new Error('The workflow still uses a fixed AnyAngle LoRA strength. Connect Studio’s anyangle_lora_strength output or remove the loader.');
    if (reference.connected && scene.reference?.name !== (reference.asset || previous?.reference)?.name)
      throw new Error('The reference image changed. Read it again and rebuild the subject.');
    const noGuide = scene.version === 3 && scene.referenceLibrary.mode !== 'guided';
    if (!noGuide && settings.model === 'base' && settings.guide === 'pose' && scene.openpose?.origin === 'keypoints' && !scene.openpose.useRig) {
      const current = referencePlan((await app.graphToPrompt()).output, node.id, 'pose_keypoints');
      if (current?.signature !== poseSignature || scene.openpose.inputPlanSignature && current?.signature !== scene.openpose.inputPlanSignature
          || posePeople && scene.openpose.inputSignature !== posePeople.signature) throw new Error('The upstream pose keypoints changed. Read them again and apply.');
    }
    const photoGuide = settings.guide === 'pose' && ['dwpose', 'json', 'keypoints'].includes(scene.openpose?.origin)
      || settings.guide === 'pose' && (scene.openpose?.useRig || settings.mapOrigin === 'rig')
      || settings.guide === 'depth' && ['da3', 'scene'].includes(settings.mapOrigin)
      || settings.guide === 'canny' && ['auto', 'reference'].includes(settings.mapOrigin);
    if (!noGuide && structure.connected && settings.model === 'base' && !photoGuide) {
      const name = settings.guide === 'pose' ? scene.openpose?.sourceName : settings.map?.name;
      const priorGuide = previous?.conditioning?.guide === settings.guide
        ? settings.guide === 'pose' ? previous.openpose?.sourceName : previous.conditioning?.map?.name : null;
      if (['pose', 'depth', 'canny'].includes(settings.guide) && name !== (structure.asset?.name || priorGuide))
        throw new Error('The structure guide changed. Read it again in Studio and apply.');
    }
    if (!valid()) throw new Error('The workflow changed. Reopen Studio.');
    return { ...scene, resolvedPrompt: saved.prompt };
  };
  const receive = async event => {
    if (event.origin !== location.origin || event.source !== frame.contentWindow || event.data?.session !== session) return;
    if (!valid()) { close(); return; }
    if (event.data.type === 'anyangle-ready') {
      await readReference();
      await readStructure();
      const inputErrors = [];
      try { await readActors(); } catch (error) { inputErrors.push(error.message); }
      try { await readKeypoints(); } catch (error) { inputErrors.push(error.message); }
      const settings = node.properties?.anyangleStart;
      send('anyangle-load', { snapshot: initialSnapshot, reference, structure, actorReferences, inputError: inputErrors.join('\n'), keypointsConnected: !!poseSignature, unwiredAnyAngle: unwiredAnyAngleLoader(), initialSettings: settings ? { model: settings.model, mode: settings.mode } : null });
    } else if (event.data.type === 'anyangle-read-reference') {
      await readReference(true); send('anyangle-reference', { reference });
    } else if (event.data.type === 'anyangle-read-structure') {
      await readStructure(true); send('anyangle-structure', { structure });
    } else if (event.data.type === 'anyangle-read-actors') {
      try { await readActors(true); send('anyangle-actors', { actorReferences }); }
      catch (error) { send('anyangle-actors', { actorReferences, error: error.message }); }
    } else if (event.data.type === 'anyangle-read-keypoints') {
      try { await readKeypoints(true); send('anyangle-keypoints', { posePeople,
        animalActorId: event.data.animalActorId, sourceName: event.data.sourceName }); }
      catch (error) { send('anyangle-keypoints', { error: error.message }); }
    } else if (event.data.type === 'anyangle-close') close();
    else if (event.data.type === 'anyangle-batch-request') {
      const requestId = event.data.requestId;
      if (typeof requestId !== 'string' || requestId.length > 100) return;
      if (!batchRequests.has(requestId)) batchRequests.set(requestId, (async () => {
        if (event.data.action === 'prepare') {
          batchGraph = await app.graphToPrompt();
          if (!batchGraph.output[String(node.id)] || !node.outputs?.find(output => output.name === 'guide_image_2')?.links?.length)
            throw new Error('Connect Studio’s guide_image_2 output to the current workflow.');
          frozenPrompts = {};
          if (event.data.snapshot) {
            const frozenScene = await validateSnapshot(event.data.snapshot);
            batchGraph = promptForSnapshot(batchGraph, node.id, event.data.snapshot, frozenScene);
          }
          for (const [encoderId, encoder] of Object.entries(batchGraph.output)) {
            if (encoder.class_type !== 'AnyAngleMultiPersonEncodeT8' || encoder.inputs.scene_json?.[0] !== String(node.id)) continue;
            const frozen = { prompt_mode: encoder.inputs.prompt_mode || 'studio-plus-input' };
            for (const key of ['prompt','negative_prompt']) {
              const value = encoder.inputs[key];
              frozen[key] = Array.isArray(value) ? await executeReference(referencePlan(batchGraph.output, encoderId, key), valid, 'text') : value ?? '';
            }
            if (Array.isArray(encoder.inputs.prompt_mode)) frozen.prompt_mode = await executeReference(referencePlan(batchGraph.output, encoderId, 'prompt_mode'), valid, 'mode');
            frozenPrompts[encoderId] = frozen;
          }
          return {};
        }
        if (event.data.action !== 'queue' || !batchGraph) throw new Error('Prepare the batch workflow first.');
        const frozenScene = await validateSnapshot(event.data.snapshot);
        const result = await api.queuePrompt(0, promptForSnapshot(batchGraph, node.id, event.data.snapshot, frozenScene, frozenPrompts));
        if (!result.prompt_id) throw new Error('No job ID was returned. Check the ComfyUI queue.');
        const encoding_plan = Object.entries(frozenPrompts || {}).map(([encoder_id, inputs]) => ({ encoder_id,
          prompt_mode: inputs.prompt_mode, prompt: inputs.prompt_mode === 'input-full' ? inputs.prompt
            : [frozenScene.resolvedPrompt, inputs.prompt].filter(Boolean).join('\n'), negative_prompt: inputs.negative_prompt,
          images: frozenScene.manifest?.references?.map(reference => ({ index: reference.index, sha256: reference.asset.name.split('.')[0] })) || [] }));
        return { prompt_id: result.prompt_id, encoding_plan };
      })());
      try { send('anyangle-batch-reply', { requestId, result: await batchRequests.get(requestId) }); }
      catch (error) { send('anyangle-batch-reply', { requestId, error: error.message }); }
    }
    else if (event.data.type === 'anyangle-apply') {
      const token = event.data.snapshot;
      if (token?.version !== 1 || !/^[a-f0-9]{64}$/.test(token.id) || !Number.isInteger(event.data.revision)) return;
      try {
        await validateSnapshot(token);
        if (!valid()) return;
        widget.value = JSON.stringify(token); widget.callback?.(widget.value);
        app.graph.setDirtyCanvas(true, true); close();
      } catch (error) { send('anyangle-apply-error', { message: error.message }); }
    }
  };
  window.addEventListener('message', receive);
  dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
  dialog.addEventListener('click', event => { if (event.target === dialog) close(); });
  closeActive = close; dialog.showModal();
}

function labelStudioSockets(node) {
  for (const input of node.inputs || []) {
    const match = input.name.match(/^(?:actor_references\.)?actor_reference_(\d+)$/);
    if (match) input.label = `Reference Image ${match[1]} (General)`;
    else if (input.name === 'reference_image') input.label = 'Scene Source Image (Optional)';
    else if (input.name === 'structure_image') input.label = 'External Guide Image (Optional)';
    else if (input.name === 'pose_keypoints') input.label = 'Pose Keypoints (Advanced)';
  }
  for (const output of node.outputs || []) {
    if (output.name === 'guide_image_2') output.label = 'Current Composition Guide';
    if (output.name === 'scene_json') output.label = 'Scene and Reference Settings';
  }
}

app.registerExtension({
  name: 'T8.AnyAngleStudio',
  afterConfigureGraph() {
    graphRevision++; closeActive?.();
    for (const node of app.graph._nodes) {
      if (node.comfyClass === 'AnyAngleStudioT8') {
        if (!node.inputs?.some(input => input.name === 'reference_image')) node.addInput('reference_image', 'IMAGE');
        if (!node.inputs?.some(input => input.name === 'structure_image')) node.addInput('structure_image', 'IMAGE');
        if (!node.outputs?.some(output => output.name === 'anyangle_lora_strength')) node.addOutput('anyangle_lora_strength', 'FLOAT');
        labelStudioSockets(node);
      }
    }
  },
  async beforeRegisterNodeDef(nodeType, data) {
    if (data.name === 'AnyAngleMultiPersonEncodeT8') {
      const executed = nodeType.prototype.onExecuted;
      nodeType.prototype.onExecuted = function (message) {
        executed?.apply(this, arguments);
        const encoding = message?.anyangle_encoding?.[0];
        if (encoding && this.outputs?.[2]) {
          this.outputs[2].label = `latent · ${encoding.width} × ${encoding.height}`;
          app.graph.setDirtyCanvas(true, true);
        }
      };
      return;
    }
    if (data.name !== 'AnyAngleStudioT8') return;
    const created = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      created?.apply(this, arguments);
      const widget = this.widgets.find(w => w.name === 'snapshot');
      // The workflow still serializes this value, but it has no visible widget row.
      widget.hidden = true;
      this.addWidget('button', 'Open AnyAngle Studio', null, () => openEditor(this, widget));
      this.color = '#173847'; this.bgcolor = '#111e28';
      labelStudioSockets(this);
      const [width, height] = this.computeSize();
      this.setSize([Math.max(345, width), height]);
      const connectionsChanged = this.onConnectionsChange;
      this.onConnectionsChange = function () { const result = connectionsChanged?.apply(this, arguments); queueMicrotask(() => labelStudioSockets(this)); return result; };
      const removed = this.onRemoved;
      this.onRemoved = function () { closeActive?.(); removed?.apply(this, arguments); };
    };
  },
});
