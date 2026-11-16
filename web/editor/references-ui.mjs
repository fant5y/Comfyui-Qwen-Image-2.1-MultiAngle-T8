import { USES, newUse, addReference, upgradeReferences, libraryManifest, libraryPrompt, staleGuide } from './reference-library.mjs?v=20261029v180';
import { uuid } from '../uuid.mjs?v=20261010lan1';
const $ = id => document.getElementById(id);
const copy = value => JSON.parse(JSON.stringify(value));
const imageURL = asset => `/anyangle-studio/assets/${encodeURIComponent(asset.name)}`;
const el = (tag, text, className) => { const node = document.createElement(tag); if (text) node.textContent = text; if (className) node.className = className; return node; };
function button(text, action, className = '') { const node = el('button', text, className); node.type = 'button'; node.onclick = action; return node; }
function select(options, value, change) { const node = el('select'); for (const [key, title] of options) node.append(new Option(title, key)); node.value = value; node.onchange = () => change(node.value); return node; }
function field(title, input) { const node = el('label', title); node.append(input); return node; }
let context, key, previewId, connected = [], tab = 'materials', openId, lastMapping = '', mappingWarning = '';
let renderedScene, renderedItems = [];
function edit(action) { context.begin(); action(); context.changed(false); }
function chooseTab(value) { tab = value; refreshReferencesUI(true); $(`tab-${value}`).focus(); }

export function installReferencesUI(value) {
  context = value;
  const left = document.querySelector('.left-panel'), objects = el('div', '', 'reference-objects'); objects.id = 'reference-objects';
  objects.setAttribute('role', 'tabpanel'); objects.setAttribute('aria-labelledby', 'tab-objects');
  objects.append(...left.children); left.append(objects);
  const tabs = el('div', '', 'reference-tabs'); tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', 'Sidebar');
  for (const [id, title] of [['materials', 'References'], ['objects', 'Scene Objects']]) {
    const node = button(title, () => chooseTab(id)); node.id = `tab-${id}`; node.setAttribute('role', 'tab'); node.setAttribute('aria-controls', `reference-${id}`);
    node.onkeydown = event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault(); chooseTab(event.key === 'Home' ? 'materials' : event.key === 'End' ? 'objects' : tab === 'materials' ? 'objects' : 'materials');
    };
    tabs.append(node);
  }
  left.prepend(tabs);
  const materials = el('section', '', 'reference-materials'); materials.id = 'reference-materials';
  materials.setAttribute('role', 'tabpanel'); materials.setAttribute('aria-labelledby', 'tab-materials');
  materials.innerHTML = `<div class="section-heading"><h2>References <small>REFERENCE LIBRARY</small></h2><span id="reference-count"></span></div>
    <p class="hint">Use images for characters, clothing, products, settings, or styles. Expand a reference to assign its role and target.</p>
    <div class="reference-source"><img id="library-source-image" alt="Scene Source Image" hidden><div><strong>Scene Source Image</strong><p id="library-source-state" class="hint"></p><button id="source-tools">Rebuild / Extract / Replace</button><button id="source-to-library">Add to References</button></div></div>
    <div class="compact-actions"><button id="add-reference" class="primary">＋ Add Reference</button><button id="read-references">Read Connections</button></div>
    <div id="legacy-references"><p class="hint">This scene uses legacy image rules. Upgrade to assign multiple roles to each image. You can undo the upgrade.</p><button id="upgrade-references">Upgrade References</button></div>
    <div id="reference-cards"></div><p id="reference-empty-note" class="empty-note">Add a reference and choose its role. Characters are optional.</p>
    <details class="reference-templates"><summary>Reference Set Templates</summary><select id="reference-template"></select><div class="compact-actions"><button id="save-reference-template">Save Set</button><button id="apply-reference-template">Apply Set</button></div><p class="hint">Templates store references and their roles. Applying one adds separate references. Check their targets afterward.</p></details>`;
  left.insertBefore(materials, objects);
  const stale = el('div', '', 'reference-review'); stale.id = 'reference-source-warning';
  const message = el('p'); message.id = 'reference-source-warning-text';
  const keep = button('Keep Saved Structure Guide', () => edit(() => { const scene = context.doc(); scene.derivedGuideStale = false; scene.retainedGuideSource = scene.derivedGuideSource;
    scene.conditioning.acceptStoredSource = true; if (scene.openpose) scene.openpose.acceptStoredSource = true; })); keep.id = 'keep-derived-guide';
  stale.append(message, button('Extract / Rebuild Again', () => chooseTab('objects')), keep); materials.insertBefore(stale, $('reference-cards'));
  const portable = el('div', '', 'compact-actions reference-portable'); portable.append($('export-scene'), $('import-scene')); materials.append(portable);
  const file = el('input'); file.type = 'file'; file.multiple = true; file.accept = 'image/*'; file.hidden = true; document.body.append(file);
  $('add-reference').onclick = () => file.click();
  file.onchange = () => { const files = [...file.files]; file.value = ''; if (!files.length) return;
    context.run(async () => { const scene = context.doc(), assets = []; for (const item of files) assets.push(await context.upload(item, true));
      if (context.doc() !== scene) throw new Error('The scene changed. Add the reference again.');
      edit(() => { if (scene.version !== 3) upgradeReferences(scene); for (const asset of assets) addReference(scene, asset); });
    });
  };
  $('read-references').onclick = () => context.send('anyangle-read-actors');
  $('upgrade-references').onclick = () => edit(() => upgradeReferences(context.doc()));
  $('source-tools').onclick = () => chooseTab('objects');
  $('source-to-library').onclick = () => edit(() => { const scene = context.doc(); if (scene.version !== 3) upgradeReferences(scene); if (scene.reference) addReference(scene, scene.reference); });
  $('save-reference-template').onclick = async () => { const name = await context.askName('Save Reference Set', 'My Reference Set'); if (!name) return;
    edit(() => { const library = context.doc().referenceLibrary; library.templates ||= []; library.templates.push({ id: uuid(), name, items: copy(library.items) }); });
  };
  $('apply-reference-template').onclick = () => edit(() => {
    const scene = context.doc(), template = scene.referenceLibrary.templates?.find(item => item.id === $('reference-template').value);
    if (!template) return;
    for (const saved of template.items) addReference(scene, saved.asset, { ...copy(saved), id: `ref-${uuid()}`, inputKey: null, missing: false,
      usages: saved.usages.map(use => ({ ...copy(use), id: `use-${uuid()}` })) });
  });
  const mode = el('label', 'Generation Mode', 'reference-workflow');
  const control = select([['guided', 'Composition Guide + References'], ['references-only', 'References Only'], ['text', 'Text Only']], 'guided', selected => edit(() => {
    const scene = context.doc(); if (scene.version !== 3) upgradeReferences(scene);
    scene.referenceLibrary.mode = selected;
    if (selected !== 'guided') scene.conditioning.model = 'base';
  })); control.id = 'reference-workflow'; mode.append(control); document.querySelector('.model-switch').after(mode);
  const first = el('div', '', 'reference-first-settings'); first.id = 'reference-first-settings';
  first.innerHTML = `<label>Output Aspect Reference<select id="first-reference"></select></label><label>First Image Pixel Budget<select id="first-reference-resolution"><option value="0">Keep Original Size · Align to 32</option><option value="768">768²pixels</option><option value="1024">1024²pixels</option><option value="1536">1536²pixels</option><option value="2048">2048²pixels</option></select></label><p class="hint">The first image sets the output aspect ratio and size. Other images use the encoder’s reference budget. Text-only output defaults to 1024 × 1024.</p>`;
  mode.after(first);
  const frame = el('p', '', 'hint'); frame.id = 'reference-frame-state'; first.append(frame);
  $('first-reference').onchange = () => edit(() => { context.doc().referenceLibrary.firstReferenceId = $('first-reference').value || null; });
  $('first-reference-resolution').onchange = () => edit(() => { context.doc().referenceLibrary.firstResolution = Number($('first-reference-resolution').value); });
  const send = el('details', '', 'reference-send-plan'); send.id = 'reference-send-plan';
  send.innerHTML = '<summary id="reference-send-summary"></summary><div id="reference-send-images"></div><p id="reference-send-warning" class="hint"></p><p class="hint">Image numbers show the actual input order. The prompt describes targets and source regions. Full Input uses your text as written.</p>';
  document.querySelector('.right-panel').prepend(send);
  const preview = el('div', '', 'reference-stage-preview'); preview.id = 'reference-stage-preview';
  preview.innerHTML = '<div class="reference-preview-title"><strong>Reference Preview</strong><span>3D scene retained · No guide output</span></div><img id="reference-stage-image" alt="Current reference preview"><p id="reference-stage-empty" class="empty-note">Enter a prompt or add a reference.</p><div id="reference-stage-thumbs"></div>';
  $('stage').append(preview);
  const crop = el('dialog', '', 'reference-crop-dialog'); crop.id = 'reference-crop-dialog';
  crop.innerHTML = `<form method="dialog"><div class="section-heading"><h2>Crop to New Reference</h2><button value="cancel" formnovalidate>Cancel</button></div><p class="hint">Drag a rectangle on the image. The crop gets its own reference and image number, and the source stays in the library.</p><div id="reference-crop-surface"><img id="reference-crop-image" alt="Crop source"><div id="reference-crop-box"></div></div><div class="crop-fields">${['x','y','width','height'].map(name => `<label>${name}<input id="crop-${name}" type="number" min="${name === 'width' || name === 'height' ? 1 : 0}" required></label>`).join('')}</div><button value="ok" class="primary">Save Crop</button></form>`;
  document.body.append(crop); installCropDrag();
}

function useControls(scene, item, use) {
  const panel = el('div', '', 'reference-use');
  const usage = select(Object.entries(USES), use.kind, value => edit(() => { use.kind = value; })); panel.append(field('Role', usage));
  const options = [['scene', 'Entire Scene'], ['text', 'Describe Target in Text'], ...scene.actors.map(actor => [`actor:${actor.id}`, `Character · ${actor.label}`]), ...(scene.props || []).map(prop => [`prop:${prop.id}`, `Prop · ${prop.label}`])];
  const selected = use.target.kind === 'scene' || use.target.kind === 'text' ? use.target.kind : `${use.target.kind === 'actors' ? 'actor' : 'prop'}:${use.target.ids[0] || ''}`;
  if (!options.some(([id]) => id === selected)) options.push([selected, 'Target Needs Reassignment']);
  const target = select(options, selected, value => edit(() => {
    const delimiter = value.indexOf(':'), kind = delimiter < 0 ? value : value.slice(0, delimiter), id = delimiter < 0 ? '' : value.slice(delimiter + 1);
    use.target = { kind: kind === 'actor' ? 'actors' : kind === 'prop' ? 'props' : kind, ids: id ? [id] : [], text: use.target.text || '' };
  })); panel.append(field('Target', target));
  if (use.kind === 'identity') panel.append(el('p', 'Identity covers face shape and hair. Add clothing, accessory, or style roles to copy the rest of the look. Crop an individual first when needed.', 'hint'));
  if (use.target.kind === 'actors' || use.target.kind === 'props') {
    const group = el('div', '', 'reference-targets');
    for (const object of scene[use.target.kind] || []) {
      const check = el('input'); check.type = 'checkbox'; check.checked = use.target.ids.includes(object.id);
      check.onchange = () => edit(() => { use.target.ids = check.checked ? [...use.target.ids, object.id] : use.target.ids.filter(id => id !== object.id); });
      group.append(field(object.label, check));
    } panel.append(group);
  }
  for (const [title, owner, name, placeholder] of [
    ...(use.target.kind === 'text' ? [['Target Description', use.target, 'text', 'For example, the bag in her hand or the product in the foreground']] : []),
    ['Source Content / Region', use, 'sourceText', 'For example, woman on the left or handbag only'], ['Additional Instructions', use, 'instruction', 'For example, keep the material and change the color to silver']]) {
    const input = el('textarea'); input.rows = 2; input.maxLength = 16000; input.value = owner[name] || ''; input.placeholder = placeholder;
    input.onchange = () => edit(() => { owner[name] = input.value; }); panel.append(field(title, input));
  }
  const enabled = el('input'); enabled.type = 'checkbox'; enabled.checked = use.enabled !== false; enabled.onchange = () => edit(() => { use.enabled = enabled.checked; });
  const controls = el('div', '', 'reference-use-actions'); controls.append(field('Enable Role', enabled), button('Remove Role', () => edit(() => { item.usages = item.usages.filter(value => value.id !== use.id); }))); panel.append(controls); return panel;
}
function card(scene, item, manifest) {
  const entry = el('div', '', 'reference-entry');
  const details = el('details', '', 'reference-card'); details.open = openId === item.id;
  details.ontoggle = () => { if (!details.isConnected) return; if (details.open) openId = item.id; else if (openId === item.id) openId = null; };
  const summary = el('summary'), image = el('img'); image.alt = item.label; if (item.asset) image.src = imageURL(item.asset);
  summary.onclick = () => { openId = details.open ? null : item.id; };
  const caption = el('span'), ref = manifest.references.find(ref => ref.referenceIds.includes(item.id));
  const state = manifest.excluded.find(value => value.id === item.id);
  caption.append(el('strong', item.label), el('small', ref ? `image_${ref.index} · ${item.usages.map(use => USES[use.kind]).join(' / ')}` : state?.reason || 'Excluded'));
  summary.append(image, caption); details.append(summary);
  const label = el('input'); label.value = item.label; label.onchange = () => edit(() => { item.label = label.value.trim() || 'References'; }); details.append(field('Reference Name', label));
  const enabled = el('input'); enabled.type = 'checkbox'; enabled.checked = item.enabled !== false; enabled.onchange = () => edit(() => { item.enabled = enabled.checked; }); details.append(field('Include Reference', enabled));
  details.append(el('p', item.inputKey ? `Connected ${item.inputKey} · Image ${(item.batchIndex || 0) + 1} of ${item.batchCount || 1}` : `Saved reference · ${item.asset?.width || '?'} × ${item.asset?.height || '?'}`, 'hint'));
  if (item.reviewSource) details.append(el('p', 'The connected image changed. Check the source region and role description.', 'reference-review'));
  for (const use of item.usages) details.append(useControls(scene, item, use));
  const actions = el('div', '', 'reference-card-actions');
  const source = button('Use as Source Image', () => edit(() => { const previous = scene.reference; scene.reference = copy(item.asset); context.sourceChanged(previous); }));
  source.disabled = !item.asset || context.sourceConnected();
  source.title = context.sourceConnected() ? 'Replace the upstream image or disconnect the source input.' : !item.asset ? 'Read or import this reference first.' : 'Use this reference for pose extraction or 3D reconstruction.';
  const crop = button('Crop Reference', () => cropReference(item)); crop.disabled = !item.asset;
  actions.append(button('＋ Add Role', () => edit(() => { item.usages.push(newUse('identity', { kind: 'scene', ids: [], text: '' })); })),
    source, crop, button('↑', () => moveReference(scene, item, -1)), button('↓', () => moveReference(scene, item, 1)));
  if (item.inputKey) actions.append(button('Use Saved Version', () => edit(() => { item.inputKey = null; item.missing = false; })));
  if (item.inputKey && item.batchCount > 1) actions.append(button('Split Batch into References', () => splitBatch(scene, item)));
  if (item.reviewSource) actions.append(button('Confirm Updated Source', () => edit(() => { item.reviewSource = false; })));
  details.append(actions);
  const tools = el('div', '', 'reference-card-tools');
  const replace = button('Replace Image', () => replaceReference(scene, item));
  replace.disabled = !!item.inputKey;
  replace.title = item.inputKey ? 'Replace the upstream image, or choose Use Saved Version before replacing it here.' : 'Replace the image while keeping its name, roles, target, and position.';
  const remove = button('Remove Reference', () => edit(() => {
    scene.referenceLibrary.items = scene.referenceLibrary.items.filter(value => value.id !== item.id);
    if (scene.referenceLibrary.firstReferenceId === item.id) scene.referenceLibrary.firstReferenceId = null;
    if (openId === item.id) openId = null;
  }));
  remove.title = 'Remove from the library. You can undo this. The scene source and characters are kept.';
  tools.append(replace, remove); entry.append(details, tools); return entry;
}
function replaceReference(scene, item) {
  const file = el('input'); file.type = 'file'; file.accept = 'image/*'; file.hidden = true; document.body.append(file);
  file.oncancel = () => file.remove();
  file.onchange = () => {
    const selected = file.files[0]; file.remove(); if (!selected) return;
    context.run(async () => {
      const asset = await context.upload(selected, true);
      if (context.doc() !== scene || !scene.referenceLibrary.items.includes(item)) throw new Error('The scene changed. Replace the image again.');
      edit(() => { item.asset = asset; item.batchIndex = 0; item.batchCount = 1; item.missing = false; item.reviewSource = true; delete item.parent; });
    });
  };
  file.click();
}
function moveReference(scene, item, delta) {
  edit(() => { const items = scene.referenceLibrary.items, index = items.indexOf(item), next = Math.min(items.length - 1, Math.max(0, index + delta)); items.splice(index, 1); items.splice(next, 0, item); });
}
function splitBatch(scene, item) {
  const assets = connected.find(ref => ref.inputKey === item.inputKey)?.assets;
  if (!assets?.length) { context.toast('Click Read Connections to load the entire batch first.'); return; }
  edit(() => { for (let index = 1; index < assets.length; index++) {
    if (scene.referenceLibrary.items.some(value => value.inputKey === item.inputKey && value.batchIndex === index)) continue;
    addReference(scene, assets[index], { label: `${item.label} · ${index + 1}`, inputKey: item.inputKey, batchIndex: index, batchCount: assets.length,
      usages: item.usages.map(use => ({ ...copy(use), id: `use-${uuid()}` })) });
  } });
}
export function setReferenceConnections(values) { connected = values || []; }
export function refreshReferencesUI(force = false) {
  if (!context) return;
  const scene = context.doc(), library = scene.referenceLibrary, modern = scene.version === 3 && !!library;
  $('reference-materials').hidden = tab !== 'materials'; $('reference-objects').hidden = tab !== 'objects';
  for (const value of ['materials', 'objects']) { $(`tab-${value}`).classList.toggle('active', tab === value); $(`tab-${value}`).setAttribute('aria-selected', String(tab === value)); $(`tab-${value}`).tabIndex = tab === value ? 0 : -1; }
  $('legacy-references').hidden = modern; $('reference-workflow').value = modern ? library.mode : 'guided';
  const source = scene.reference; $('source-to-library').disabled = !source;
  $('reference-source-warning').hidden = !scene.sourceStale && !scene.derivedGuideStale && !staleGuide(scene);
  $('reference-source-warning-text').textContent = scene.sourceStale ? 'The source changed. Rebuild to update the 3D scene. References and camera settings are kept.' : 'The source changed. Extract the pose or depth again, or choose to keep the saved guide.';
  $('keep-derived-guide').hidden = !scene.derivedGuideStale && !staleGuide(scene);
  $('library-source-image').hidden = !source; if (source) $('library-source-image').src = imageURL(source);
  const noGuide = modern && library.mode !== 'guided'; $('stage').classList.toggle('reference-only', noGuide); $('reference-stage-preview').hidden = !noGuide;
  if (noGuide) $('mouse-pitch').closest('.studio-options').hidden = true;
  $('image-order-row').hidden = noGuide || scene.conditioning.promptMode === 'single';
  const anyangle = scene.conditioning.model === 'anyangle';
  $('library-source-state').textContent = source ? anyangle && !noGuide
    ? 'Used for extraction and reconstruction. AnyAngle includes the source automatically. Add it to References to assign more roles.'
    : 'Used for extraction and reconstruction. Add it to References to include it in multi-image generation.' : 'Optional. You can pose mannequins or generate from text alone.';
  for (const option of $('image-order').options) option.textContent = option.value === 'guide-first'
    ? (modern && anyangle && source ? 'Render 1 / Source 2 / References 3+' : modern ? 'Guide First / References After' : 'Guide 1 / Source 2')
    : (modern && anyangle && source ? 'Source 1 / Render 2 / References 3+' : modern ? 'References First / Guide Last' : 'Source 1 / Guide 2');
  if (modern) $('reference-heading').textContent = 'Scene Source Image · Extract / Rebuild';
  document.querySelector('.guide-choice-grid').hidden = noGuide;
  document.querySelector('.guide-label').hidden = noGuide;
  document.querySelector('.output-section').hidden = noGuide;
  $('guide-explanation').hidden = noGuide;
  for (const id of ['coarse-inputs','openpose-panel','map-inputs','canny-options','stage-help']) if (noGuide) $(id).hidden = true;
  if (!noGuide) $('stage-help').hidden = false;
  $('ratio').disabled = noGuide;
  $('reference-first-settings').hidden = !modern || library.mode !== 'references-only';
  $('reference-send-plan').hidden = !modern; document.querySelector('.reference-templates').hidden = !modern;
  if (!modern) { key = null; renderedScene = null; renderedItems = []; $('reference-cards').replaceChildren(); $('reference-empty-note').hidden = true; return; }
  const manifest = libraryManifest(scene), signature = JSON.stringify([library, scene.actors, scene.props, scene.conditioning, manifest, context.sourceConnected()]);
  const firstImage = manifest.references[0];
  if (firstImage && library.mode === 'references-only') {
    let width = firstImage.asset.width, height = firstImage.asset.height;
    const requested = `${width} × ${height}`, scale = library.firstResolution ? library.firstResolution / Math.sqrt(width * height) : 1;
    width = Math.max(32, Math.round(width * scale / 32) * 32); height = Math.max(32, Math.round(height * scale / 32) * 32);
    $('reference-frame-state').textContent = `Source ${requested} → First image / Native output ${width} × ${height}`;
  } else $('reference-frame-state').textContent = library.mode === 'text' ? 'Native text-only size: 1024 × 1024' : '';
  const mapping = JSON.stringify([manifest.guide?.index, manifest.references.map(reference => [reference.asset.name, reference.index])]);
  if (lastMapping && lastMapping !== mapping) mappingWarning = 'Image order or content changed. Check your <imageN> tags against this list when using a custom or full-input prompt.';
  lastMapping = mapping;
  const selectedId = library.firstReferenceId || '';
  if (force || signature !== key || scene !== renderedScene || library.items.some((item, index) => item !== renderedItems[index])) {
    key = signature; renderedScene = scene; renderedItems = library.items.slice();
    $('reference-cards').replaceChildren(...library.items.map(item => card(scene, item, manifest)));
    $('reference-count').textContent = `${library.items.length} references`; $('reference-empty-note').hidden = !!library.items.length;
    $('first-reference').replaceChildren(new Option('First Enabled Reference', ''), ...library.items.map(item => new Option(item.label, item.id))); $('first-reference').value = selectedId;
    const budget = $('first-reference-resolution'), resolution = String(library.firstResolution || 0);
    for (const option of [...budget.options]) if (option.dataset.custom === 'true') option.remove();
    if (![...budget.options].some(option => option.value === resolution)) {
      const option = new Option(`${resolution}² pixels · Custom`, resolution); option.dataset.custom = 'true'; budget.append(option);
    }
    budget.value = resolution;
    $('reference-template').replaceChildren(...(library.templates || []).map(template => new Option(template.name, template.id)));
    $('apply-reference-template').disabled = !library.templates?.length;
    $('reference-send-summary').textContent = `${manifest.imageCount} images · ${manifest.guide ? '1 guide + ' : ''}${manifest.references.length} references`;
    const rows = []; if (manifest.guide) rows.push(el('p', `image_${manifest.guide.index} · Current Composition Guide`));
    for (const reference of manifest.references) rows.push(el('p', `image_${reference.index} · ${reference.labels.join(' / ')} · ${reference.usages.map(use => `${USES[use.kind]} → ${use.targetText}`).join('；')}`));
    for (const entry of manifest.excluded) rows.push(el('p', `${entry.label} · ${entry.reason}`, 'hint'));
    $('reference-send-images').replaceChildren(...rows); $('reference-send-warning').textContent = [mappingWarning, ...manifest.warnings].filter(Boolean).join(' ') || 'Qwen recommends up to 10 images. Each reference is encoded once even when assigned several roles.';
    $('prompt-preview').textContent = libraryPrompt(scene, manifest);
  }
  if (noGuide) {
    const selected = library.items.find(item => item.id === previewId) || library.items.find(item => item.id === selectedId) || library.items.find(item => item.asset);
    $('reference-stage-image').hidden = !selected?.asset; $('reference-stage-empty').hidden = !!selected?.asset;
    if (selected?.asset) $('reference-stage-image').src = imageURL(selected.asset);
    $('reference-stage-thumbs').replaceChildren(...library.items.filter(item => item.asset).map(item => { const thumb = button('', () => { previewId = item.id; refreshReferencesUI(); }); const image = el('img'); image.src = imageURL(item.asset); image.alt = item.label; thumb.title = item.label; thumb.append(image); thumb.classList.toggle('active', item.id === selected?.id); return thumb; }));
    $('view-detail').textContent = library.mode === 'text' ? 'Text Only · References excluded' : 'References Only · First image sets the aspect ratio';
  }
  for (const id of ['camera-heading', 'camera-eyebrow', 'camera-sliders', 'lens-panel', 'view-presets', 'shot-shelf', 'guide-section']) {
    const node = $(id) || (id === 'guide-section' ? document.querySelector('.guide-section') : null); if (node && noGuide) node.hidden = true;
  }
  if (noGuide) { $('download-guide').disabled = true; $('open-batch').disabled = true; }
  document.querySelector('.guide-section').hidden = noGuide;
  $('model-anyangle').disabled ||= noGuide;
  $('image-wiring').textContent = 'Connect Studio’s Current Composition Guide and Scene and Reference Settings to Multi-Image Encode. For Full Input, connect Studio’s prompt to the encoder prompt input.';
  $('prompt-mode-hint').textContent = 'Type a prompt in the encoder or connect another text node. Studio Plus Input appends it once. Full Input uses it as written. Reference roles guide the prompt.';
  if (anyangle) $('prompt-mode-hint').textContent += ' AnyAngle keeps the camera trigger phrase and appends enabled reference roles. The source keeps its input size. Other images use the encoder’s reference budget.';
  if (scene.source?.kind === 'splat') $('prompt-mode-hint').textContent += ' For reconstructed scenes, describe targets by name or position, such as the woman on the left in the source image.';
  const select = $('prompt-mode');
  for (const option of select.options) { if (option.value === 'default') option.textContent = 'Generate from Reference Roles'; if (option.value === 'single') option.hidden = true; }
  if (scene.conditioning.promptMode === 'single') $('prompt-mode-hint').textContent += ' The reference list controls which images are sent. Disable references to send only the guide.';
}
function installCropDrag() {
  const surface = $('reference-crop-surface'), image = $('reference-crop-image'); let start;
  function display() { const w = image.naturalWidth, h = image.naturalHeight; if (!w || !h) return; const box = $('reference-crop-box');
    box.style.left = `${Number($('crop-x').value) / w * 100}%`; box.style.top = `${Number($('crop-y').value) / h * 100}%`;
    box.style.width = `${Number($('crop-width').value) / w * 100}%`; box.style.height = `${Number($('crop-height').value) / h * 100}%`; }
  const point = event => { const bounds = image.getBoundingClientRect(); return [Math.max(0, Math.min(image.naturalWidth, Math.round((event.clientX - bounds.left) / bounds.width * image.naturalWidth))), Math.max(0, Math.min(image.naturalHeight, Math.round((event.clientY - bounds.top) / bounds.height * image.naturalHeight)))]; };
  surface.onpointerdown = event => { if (event.button !== 0) return; event.preventDefault(); start = point(event); surface.setPointerCapture(event.pointerId); };
  surface.onpointermove = event => { if (!start) return; const end = point(event); for (const [id, value] of [['x', Math.min(start[0], end[0])], ['y', Math.min(start[1], end[1])], ['width', Math.abs(start[0] - end[0])], ['height', Math.abs(start[1] - end[1])]]) $(`crop-${id}`).value = value; display(); };
  surface.onpointerup = surface.onpointercancel = () => { start = null; };
  for (const name of ['x', 'y', 'width', 'height']) $(`crop-${name}`).oninput = display;
  image.onload = display;
}
async function cropReference(item) {
  if (!item.asset) return;
  const scene = context.doc(), asset = item.asset, dialog = $('reference-crop-dialog'), image = $('reference-crop-image');
  image.src = imageURL(asset); for (const [name, value] of [['x', 0], ['y', 0], ['width', asset.width], ['height', asset.height]]) $(`crop-${name}`).value = value;
  dialog.returnValue = ''; dialog.showModal();
  const result = await new Promise(resolve => dialog.addEventListener('close', () => resolve(dialog.returnValue), { once: true })); if (result !== 'ok') return;
  context.run(async () => {
    const x = Number($('crop-x').value), y = Number($('crop-y').value), width = Number($('crop-width').value), height = Number($('crop-height').value);
    if (![x,y,width,height].every(Number.isInteger) || x < 0 || y < 0 || width < 1 || height < 1 || x + width > image.naturalWidth || y + height > image.naturalHeight) throw new Error('The crop must be inside the source image and at least 1 × 1 pixel.');
    const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height; canvas.getContext('2d').drawImage(image, x,y,width,height, 0,0,width,height);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png')); const saved = await context.upload(new File([blob], 'crop.png', { type: 'image/png' }), true);
    if (context.doc() !== scene || !scene.referenceLibrary.items.includes(item) || item.asset.name !== asset.name) throw new Error('The source image changed. Try cropping again.');
    edit(() => addReference(scene, saved, { label: `${item.label} · Crop`, parent: { name: asset.name, box: [x,y,width,height] }, usages: item.usages.map(use => ({ ...copy(use), id: `use-${uuid()}` })) }));
  });
}
