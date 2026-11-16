import { indexGallery, searchGallery, relatedSuggestions } from './gallery-search.mjs?v=20261116en';
import { addGalleryReference } from './gallery-pose.mjs?v=20261116en';
import { uuid } from '../uuid.mjs?v=20261116en';

const API='/anyangle-studio/pose-gallery', $=id=>document.getElementById(id);
const clone=value=>structuredClone(value);
export const galleryImage=name=>`${API}/blobs/${encodeURIComponent(name)}`;
async function api(path='',data,method='POST'){
  const response=await fetch(API+path,data===undefined?{}:{method,headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
  const result=await response.json().catch(()=>null);
  if(!response.ok||!result)throw new Error(result?.error||`Image Pose Gallery request failed (HTTP ${response.status})`);
  return result;
}
function button(text,action){const node=document.createElement('button');node.type='button';node.textContent=text;node.onclick=action;return node;}
const filterControls={type:'pg-type',people:'pg-people',frame:'pg-frame',angle:'pg-angle',sort:'pg-sort',collection:'pg-collection',offline:'pg-offline',query:'pl-search',category:'pl-category',tab:'pl-tab',source:'pl-source'};

export function installPoseGallery(context,hooks){
  let data={revision:0,items:[],presets:[],collections:[]}, index=[], selected=null, viewId=null, token=0, busy=false, disposed=false, remembering=false, importAbort=null, activeJob=null;
  const selection=new Map();let resumeJob=null;
  const filters=document.createElement('div');filters.className='pg-filters';
  filters.innerHTML=`<select id="pg-type" aria-label="Pose Type"><option value="">All Types</option><option value="pose">Editable Poses</option><option value="composition">Group Arrangements</option><option value="reference-set">Image Pose References</option></select>
    <select id="pg-people" aria-label="Group Size"><option value="">Any Group Size</option><option value="1">One Person</option><option value="2">Two People</option></select>
    <select id="pg-frame" aria-label="Framing"><option value="">Full and Upper Body</option><option value="full">Full Body</option><option value="upper">Upper Body</option></select>
    <select id="pg-angle" aria-label="Gallery View"><option value="">All Views</option><option value="front">Front</option><option value="side">Side</option><option value="diag">Three-Quarter</option><option value="high">High Angle</option><option value="low">Low Angle</option></select>
    <select id="pg-sort" aria-label="Sort"><option value="">Relevance / Name</option><option value="recent">Recently Applied</option><option value="favorite">Favorites First</option></select>
    <select id="pg-collection" aria-label="Image Collections"><option value="">All Collections</option></select><select id="pg-offline" aria-label="Offline Assets"><option value="">All Assets</option><option value="ready">Full Image Available</option></select>`;
  hooks.dialog.querySelector('.pl-toolbar').after(filters);
  const chips=document.createElement('div');chips.className='pg-active-filters';filters.after(chips);
  $('pl-tab').append(new Option('Recently Applied Images','recent'),new Option('Hidden Images','hidden'));
  $('pl-search').placeholder='Search by pose name, ID, or tag';
  const management=document.createElement('details');management.className='pl-sources pg-management';
  management.innerHTML=`<summary>Image Pose Gallery · Imports, Search Presets, and Collections</summary><p class="hint">Import a gallery folder or ZIP. Images are grouped by pose. Use a view as a reference or extract its skeleton to pose a mannequin.</p>
    <div class="compact-actions"><button id="pg-import-zip">Import Gallery ZIP</button><button id="pg-import-dir">Import Gallery Folder</button><button id="pg-export">Export Entire Image Gallery</button><button id="pg-jobs">Import Jobs / Resume</button><button id="pg-cache-clear">Clear Exports and Unused Cache</button></div><div id="pg-job-list"></div>
    <div class="pg-settings-row"><select id="pg-presets" aria-label="Saved Searches"><option value="">Choose Search Preset</option></select><button id="pg-preset-save">Save Current Search</button><button id="pg-preset-update">Update</button><button id="pg-preset-rename">Rename</button><button id="pg-preset-delete">Delete</button></div>
    <div class="pg-settings-row"><button id="pg-collection-new">New Collection</button><button id="pg-collection-rename">Rename Current Collection</button><button id="pg-collection-delete">Delete Current Collection</button><button id="pg-settings-export">Export Presets and Collections</button><button id="pg-settings-import">Import Presets and Collections</button></div>
    <p id="pg-status" class="hint" role="status"></p>`;
  hooks.dialog.querySelector('.pl-management').after(management);
  const detail=document.createElement('aside');detail.className='pl-detail pg-detail';detail.hidden=true;
  detail.innerHTML=`<div class="pg-image-stage"><img id="pg-image" alt="Pose reference for the current view"><span id="pg-image-state"></span></div><h3 id="pg-name"></h3><p id="pg-info" class="hint"></p><div id="pg-views" class="pg-views"></div>
    <p id="pg-matches" class="hint"></p><label>Apply Pose Reference To<select id="pg-target"><option value="scene">Entire Scene</option></select></label>
    <button id="pg-reference" class="primary">Use as Pose Reference</button><button id="pg-extract" class="wide-button">Extract Pose / Copy to Mannequin</button><p class="hint">This is a 2D reference. To copy it to a mannequin, detect and preview the pose, then choose a target. Undetected limbs keep their pose.</p>
    <div class="pl-entry-actions"><button id="pg-favorite">Favorite</button><button id="pg-rename">Rename</button><button id="pg-tags">Pose Tags</button><button id="pg-hide">Hide</button><button id="pg-collection-add">Add to Current Collection</button><button id="pg-export-one">Export This Pose Set</button></div>
    <details><summary>Batch Gallery Views</summary><p class="hint">Select one or more views. Each image creates one job. Use Pose Batch to combine mannequin poses with camera views.</p><div id="pg-batch-views"></div><button id="pg-batch-add">Add Views to Batch</button><p id="pg-batch-count"></p><button id="pg-batch-run">Run Selected Views</button><button id="pg-batch-clear">Clear Batch Selection</button></details>
    <details><summary>Source and Image Details</summary><pre id="pg-provenance"></pre></details>`;
  hooks.dialog.querySelector('.pl-content').append(detail);
  const zip=document.createElement('input'),directory=document.createElement('input'),settingsFile=document.createElement('input');
  for(const input of [zip,directory,settingsFile]){input.type='file';input.hidden=true;document.body.append(input);}
  zip.accept='.zip';directory.webkitdirectory=true;directory.multiple=true;settingsFile.accept='.json';
  const message=text=>{if(!disposed)$('pg-status').textContent=text;};
  const execute=fn=>Promise.resolve().then(fn).catch(error=>{if(!disposed){message(error.message);context.toast(error.message);}});
  const mutate=fn=>{if(busy)return;busy=true;controls();return execute(fn).finally(()=>{busy=false;if(!disposed){controls();hooks.refresh();}});};
  function accept(next){if(next.revision>=data.revision){data=next;index=indexGallery(data.items);settings();}}
  function options(){const result=Object.fromEntries(Object.entries(filterControls).map(([key,id])=>[key,$(id).value]));const folder=data.collections.find(row=>row.id===result.collection);if(folder)result.collectionIds=folder.ids;return result;}
  function restoreOptions(value){for(const [key,id]of Object.entries(filterControls))if(value[key]!==undefined)$(id).value=value[key];hooks.filterChanged();}
  function settings(){
    for(const [id,rows,label]of [['pg-presets',data.presets,'Choose Search Preset'],['pg-collection',data.collections,'All Collections']]){
      const value=$(id).value;$(id).replaceChildren(new Option(label,''),...rows.map(row=>new Option(row.name,row.id)));$(id).value=value;
    }
  }
  async function reload(){accept(await api());}
  async function remember(){if(remembering||disposed)return;remembering=true;try{const current=options();delete current.collectionIds;accept(await api('/preferences',{revision:data.revision,changes:{lastFilters:current}}));}catch(error){message(`Could not save filters: ${error.message}`);}finally{remembering=false;}}
  function controls(){
    // Keep selection and targets fixed while an asset, edit or batch is being prepared.
    for(const node of [detail,management,filters,chips,...hooks.dialog.querySelectorAll('.pl-list,.pl-toolbar,.pl-management,.pl-sources')])node.inert=busy;
    detail.setAttribute('aria-busy',String(busy));
  }
  function item(){return data.items.find(row=>row.id===selected);}
  function view(){return item()?.views.find(row=>row.id===viewId);}
  function render(entry){
    chips.replaceChildren();for(const [key,id] of Object.entries(filterControls)){const control=$(id);if(!control.value||key==='tab'&&control.value==='all')continue;
      const label=control.tagName==='SELECT'?control.selectedOptions[0]?.textContent:control.value;
      chips.append(button(`${label} ×`,()=>{control.value=key==='tab'?'all':'';hooks.filterChanged();}));}
    const active=entry?.kind==='reference-set';detail.hidden=!active;
    if(!active){if(selected!==null){token++;selected=null;viewId=null;$('pg-image').removeAttribute('src');}return;}
    const changed=entry.id!==selected;
    if(changed){token++;selected=entry.id;viewId=entry.matchedViewIds?.[0]||entry.views[0].id;}
    if(!entry.views.some(row=>row.id===viewId))viewId=entry.views[0].id;
    const current=view();
    $('pg-name').textContent=entry.name;$('pg-info').textContent=`${entry.systemName} · ${entry.number} · ${entry.people} people · ${entry.views.length} available views${entry.sourceMissing?' · This pose is absent from the latest source index. Local copy retained.':''}`;
    $('pg-image').src=galleryImage((current.original.ready?current.original:current.thumbnail).name);
    $('pg-image-state').textContent=current.original.ready?'':'Thumbnail only. Full image pending.';
    $('pg-image').onerror=()=>{$('pg-image-state').textContent='Could not load the image. Resume the import or refresh.';};
    $('pg-matches').textContent=entry.matchReasons?.length?`Matches: ${entry.matchReasons.join(' · ')}`:'';
    $('pg-views').replaceChildren();
    for(const angle of ['front','side','diag','high','low']){
      const candidate=entry.views.find(row=>row.angle===angle),label={front:'Front',side:'Side',diag:'Three-Quarter',high:'High Angle',low:'Low Angle'}[angle];
      const node=button(candidate?label:`${label} · Unavailable`,()=>{token++;viewId=candidate.id;render(entry);});node.disabled=!candidate;node.classList.toggle('selected',candidate?.id===viewId);$('pg-views').append(node);
    }
    const target=$('pg-target').value;
    $('pg-target').replaceChildren(new Option('Entire Scene','scene'),new Option('Selected Characters','selected'),...(context.doc().actors||[]).filter(role=>role.visible!==false).map(role=>new Option(role.label,role.id)));
    $('pg-target').value=[...$('pg-target').options].some(option=>option.value===target)?target:'scene';
    $('pg-favorite').textContent=entry.favorite?'Remove from Favorites':'Add to Favorites';$('pg-hide').textContent=entry.hidden?'Unhide':'Hide Pose';
    $('pg-provenance').textContent=JSON.stringify({source:entry.source,view:current,tags:entry.tags},null,2);
    if(changed){$('pg-batch-views').replaceChildren();for(const candidate of entry.views){const label=document.createElement('label'),check=document.createElement('input');check.type='checkbox';check.value=candidate.id;check.checked=selection.has(candidate.id);label.append(check,document.createTextNode(candidate.label));$('pg-batch-views').append(label);}}
    $('pg-batch-count').textContent=`${selection.size} views selected`;
    $('pg-reference').disabled=busy||entry.hidden||!current.original.ready;$('pg-extract').disabled=busy||entry.hidden||!current.original.ready;
  }
  function target(){const value=$('pg-target').value,doc=context.doc();if(value==='scene')return{kind:'scene',ids:[],text:''};const ids=value==='selected'?(doc.selectedActorIds||[]):[value];const visible=ids.filter(id=>doc.actors?.some(role=>role.id===id&&role.visible!==false));if(!visible.length)throw new Error('Select a visible character first.');return{kind:'actors',ids:visible,text:''};}
  async function getAsset(id=selected,view=viewId){return api('/asset',{id,view});}
  async function markUsed(id){try{accept(await api(`/items/${id}`,{revision:data.revision,changes:{used:true}},'PATCH'));}catch(error){message(`Pose applied. Could not update recent history: ${error.message}`);}}
  async function addCurrent(){
    const stamp=token,id=selected,mapping=target(), result=await getAsset();
    if(stamp!==token||!hooks.dialog.open)return;
    await context.run(async()=>{context.begin();addGalleryReference(context.doc(),result.asset,result.source,mapping);
      context.changed();hooks.dialog.close();context.toast('Pose reference added. Edit its role and target in References.');});
    await markUsed(id);
  }
  async function extract(){const stamp=token,id=selected,result=await getAsset();if(stamp!==token||!hooks.dialog.open)return;
    if(!context.galleryExtract)throw new Error('Pose extraction is unavailable. Refresh the page.');
    const applied=await context.galleryExtract(result.asset,result.source,item().people);if(applied){hooks.dialog.close();await markUsed(id);}
  }
  async function exportPack(ids){message('Preparing image pack…');const result=await api('/export',{ids});
    context.download(result.url,'anyangle-image-poses.zip');message('Image pack ready. It includes source details, collections, and search presets.');}
  async function patch(changes){accept(await api(`/items/${selected}`,{revision:data.revision,changes},'PATCH'));hooks.refresh();render(item());}
  async function saveSettings(changes){accept(await api('/preferences',{revision:data.revision,changes}));hooks.refresh();}
  async function poll(ident){
    activeJob=ident;
    while(!disposed&&activeJob===ident){const state=await api('/jobs/'+ident);message(`Gallery import · ${state.completed}/${state.total||'…'} · ${state.view||state.state}`);
      if(state.state==='ready'){await reload();hooks.catalogChanged();message(`Imported ${state.result.groups} poses and ${state.result.views} views`);break;}
      if(['failed','cancelled','paused'].includes(state.state)){message(state.error||'Import stopped. Verified files are kept for resuming.');break;}
      await new Promise(resolve=>setTimeout(resolve,600));}
    await showJobs();
  }
  async function showJobs(){const rows=await api('/jobs');$('pg-job-list').replaceChildren();
    for(const row of rows){const div=document.createElement('div');div.className='pg-job';const info=document.createElement('span');info.textContent=`${row.name} · ${row.state} · ${row.completed}/${row.total||'…'}`;div.append(info);
      if(row.state==='running')div.append(button('Cancel',()=>execute(()=>api(`/jobs/${row.id}/cancel`,{}))));
      else {
        if(row.state!=='ready'){
          div.append(button('Reselect Files to Resume Upload',()=>{resumeJob=row;(row.kind==='zip'?zip:directory).click();}));
          div.append(button('Check Uploaded Files / Retry Import',()=>execute(async()=>{await api(`/jobs/${row.id}/start`,{});await poll(row.id);})));}
        div.append(button('Remove Temporary Upload Files',()=>execute(async()=>{await api(`/jobs/${row.id}/remove`,{});await showJobs();message('Temporary upload files cleared. Imported poses and scene assets are kept.');})));}
      $('pg-job-list').append(div);}
  }
  async function importFiles(list,kind){
    if(importAbort)throw new Error('Another gallery is uploading.');
    const files=[...list];if(!files.length)return;
    const previous=resumeJob;resumeJob=null;
    const sourceName=kind==='zip'?files[0].name:files[0].webkitRelativePath.split('/')[0];
    if(previous&&(previous.kind!==kind||previous.name!==sourceName))throw new Error('Reselect the original folder or ZIP to resume. Start a new import for a different gallery.');
    const job=previous?await api(`/jobs/${previous.id}/resume`,{}):await api('/jobs',{kind,name:kind==='zip'?files[0].name:files[0].webkitRelativePath.split('/')[0]});importAbort=new AbortController();activeJob=job.id;
    const cancel=button('Cancel Upload',()=>importAbort?.abort());$('pg-job-list').replaceChildren(cancel);
    try{let count=0;for(const file of files){message(`Uploading gallery ${++count}/${files.length} · ${file.name}`);const response=await fetch(`${API}/jobs/${job.id}/file?path=${encodeURIComponent(file.webkitRelativePath||file.name)}`,{method:'PUT',body:file,signal:importAbort.signal});
        if(!response.ok){const result=await response.json();throw new Error(result.error||'Upload failed');}}
      await api(`/jobs/${job.id}/start`,{});importAbort=null;await showJobs();await poll(job.id);
    }catch(error){if(error.name==='AbortError'){await api(`/jobs/${job.id}/cancel`,{});message('Upload canceled');}else throw error;}
    finally{importAbort=null;await showJobs();}
  }
  async function presetChange(mode){const id=$('pg-presets').value,rows=clone(data.presets),row=rows.find(row=>row.id===id);
    if(mode!=='save'&&!row)throw new Error('Select a search preset first.');
    if(mode==='delete'){await saveSettings({presets:rows.filter(value=>value.id!==id)});return;}
    const name=mode==='update'?row.name:await context.askName(mode==='save'?'Save Search Preset':'Rename Search Preset',row?.name||$('pl-search').value||'Favorite Search');if(!name)return;
    const value=options();delete value.collectionIds;
    if(mode==='save')rows.push({id:uuid(),name,filters:value});else Object.assign(row,{name},mode==='update'?{filters:value}:{});
    await saveSettings({presets:rows});
  }
  async function collectionChange(mode){const id=$('pg-collection').value,rows=clone(data.collections),row=rows.find(row=>row.id===id);
    if(mode!=='new'&&!row)throw new Error('Select a collection first.');
    if(mode==='delete'){await saveSettings({collections:rows.filter(value=>value.id!==id)});return;}
    if(mode==='add'){if(!selected)throw new Error('Select a pose first.');row.ids=row.ids.includes(selected)?row.ids.filter(value=>value!==selected):[...row.ids,selected];await saveSettings({collections:rows});return;}
    const name=await context.askName(mode==='new'?'New Collection':'Rename Collection',row?.name||'Favorite Poses');if(!name)return;
    if(mode==='new')rows.push({id:uuid(),name,ids:[]});else row.name=name;await saveSettings({collections:rows});
  }
  for(const id of Object.values(filterControls))$(id).addEventListener('change',()=>{hooks.filterChanged();});
  $('pl-search').addEventListener('compositionstart',()=>hooks.composing(true));$('pl-search').addEventListener('compositionend',()=>{hooks.composing(false);hooks.filterChanged();});
  hooks.dialog.addEventListener('keydown',event=>{if(event.key==='/'&&!event.isComposing&&!/INPUT|TEXTAREA|SELECT/.test(event.target.tagName)){event.preventDefault();$('pl-search').focus();}});
  hooks.dialog.addEventListener('close',()=>{token++;remember();});
  $('pg-reference').onclick=()=>mutate(addCurrent);$('pg-extract').onclick=()=>mutate(extract);
  $('pg-favorite').onclick=()=>mutate(()=>patch({favorite:!item().favorite}));
  $('pg-hide').onclick=()=>mutate(()=>patch({hidden:!item().hidden}));
  $('pg-rename').onclick=()=>mutate(async()=>{const name=await context.askName('Rename Pose',item().name);if(name)await patch({name});});
  $('pg-tags').onclick=()=>mutate(async()=>{const tags=await context.askName('Pose Tags (Comma-Separated)',(item().tags||[]).join('，'));if(tags!==null)await patch({tags:tags.split(/[,，]/).map(x=>x.trim()).filter(Boolean)});});
  $('pg-export-one').onclick=()=>mutate(()=>exportPack([selected]));$('pg-export').onclick=()=>mutate(()=>exportPack());
  $('pg-import-zip').onclick=()=>{resumeJob=null;zip.click();};$('pg-import-dir').onclick=()=>{resumeJob=null;directory.click();};
  zip.onchange=()=>{const files=[...zip.files];zip.value='';execute(()=>importFiles(files,'zip'));};directory.onchange=()=>{const files=[...directory.files];directory.value='';execute(()=>importFiles(files,'directory'));};
  $('pg-jobs').onclick=()=>execute(showJobs);
  $('pg-cache-clear').onclick=()=>mutate(async()=>{const result=await api('/cache/clear',{});message(`Cleared ${(result.removedBytes/1024/1024).toFixed(1)} MiB of exports and unused cache. Gallery and applied assets are kept.`);});
  $('pg-presets').onchange=()=>{const row=data.presets.find(row=>row.id===$('pg-presets').value);if(row)restoreOptions(row.filters);};
  for(const mode of ['save','update','rename','delete'])$('pg-preset-'+mode).onclick=()=>mutate(()=>presetChange(mode));
  for(const mode of ['new','rename','delete','add'])$('pg-collection-'+mode).onclick=()=>mutate(()=>collectionChange(mode));
  $('pg-settings-export').onclick=()=>context.download(new Blob([JSON.stringify({kind:'anyangle-gallery-settings',version:1,presets:data.presets,collections:data.collections},null,2)],{type:'application/json'}),'anyangle-gallery-settings.json');
  $('pg-settings-import').onclick=()=>settingsFile.click();settingsFile.onchange=()=>mutate(async()=>{const file=settingsFile.files[0];settingsFile.value='';if(!file)return;if(file.size>1024*1024)throw new Error('Settings file exceeds 1 MiB');const value=JSON.parse(await file.text());if(value.kind!=='anyangle-gallery-settings'||value.version!==1)throw new Error('Choose a gallery settings JSON file.');
    const changes={};for(const key of ['presets','collections']){if(!Array.isArray(value[key]))throw new Error('Invalid gallery settings format');const rows=new Map(data[key].map(row=>[row.id,row]));for(const row of value[key])rows.set(row.id,row);changes[key]=[...rows.values()];}await saveSettings(changes);});
  $('pg-batch-add').onclick=()=>{for(const node of $('pg-batch-views').querySelectorAll('input')){if(node.checked)selection.set(node.value,{id:selected,view:node.value});else selection.delete(node.value);}render(item());};
  $('pg-batch-clear').onclick=()=>{selection.clear();$('pg-batch-views').querySelectorAll('input').forEach(node=>node.checked=false);render(item());};
  $('pg-batch-run').onclick=()=>mutate(async()=>{if(!selection.size)throw new Error('Select views and add them to the batch first.');if(!context.galleryBatch)throw new Error('Gallery batching is unavailable. Refresh the page.');
    const stamp=token,mapping=target(),rows=clone([...selection.values()]),plan=[];
    for(const row of rows){const asset=await getAsset(row.id,row.view);if(stamp!==token||!hooks.dialog.open)return;plan.push({...row,...asset});}
    await context.galleryBatch(plan,mapping);
  });
  return {reload,items:()=>data.items,matches:()=>searchGallery(index,options()),options,render,
    restoreFilters:()=>restoreOptions(data.lastFilters||{}),suggestions:()=>relatedSuggestions(index,options()),
    preview:item=>{render(item);},destroy:()=>{disposed=true;activeJob=null;token++;importAbort?.abort();for(const input of [zip,directory,settingsFile])input.remove();}};
}
