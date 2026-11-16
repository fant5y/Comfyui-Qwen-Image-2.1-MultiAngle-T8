import { installGalleryKeypoints } from './gallery-keypoints.mjs?v=20261116en';
import { poseCopyIssue } from './openpose.mjs?v=20261116en';
import { applyGalleryPose, galleryPoseGuide, galleryViewPlan } from './gallery-pose.mjs?v=20261116referenceroles';
import { libraryManifest } from './reference-library.mjs?v=20261116referenceroles';

const assetURL = asset => `/anyangle-studio/assets/${encodeURIComponent(asset.name)}`;
function modal(title) {
  const dialog = document.createElement('dialog'); dialog.className = 'pose-library-dialog pg-action-dialog';
  const heading = document.createElement('h2'); heading.textContent = title;
  const status = document.createElement('p'); status.className = 'hint'; status.setAttribute('role', 'status');
  const actions = document.createElement('div'); actions.className = 'compact-actions';
  const close = document.createElement('button'); close.type = 'button'; close.textContent = 'Cancel'; close.onclick = () => dialog.close();
  dialog.append(heading, status, actions, close); document.body.append(dialog);
  return { dialog, status, actions, close };
}
function check(text) {
  const label = document.createElement('label'), input = document.createElement('input');
  input.type = 'checkbox'; label.className = 'option-toggle'; label.append(input, document.createTextNode(text));
  return { label, input };
}
function action(text, callback) {
  const button = document.createElement('button'); button.type = 'button'; button.textContent = text; button.onclick = callback;
  return button;
}

export function installGalleryActions(context) {
  const requests = new Set();
  async function extract(asset, provenance, expectedPeople) {
    const { dialog, status, actions, close } = modal('Extract Gallery Pose · Preview and Assign Characters');
    const controller = new AbortController(); requests.add(controller);
    const views = document.createElement('div'); views.className = 'pg-detection-images';
    const original = new Image(); original.alt = 'Selected gallery source image'; original.src = assetURL(asset); views.append(original);
    dialog.insertBefore(views, status);
    const targets = document.createElement('div'); targets.className = 'pg-detection-targets'; dialog.insertBefore(targets, actions);
    const layout = check('Match source positions and character sizes, then reframe (defaults to keeping the current placement and camera)');
    const release = check('Allow removing existing contact anchors for affected characters');
    dialog.insertBefore(layout.label, actions); dialog.insertBefore(release.label, actions);
    let detection, applying = false, applied = false, detecting = false;
    const selectors = [];
    const editorHost = document.createElement('section'); dialog.insertBefore(editorHost, targets);
    const editor = installGalleryKeypoints(editorHost, asset, () => {
      renderTargets(editor.people()); skeleton.hidden = true;
      status.textContent = 'Joints edited. Check the colored skeleton over the source image, then confirm to update the scene.';
    });
    const skeleton = new Image(); skeleton.alt = 'Extracted or corrected skeleton'; skeleton.hidden = true; views.append(skeleton);
    async function requestDetection(payload) {
      const response = await fetch('/anyangle-studio/pose-people', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload), signal: controller.signal });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Pose detection failed');
      if (!result.people?.length || !result.asset) throw new Error('No people detected. Draw boxes, mark joints manually, or use the source as a pose reference.');
      return result;
    }
    const apply = mode => async () => {
      if (applying || detecting || !editor.people().some(person => Object.keys(person.points || {}).length)) return;
      applying = true; actions.inert = true; targets.inert = true; close.disabled = true; editor.setBusy(true);
      const mapping = selectors.map(select => select.disabled ? '' : select.value);
      const options = { matchLayout: layout.input.checked, releaseContacts: release.input.checked };
      layout.input.disabled = release.input.disabled = true;
      try {
        if (editor.edited() || !detection) detection = await requestDetection({ keypoints: editor.frame() });
        await context.run(async () => {
          if (mode === 'guide') {
            const scene = galleryPoseGuide(context.doc(), detection, provenance);
            context.begin(); context.replace(scene); context.studio().doc = scene; context.changed();
          } else await applyGalleryPose(context, detection, mapping, provenance, options);
        });
        applied = true; dialog.close();
        context.toast(mode === 'guide' ? 'Static pose guide applied. Source image and character identities are kept.' : 'Visible joints copied. You can adjust limb depth by hand.');
      } catch (error) { status.textContent = error.message; }
      finally { applying = false; actions.inert = false; targets.inert = false; close.disabled = false; layout.input.disabled = release.input.disabled = false; editor.setBusy(false); }
    };
    const guide = action('Use Previewed Static Pose Guide', apply('guide'));
    const copy = action('Copy to Assigned Characters', apply('rig'));
    guide.disabled = copy.disabled = true; actions.append(guide, copy);
    function renderTargets(people, reset = false) {
      const previous = reset ? [] : selectors.map(select => select.value); selectors.length = 0; targets.replaceChildren();
      const actors = (context.doc().actors || []).filter(actor => actor.visible !== false && !actor.locked);
      for (const [index, person] of people.entries()) {
        const label = document.createElement('label'), select = document.createElement('select');
        const issue = poseCopyIssue(person.points || {});
        label.textContent = `Person ${index + 1}${person.fullBody === false ? ' · Partial body / Occluded' : ''}${person.lowConfidence ? ' · Low confidence' : ''}${issue ? ' · ' + issue : ''}`;
        select.setAttribute('aria-label', `Person ${index + 1} target`);
        select.append(new Option('Skip This Person', ''), new Option('Add Mannequin', 'new'), ...actors.map(actor => new Option(actor.label, actor.id)));
        select.value = issue ? '' : previous[index] || ''; select.disabled = !!issue;
        selectors.push(select); label.append(select); targets.append(label);
      }
      const editable = ['human', 'empty'].includes(context.doc().source.kind);
      guide.disabled = !people.some(person => Object.keys(person.points || {}).length);
      copy.disabled = !editable || !selectors.length || selectors.every(select => select.disabled);
    }
    async function detect(regions) {
      if(detecting || applying)return;
      detecting = true; editor.setBusy(true); actions.inert = true;
      status.textContent = regions ? 'Extracting from selected regions. Check and correct joints where people overlap.' : 'Running DWPose. First use requires the detection model. You can cancel and keep the scene as it is.';
      try {
        const result = await requestDetection({ reference: asset.name, ...(regions ? { regions } : {}) });
        if (!dialog.open) return;
        detection = result; editor.setPeople(result.people); renderTargets(result.people, true);
        skeleton.src = assetURL(result.asset); skeleton.hidden = false;
        status.textContent = `Detected ${result.people.length} people${result.people.length !== expectedPeople ? ' (differs from the gallery count; check for missed or false detections)' : ''}. Automatic detections are ordered left to right. Manual regions are ordered as drawn. Check each skeleton and assign a target.`;
      } catch(error) {
        if(dialog.open && error.name !== 'AbortError') { status.textContent = error.message + ' Try selecting a region below or mark visible joints manually.'; editor.open(); }
      } finally { detecting=false;editor.setBusy(false);actions.inert=false; }
    }
    editor.bar.append(action('Extract from Selected Regions', () => {
      if(!editor.regions().length){status.textContent='Drag a box around each person or choose Use Full Image for One Person.';return;}
      detect(editor.regions());
    }));
    dialog.addEventListener('cancel', event => { if (applying) event.preventDefault(); });
    const done = new Promise(resolve => dialog.addEventListener('close', () => {
      controller.abort(); requests.delete(controller); dialog.remove(); resolve(applied);
    }, { once: true }));
    dialog.showModal(); await detect();
    return done;
  }

  async function batch(rows, target) {
    const { dialog, status, actions, close } = modal(`Gallery View Batch · ${rows.length} Images`);
    const mode = document.createElement('select'); mode.setAttribute('aria-label', 'Gallery Batch Mode');
    mode.append(new Option('Gallery Pose Reference Only', 'references-only'), new Option('Current Composition Guide + Gallery Pose Reference', 'guided'));
    dialog.insertBefore(mode, status);
    status.textContent = 'Each job uses one gallery view and keeps other references and text. The batch uses the Qwen Base Model and restores your draft when it ends. Choose studio-plus-input in Multi-Image Encode to include the pose role in the prompt.';
    const list = document.createElement('ul'); list.className = 'pg-batch-summary';
    for (const row of rows) { const item = document.createElement('li'); item.textContent = row.asset.label || row.source.viewId; list.append(item); }
    dialog.insertBefore(list, actions);
    let controller = null, running = false, result = null;
    const receipt = action('Download Batch Receipt', () => context.download(new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' }), 'anyangle-gallery-batch.json'));
    receipt.disabled = true;
    const start = queue => async () => {
      if (running) return;
      running = true; actions.inert = true; mode.disabled = true; close.textContent = 'Stop Submitting Jobs';
      controller = new AbortController(); requests.add(controller);
      try {
        // Validate the complete plan before the first snapshot or queue operation.
        context.studio().syncPose();
        const plan = galleryViewPlan(context.doc(), rows, target, mode.value), previews = [...plan.views()];
        const warnings = [...new Set(previews.flatMap(view => libraryManifest(view.scene).warnings || []))];
        await context.run(async () => { result = await context.runBatch(plan, queue, controller.signal, progress => {
          status.textContent = `${progress.phase === 'capture' ? 'Preparing' : 'Processed'} ${progress.index}${progress.phase === 'capture' ? ' → ' + (progress.index + 1) : ''} / ${progress.total} · ${progress.label}`;
        }); });
        status.textContent = `${result.error ? 'Stopped: ' + result.error.message : result.stopped ? 'Stopped submitting jobs' : 'Batch complete'} · Saved ${result.views.length}, queued ${result.views.filter(row => row.prompt_id).length}. Draft restored. ${warnings.join(' ')}`;
        result = { version: 1, kind: 'anyangle-gallery-batch', ...result, error: result.error?.message || null };
        receipt.disabled = !result.views.length;
      } catch (error) { status.textContent = error.message; }
      finally { requests.delete(controller); running = false; actions.inert = false; mode.disabled = false; close.textContent = 'Close'; }
    };
    const save = action('Save Scene Snapshots Only', start(false)), queue = action('Save and Queue in ComfyUI', start(true));
    queue.disabled = !context.canQueue;
    if (!context.canQueue) queue.title = 'Open Studio from the ComfyUI node to queue jobs. Standalone Studio can save snapshots.';
    actions.append(save, queue, receipt);
    close.onclick = () => running ? controller.abort() : dialog.close();
    dialog.addEventListener('cancel', event => { if (running) { event.preventDefault(); controller.abort(); } });
    const done = new Promise(resolve => dialog.addEventListener('close', () => { dialog.remove(); resolve(result); }, { once: true }));
    dialog.showModal(); return done;
  }
  return { extract, batch, destroy() { for (const request of requests) request.abort(); requests.clear(); } };
}
