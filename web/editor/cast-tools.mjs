import { editableActors, bindActor } from './actors.mjs?v=20261116en';
import { PRESETS } from './scene.mjs?v=20261116en';
import { uuid } from '../uuid.mjs?v=20261116en';
import { detachTargets } from './reference-library.mjs?v=20261116en';

const $ = id => document.getElementById(id);
export function installCastTools(context) {
  const panel = document.createElement('details'); panel.className = 'panel-block';
  panel.innerHTML = `<summary>Character Interactions and Props <span class="tag">SCENE</span></summary><label>Layout<select id="cast-layout"><option value="group">Group Photo · Face Camera</option><option value="dialogue">Conversation · Face Each Other</option><option value="handshake">Handshake · Align Hands</option></select></label><button id="apply-layout" class="wide-button">Apply to Selected Characters</button><p class="hint">Locked characters keep their poses. Handshake aligns hands once with IK. You can edit the pose afterward.</p><button id="align-contact" class="wide-button">Realign Hands</button><button id="release-contact" class="wide-button">Clear Contact Anchors</button><button id="add-prop" class="wide-button">＋ Import GLB Prop</button><div id="prop-list" class="prop-list"></div>`;
  $('hands-panel').before(panel);
  const file = document.createElement('input'); file.type = 'file'; file.accept = '.glb'; file.hidden = true; document.body.append(file);
  const mutate = action => context.run(async () => {
    const previous = structuredClone(context.doc()), rollbackHistory = context.begin();
    try { await action(); context.changed(); render(); }
    catch(error) {
      context.replace(previous); rollbackHistory?.();
      try { await context.studio().restore(previous); } catch { /* Keep the original cast edit error. */ }
      throw error;
    }
  });
  $('apply-layout').onclick = () => mutate(async () => {
    const doc=context.doc(), roles=editableActors(doc,'selected').filter(role => role.source.kind !== 'animal');
    if(!roles.length) throw new Error('Select an unlocked character first.');
    const layout=$('cast-layout').value;if(layout!=='group'&&roles.length!==2)throw new Error('Select two unlocked characters for a conversation or handshake.');
    context.studio().syncPose(); const active=doc.activeActorId;
    for(const[i,role]of roles.entries()){
      role.pose=structuredClone(PRESETS[0]); role.pose={bones:role.pose.bones};
      role.transform.x=(i-(roles.length-1)/2)*(layout==='group'?7:6);role.transform.z=0;role.transform.y=0;role.transform.yaw=layout==='group'?0:i===0?90:-90;
    }
    bindActor(doc,active);await context.studio().restore(doc);context.studio().useRigPose();context.studio().groundActors(roles.map(role=>role.id));
    if(layout==='handshake') await context.studio().alignHands(roles[0].id,'r',roles[1].id,'r');
    context.showScene();context.toast('Layout applied. You can adjust the camera, positions, and joints.');
  });
  $('align-contact').onclick = () => mutate(async()=>{const roles=editableActors(context.doc(),'selected').filter(role => role.source.kind !== 'animal');if(roles.length!==2)throw new Error('Select two unlocked characters.');await context.studio().alignHands(roles[0].id,'r',roles[1].id,'r');});
  $('release-contact').onclick = ()=>{context.begin();context.doc().contacts=[];context.changed(false);context.toast('Contact anchors cleared. The current pose is kept.');};
  $('add-prop').onclick = ()=>file.click();
  file.onchange = ()=>{const chosen=file.files[0];file.value='';if(!chosen)return;
    mutate(async()=>{if(context.doc().source.kind!=='human')throw new Error('Switch to a mannequin scene before importing props.');const asset=await context.upload(chosen);const prop={id:`prop-${uuid()}`,label:chosen.name,asset,transform:{x:0,y:0,z:-5,scale:1,yaw:0},visible:true,locked:false};context.doc().props||=[];context.doc().props.push(prop);await context.studio().restoreProps();});
  };
  function render(){
    $('prop-list').replaceChildren();
    for(const prop of context.doc().props||[]){
      const card=document.createElement('div');card.className='prop-card';const title=document.createElement('strong');title.textContent=prop.label;card.append(title);
      for(const[key,label]of [['x','X'],['y','Y'],['z','Z'],['scale','Scale'],['yaw','Facing °']]){const row=document.createElement('label'),input=document.createElement('input');input.type='number';input.step=key==='yaw'?'1':'.1';input.value=prop.transform[key];input.disabled=prop.locked;row.append(document.createTextNode(label),input);input.onchange=()=>{const n=Number(input.value);if(!Number.isFinite(n)||key==='scale'&&n<=0)return;context.begin();prop.transform[key]=n;context.studio().updateProp(prop);context.changed();};card.append(row);}
      const actions=document.createElement('div');actions.className='compact-actions';
      for(const[text,action]of [[prop.visible?'Hide':'Show',()=>{prop.visible=!prop.visible;context.studio().updateProp(prop);}],[prop.locked?'Unlock':'Lock',()=>{prop.locked=!prop.locked;}],['Delete',async()=>{detachTargets(context.doc(),'props',prop.id);context.doc().props=context.doc().props.filter(item=>item.id!==prop.id);await context.studio().restoreProps();}]]){const button=document.createElement('button');button.textContent=text;button.onclick=()=>mutate(action);actions.append(button);}
      card.append(actions);$('prop-list').append(card);
    }
  }
  let key, renderedDoc, renderedProps = [];
  return () => {
    const doc = context.doc(), props = doc.props || [], next = JSON.stringify(props);
    if (next !== key || doc !== renderedDoc || props.some((prop, i) => prop !== renderedProps[i])) {
      key = next; renderedDoc = doc; renderedProps = props.slice(); render();
    }
  };
}
