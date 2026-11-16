import { StudioScene, defaultScene } from './scene.mjs?v=20261116en';
import { activeActor, createActor, bindActor, editableActors } from './actors.mjs?v=20261116en';
import { applyCatalogTransaction, filterCatalog, finishCatalogPose } from './pose-catalog.mjs?v=20261116en';
import { installPoseGallery, galleryImage } from './pose-gallery-ui.mjs?v=20261116en';

const clone = value => structuredClone(value);
const $ = id => document.getElementById(id);
const API = '/anyangle-studio/pose-library';
async function readResult(response) {
  const result=await response.json().catch(()=>null);
  if(!response.ok)throw new Error(result?.error || `Pose Library request failed (HTTP ${response.status})${response.status===413?'. Reduce the file or preview size.':''}`);
  if(!result || typeof result!=='object')throw new Error('The Pose Library returned invalid data. Refresh and try again.');
  return result;
}
async function api(path = '', data, method = 'POST') {
  const response = await fetch(API + path, data === undefined ? {} : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  return readResult(response);
}
function control(label, action, className = '') {
  const button = document.createElement('button'); button.type = 'button'; button.textContent = label; button.className = className; button.onclick = action; return button;
}

export function installPoseLibrary(context) {
  let catalog = { revision: 0, items: [], catalog: [] }, selected = null, page = 0, pending = null;
  let preview = null, previewToken = 0, previewWork = Promise.resolve(), disposed = false, importToken = 0, writing = false, composing = false, filtersRestored = false;
  const batchIds = new Set();
  const dialog = document.createElement('dialog'); dialog.id = 'pose-library-dialog'; dialog.className = 'pose-library-dialog';
  dialog.innerHTML = `<div class="pl-header"><div><span class="pl-eyebrow">POSE LIBRARY</span><h2>Pose Library <small id="pl-total"></small></h2></div><button id="pl-close" aria-label="Close Pose Library">Close</button></div>
    <div class="pl-toolbar"><input id="pl-search" type="search" placeholder="Search by name, original name, or tag" aria-label="Search Poses"><select id="pl-category" aria-label="Pose Category"><option value="">All Poses</option></select><select id="pl-tab" aria-label="Pose Filter"><option value="all">All</option><option value="imported">Imported</option><option value="favorites">Favorites</option></select><select id="pl-source" aria-label="Pose Source"><option value="">All Sources</option></select></div>
    <div class="pl-management"><button id="pl-files">Import Files / ZIP</button><button id="pl-directory">Import Pose Folder</button><button id="pl-export">Export Pose Pack</button><button id="pl-save">Save Current Pose</button><button id="pl-save-composition">Save Selected Group Arrangement</button><button id="pl-migrate" hidden>Migrate Legacy Poses</button><button id="pl-reload">Refresh Local List</button><button id="pl-show-hidden">Restore Hidden Built-ins</button></div>
    <details class="pl-sources"><summary>Add External Pose Libraries</summary><p class="hint">Includes a curated collection and four community libraries. Only pose data is imported. Source and license details are retained. Content without a declared license is excluded from redistribution.</p><label><input id="pl-latest" type="checkbox">Load latest source version (defaults to a reviewed version)</label><div id="pl-sources"></div><p id="pl-source-status" role="status"></p></details>
    <div id="pl-import" class="pl-import" hidden><h3>Import Review</h3><p id="pl-import-summary"></p><div id="pl-import-rows"></div><div class="compact-actions"><button id="pl-import-all">Select All Valid Items</button><button id="pl-import-none">Clear Selection</button><button id="pl-import-commit" class="primary">Save Selected Poses</button><button id="pl-import-cancel">Cancel Import</button></div></div>
    <p id="pl-status" role="status" class="hint"></p>
    <div class="pl-content"><section class="pl-list"><div id="pl-grid" class="pl-grid"></div><div class="pl-pagination"><button id="pl-prev">Previous</button><span id="pl-page"></span><button id="pl-next">Next</button></div></section>
    <aside class="pl-detail"><div id="pl-preview-stage" class="pl-preview-stage"><canvas id="pl-preview" aria-label="Isolated 3D pose preview"></canvas><p id="pl-preview-hint">Select a pose to preview it in 3D</p></div><h3 id="pl-name">Select a Pose</h3><p id="pl-description" class="hint"></p><p id="pl-target" class="pl-target"></p>
    <label>Apply To<select id="pl-scope"><option value="current">Current Character</option><option value="selected">Selected Unlocked Characters</option><option value="all">All Editable Characters</option></select></label>
    <label>Pose Scope<select id="pl-part"><option value="full">Full Pose</option><option value="body">Body · Keep Hand Poses</option><option value="arms">Both Arms</option><option value="legs">Both Legs</option><option value="hands">Wrists and Fingers</option></select></label>
    <label class="option-toggle"><input id="pl-preserve-hands" type="checkbox"><span>Keep Current Hand Poses</span></label><label class="option-toggle"><input id="pl-ground" type="checkbox"><span>Ground After Applying</span></label><label id="pl-contact-row" class="option-toggle" hidden><input id="pl-release" type="checkbox"><span id="pl-contact-text"></span></label>
    <button id="pl-apply" class="primary" disabled>Apply to Characters</button><button id="pl-fit" class="wide-button">Fit to Current Frame</button><p class="hint">Applying a pose keeps identity, body shape, and camera settings. Adjust contact points afterward as needed.</p>
    <div class="pl-entry-actions"><button id="pl-favorite">Favorites</button><button id="pl-rename">Rename</button><button id="pl-delete">Delete / Hide</button><button id="pl-batch">Add to Pose Batch</button><button id="pl-export-one">Export This Pose</button></div><details><summary>Source and Compatibility</summary><pre id="pl-provenance"></pre></details></aside></div>`;
  document.body.append(dialog);
  const boneDetail=dialog.querySelector('.pl-detail');
  const gallery=installPoseGallery(context,{dialog,refresh:()=>render(),filterChanged:()=>{page=0;render();},composing:value=>{composing=value;},catalogChanged:()=>execute(async()=>{await reload();render();})});
  const files = document.createElement('input'); files.type = 'file'; files.multiple = true; files.accept = '.json,.zip,.webp,.png,.jpg,.jpeg'; files.hidden = true;
  const directory = document.createElement('input'); directory.type = 'file'; directory.multiple = true; directory.webkitdirectory = true; directory.hidden = true;
  document.body.append(files, directory);
  const open = control('Open Pose Library', () => execute(async () => { await reload(); render(); if(!dialog.open)dialog.showModal(); if(entry())await showPreview(); }), 'wide-button accent-button');
  open.id = 'open-pose-library'; document.querySelector('.reference-tabs').after(open);
  const message = text => { if(!disposed)$('pl-status').textContent = text; };
  const execute = task => Promise.resolve().then(task).catch(error => { if(!disposed){message(error.message); context.toast(error.message);} });
  const mutate = task => {
    if(writing)return;writing=true;render();
    return execute(task).finally(()=>{writing=false;if(!disposed)render();});
  };
  const entry = () => matches().find(item=>item.id===selected) || [...catalog.items,...gallery.items()].find(item => item.id === selected && (!item.hidden || $('pl-tab').value==='hidden'));
  const accept = next => {if(next.revision>=catalog.revision)catalog=next;};
  async function reload() {
    const [poses]=await Promise.all([api(),gallery.reload()]);accept(poses);
    $('pl-total').textContent = `${catalog.items.filter(item => !item.hidden).length} items`;
    const cat = $('pl-category').value, source = $('pl-source').value;
    const all=[...catalog.items,...gallery.items()];
    $('pl-category').replaceChildren(new Option('All Poses',''), ...[...new Set(all.map(item => item.category))].sort().map(value => new Option(value,value))); $('pl-category').value = cat;
    $('pl-source').replaceChildren(new Option('All Sources',''), ...[...new Map(all.map(item => [item.source?.id || 'local',item.source?.name || 'Local Import'])).entries()].map(([value,name]) => new Option(value==='builtin'?'AnyAngle Built-in':value==='local'?'Locally Saved / Imported':name,value))); $('pl-source').value = source;
    if(!filtersRestored){filtersRestored=true;gallery.restoreFilters();}
    $('pl-sources').replaceChildren();
    for (const source of catalog.catalog || []) $('pl-sources').append(control(`Load ${source.name}`, () => execute(() => readSource(source))));
    let legacy = [], migrated=false;
    try { legacy = JSON.parse(localStorage.getItem('anyangle-studio.poses.v1') || '[]'); migrated=localStorage.getItem('anyangle-studio.poses.migrated.v1')==='yes'; } catch { /* Server catalog remains available when browser storage is blocked. */ }
    $('pl-migrate').hidden = !Array.isArray(legacy) || !legacy.length || migrated;
    $('pl-migrate').textContent = `Migrate Legacy Poses ${legacy.length || 0} items`;
    $('pl-migrate').onclick = () => execute(async () => {
      const form = new FormData();
      for (const [i, item] of legacy.entries()) if (item?.pose?.bones) form.append('files', new Blob([JSON.stringify({version:1,kind:'anyangle-pose',pose:item.pose})],{type:'application/json'}), `${item.name || `Legacy Pose ${i+1}`}.json`);
      if (await inspect(form)) pending.migration = true;
    });
  }
  function matches() {
    const options=gallery.options();
    const bones=options.type==='reference-set'||options.angle||options.frame||options.collection||['recent','hidden'].includes(options.tab)?[]:filterCatalog(catalog.items,options).filter(item=>(!options.type||(item.kind||'pose')===options.type)&&(!options.people||String(item.slots?.length||1)===options.people));
    return [...bones,...gallery.matches()];
  }
  function targets() {
    const roles = editableActors(context.doc(), $('pl-scope').value);
    $('pl-target').textContent = context.doc().source.kind === 'human' ? `Will apply to: ${roles.map(role => role.label).join(', ') || 'No editable characters'}` : 'Switch to a posable mannequin to apply library poses.';
    const ids = new Set(roles.map(role=>role.id)), contacts = (context.doc().contacts || []).filter(contact => contact.actors?.some(id=>ids.has(id)));
    $('pl-contact-row').hidden = !contacts.length; $('pl-contact-text').textContent = `Allow removing ${contacts.length} contact anchors involving these characters`;
    const composition=entry()?.kind==='composition';
    $('pl-part').disabled=composition;$('pl-preserve-hands').disabled=composition;
    $('pl-apply').textContent=composition ? `Apply Arrangement for ${entry().slots.length} Characters (Moves Characters)` : 'Apply to Characters';
    if(composition)$('pl-target').textContent+=` · Requires ${entry().slots.length} characters, matched in displayed order`;
    $('pl-apply').disabled = writing || !entry() || !roles.length || context.doc().source.kind !== 'human' || contacts.length > 0 && !$('pl-release').checked || composition && roles.length!==entry().slots.length;
  }
  function render() {
    if(disposed)return;
    const images=gallery.items().filter(item=>!item.hidden);
    $('pl-total').textContent = `${catalog.items.filter(item=>!item.hidden).length} poses / arrangements · ${images.length} image sets / ${images.reduce((sum,item)=>sum+item.views.length,0)} views`;
    dialog.setAttribute('aria-busy',String(writing));
    for(const id of ['pl-save','pl-save-composition','pl-show-hidden','pl-files','pl-directory','pl-reload','pl-migrate','pl-import-commit','pl-import-cancel'])$(id).disabled=writing;
    for(const id of ['pl-save','pl-save-composition'])$(id).disabled=writing||context.doc().source.kind!=='human';
    $('pl-sources').querySelectorAll('button').forEach(button=>button.disabled=writing);
    const items = matches(), pages = Math.max(1,Math.ceil(items.length/24)); page = Math.min(page,pages-1);
    $('pl-grid').replaceChildren();
    for (const item of items.slice(page*24,(page+1)*24)) {
      const card = control('', () => { selected = item.id; render(); execute(showPreview); if (matchMedia('(max-width:700px)').matches) dialog.querySelector('.pl-detail:not([hidden])').scrollIntoView({block:'start',behavior:'smooth'}); }, 'pl-card' + (selected === item.id ? ' selected' : ''));
      if(item.kind==='reference-set'){const img=document.createElement('img'),view=item.views.find(view=>view.id===item.matchedViewIds?.[0])||item.views[0];img.src=galleryImage(view.thumbnail.name);img.loading='lazy';img.alt=`${item.name} · ${view.label}`;card.append(img);}
      else if (item.preview || item.builtin) { const img = document.createElement('img'); img.src = item.preview ? `${API}/previews/${encodeURIComponent(item.preview)}` : new URL(`./pose-previews/${encodeURIComponent(item.id)}.png`,import.meta.url).href; img.loading = 'lazy'; img.alt = item.name; card.append(img); }
      else { const graphic = document.createElement('span'); graphic.className='pl-placeholder'; graphic.textContent = item.category === '舞蹈' ? '✧' : ['Movement', '运动'].includes(item.category) ? '↗' : '◯'; card.append(graphic); }
      const name = document.createElement('strong'); name.textContent = item.name;
      const meta = document.createElement('small'); meta.textContent = `${item.favorite ? '★ ' : ''}${item.kind==='reference-set'?`${item.people} people · ${item.views.length} views`:item.kind==='composition' ? `${item.slots.length}-character arrangement` : item.category} · ${item.builtin ? 'Built-in' : 'Imported'}${batchIds.has(item.id) ? ' · Added to batch' : ''}`;
      card.append(name,meta); $('pl-grid').append(card);
    }
    if (!items.length) { const empty=document.createElement('p'); empty.textContent='No matching poses. Change the filters or import from a local or external library.'; $('pl-grid').append(empty);for(const suggestion of gallery.suggestions())$('pl-grid').append(control(`Clear ${{angle:'view',people:'people',frame:'framing',category:'category',source:'source',tab:'scope'}[suggestion.field]} filter · ${suggestion.count} sets`,()=>{document.getElementById({angle:'pg-angle',people:'pg-people',frame:'pg-frame',category:'pl-category',source:'pl-source',tab:'pl-tab'}[suggestion.field]).value=suggestion.field==='tab'?'all':'';page=0;render();})); }
    $('pl-page').textContent = `${page+1} / ${pages} · ${items.length} items`; $('pl-prev').disabled = page === 0; $('pl-next').disabled = page === pages-1;
    const item = entry();
    dialog.querySelector('.pl-content').dataset.selected = String(!!item);
    boneDetail.hidden=item?.kind==='reference-set';gallery.render(item);
    if(item?.kind==='reference-set'){previewToken++;return;}
    if (!item) {
      previewToken++; $('pl-preview').hidden = true; $('pl-preview-hint').hidden = false;
      $('pl-preview-hint').textContent = 'Select a pose to preview it in 3D';
    }
    $('pl-name').textContent = item?.name || 'Select a Pose';
    $('pl-description').textContent = item ? `${item.originalName} · ${item.warnings?.join(' · ') || 'Editable rig pose'}` : 'Click a card to preview. Click Apply to update the character.';
    $('pl-provenance').textContent = item ? JSON.stringify({source:item.source,rigProfile:item.rigProfile,poseHash:item.poseHash},null,2) : '';
    $('pl-favorite').textContent = item?.favorite ? 'Remove from Favorites' : 'Add to Favorites';
    for (const id of ['pl-favorite','pl-rename','pl-delete','pl-batch','pl-export-one']) $(id).disabled = writing || !item;
    $('pl-batch').textContent = item && batchIds.has(item.id) ? 'Remove from Pose Batch' : 'Add to Pose Batch';
    targets();
  }
  async function showPreview() {
    const item = clone(entry()); if (!item) return;
    if(item.kind==='reference-set'){previewToken++;gallery.preview(item);return;}
    const token = ++previewToken; $('pl-preview').hidden = true;
    $('pl-preview-hint').hidden = false; $('pl-preview-hint').textContent = 'Loading mannequin preview…';
    previewWork = previewWork.catch(()=>{}).then(async () => {
      if (disposed || token !== previewToken || !dialog.open) return;
      const doc=defaultScene(), target=activeActor(context.doc());
      doc.source={kind:'human'};doc.width=doc.height=384;doc.interaction.quality='economy';
      doc.actors=(item.kind==='composition' ? item.slots : [{pose:item.pose}]).map((slot,i)=>createActor(i,{id:`library-preview-${i}`,mesh:clone(target?.mesh || doc.mesh),pose:clone(slot.pose),transform:{x:0,y:0,z:0,yaw:0,scale:1,...slot.transform}}));doc.activeActorId='library-preview-0';doc.selectedActorIds=doc.actors.map(role=>role.id);bindActor(doc);
      doc.camera={...doc.camera,azimuth:25,elevation:5,zoom:1};
      if (!preview) { preview=new StudioScene($('pl-preview'),{begin:()=>{},change:()=>{},camera:()=>{},select:()=>{},error:error=>message(error.message)});await preview.init(doc); }
      else await preview.restore(doc);
      if(item.kind==='composition')await finishCatalogPose(preview,{actorIds:doc.actors.map(role=>role.id),align:(item.align||[]).map(pair=>({actors:pair.slots.map(i=>doc.actors[i].id),hands:pair.hands}))});
      if (disposed || token !== previewToken || !dialog.open) return;
      preview.fit(true);$('pl-preview').hidden=false;$('pl-preview-hint').hidden=true;
    });
    await previewWork;
  }
  async function apply(item = entry()) {
    if (!item) return;
    const options={scope:$('pl-scope').value,part:item.kind==='composition'?'full':$('pl-part').value,preserveHands:item.kind!=='composition'&&$('pl-preserve-hands').checked,releaseContacts:$('pl-release').checked,ground:$('pl-ground').checked};
    await context.run(async()=>{
      try {
        const result=await applyCatalogTransaction(context,item,options);dialog.close();context.toast(`Applied “${item.name}” to ${result.actorIds.length} characters. You can undo or refine the pose.`);
      } catch(error) { message(error.message); throw error; }
    });
  }
  async function inspect(form) {
    const token=++importToken;
    message('Checking pose files…');
    const response = await fetch(API+'/inspect',{method:'POST',body:form}); const result=await readResult(response);
    if(disposed || token!==importToken || !dialog.open)return false;
    pending=result;renderImport();message('Review complete. Select the poses to save.');
    return true;
  }
  function renderImport() {
    $('pl-import').hidden=false;$('pl-import-summary').textContent=`${pending.entries.length} ready to import · ${pending.errors.length} invalid`;
    $('pl-import-rows').replaceChildren();
    for(const [i,item]of pending.entries.entries()){
      const label=document.createElement('label'),check=document.createElement('input');check.type='checkbox';check.checked=true;check.value=i;
      label.append(check,document.createTextNode(`${item.name} · ${item.warnings?.join(' · ') || 'Valid rig format'}`));$('pl-import-rows').append(label);
    }
    for(const row of pending.errors){const line=document.createElement('p');line.textContent=`${row.path}：${row.error}`;$('pl-import-rows').append(line);}
  }
  async function readSource(source) {
    const token=++importToken;
    const node=$('pl-source-status');node.textContent=`Loading ${source.name}…`;
    const start=await api(`/sources/${source.id}/refresh`,{latest:$('pl-latest').checked});
    while(!disposed && token===importToken && dialog.open){
      const job=await api(`/jobs/${start.id}`);
      if(disposed || token!==importToken || !dialog.open)return;
      node.textContent=`${source.name} · ${job.index} / ${job.total || '…'} · ${job.path || ''}`;
      if(job.state==='failed')throw new Error(job.error);
      if(job.state==='ready'){pending=job.result;renderImport();node.textContent=`${source.name} · ${pending.entries.length} valid poses · ${pending.errors.length} invalid`;return;}
      await new Promise(resolve=>setTimeout(resolve,1000));
    }
  }
  async function exportPack(ids) {
    const response=await fetch(API+'/export',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ids})});
    if(!response.ok)await readResult(response);
    context.download(await response.blob(),'anyangle-poses.zip');
  }
  function portablePose(id=context.doc().activeActorId) {
    const studio=context.studio(),viewer=studio.viewer,passive=viewer.passiveCharacters.get(id);
    const pose=clone(passive ? context.doc().actors.find(role=>role.id===id).pose : studio.pose());
    pose.positionDeltas={};
    for(const bone of passive?.boneList || viewer.boneList){
      const rest=passive?.initialPositions.get(bone.name) || viewer.shapedBoneRestPositions?.[bone.name] || viewer.initialBoneStates?.[bone.name]?.position;
      if(rest && bone.position.distanceToSquared(rest)>1e-10)pose.positionDeltas[bone.name]=[bone.position.x-rest.x,bone.position.y-rest.y,bone.position.z-rest.z];
    }
    delete pose.bonePositions;delete pose.hipBonePosition;delete pose.ikEffectorPositions;delete pose.poleTargetPositions;
    return pose;
  }
  async function saveCurrent() {
    if(context.doc().source.kind!=='human')throw new Error('Select a posable mannequin first.');
    const name=await context.askName('Save to Shared Pose Library','My Pose');if(!name)return;
    const pose=portablePose();
    accept(await api('/import',{revision:catalog.revision,entries:[{name,originalName:name,pose,source:{id:'local',name:'User-Saved Pose',license:'User-provided'}}]}));
    selected=catalog.items.find(item=>item.name===name && !item.builtin)?.id;await reload();$('pl-source').value='local';$('pl-search').value=name;render();context.toast('Pose saved to the local shared ComfyUI library.');
  }
  async function saveComposition(){
    context.studio().syncPose();const roles=editableActors(context.doc(),$('pl-scope').value);
    if(roles.length<2)throw new Error('Select at least two editable characters under Apply To.');
    const name=await context.askName('Save Group Arrangement','My Group Arrangement');if(!name)return;
    const origin=roles[0].transform, ids=roles.map(role=>role.id);
    const slots=roles.map(role=>({label:role.label,pose:portablePose(role.id),transform:Object.fromEntries(['x','y','z','yaw'].map(key=>[key,role.transform[key]-origin[key]]))}));
    const align=(context.doc().contacts||[]).filter(pair=>pair.actors?.every(id=>ids.includes(id))).map(pair=>({slots:pair.actors.map(id=>ids.indexOf(id)),hands:pair.sides}));
    accept(await api('/import',{revision:catalog.revision,entries:[{kind:'composition',name,originalName:name,slots,align,pose:slots[0].pose,source:{id:'local',name:'User-Saved Arrangement',license:'User-provided'}}]}));
    await reload();render();message('Group arrangement saved. Assign the matching characters when applying it.');
  }
  $('pl-close').onclick=()=>dialog.close();
  dialog.addEventListener('close',()=>{previewToken++;importToken++;pending=null;$('pl-import').hidden=true;});
  for(const id of ['pl-search','pl-category','pl-tab','pl-source'])$(id).oninput=()=>{if(!composing){page=0;render();}};
  $('pl-prev').onclick=()=>{page--;render();};$('pl-next').onclick=()=>{page++;render();};
  $('pl-files').onclick=()=>files.click();$('pl-directory').onclick=()=>directory.click();
  for(const input of [files,directory])input.onchange=()=>execute(async()=>{
    const form=new FormData();for(const file of input.files)if(/\.(json|zip|webp|png|jpe?g)$/i.test(file.name))form.append('files',file,file.webkitRelativePath || file.name);input.value='';await inspect(form);
  });
  $('pl-import-all').onclick=()=>$('pl-import-rows').querySelectorAll('input').forEach(input=>input.checked=true);
  $('pl-import-none').onclick=()=>$('pl-import-rows').querySelectorAll('input').forEach(input=>input.checked=false);
  $('pl-import-cancel').onclick=()=>{importToken++;pending=null;$('pl-import').hidden=true;};
  $('pl-import-commit').onclick=()=>mutate(async()=>{
    if(!pending)throw new Error('Review the poses before importing.');
    const inspected=pending,token=++importToken;
    const entries=[...$('pl-import-rows').querySelectorAll('input:checked')].map(input=>inspected.entries[Number(input.value)]);
    if(!entries.length)throw new Error('Select at least one valid pose.');
    accept(await api('/import',{revision:catalog.revision,entries}));
    let warning='';
    if(inspected.migration)try{localStorage.setItem('anyangle-studio.poses.migrated.v1','yes');}catch{warning=' The browser could not save migration status. The original data is still available.';}
    if(token===importToken){pending=null;$('pl-import').hidden=true;}await reload();render();message(`Saved ${entries.length} items. You can now preview and apply them.${warning}`);
  });
  $('pl-reload').onclick=()=>execute(async()=>{await reload();render();message('Local Pose Library refreshed.');});
  $('pl-save').onclick=()=>mutate(saveCurrent);$('pl-save-composition').onclick=()=>mutate(saveComposition);$('pl-export').onclick=()=>execute(()=>exportPack());$('pl-export-one').onclick=()=>execute(()=>exportPack([selected]));
  $('pl-show-hidden').onclick=()=>mutate(async()=>{for(const item of catalog.items.filter(item=>item.builtin&&item.hidden))accept(await api(`/items/${item.id}`,{revision:catalog.revision,changes:{hidden:false}},'PATCH'));await reload();render();});
  $('pl-apply').onclick=()=>mutate(()=>apply());$('pl-scope').onchange=targets;$('pl-release').onchange=targets;
  $('pl-fit').onclick=()=>execute(async()=>{dialog.close();await context.run(async()=>{context.begin();context.studio().fit(true);context.changed();});});
  $('pl-favorite').onclick=()=>mutate(async()=>{const item=entry();accept(await api(`/items/${item.id}`,{revision:catalog.revision,changes:{favorite:!item.favorite}},'PATCH'));render();});
  $('pl-rename').onclick=()=>mutate(async()=>{const item=entry(),name=await context.askName('Rename Pose',item.name);if(!name)return;accept(await api(`/items/${item.id}`,{revision:catalog.revision,changes:{name}},'PATCH'));render();});
  $('pl-delete').onclick=()=>mutate(async()=>{
    const item=clone(entry());if(item.builtin)accept(await api(`/items/${item.id}`,{revision:catalog.revision,changes:{hidden:true}},'PATCH'));else accept(await api('/delete',{revision:catalog.revision,ids:[item.id]}));
    batchIds.delete(item.id);selected=null;render();message('Item removed. Saved scenes keep their existing poses.');
    const undo=control('Restore Removed Pose',()=>mutate(async()=>{if(item.builtin)accept(await api(`/items/${item.id}`,{revision:catalog.revision,changes:{hidden:false}},'PATCH'));else accept(await api('/import',{revision:catalog.revision,entries:[item]}));render();undo.remove();}));$('pl-status').append(' ',undo);
  });
  $('pl-batch').onclick=()=>{if(batchIds.has(selected))batchIds.delete(selected);else batchIds.add(selected);render();context.batchChanged?.();};
  $('save-pose').onclick=()=>mutate(async()=>{await reload();await saveCurrent();});
  $('import-pose').onclick=()=>execute(async()=>{await reload();render();dialog.showModal();files.click();});
  return {
    open:()=>open.click(), refresh:()=>{if(dialog.open){render();}},
    batchEntries:()=>catalog.items.filter(item=>batchIds.has(item.id)).map(clone),
    batchOptions:()=>({scope:$('pl-scope').value,part:$('pl-part').value,preserveHands:$('pl-preserve-hands').checked,releaseContacts:$('pl-release').checked,ground:$('pl-ground').checked}),
    destroy:async()=>{disposed=true;previewToken++;importToken++;gallery.destroy();await previewWork.catch(()=>{});preview?.dispose();dialog.remove();files.remove();directory.remove();},
  };
}
