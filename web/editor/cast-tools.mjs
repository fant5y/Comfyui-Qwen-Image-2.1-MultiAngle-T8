import { editableActors, bindActor } from './actors.mjs?v=20261116en';
import { PRESETS } from './scene.mjs?v=20261116modelrotation';
import { uuid } from '../uuid.mjs?v=20261116en';
import { detachTargets } from './reference-library.mjs?v=20261116en';

const $ = id => document.getElementById(id);
export function installCastTools(context) {
  const panel = document.createElement('details'); panel.className = 'panel-block';
  panel.innerHTML = `<summary>Character Interactions <span class="tag">SCENE</span></summary><label>Layout<select id="cast-layout"><option value="group">Group Photo · Face Camera</option><option value="dialogue">Conversation · Face Each Other</option><option value="handshake">Handshake · Align Hands</option></select></label><button id="apply-layout" class="wide-button">Apply to Selected Characters</button><p class="hint">Locked characters keep their poses. Handshake aligns hands once with IK. You can edit the pose afterward.</p><button id="align-contact" class="wide-button">Realign Hands</button><button id="release-contact" class="wide-button">Clear Contact Anchors</button>`;
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
    mutate(async()=>{if(context.doc().source.kind!=='human')throw new Error('Switch to a mannequin scene before importing props.');const asset=await context.upload(chosen);const prop={id:`prop-${uuid()}`,label:chosen.name,asset,transform:{x:0,y:0,z:-5,scale:1,yaw:0},visible:true,locked:false};context.doc().props||=[];context.doc().props.push(prop);await context.studio().restoreProps();context.selectModel(prop.id);});
  };
  function render() {
    const list = $('prop-list');
    const studio = context.studio();
    list.replaceChildren();
    const actionButton = (label, action, tooltip = label) => {
      const button = document.createElement('button'); button.textContent = label; button.title = tooltip;
      button.setAttribute('aria-label', tooltip); button.onclick = action; return button;
    };
    for (const prop of context.doc().props || []) {
      const selected = studio?.selectedModelId === prop.id;
      const card = document.createElement('div'); card.className = 'actor-card';
      card.style.setProperty('--actor-color', '#8da8b6');
      card.classList.toggle('active', selected);
      const title = document.createElement('button'); title.className = 'actor-name'; title.textContent = prop.label;
      title.setAttribute('aria-pressed', String(selected)); title.onclick = () => context.selectModel(prop.id);
      const actions = document.createElement('div'); actions.className = 'actor-card-actions';
      const visible = prop.visible !== false;
      actions.append(actionButton(visible ? '◉' : '○', () => mutate(() => {
        prop.visible = !visible; studio.updateProp(prop); studio.setMode(studio.mode);
      }), visible ? 'Hide Model' : 'Show Model'));
      actions.append(actionButton(prop.locked ? 'Locked' : 'Lock', () => mutate(() => {
        prop.locked = !prop.locked; studio.setMode(studio.mode);
      }), prop.locked ? 'Unlock Model' : 'Lock Model'));
      card.append(title, actions); list.append(card);
    }
    const prop = studio?.selectedModel();
    if (!prop) return;
    const inspector = document.createElement('div'); inspector.className = 'model-inspector';
    const name = document.createElement('label'), nameInput = document.createElement('input');
    nameInput.value = prop.label; nameInput.maxLength = 255;
    nameInput.onchange = () => {
      const label = nameInput.value.trim();
      if (!label || label === prop.label) { nameInput.value = prop.label; return; }
      context.begin(); prop.label = label; context.changed(false);
    };
    name.append('Name', nameInput); inspector.append(name);
    const addFields = (className, fields) => {
      const group = document.createElement('div'); group.className = className;
      for (const [key, label, step] of fields) {
        const row = document.createElement('label'), input = document.createElement('input');
        input.type = 'number'; input.step = step; input.disabled = prop.locked;
        const displayValue = () => Number((prop.transform[key] ?? 0).toFixed(3));
        input.value = displayValue();
        input.onchange = () => {
          const value = input.valueAsNumber;
          if (!Number.isFinite(value) || key === 'scale' && value <= 0) { input.value = displayValue(); return; }
          if (value === displayValue()) return;
          context.begin(); prop.transform[key] = value; studio.updateProp(prop); context.changed();
        };
        row.append(label, input); group.append(row);
      }
      inspector.append(group);
    };
    addFields('actor-position', [['x', 'X', '.1'], ['y', 'Y', '.1'], ['z', 'Z', '.1']]);
    addFields('dimensions', [['yaw', 'Facing °', '1'], ['scale', 'Scale', '.01']]);
    addFields('dimensions', [['pitch', 'Pitch °', '1'], ['roll', 'Roll °', '1']]);
    const actions = document.createElement('div'); actions.className = 'compact-actions';
    const rotate = actionButton('Rotate in Viewport', () => context.editScene());
    rotate.disabled = prop.locked || prop.visible === false;
    actions.append(rotate);
    inspector.append(actions);
    const joints = studio.modelJoints();
    if (joints.length) {
      const label = document.createElement('label'), select = document.createElement('select');
      select.append(new Option('Whole Model', ''));
      joints.forEach(({ bone }, index) => select.append(new Option(bone.name || 'Joint ' + (index + 1), String(index))));
      select.value = String(studio.modelJoint ?? '');
      select.disabled = rotate.disabled;
      select.onchange = () => {
        studio.finishDrag();
        studio.modelJoint = select.value === '' ? null : Number(select.value);
        context.editScene();
      };
      label.append('Rotation Target', select); inspector.append(label);
    }
    list.append(inspector);
  }
  let key, renderedDoc, renderedProps = [];
  return () => {
    const doc = context.doc(), props = doc.props || [], next = JSON.stringify([context.studio()?.selectedModelId, props]);
    if (next !== key || doc !== renderedDoc || props.some((prop, i) => prop !== renderedProps[i])) {
      key = next; renderedDoc = doc; renderedProps = props.slice(); render();
    }
  };
}
