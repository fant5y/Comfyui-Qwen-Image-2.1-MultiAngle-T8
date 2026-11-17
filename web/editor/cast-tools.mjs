import { editableActors, bindActor } from './actors.mjs?v=20261116en';
import { PRESETS } from './scene.mjs?v=20261116canvasprompt';
import { uuid } from '../uuid.mjs?v=20261116en';
import { detachTargets } from './reference-library.mjs?v=20261116canvasprompt';

const $ = id => document.getElementById(id);
export function installCastTools(context) {
  const panel = document.createElement('section'); panel.className = 'inspector-group pose-subsection'; panel.id = 'cast-interactions';
  panel.innerHTML = `<h3>Character Interactions</h3><label>Layout<select id="cast-layout"><option value="group">Group Photo · Face Camera</option><option value="dialogue">Conversation · Face Each Other</option><option value="handshake">Handshake · Align Hands</option></select></label><button id="apply-layout" class="wide-button">Apply to Selected Characters</button><p class="hint">Locked characters keep their poses. Handshake aligns hands once with IK. You can edit the pose afterward.</p><button id="align-contact" class="wide-button">Realign Hands</button><button id="release-contact" class="wide-button">Clear Contact Anchors</button>`;
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
  context.importModel = () => file.click();
  context.duplicateModel = () => mutate(async () => {
    const studio = context.studio(), model = studio.selectedModel();
    if (!model) return;
    const duplicate = structuredClone(model);
    duplicate.id = "prop-" + uuid(); duplicate.label += " Copy";
    duplicate.transform.x += 2;
    context.doc().props.push(duplicate);
    await studio.restoreProps(); context.selectModel(duplicate.id);
  });
  context.deleteModel = () => mutate(async () => {
    const studio = context.studio(), model = studio.selectedModel();
    if (!model) return;
    detachTargets(context.doc(), "props", model.id);
    context.doc().props = context.doc().props.filter(item => item.id !== model.id);
    await studio.restoreProps(); studio.setMode(studio.mode);
  });
  file.onchange = ()=>{const chosen=file.files[0];file.value='';if(!chosen)return;
    mutate(async()=>{const asset=await context.upload(chosen);const prop={id:`prop-${uuid()}`,label:chosen.name,asset,transform:{x:0,y:0,z:-5,scale:1,yaw:0},visible:true,locked:false};context.doc().props||=[];context.doc().props.push(prop);const studio=context.studio();await studio.restoreProps();context.selectModel(prop.id);if(context.doc().source.kind==='empty'&&context.doc().props.length===1)studio.fit(true);});
  };
}
