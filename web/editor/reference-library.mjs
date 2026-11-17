import { guideSource } from './guides.mjs?v=20261116en';
import { uuid } from '../uuid.mjs?v=20261116en';
export const USES = { free: 'General Reference', character: 'Character Appearance', identity: 'Identity / Face', clothing: 'Clothing', accessory: 'Accessories / Products', scene: 'Scene / Background', style: 'Style / Lighting', layout: 'Layout / Composition', pose: 'Pose' };
const copy = value => JSON.parse(JSON.stringify(value));
const uid = prefix => `${prefix}-${uuid()}`;
export const emptyLibrary = () => ({ version: 1, mode: 'guided', items: [], firstReferenceId: null, firstResolution: 0, templates: [] });
export function canvasBackgroundAsset(scene) {
  return scene.referenceLibrary?.items?.find(item => item.id === scene.backgroundReferenceId && !item.missing)?.asset;
}
export function newUse(kind = 'free', target = { kind: 'scene', ids: [], text: '' }) {
  return { id: uid('use'), kind, target: copy(target), enabled: true, sourceText: '', instruction: '' };
}
export function addReference(scene, asset, values = {}) {
  const item = { id: uid('ref'), label: asset?.label || `Reference ${scene.referenceLibrary.items.length + 1}`, asset, enabled: true,
    inputKey: null, batchIndex: 0, batchCount: 1, usages: [newUse()], ...copy(values) };
  scene.referenceLibrary.items.push(item); return item;
}
export function upgradeReferences(scene) {
  if (scene.version === 3) return;
  const library = emptyLibrary(); scene.referenceLibrary = library; scene.version = 3;
  const byName = new Map();
  // Migrate only images actually used by the old route; keep static-guide behavior explicit.
  const oldActors = scene.source?.kind === 'human' && scene.conditioning?.identityMode === 'actors'
    && scene.conditioning.model === 'base' && (scene.conditioning.promptMode === 'custom' || !['image','canny-image'].includes(guideSource(scene).kind));
  if (oldActors) for (const actor of scene.actors || []) {
    if (actor.visible === false || scene.conditioning.promptMode === 'single' || !actor.identity?.asset) continue;
    let item = byName.get(actor.identity.asset.name);
    if (!item) { item = addReference(scene, actor.identity.asset, { inputKey: actor.identity.inputKey || null, usages: [] }); byName.set(item.asset.name, item); }
    const use = newUse('identity', { kind: 'actors', ids: [actor.id], text: '' });
    use.sourceText = typeof actor.identity.sourcePerson === 'string' ? actor.identity.sourcePerson : actor.identity.sourcePerson?.description || '';
    use.instruction = actor.identity.description || ''; item.usages.push(use);
  }
  else if (scene.reference && scene.conditioning?.promptMode !== 'single') addReference(scene, scene.reference);
}
export function updateReferences(scene, connected) {
  const items = scene.referenceLibrary.items, keys = new Set(connected.map(entry => entry.inputKey));
  for (const item of items) if (item.inputKey && !keys.has(item.inputKey)) item.missing = true;
  for (const entry of connected) {
    const matches = items.filter(item => item.inputKey === entry.inputKey);
    if (!matches.length) matches.push(addReference(scene, entry.asset || null, { label: entry.asset?.label || entry.inputKey,
      inputKey: entry.inputKey, missing: !entry.asset, batchCount: entry.batchCount || 1 }));
    for (const item of matches) {
      const asset = entry.assets?.[item.batchIndex || 0] || (!item.batchIndex ? entry.asset : null);
      if (asset?.name && item.asset?.name && asset.name !== item.asset.name) item.reviewSource = true;
      item.asset = asset || item.asset; item.missing = !asset; item.batchCount = entry.batchCount || entry.assets?.length || 1;
    }
  }
}
export function detachTargets(scene, kind, id) {
  for (const item of scene.referenceLibrary?.items || []) for (const use of item.usages) {
    if (use.target.kind === kind) use.target.ids = use.target.ids.filter(value => value !== id);
  }
}
export function sourceChanged(scene, previous) {
  if (scene.version !== 3 || previous?.name === scene.reference?.name) return;
  scene.sourceStale = scene.source?.kind === 'splat' && scene.source.reference?.name !== scene.reference?.name;
  if (scene.conditioning?.mapOrigin === 'da3' || scene.openpose?.origin === 'dwpose') {
    if (scene.conditioning.mapOrigin === 'da3') { scene.conditioning.mapReference ||= previous?.name; scene.conditioning.acceptStoredSource = false; }
    if (scene.openpose?.origin === 'dwpose') { scene.openpose.referenceName ||= previous?.name; scene.openpose.acceptStoredSource = false; }
    scene.derivedGuideStale = true;
    scene.derivedGuideSource = previous?.name || null;
  }
}
export function staleGuide(scene) {
  const settings = scene.conditioning || {}, guide = settings.model === 'anyangle' ? 'coarse' : settings.guide || 'coarse';
  const state = guide === 'depth' && settings.mapOrigin === 'da3' ? { name: settings.mapReference, accepted: settings.acceptStoredSource }
    : guide === 'pose' && scene.openpose?.origin === 'dwpose' && !scene.openpose.useRig ? { name: scene.openpose.referenceName, accepted: scene.openpose.acceptStoredSource } : null;
  return !!state && !state.accepted && (state.name ? state.name !== scene.reference?.name : scene.derivedGuideStale);
}
export function targetText(scene, target) {
  if (target.kind === 'scene') return 'the whole generated scene';
  if (target.kind === 'text') return target.text?.trim() || null;
  if (target.kind === 'actors' && !['human', 'splat'].includes(scene.source?.kind)) return null;
  const objects = scene[target.kind === 'actors' ? 'actors' : 'props'] || [];
  return objects.filter(obj => target.ids?.includes(obj.id) && obj.visible !== false).map(obj => obj.label || obj.id).join(', ') || null;
}
export function libraryManifest(scene) {
  const library = scene.referenceLibrary, mode = library.mode || 'guided', settings = scene.conditioning || {};
  let references = []; const excluded = [], byName = new Map();
  for (const item of library.items) {
    const uses = item.usages.filter(use => use.enabled !== false).map(use => ({ ...use, targetText: targetText(scene, use.target) })).filter(use => use.targetText);
    const reason = item.enabled === false ? 'Reference disabled' : mode === 'text' ? 'Text Only excludes images'
      : !uses.length ? 'Role disabled or target needs reassignment' : !item.asset || item.missing ? 'Missing connection or reference. Read connections again or choose Use Saved Version.' : null;
    if (reason) { excluded.push({ id: item.id, label: item.label || item.id, reason }); continue; }
    const name = item.asset.name;
    if (!byName.has(name)) { byName.set(name, references.length); references.push({ asset: item.asset, referenceIds: [], labels: [], usages: [], actorIds: [] }); }
    const entry = references[byName.get(name)]; entry.referenceIds.push(item.id); entry.labels.push(item.label || item.id); entry.usages.push(...uses);
    entry.actorIds = [...new Set([...entry.actorIds, ...uses.filter(use => use.target.kind === 'actors').flatMap(use => use.target.ids || [])
      .filter(id => scene.actors?.some(actor => actor.id === id && actor.visible !== false))])];
  }
  const anyangle = (settings.model || 'anyangle') === 'anyangle', pair = anyangle && mode === 'guided' && !!scene.reference;
  if (pair) {
    const source = references.find(reference => reference.asset.name === scene.reference.name)
      || { asset: scene.reference, referenceIds: [], labels: [], usages: [], actorIds: [] };
    source.asset = scene.reference;
    source.referenceIds.unshift('scene-source'); source.labels.unshift('Scene Source Image');
    references = [source, ...references.filter(reference => reference !== source)];
  }
  const first = library.firstReferenceId;
  if (mode === 'references-only' && first) {
    const selected = references.find(entry => entry.referenceIds.includes(first));
    if (selected) references = [selected, ...references.filter(entry => entry !== selected)];
  }
  const order = settings.imageOrder || (anyangle ? 'reference-first' : 'guide-first');
  const guide = mode === 'guided' ? { index: anyangle ? pair && order === 'reference-first' ? 2 : 1
    : order === 'guide-first' || !references.length ? 1 : references.length + 1, width: scene.width, height: scene.height } : null;
  references.forEach((reference, i) => {
    reference.index = pair && guide.index === 2 ? i ? i + 2 : 1 : i + (guide?.index === 1 ? 2 : 1);
    reference.resolution = pair && !i ? 0 : mode === 'references-only' && !i ? library.firstResolution || 0 : 'reference';
  });
  const imageCount = references.length + (guide ? 1 : 0);
  const kind = anyangle ? 'coarse' : settings.guide || 'coarse', staticGuide = kind !== 'coarse' && (settings.map && (settings.mapKind || kind) === kind || kind === 'canny' && scene.reference && settings.mapOrigin !== 'auto');
  return { version: 2, mode, imageOrder: order, guide, references,
    actors: (scene.actors || []).filter(actor => !staticGuide && scene.source?.kind === 'human' && actor.visible !== false).map(actor => ({ id: actor.id, label: actor.label || actor.id, transform: actor.transform || {}, editorColor: actor.editorColor ?? null, description: actor.identity?.description || '' })),
    props: (scene.props || []).filter(model => !staticGuide && kind !== 'pose' && scene.source?.kind === 'human' && model.visible !== false)
      .map(model => ({ label: model.label || model.id, editorColor: model.editorColor ?? null, description: model.description || '' })),
    imageCount, excluded, missing: excluded.filter(entry => entry.reason.startsWith('Missing connection')).map(entry => entry.label),
    warnings: imageCount > 10 ? ['Qwen Image 2.1 recommends up to 10 images. All images will be sent. Monitor output quality and VRAM use.'] : [] };
}
export function libraryPrompt(scene, manifest) {
  const settings = scene.conditioning || {};
  if (settings.promptMode === 'custom') return settings.customPrompt ?? '';
  if (scene.promptTemplate === 2) return compositionPrompt(scene, manifest);
  const lines = [], guide = manifest.guide;
  const anyangle = (settings.model || 'anyangle') === 'anyangle';
  const kind = anyangle ? 'coarse' : settings.guide || 'coarse';
  const original = manifest.references.find(reference => reference.referenceIds.includes('scene-source'));
  if (guide && anyangle && original) {
    lines.push(`Change the camera angle from <image${guide.index}> to <image${original.index}>.`);
  } else if (guide) {
    const instructions = { coarse: 'camera angle, composition, poses and placement', pose: 'body poses, limb directions, position and framing', depth: 'spatial depth, layout and occlusion', canny: 'silhouettes, contours and major edges' };
    lines.push(`Create a finished image following the ${instructions[kind]} in <image${guide.index}>. Do not render guide marks, mannequin colors or skeleton lines.`);
    if (manifest.actors.length) {
      lines.push(`The guide contains ${manifest.actors.length} people. Keep their identities and placements separate.`);
      manifest.actors.forEach((actor, index) => {
        const color = kind === 'coarse' && settings.colorActors && actor.editorColor ? ` (${actor.editorColor} mannequin)` : '';
        lines.push(`Person ${index + 1}${color} in the guide is ${actor.label}.${actor.description?.trim() ? ` ${actor.description.trim()}` : ''}`);
      });
    }
  } else if (manifest.mode === 'references-only') lines.push('Create one coherent finished image using the references only for their specified purposes.');
  if (guide) {
    for (const [index, model] of (manifest.props || []).entries()) {
      const color = kind === 'coarse' && settings.colorActors && model.editorColor ? ` (guide color ${model.editorColor})` : '';
      const appearance = model.description.trim();
      lines.push(`Model ${index + 1}${color} in <image${guide.index}> is ${model.label}. Keep its size, placement and orientation.${appearance ? ` ${appearance}` : ''}`);
    }
  }
  for (const reference of manifest.references) for (const use of reference.usages || [])
    lines.push(referencePromptLine(reference.index, use));
  if (settings.promptExtra?.trim()) lines.push(settings.promptExtra.trim());
  return lines.join('\n');
}

const visualName = item => (item.label || item.id).replace(/\.glb$/i, '').replace(/_/g, ' ');
const guideOperation = {
  coarse: 'Render the scene using the framing, viewpoint, poses and placement in',
  pose: 'Render the subjects in the poses and framing shown by the skeleton in',
  depth: 'Render the scene using the layout and depth relationships in',
  canny: 'Render the scene using the spatial layout and outlines in',
};

function compositionPrompt(scene, { guide, references, imageCount, mode }) {
  const settings = scene.conditioning || {};
  const original = references.find(reference => reference.referenceIds.includes('scene-source'));
  const anyangle = (settings.model || 'anyangle') === 'anyangle';
  const kind = anyangle ? 'coarse' : settings.guide || 'coarse';
  const imageTag = index => '<image' + index + '>';
  const guideImage = guide && (imageCount === 1 ? 'the guide image' : imageTag(guide.index));
  const lines = [];
  const seen = new Set(Array.isArray(scene.guideSubjects) ? scene.guideSubjects : []);
  if (guide) {
    if (anyangle && original) lines.push('Change the camera angle from ' + guideImage + ' to ' + imageTag(original.index) + '.');
    else {
      lines.push(guideOperation[kind] + ' ' + guideImage + '.');
      if (kind === 'coarse' && scene.actors?.some(actor => actor.visible !== false && seen.has(actor.id)))
        lines.push('Render the subjects and setting with their intended materials and colors. Replace mannequin surfaces with the subjects’ intended appearance.');
    }
    for (const actor of scene.actors || []) {
      if (actor.visible === false || !seen.has(actor.id)) continue;
      const species = { owl: 'an owl', bunny: 'a rabbit', canine: 'a dog', feline: 'a cat' }[actor.source?.shape] || 'a person';
      const figure = kind === 'coarse' && settings.colorActors && actor.editorColor
        ? ' Match the pose and placement of the ' + actor.editorColor + ' guide figure.' : '';
      const description = actor.identity?.description?.trim();
      lines.push('Render ' + visualName(actor) + ' as ' + species + '.' + figure + (description ? ' ' + description : ''));
    }
    for (const model of scene.props || []) {
      if (model.visible === false || !seen.has(model.id)) continue;
      const description = model.description?.trim();
      lines.push('Preserve the size, position and orientation of ' + visualName(model) + ' in ' + guideImage + '.' + (description ? ' ' + description : ''));
    }
  } else if (mode === 'references-only') lines.push('Compose a new scene using the specified details from the reference images.');
  for (const reference of references) {
    const image = imageCount === 1 ? 'the reference image' : imageTag(reference.index);
    for (const use of reference.usages || []) {
      const line = compositionReferenceLine(scene, use, image, guide, seen);
      if (line) lines.push(line);
    }
  }
  if (settings.promptExtra?.trim()) lines.push(settings.promptExtra.trim());
  return lines.join('\n');
}

export function compositionReferenceLine(scene, use, image, guide, seen = new Set(Array.isArray(scene.guideSubjects) ? scene.guideSubjects : [])) {
  const { kind, ids = [] } = use.target;
  let target = use.targetText;
  if (kind === 'actors' || kind === 'props') {
    const objects = (scene[kind] || []).filter(item => item.visible !== false && ids.includes(item.id) && (!guide || seen.has(item.id)));
    if (!objects.length) return '';
    target = objects.map(visualName).join(', ');
  }
  const source = use.sourceText?.trim();
  const from = source ? image + ' (use ' + source + ')' : image;
  const animal = kind === 'actors' && scene.actors?.some(actor => ids.includes(actor.id) && actor.source?.kind === 'animal');
  const instructions = {
    free: 'Use ' + from + ' as an appearance reference for ' + target + '.',
    character: animal ? 'Match the animal’s appearance, coloring and markings in ' + from + ' for ' + target + '.'
      : 'Match the character appearance, hairstyle and clothing in ' + from + ' for ' + target + '.',
    identity: 'Match the face and hairstyle in ' + from + ' for ' + target + '.',
    clothing: 'Dress ' + target + ' in the clothing shown in ' + from + '.',
    accessory: 'Use the accessory or product design in ' + from + ' for ' + target + '.',
    scene: 'Use the environment in ' + from + ' as the background' + (kind === 'scene' ? '' : ' for ' + target) + '. Retain the scene subjects.',
    style: 'Apply the visual style, lighting and palette of ' + from + ' to ' + target + '.',
    layout: guide ? 'Use the arrangement in ' + from + ' for details of ' + target + " where it fits the guide's framing and placement."
      : 'Match the arrangement in ' + from + ' for ' + target + '.',
    pose: guide ? 'Use the gesture in ' + from + ' for ' + target + " while preserving the guide's placement and framing."
      : 'Match the pose and gesture in ' + from + ' for ' + target + '.',
  };
  const extra = use.instruction?.trim();
  return instructions[use.kind] + (extra ? ' ' + extra : '');
}

export function referencePromptLine(index, use) {
  const rules = { free: 'Use the relevant content as a general reference',
    character: 'Use the depicted character’s appearance, hairstyle, clothing and accessories; follow the scene composition and leave out the reference background', identity: 'Use only the face identity and hairstyle; do not copy the clothing, pose or background',
    clothing: "Use only the clothing design; do not copy the model's identity, pose or background", accessory: 'Use only the accessory or product design; do not add people from this reference',
    scene: 'Use the environment and background; do not add people from this reference', style: 'Use the visual style, lighting and color palette; do not copy the subject or pose', layout: 'Use the arrangement and composition; do not copy subject identities',
    pose: 'Use only the body pose, limb directions and gesture; do not copy the face, body shape, clothing, background or drawing style' };
  const source = use.sourceText?.trim() ? ` Source content: ${use.sourceText.trim()}.` : '';
  const extra = use.instruction?.trim() ? ` ${use.instruction.trim()}` : '';
  return `<image${index}>: ${rules[use.kind]} for ${use.targetText}.${source}${extra}`;
}
