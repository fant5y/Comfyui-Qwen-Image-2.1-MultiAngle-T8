import * as THREE from '../vendor/three.module.mjs';
import { uuid } from '../uuid.mjs?v=20261116en';
import { AnimalMannequin, ANIMAL_SHAPES } from './animal-mannequin.mjs?v=20261117owlwings';
import { GLTFLoader } from '../vendor/GLTFLoader.mjs';
import { PoseViewerCore } from '../vendor/vnccs_pose_studio_core.mjs?v=20261031resize';
import { solveMorph, buildStaticModelData } from '../vendor/vnccs_pose_morph_runtime.mjs?v=20261116bodyrange';
import { loadHumanPack, HumanAssetError } from './human.mjs?v=20261116en';
import { applyLens } from './lens.mjs?v=20261116en';
import { HAND_PRESETS } from '../vendor/vnccs_hand_presets.mjs';
import { SplatScene } from './splat.mjs?v=20261116en';
import { capturePNG } from './capture.mjs?v=20261116en';
import { liftOpenPose, copyVisiblePose, WORLD_KEYPOINT_NAMES, ORDER, LIMBS, COLORS } from './openpose.mjs?v=20261116en';
import { createActor, ensureActors, activeActor, bindActor, saveActor, visibleActors } from './actors.mjs?v=20261116en';
import { loadProp, disposeProp, placeProp } from './props.mjs?v=20261116canvasprompt';
import { emptyLibrary, canvasBackgroundAsset } from './reference-library.mjs?v=20261116canvasprompt';

export const PRESETS = [
  { name: 'Natural Stand', bones: { upperarm_l: [0, 0, -8], upperarm_r: [0, 0, 8] } },
  { name: 'Step Forward', bones: { thigh_l: [-25, 0, 0], calf_l: [16, 0, 0], thigh_r: [20, 0, 0], calf_r: [9, 0, 0], upperarm_l: [20, 0, -8], upperarm_r: [-20, 0, 8] } },
  { name: 'Seated', bones: { thigh_l: [-85, 0, -5], thigh_r: [-85, 0, 5], calf_l: [85, 0, 0], calf_r: [85, 0, 0], lowerarm_l: [-45, 0, 0], lowerarm_r: [-45, 0, 0] } },
  { name: 'Raised Hand', bones: { upperarm_l: [0, 0, 100], lowerarm_l: [0, 0, 20], upperarm_r: [0, 0, 10] } },
];
export const defaultScene = () => ({
  version: 3, referenceLibrary: emptyLibrary(), width: 1024, height: 1024, actors: [], activeActorId: null, selectedActorIds: [],
  source: { kind: 'empty' }, reference: null,
  reconstruction: { keepBackground: false },
  interaction: { mousePitch: true, quality: 'balanced', livePreview: true },
  camera: { azimuth: 35, elevation: 8, zoom: 1.3, offsetX: 0, offsetY: 0, offsetZ: 0, focalLength: 0 },
  mesh: { age: 25, gender: 0.5, weight: 0.5, muscle: 0.5, height: 0.5, breast_size: 0, firmness: 0.5, show_genitals: false },
  pose: { bones: PRESETS[0].bones }, shots: [], front: 0, scale: 1,
  background: '#69717b',
  conditioning: { model: 'anyangle', guide: 'coarse', map: null, cannyLow: 50, cannyHigh: 150 },
  openpose: null,
});
export function restoreSceneDefaults(doc) {
  const defaults = defaultScene();
  for (const key of ['width', 'height', 'source', 'reference', 'shots', 'front', 'scale', 'background', 'pose', 'openpose'])
    doc[key] ??= defaults[key];
  for (const key of ['camera', 'mesh', 'conditioning', 'interaction']) doc[key] = { ...defaults[key], ...doc[key] };
  doc.reconstruction = { keepBackground: !!doc.source.keep_background, ...doc.reconstruction };
  // Leave legacy actors absent so ensureActors can migrate the original pose.
  return doc;
}
export const assetURL = name => `/anyangle-studio/assets/${encodeURIComponent(name)}`;
const radians = THREE.MathUtils.degToRad;
const degrees = THREE.MathUtils.radToDeg;
const clamp = THREE.MathUtils.clamp;

function modelData(morph, data) {
  return {
    vertices: morph.vertices, uvs: data.uvs, indices: data.indices,
    skinIndices: data.skinIndices, skinWeights: data.skinWeights,
    landmarks: morph.landmarks || {}, landmark_indices: morph.landmarkIndices || {},
    bones: data.bones.map((bone, i) => {
      const headPos = Array.from(morph.bonePositions.subarray(i * 6, i * 6 + 3));
      const tailPos = Array.from(morph.bonePositions.subarray(i * 6 + 3, i * 6 + 6));
      return { name: bone.name, parent: bone.parent || null, headPos, tailPos, length: Math.hypot(...tailPos.map((v, j) => v - headPos[j])) };
    }),
  };
}

function directMaleAnatomy(pack, vertices, tilt, turn) {
  if (!tilt && !turn) return;
  const shaft = pack.targets.find(target => target.factorValues.includes('penis-circ-incr'));
  if (!shaft?.indices.length) return;
  const point = new THREE.Vector3();
  let rootIndex = shaft.indices[0], tipIndex = rootIndex;
  for (const index of shaft.indices) {
    const y = pack.baseVertices[index * 3 + 1];
    if (y > pack.baseVertices[rootIndex * 3 + 1]) rootIndex = index;
    if (y < pack.baseVertices[tipIndex * 3 + 1]) tipIndex = index;
  }
  const pivot = new THREE.Vector3().fromArray(vertices, rootIndex * 3);
  pivot.x = 0;
  const root = new THREE.Vector3().fromArray(pack.baseVertices, rootIndex * 3);
  const axis = new THREE.Vector3().fromArray(pack.baseVertices, tipIndex * 3).sub(root);
  root.x = axis.x = 0;
  const axisLength = axis.lengthSq();
  if (axisLength < 1e-8) return;
  const tiltAxis = new THREE.Vector3(1, 0, 0);
  const turnAxis = axis.clone().cross(tiltAxis).normalize();
  const tiltRadians = -radians(tilt);
  const turnRadians = radians(turn);
  const lateralRotation = new THREE.Quaternion();
  const jointRotation = new THREE.Quaternion();
  for (const index of shaft.indices) {
    const offset = index * 3;
    // Fade the rotation near the attachment so the base stays on the pelvis.
    const distance = point.fromArray(pack.baseVertices, offset).sub(root).dot(axis) / axisLength;
    const weight = THREE.MathUtils.smoothstep(distance, 0.04, 0.28);
    jointRotation.setFromAxisAngle(tiltAxis, tiltRadians * weight);
    jointRotation.multiply(lateralRotation.setFromAxisAngle(turnAxis, turnRadians * weight));
    point.fromArray(vertices, offset).sub(pivot).applyQuaternion(jointRotation).add(pivot).toArray(vertices, offset);
  }
}

function disposeObject(root) {
  root.traverse(object => {
    object.geometry?.dispose();
    object.skeleton?.dispose();
    for (const material of [].concat(object.material || [])) {
      for (const value of Object.values(material)) if (value?.isTexture) value.dispose();
      material.dispose();
    }
  });
  root.removeFromParent();
}

function worldBounds(root) {
  root.updateMatrixWorld(true);
  root.traverse(object => {
    if (object.isSkinnedMesh) { object.skeleton.update(); object.computeBoundingBox(); }
  });
  return new THREE.Box3().setFromObject(root);
}

export class StudioScene {
  constructor(canvas, callbacks) {
    this.canvas = canvas;
    this.callbacks = callbacks;
    this.mode = 'camera';
    this.restoring = true;
    this.rigPointerDown = false;
    this.rigHistory = null;
    this.actorRoots = new Map();
    this.animalActors = new Map();
    this.propRoots = new Map();
    this.viewer = new PoseViewerCore(canvas, {
      skinMode: 'naked', enableTextureSkinning: true,
      showSkeletonHelper: false, showCaptureFrame: false, useHandControlPopover: false,
      onPoseChange: () => { if (!this.restoring && this.mode !== 'position') callbacks.change(true, this.interactionControls !== false); },
      onBoneSelectionChange: ({ boneName }) => callbacks.select(boneName, this.interactionControls !== false),
      onError: error => callbacks.error(error),
    });
    // One editor history owns the pose, camera, assets and shot library together.
    this.viewer.recordState = () => {
      if (this.restoring) return;
      // FK marks itself as dragging before requesting its initial history entry.
      this.beginningRigGesture = true;
      try {
        const pose = this.rigPointerDown ? this.interactionSnapshot() : null;
        const rollback = callbacks.begin();
        if (pose !== null) this.rigHistory = { pose, rollback };
      }
      finally { this.beginningRigGesture = false; }
    };
    this.viewer.options.onInteractionEnd = () => {
      const history = this.rigHistory; this.rigHistory = null;
      if (this.restoring) return;
      // Selecting an IK marker or FK ring without moving leaves history intact.
      if (history && history.pose === this.interactionSnapshot()) history.rollback?.();
      else callbacks.change(true, this.interactionControls !== false);
    };
    const requestRender = this.viewer.requestRender.bind(this.viewer);
    this.viewer.requestRender = () => { if (!this.capturing) requestRender(); };
  }

  async init(doc) {
    this.doc = doc;
    await this.viewer.init();
    if (!this.viewer.initialized) throw new Error('WebGL initialization failed. Enable hardware acceleration in your browser.');
    this.viewer.transform.addEventListener('objectChange', () => {
      if (this.mode === 'position') {
        this.savePlacementPosition();
        return;
      }
      const model = this.selectedModel();
      const rotation = this.modelRotation();
      if (!rotation) { this.animal?.update(this.animalSelection); return; }
      if (this.modelJoints()[this.modelJoint]) (model.jointRotations ||= {})[this.modelJoint] = rotation;
      else {
        const [pitch, yaw, roll] = rotation;
        Object.assign(model.transform, { pitch, yaw, roll });
      }
    });
    this.cameraClips = [this.viewer.camera, this.viewer.captureCamera].map(camera => ({ near: camera.near, far: camera.far }));
    this.viewer.setDirectionalSkydomeVisible(false);
    this.workspaceBackground = new THREE.Color('#171f28');
    this.viewer.scene.background = this.workspaceBackground;
    this.viewer.camera.fov = 38;
    this.viewer.updateLights([{ type: 'ambient', color: '#ffffff', intensity: 1.3 },
      { type: 'directional', color: '#ffffff', intensity: 1.7, x: 8, y: 20, z: 18 }]);
    this.grid = new THREE.GridHelper(100, 50, 0x425365, 0x28343f);
    this.grid.material.transparent = true;
    this.grid.material.opacity = 0.32;
    this.viewer.scene.add(this.grid);
    const points = Array.from({ length: 129 }, (_, i) => new THREE.Vector3(Math.sin(i / 128 * Math.PI * 2) * 14, 0, Math.cos(i / 128 * Math.PI * 2) * 14));
    this.ring = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(points), new THREE.LineBasicMaterial({ color: 0x24cce3, transparent: true, opacity: 0.72 }));
    this.viewer.scene.add(this.ring);
    this.shotHelper = new THREE.CameraHelper(this.viewer.captureCamera);
    this.shotHelper.material.color.set('#eba84b');
    this.viewer.scene.add(this.shotHelper);
    this.photoFrame = new THREE.LineLoop(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0xeba84b, depthTest: false }));
    this.photoFrame.renderOrder = 1000;
    this.viewer.scene.add(this.photoFrame);
    await this.restore(doc);
    this.bindCamera();
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.canvas.parentElement);
    this.resize();
  }

  updatePerformance() {
    const renderer = this.viewer.renderer;
    if (!renderer) return;
    const limit = { economy: 1, balanced: 1.5, sharp: 2 }[this.doc.interaction?.quality] || 1.5;
    const ratio = Math.min(globalThis.devicePixelRatio || 1, limit);
    if (renderer.getPixelRatio() !== ratio) renderer.setPixelRatio(ratio);
    this.viewer.requestRender();
  }

  resize() {
    const { width, height } = this.canvas.parentElement.getBoundingClientRect();
    this.viewer.resize(Math.max(1, width), Math.max(1, height));
    if (this.mode === 'camera' && this.baseTarget) this.updateShot();
  }

  loadSceneBackground() {
    if (this.capturing) return this.backgroundLoad;
    const name = canvasBackgroundAsset(this.doc)?.name;
    if (name === this.backgroundName) {
      this.updateSceneBackground();
      return this.backgroundLoad;
    }
    this.backgroundName = name;
    if (this.sceneBackground) {
      this.sceneBackground.removeFromParent();
      this.sceneBackground.geometry.dispose();
      this.sceneBackground.material.dispose();
      this.sceneBackground.material.map.dispose();
      this.sceneBackground = null;
    }
    const pending = name ? new THREE.TextureLoader().loadAsync(assetURL(name)).then(texture => {
      if (this.disposed || this.backgroundLoad !== pending) { texture.dispose(); return null; }
      texture.colorSpace = THREE.SRGBColorSpace;
      const plane = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: texture, toneMapped: false }));
      plane.visible = false;
      this.sceneBackground = plane;
      this.viewer.scene.add(plane);
      this.updateSceneBackground();
      return plane;
    }).catch(() => null) : null;
    this.backgroundLoad = pending;
    this.viewer.requestRender();
    return pending;
  }

  updateSceneBackground() {
    const plane = this.sceneBackground;
    if (!plane || this.capturing || this.disposed) return;
    const settings = this.doc.sceneBackground ||= {};
    if (!settings.frame) {
      const camera = this.viewer.captureCamera;
      if (this.splat) this.splat.configureCamera(camera, this.doc, this.doc.width, this.doc.height);
      else this.configureCapture(this.doc.width, this.doc.height);
      camera.updateMatrixWorld(true);
      const direction = camera.getWorldDirection(new THREE.Vector3());
      const target = this.baseTarget || new THREE.Vector3(0, 10, 0);
      // Start behind the subject and project the frame onto the image plane.
      const targetDepth = target.clone().sub(camera.position).dot(direction);
      const distance = Math.min(camera.far * 0.9, Math.max(camera.near * 2, targetDepth + 25));
      const framePoint = y => {
        const ray = new THREE.Vector3(0, y, 0.5).unproject(camera).sub(camera.position);
        return ray.multiplyScalar(distance / ray.dot(direction)).add(camera.position);
      };
      const center = framePoint(0);
      settings.frame = {
        center: center.toArray(), rotation: camera.quaternion.toArray(),
        height: 2 * framePoint(1).distanceTo(center), aspect: this.doc.width / this.doc.height,
      };
    }
    const { center, rotation, height, aspect } = settings.frame;
    const image = plane.material.map.image;
    const imageAspect = image.width / image.height;
    const planeHeight = height * Math.max(1, aspect / imageAspect) * (settings.scale ?? 1);
    plane.position.fromArray(center);
    plane.position.x += settings.x ?? 0;
    plane.position.y += settings.y ?? 0;
    plane.position.z += settings.z ?? 0;
    plane.quaternion.fromArray(rotation);
    plane.scale.set(planeHeight * imageAspect, planeHeight, 1);
    plane.visible = settings.visible !== false;
    this.viewer.requestRender();
  }

  buildHuman(pose, actor = activeActor(this.doc)) {
    if (this.cachedPack !== this.pack) {
      this.cachedPack = this.pack; this.morphCache = new Map(); this.morphCacheBytes = 0;
      this.humanStatic = new Map();
    }
    const key = JSON.stringify(this.doc.mesh);
    let cached = this.morphCache.get(key);
    if (!cached) {
      const morph = solveMorph(this.pack, this.doc.mesh);
      if (morph.includeGenitals) directMaleAnatomy(this.pack, morph.vertices,
        this.doc.mesh.penis_tilt || 0, this.doc.mesh.penis_turn || 0);
      cached = { morph, bytes: morph.vertices.byteLength + morph.bonePositions.byteLength + 65536 };
      this.morphCacheBytes += cached.bytes;
    } else this.morphCache.delete(key);
    this.morphCache.set(key, cached);
    while (this.morphCache.size > 16 || this.morphCacheBytes > 16 * 1024 * 1024) {
      const first = this.morphCache.keys().next().value;
      this.morphCacheBytes -= this.morphCache.get(first).bytes; this.morphCache.delete(first);
    }
    const morph = cached.morph;
    if (!this.humanStatic.has(morph.includeGenitals))
      this.humanStatic.set(morph.includeGenitals, buildStaticModelData(this.pack, morph.includeGenitals));
    // Native cached proportion controls belong to a rig, never to its previous occupant.
    this.viewer.headScale = this.viewer.armScale = this.viewer.handScale = this.viewer.footScale = 1;
    this.viewer.setSkinTexture('naked');
    this.viewer.loadData(modelData(morph, this.humanStatic.get(morph.includeGenitals)), true);
    if (pose?.positionDeltas) {
      pose = structuredClone(pose); pose.bonePositions = { ...pose.bonePositions };
      for (const [name, delta] of Object.entries(pose.positionDeltas)) {
        const rest = this.viewer.shapedBoneRestPositions?.[name] || this.viewer.initialBoneStates?.[name]?.position;
        if (rest && Array.isArray(delta) && delta.length === 3 && delta.every(Number.isFinite))
          pose.bonePositions[name] = [rest.x + delta[0], rest.y + delta[1], rest.z + delta[2]];
      }
      delete pose.hipBonePosition;
    }
    this.viewer.setPose(pose || { bones: {} }, true);
    this.viewer.setActiveCharacterAppearance({ color: actor?.editorColor || '#e3e9ee', transform: { x: 0, y: 0, z: 0, zoom: actor ? 1 : this.doc.scale } });
    if (actor) this.attachActor(actor, this.viewer.skinnedMesh);
  }

  attachActor(actor, mesh) {
    let root = this.actorRoots.get(actor.id);
    if (!root) { root = new THREE.Group(); root.userData.actorId = actor.id; this.actorRoots.set(actor.id, root); this.viewer.scene.add(root); }
    root.add(mesh); mesh.userData.actorId = actor.id;
    this.updateActorTransform(actor);
    return root;
  }

  updateActorTransform(actor = activeActor(this.doc)) {
    const root = this.actorRoots.get(actor?.id); if (!root) return;
    const t = actor.transform;
    root.position.set(t.x, t.y, t.z); root.rotation.y = radians(t.yaw); root.scale.setScalar(t.scale);
    root.visible = this.doc.source.kind === 'human' && actor.visible !== false;
    root.updateMatrixWorld(true);
    const animal = this.animalActors.get(actor.id);
    if (animal) animal.update(this.animalSelection, actor.editorColor);
    root.traverse(object => { if (object.isSkinnedMesh) { object.skeleton.update(); object.computeBoundingBox(); object.computeBoundingSphere(); } });
    if (!animal && actor.id === this.doc.activeActorId) { this.viewer.updateMarkers(); this.viewer.updateIKEffectorPositions?.(); }
    this.viewer.requestRender();
  }

  get animal() { return this.animalActors.get(this.doc?.activeActorId); }

  actorMesh(id) { if (this.animalActors.has(id)) return null; return id === this.doc.activeActorId ? this.viewer.skinnedMesh : this.viewer.passiveCharacters.get(id)?.mesh; }
  actorBones(id) { if (this.animalActors.has(id)) return null; return id === this.doc.activeActorId ? this.viewer.bones : this.viewer.passiveCharacters.get(id)?.bones; }
  humanBounds(selected = false) {
    const box = new THREE.Box3();
    for (const actor of selected ? this.doc.actors || [] : visibleActors(this.doc)) {
      if (selected && !(this.doc.selectedActorIds || [this.doc.activeActorId]).includes(actor.id)) continue;
      const animal = this.animalActors.get(actor.id);
      if (animal) { box.union(worldBounds(animal.root)); continue; }
      const mesh = this.actorMesh(actor.id);
      if (mesh) { mesh.updateMatrixWorld(true); mesh.skeleton.update(); mesh.computeBoundingBox(); box.union(mesh.boundingBox.clone().applyMatrix4(mesh.matrixWorld)); }
    }
    if (!selected) for (const prop of this.doc.props || []) if (prop.visible !== false) {
      const root = this.propRoots?.get(prop.id); if (root) box.union(worldBounds(root));
    }
    return box;
  }

  async restoreProps() {
    this.propRoots ||= new Map(); const props = this.doc.props || [], ids = new Set(props.map(prop=>prop.id));
    if (!ids.has(this.selectedModelId)) { this.selectedModelId = null; this.modelJoint = null; }
    for (const [id, root] of this.propRoots) if (!ids.has(id) || props.find(prop=>prop.id===id)?.asset.name !== root.userData.assetName) { disposeProp(root); this.propRoots.delete(id); }
    for (const prop of props) {
      let root = this.propRoots.get(prop.id);
      if (this.doc.source.kind !== 'human') { if (root) root.visible = false; continue; }
      if (!root) { root = await loadProp(prop.asset); root.userData.assetName = prop.asset.name; root.userData.modelId = prop.id; this.propRoots.set(prop.id,root); this.viewer.scene.add(root); }
      placeProp(root,prop,this.doc.source.kind==='human');
    }
  }

  updateProp(prop) { const root = this.propRoots.get(prop.id); if (root) { placeProp(root,prop,this.doc.source.kind==='human'); this.viewer.requestRender(); } }

  async selectActor(id) {
    if (id === this.doc.activeActorId || this.doc.source.kind !== 'human') return;
    const actor = this.doc.actors.find(item => item.id === id); if (!actor) return;
    this.syncPose();
    if (this.animal || actor.source.kind === 'animal') {
      bindActor(this.doc, id);
      await this.restore(this.doc);
      this.callbacks.actor?.(id);
      return;
    }
    this.restoring = true;
    try {
      const previous = activeActor(this.doc);
      if (previous && this.viewer.upsertPassiveCharacterFromActive(previous.id, { pose: previous.pose, color: previous.editorColor }))
        this.attachActor(previous, this.viewer.passiveCharacters.get(previous.id).mesh);
      this.viewer.removePassiveCharacter(id);
      bindActor(this.doc, id); this.buildHuman(actor.pose, actor);
      this.setMode(this.mode); await this.waitForCaptureReady(); this.syncPose();
    } finally { this.restoring = false; }
    this.callbacks.actor?.(id);
  }

  async waitForCaptureReady(timeout = 45000) {
    if (this.doc.source.kind !== 'human') return this.viewer.waitForCaptureReady();
    let timer;
    try {
      return await Promise.race([this.viewer.waitForCaptureReady(), new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new HumanAssetError('Mannequin textures timed out. Retry or repair the mannequin assets.')), timeout);
      })]);
    } finally { clearTimeout(timer); }
  }

  async restore(doc) {
    this.restoring = true;
    try {
      this.doc = restoreSceneDefaults(doc);
      if (doc.source.kind === 'animal') {
        ensureActors(doc);
        const { shape, pose } = doc.source;
        const actor = createActor(doc.actors.length, {
          label: ANIMAL_SHAPES[shape], source: { kind: 'animal', shape }, animalPose: pose,
          transform: { x: 0, y: 0, z: 0, scale: doc.scale, yaw: doc.front },
        });
        doc.source = { kind: 'human' };
        doc.actors.push(actor);
        doc.activeActorId = actor.id; doc.selectedActorIds = [actor.id];
      }
      ensureActors(doc, doc.source.kind === 'human');
      await this.restoreProps();
      this.updatePerformance();
      if (doc.source.kind !== 'splat') [this.viewer.camera, this.viewer.captureCamera].forEach((camera, i) => {
        camera.clearViewOffset(); camera.near = this.cameraClips[i].near; camera.far = this.cameraClips[i].far;
        camera.up.set(0, 1, 0); camera.updateProjectionMatrix();
      });
      if (this.splat && doc.source.kind !== 'splat') { await this.splat.dispose(); this.splat = null; }
      if (this.glb && doc.source.kind !== 'glb') { disposeObject(this.glb); this.glb = null; this.glbName = null; }
      for (const animal of this.animalActors.values()) animal.dispose();
      this.animalActors.clear();
      this.animalSelection = '';
      if (doc.source.kind === 'human') {
        const people = doc.actors.filter(actor => actor.source.kind !== 'animal');
        if (people.length && !this.pack) this.pack = await loadHumanPack();
        this.viewer.clearPassiveCharacters();
        for (const root of this.actorRoots.values()) root.removeFromParent();
        this.actorRoots.clear();
        const selectedId = doc.activeActorId;
        for (const actor of doc.actors.filter(item => item.source.kind === 'animal')) {
          const rig = new AnimalMannequin(actor.source.shape);
          rig.restore(actor.animalPose);
          rig.setBuild(actor.animalBuild);
          this.animalActors.set(actor.id, rig);
          this.attachActor(actor, rig.root);
          this.viewer.scene.add(rig.handles);
        }
        for (const actor of people.filter(item => item.id !== selectedId)) {
          bindActor(doc, actor.id); this.buildHuman(actor.pose, actor);
          this.viewer.upsertPassiveCharacterFromActive(actor.id, { pose: actor.pose, color: actor.editorColor });
          this.attachActor(actor, this.viewer.passiveCharacters.get(actor.id).mesh);
          await new Promise(resolve => setTimeout(resolve, 0));
        }
        const actor = bindActor(doc, selectedId);
        if (this.animal) this.viewer.skinnedMesh?.removeFromParent();
        else this.buildHuman(actor.pose, actor);
        this.baseTarget = Array.isArray(doc.cameraTarget) ? new THREE.Vector3(...doc.cameraTarget) : this.humanBounds().getCenter(new THREE.Vector3());
        if (!Number.isFinite(this.baseTarget.x)) this.baseTarget.set(0, 10, 0);
        doc.cameraTarget = this.baseTarget.toArray();
      } else if (doc.source.kind === 'splat') {
        if (this.splat?.disposed || this.splat?.source?.name !== doc.source.name) {
          const loaded = new SplatScene(this.viewer);
          await loaded.load(doc.source);
          await this.splat?.dispose();
          this.splat = loaded;
          this.viewer.scene.add(this.splat.root);
        }
        this.splat.root.scale.setScalar(doc.scale);
        this.splat.root.rotation.y = radians(doc.front);
        this.splat.root.updateMatrixWorld(true);
        this.baseTarget = this.splat.target;
      } else if (doc.source.kind === 'glb') {
        if (this.glbName !== doc.source.name) {
          const response = await fetch(assetURL(doc.source.name));
          if (!response.ok) throw new Error('GLB asset missing. Import it again.');
          const manager = new THREE.LoadingManager();
          manager.setURLModifier(url => {
            if (!url.startsWith('blob:') && !url.startsWith('data:')) throw new Error('The GLB must include its materials.');
            return url;
          });
          const gltf = await new GLTFLoader(manager).parseAsync(await response.arrayBuffer(), '');
          const imported = gltf.scene;
          const bounds = worldBounds(imported);
          if (bounds.isEmpty()) throw new Error('The GLB contains no renderable geometry.');
          const size = bounds.getSize(new THREE.Vector3());
          const center = bounds.getCenter(new THREE.Vector3());
          const longest = Math.max(size.x, size.y, size.z);
          if (!Number.isFinite(longest) || longest <= 0) throw new Error('The GLB geometry bounds are invalid.');
          const scale = 20 / longest;
          const normalized = new THREE.Group();
          normalized.add(imported);
          normalized.position.set(-center.x * scale, -bounds.min.y * scale, -center.z * scale);
          normalized.scale.setScalar(scale);
          const group = new THREE.Group();
          group.add(normalized);
          if (this.glb) disposeObject(this.glb);
          this.glb = group;
          this.glbName = doc.source.name;
          this.viewer.scene.add(group);
        }
        this.glb.position.fromArray(doc.source.position || [0, 0, 0]);
        this.glb.scale.setScalar(doc.scale);
        this.glb.rotation.y = radians(doc.front);
        this.baseTarget = worldBounds(this.glb).getCenter(new THREE.Vector3()).sub(this.glb.position);
      } else {
        this.baseTarget = new THREE.Vector3(0, 10, 0);
      }
      this.viewer.setMannequinVisible(doc.source.kind === 'human' && !this.animal);
      for (const actor of doc.actors) this.updateActorTransform(actor);
      const bounds = doc.source.kind === 'splat' ? this.splat.bounds
        : doc.source.kind === 'empty' ? new THREE.Box3(new THREE.Vector3(-10, 0, -10), new THREE.Vector3(10, 20, 10))
        : doc.source.kind === 'human' ? this.humanBounds() : worldBounds(this.animal?.root || this.glb);
      if (bounds.isEmpty()) bounds.set(new THREE.Vector3(-10, 0, -10), new THREE.Vector3(10, 20, 10));
      this.grid.position.y = bounds.min.y - 0.03;
      this.ring.position.copy(this.baseTarget);
      this.ring.visible = doc.source.kind !== 'splat' && doc.source.kind !== 'empty';
      this.setMode(this.mode);
      this.updateShot(true);
      await this.waitForCaptureReady();
      // Normalize sparse or older pose documents without treating restoration
      // as a user edit and replacing an explicitly selected photo skeleton.
      this.syncPose();
    } finally { this.restoring = false; }
  }

  pose() {
    const { camera, cameraParams, ...pose } = this.viewer.getPose();
    return pose;
  }

  syncPose() {
    if (this.animal) {
      const actor = activeActor(this.doc);
      actor.animalPose = this.animal.pose();
      actor.transform.scale = this.doc.scale;
      return;
    }
    if (this.doc.source.kind !== 'human') return;
    const pose = this.pose();
    if (!this.restoring && JSON.stringify(pose) !== JSON.stringify(this.doc.pose)) this.useRigPose();
    this.doc.pose = pose;
    saveActor(this.doc, pose);
  }

  useRigPose() {
    if (this.doc.openpose) this.doc.openpose.useRig = true;
    const settings = this.doc.conditioning;
    if (settings.guide === 'pose') {
      settings.map = null; settings.mapKind = null; settings.mapOrigin = 'rig';
    }
  }

  updateShot(snap = false) {
    const d = this.doc, c = d.camera;
    if (d.source.kind === 'human' && Array.isArray(d.cameraTarget) && d.cameraTarget.length === 3 && d.cameraTarget.every(Number.isFinite))
      this.baseTarget.set(...d.cameraTarget);
    this.photoFrame.visible = d.source.kind === 'splat';
    if (d.source.kind === 'splat') {
      const v = this.viewer;
      const target = this.splat.configureCamera(v.captureCamera, d, d.width, d.height);
      v.captureFrame.visible = false;
      if (snap || this.mode === 'camera') {
        const aspect = v.camera.aspect;
        v.camera.copy(v.captureCamera);
        v.camera.aspect = aspect;
        const padding = 1.12;
        const sx = Math.min(1, (d.width / d.height) / aspect) / padding;
        const sy = Math.min(1, aspect / (d.width / d.height)) / padding;
        for (let column = 0; column < 4; column++) {
          v.camera.projectionMatrix.elements[column * 4] *= sx;
          v.camera.projectionMatrix.elements[column * 4 + 1] *= sy;
        }
        v.camera.projectionMatrixInverse.copy(v.camera.projectionMatrix).invert();
        v.orbit.target.copy(target);
        const distance = v.camera.position.distanceTo(target);
        const ndcZ = new THREE.Vector3(0, 0, -distance).applyMatrix4(v.captureCamera.projectionMatrix).z;
        this.photoFrame.geometry.dispose();
        this.photoFrame.geometry = new THREE.BufferGeometry().setFromPoints([[-1,-1],[1,-1],[1,1],[-1,1]].map(([x,y]) => new THREE.Vector3(x,y,ndcZ).unproject(v.captureCamera)));
      }
      this.shotHelper.update(); this.shotHelper.visible = this.mode === 'edit';
      v.requestRender(); return;
    }
    this.viewer.sceneCameraTarget = this.baseTarget.clone();
    this.viewer.sceneCameraTarget.z -= c.offsetZ || 0;
    this.configureCapture(d.width, d.height);
    this.viewer.captureFrame.visible = true;
    if (snap || this.mode === 'camera') {
      // Fit the complete output frame inside a differently-shaped editor viewport.
      const framing = 1.12 * Math.max(1, (d.width / d.height) / this.viewer.camera.aspect);
      const v = this.viewer;
      v.camera.fov = degrees(2 * Math.atan(Math.tan(radians(v.captureCamera.fov / 2)) * framing));
      v.camera.position.copy(v.captureCamera.position);
      v.camera.zoom = c.zoom; v.camera.updateProjectionMatrix();
      v.orbit.target.copy(v.sceneCameraTarget).add(new THREE.Vector3(-c.offsetX, -c.offsetY, 0));
      const damping = v.orbit.enableDamping; v.orbit.enableDamping = false;
      v.orbit.update(); v.orbit.enableDamping = damping;
      this.viewer.captureFrame.visible = true;
    }
    this.shotHelper.update();
    this.shotHelper.visible = this.mode === 'edit' && !this.animal;
    if (this.animal && this.mode === 'edit') this.viewer.captureFrame.visible = false;
    this.viewer.requestRender();
  }

  configureCapture(width, height) {
    const v = this.viewer, c = this.doc.camera;
    v.updateCaptureCamera(width, height, c.zoom, c.offsetX, c.offsetY, c.azimuth, -c.elevation);
    if (this.animal && this.mode === 'edit') v.captureFrame.visible = false;
    const target = (v.sceneCameraTarget || v.meshCenter || new THREE.Vector3(0, 10, 0)).clone().add(new THREE.Vector3(-c.offsetX, -c.offsetY, 0));
    applyLens(v.captureCamera, target, c.focalLength || 0);
  }

  selectedModel() {
    return this.doc.source.kind === 'human' && this.doc.props?.find(model => model.id === this.selectedModelId);
  }

  modelJoints() {
    return this.propRoots.get(this.selectedModelId)?.userData.joints || [];
  }

  modelRotation() {
    if (this.mode !== 'edit' || !this.selectedModel()) return null;
    const joint = this.modelJoints()[this.modelJoint]?.bone;
    const target = joint || this.propRoots.get(this.selectedModelId);
    if (!target || target !== this.viewer.transform.object) return null;
    if (joint) return joint.quaternion.toArray();
    return [target.rotation.x, target.rotation.y, target.rotation.z].map(degrees);
  }

  canPlaceScene() {
    return ['human', 'glb'].includes(this.doc?.source.kind)
      || (this.doc?.sceneBackground?.visible !== false && !!canvasBackgroundAsset(this.doc || {}));
  }

  placementTarget() {
    if (this.selectedPlacementAsset === 'background') {
      return this.sceneBackground?.visible ? { root: this.sceneBackground } : null;
    }
    if (this.selectedPlacementAsset === 'glb') {
      return this.doc.source.kind === 'glb' ? { root: this.glb } : null;
    }
    const model = this.selectedModel();
    if (model) return !model.locked && model.visible !== false ? { item: model, root: this.propRoots.get(model.id), model: true } : null;
    const actor = activeActor(this.doc);
    if (this.doc.source.kind !== 'human' || !this.doc.selectedActorIds?.includes(actor?.id) || actor.locked || actor.visible === false) return null;
    return { item: actor, root: this.actorRoots.get(actor.id), model: false };
  }

  updatePlacementGizmo() {
    const transform = this.viewer.transform;
    if (this.mode !== 'position' || !transform || transform.dragging) return;
    const root = this.placementTarget()?.root;
    if (root && transform.object !== root) {
      transform.setMode('translate');
      transform.setSpace('world');
      transform.attach(root);
    } else if (!root && transform.object) transform.detach();
    this.viewer.requestRender();
  }

  interactionSnapshot() {
    if (this.mode === 'position') return JSON.stringify(this.viewer.transform.object?.position.toArray());
    return JSON.stringify(this.modelRotation() ?? this.animal?.pose() ?? this.viewer.getPose());
  }

  savePlacementPosition() {
    const target = this.placementTarget();
    if (!target?.root || target.root !== this.viewer.transform.object) return;
    const { x, y, z } = target.root.position;
    if (target.item) {
      Object.assign(target.item.transform, { x, y, z });
      if (target.model) this.updateProp(target.item);
      else this.updateActorTransform(target.item);
    } else if (this.selectedPlacementAsset === 'background') {
      const settings = this.doc.sceneBackground;
      const [centerX, centerY, centerZ] = settings.frame.center;
      Object.assign(settings, { x: x - centerX, y: y - centerY, z: z - centerZ });
    } else this.doc.source.position = [x, y, z];
    this.viewer.requestRender();
  }

  setMode(mode) {
    this.finishDrag?.();
    if ((mode === 'position' && !this.canPlaceScene()) || (mode === 'edit' && ['splat', 'empty'].includes(this.doc.source.kind))) mode = 'camera';
    this.mode = mode;
    const actor = activeActor(this.doc);
    const model = this.selectedModel();
    const editable = !model && !!actor && this.doc.selectedActorIds?.includes(actor.id) && this.doc.source.kind === 'human' && !actor.locked && actor.visible !== false;
    for (const animal of this.animalActors.values()) animal.handles.visible = mode === 'edit' && animal === this.animal && editable;
    const editHuman = editable && !this.animal;
    this.viewer.setIKMode(mode === 'edit' && editHuman);
    this.viewer.transform.detach();
    this.viewer.transform.setSize(this.animal && !model ? 0.46 : 0.8);
    this.viewer.transform.visible = mode === 'edit' && editHuman;
    if (mode === 'edit' && model && !model.locked && model.visible !== false) {
      const target = this.modelJoints()[this.modelJoint]?.bone || this.propRoots.get(model.id);
      if (target) {
        this.viewer.transform.setMode('rotate'); this.viewer.transform.setSpace('local');
        this.viewer.transform.attach(target);
      }
    } else if (mode === 'position') this.updatePlacementGizmo();
    else if (this.animal) this.selectAnimalJoint(editable ? this.animalSelection : '');
    this.viewer.skeletonHelper && (this.viewer.skeletonHelper.visible = false);
    this.viewer.jointMarkers.forEach(marker => { marker.visible = mode === 'edit' && editHuman && this.viewer._shouldMarkerBeVisible(marker); });
    this.viewer.orbit.enabled = mode === 'edit' || mode === 'position';
    this.shotHelper.visible = mode === 'edit';
    this.updateShot(mode === 'camera');
  }

  selectAnimalJoint(name) {
    const rig = this.animal;
    if (!rig) return;
    this.animalSelection = name;
    const joint = rig.handles.visible && rig.joints.get(name);
    const transform = this.viewer.transform;
    if (!transform.dragging) {
      if (joint) {
        transform.setMode('rotate'); transform.setSpace('local'); transform.attach(joint);
      } else transform.detach();
    }
    rig.update(name);
    this.viewer.requestRender();
  }

  currentViewAsShot() {
    const v = this.viewer;
    const delta = v.camera.position.clone().sub(v.orbit.target);
    const distance = delta.length();
    this.doc.camera.azimuth = degrees(Math.atan2(delta.x, delta.z));
    this.doc.camera.elevation = degrees(Math.asin(delta.y / distance));
    this.doc.camera.zoom = v.camera.zoom * 45 / distance * Math.tan(radians(15)) / Math.tan(radians(v.camera.fov / 2));
    const target = this.baseTarget;
    this.doc.camera.offsetX = target.x - v.orbit.target.x;
    this.doc.camera.offsetY = target.y - v.orbit.target.y;
    this.doc.camera.offsetZ = target.z - v.orbit.target.z;
    this.updateShot(true);
  }

  async capture(width = this.doc.width, height = this.doc.height, options = {}) {
    const backgroundAsset = !options.depth && !options.canny && !options.actorIds && this.doc.sceneBackground?.visible !== false && canvasBackgroundAsset(this.doc);
    const backgroundPlane = backgroundAsset ? await this.loadSceneBackground() : null;
    if (backgroundAsset && !backgroundPlane) throw new Error('Could not load the scene background. Replace or clear the reference image.');
    if (this.doc.source.kind === 'empty' && !backgroundPlane) throw new Error('Rebuild the source subject or import its 3D scene first.');
    await this.waitForCaptureReady();
    const v = this.viewer;
    const content = this.splat?.root || this.animal?.root || (this.doc.source.kind === 'glb' ? this.glb : v.skinnedMesh);
    if (!content && !backgroundPlane) throw new Error('The scene has no renderable assets.');
    const contents = this.doc.source.kind === 'human' && this.actorRoots?.size
      ? [...(options.actorIds ? this.doc.actors.filter(actor => options.actorIds.includes(actor.id)) : visibleActors(this.doc)).map(actor => this.actorRoots.get(actor.id)),
        ...(!options.actorIds ? (this.doc.props || []).filter(prop=>prop.visible!==false).map(prop=>this.propRoots.get(prop.id)) : [])].filter(Boolean) : this.doc.source.kind === 'empty' ? [] : [content].filter(Boolean);
    if (!contents.length && !backgroundPlane) throw new Error('Make at least one character visible.');
    if (options.depth && this.splat) throw new Error('Use DA3 source depth for a TripoSplat reconstruction.');
    const visibility = v.scene.children.map(object => [object, object.visible]);
    // VNCCS attaches joint markers below the skinned mesh, not just to the scene.
    const nestedHelpers = this.doc.source.kind === 'human'
      ? [...v.jointMarkers, ...Object.values(v.ikController?.effectors || {}),
        ...Object.values(v.ikController?.poleTargets || {}), ...(v._handRings || [])]
        .filter(Boolean).map(object => [object, object.visible]) : [];
    const background = v.scene.background;
    const overrideMaterial = v.scene.overrideMaterial;
    const actorColors = [];
    let depthMaterial = null, cannyMaterial = null, captureBackground = null;
    this.capturing = true;
    let restoreSplat = null, restoreBackgroundMap = null;
    try {
      if (v._renderFrame) { cancelAnimationFrame(v._renderFrame); v._renderFrame = null; }
      if (this.splat) this.splat.configureCamera(v.captureCamera, this.doc, width, height);
      else this.configureCapture(width, height);
      // Pointer input may update the live cameras while sorting awaits a worker.
      const camera = v.captureCamera.clone();
      if (this.splat) {
        restoreSplat = this.splat.beginOffscreenCapture(width, height);
        await this.splat.prepareCapture(v.renderer, camera);
      }
      // Positive content selection excludes every editor overlay, even newly added helpers.
      for (const [object] of visibility) object.visible = contents.includes(object) || !!object.isLight;
      for (const [object] of nestedHelpers) object.visible = false;
      v.scene.background = new THREE.Color(this.doc.background);
      if (backgroundPlane?.parent === v.scene) {
        backgroundPlane.visible = true;
        if (this.splat) {
          const texture = backgroundPlane.material.map;
          captureBackground = texture.clone();
          captureBackground.colorSpace = THREE.NoColorSpace;
          backgroundPlane.material.map = captureBackground;
          restoreBackgroundMap = () => { backgroundPlane.material.map = texture; };
        }
      }
      if (this.doc.source.kind === 'human' && this.doc.conditioning?.colorActors !== true) {
        for (const actor of visibleActors(this.doc)) for (const material of this.animalActors.get(actor.id)?.colors.slice(0, 1) || [].concat(this.actorMesh(actor.id)?.material || [])) {
          if (material.color) { actorColors.push([material, material.color.clone()]); material.color.set('#e3e9ee'); }
        }
      }
      if (this.doc.conditioning?.colorActors === true && !options.depth && !options.canny && !options.actorIds) {
        for (const model of this.doc.props || []) {
          if (model.visible === false || !model.editorColor) continue;
          const materials = new Set();
          this.propRoots.get(model.id)?.traverse(mesh => {
            if (mesh.isMesh) for (const material of [].concat(mesh.material || [])) if (material.color) materials.add(material);
          });
          for (const material of materials) {
            actorColors.push([material, material.color.clone()]);
            material.color.set(model.editorColor);
          }
        }
      }
      if (options.depth) {
        camera.updateMatrixWorld(true);
        const bounds = this.doc.source.kind === 'human' ? this.humanBounds() : worldBounds(content);
        const depths = [];
        for (const x of [bounds.min.x, bounds.max.x]) for (const y of [bounds.min.y, bounds.max.y]) for (const z of [bounds.min.z, bounds.max.z])
          depths.push(-new THREE.Vector3(x, y, z).applyMatrix4(camera.matrixWorldInverse).z);
        const near = Math.max(camera.near, Math.min(...depths)), far = Math.max(near + 0.001, Math.max(...depths));
        depthMaterial = new THREE.MeshDepthMaterial({ depthPacking: THREE.BasicDepthPacking });
        depthMaterial.onBeforeCompile = shader => {
          shader.uniforms.sceneNear = { value: near }; shader.uniforms.sceneFar = { value: far };
          shader.uniforms.cameraNear = { value: camera.near }; shader.uniforms.cameraFar = { value: camera.far };
          shader.uniforms.nearWhite = { value: this.doc.conditioning.depthInvert ? 0 : 1 };
          shader.fragmentShader = 'uniform float sceneNear; uniform float sceneFar; uniform float cameraNear; uniform float cameraFar; uniform float nearWhite;\n' + shader.fragmentShader;
          shader.fragmentShader = shader.fragmentShader.replace('gl_FragColor = vec4( vec3( 1.0 - fragCoordZ ), opacity );',
            'float linearDepth = -perspectiveDepthToViewZ(fragCoordZ, cameraNear, cameraFar); float t = clamp((linearDepth-sceneNear)/(sceneFar-sceneNear),0.0,1.0); gl_FragColor = vec4(vec3(mix(t,1.0-t,nearWhite)),1.0);');
        };
        v.scene.overrideMaterial = depthMaterial; v.scene.background = new THREE.Color('#000000');
      } else if (options.canny && !this.splat) {
        // Structure edges must not disappear when an actor color and the user
        // background have similar luminance. Render mesh geometry as lit clay
        // for this offscreen pass only; keep the real camera and depth test.
        cannyMaterial = new THREE.MeshStandardMaterial({ color: '#eeeeee', roughness: 1, metalness: 0, side: THREE.DoubleSide });
        v.scene.overrideMaterial = cannyMaterial;
        v.scene.background = new THREE.Color('#000000');
      }
      // The bundled splat shader writes already encoded RGB, unlike Three's
      // standard mesh materials. Preserve those colors and its background.
      if (this.splat && v.scene.background.isColor) v.scene.background.convertLinearToSRGB();
      v.scene.updateMatrixWorld(true);
      v.skeleton?.update();
      return capturePNG(v.renderer, v.scene, camera, width, height,
        this.splat || options.depth ? THREE.NoColorSpace : THREE.SRGBColorSpace);
    } finally {
      for (const [object, visible] of visibility) object.visible = visible;
      for (const [object, visible] of nestedHelpers) object.visible = visible;
      v.scene.background = background;
      v.scene.overrideMaterial = overrideMaterial; depthMaterial?.dispose(); cannyMaterial?.dispose();
      restoreBackgroundMap?.(); captureBackground?.dispose();
      for (const [material, color] of actorColors) material.color.copy(color);
      try { restoreSplat?.(); }
      finally { this.capturing = false; this.updateShot(); this.loadSceneBackground(); }
    }
  }

  fit(selected = false) {
    if (this.doc.source.kind === 'splat') {
      this.doc.camera = { azimuth: 0, elevation: 0, zoom: 1, offsetX: 0, offsetY: 0, offsetZ: 0 };
      this.updateShot(true); return;
    }
    if (this.doc.source.kind === 'empty') return;
    const content = this.animal?.root || (this.doc.source.kind === 'glb' ? this.glb : this.viewer.skinnedMesh);
    const model = selected && this.selectedModel();
    const modelRoot = model && this.propRoots.get(model.id);
    if (model && !modelRoot) return;
    const bounds = model ? worldBounds(modelRoot)
      : this.doc.source.kind === 'human' && this.actorRoots?.size ? this.humanBounds(selected) : worldBounds(content);
    if (bounds.isEmpty()) return;
    this.doc.camera.zoom = 1;
    const center = bounds.getCenter(new THREE.Vector3());
    this.doc.camera.offsetX = this.baseTarget.x - center.x;
    this.doc.camera.offsetY = this.baseTarget.y - center.y;
    this.doc.camera.offsetZ = this.baseTarget.z - center.z;
    this.updateShot();
    this.viewer.captureCamera.updateMatrixWorld(true);
    let extent = 0;
    for (const x of [bounds.min.x, bounds.max.x]) for (const y of [bounds.min.y, bounds.max.y]) for (const z of [bounds.min.z, bounds.max.z]) {
      const point = new THREE.Vector3(x, y, z).project(this.viewer.captureCamera);
      extent = Math.max(extent, Math.abs(point.x), Math.abs(point.y));
    }
    this.doc.camera.zoom = clamp(0.83 / Math.max(extent, 0.01), 0.1, 8);
    this.updateShot(true);
  }

  setPreset(preset) {
    if (this.animal) return;
    if (!this.restoring && activeActor(this.doc)?.locked) throw new Error('Unlock the character first.');
    this.viewer.setPose({ bones: preset.bones }, true);
    if (!this.restoring) this.useRigPose();
    this.syncPose();
    this.setMode(this.mode);
  }

  hand(side, preset) { this.viewer.applyHandPreset(side, HAND_PRESETS[preset]); this.syncPose(); }

  applyOpenPose(points, flips = {}, mode = 'estimated') {
    if (activeActor(this.doc)?.locked) throw new Error('Unlock the character first.');
    const actor = activeActor(this.doc), root = this.actorRoots?.get(actor?.id);
    if (!root) return this._applyOpenPose(points, flips, mode);
    // Lift in an untransformed reference plane, then place that pose in its role's world frame.
    root.position.set(0, 0, 0); root.rotation.set(0, 0, 0); root.scale.setScalar(1); root.updateMatrixWorld(true);
    try { return this._applyOpenPose(points, flips, mode); }
    finally { this.updateActorTransform(actor); this.viewer.updateIKEffectorPositions(); this.viewer.updateMarkers(); }
  }

  _applyOpenPose(points, flips = {}, mode = 'estimated') {
    if (this.doc.source.kind !== 'human') throw new Error('Switch to a mannequin before applying an OpenPose pose.');
    const viewer = this.viewer;
    if (mode === 'estimated') viewer.resetPose();
    viewer.skinnedMesh.updateMatrixWorld(true);
    const worldOf = name => viewer.bones[name].getWorldPosition(new THREE.Vector3()).toArray();
    const joints = { ls: 'upperarm_l', le: 'lowerarm_l', lw: 'hand_l', rs: 'upperarm_r', re: 'lowerarm_r', rw: 'hand_r',
      lh: 'thigh_l', lk: 'calf_l', la: 'foot_l', rh: 'thigh_r', rk: 'calf_r', ra: 'foot_r' };
    const rest = Object.fromEntries(Object.entries(joints).map(([key, bone]) => [key, worldOf(bone)]));
    rest.neck = rest.ls.map((value, i) => (value + rest.rs[i]) / 2);
    rest.hipMid = rest.lh.map((value, i) => (value + rest.rh[i]) / 2);
    const head = worldOf('head'), pelvis = worldOf('pelvis');
    if (mode === 'conservative') {
      rest.head = head; rest.pelvis = pelvis;
      const kps = copyVisiblePose(points, rest);
      const worldKps = Object.fromEntries(Object.entries(kps).filter(([key]) => WORLD_KEYPOINT_NAMES[key])
        .map(([key, value]) => [WORLD_KEYPOINT_NAMES[key], new THREE.Vector3(...value)]));
      const applied = viewer.applyWorldKeypointImport(worldKps, { drawFigure: false, placeHipRoots: false,
        alignHead: false, alignHands: false, alignFeet: false, dispatchPoseChange: false });
      if (!applied) throw new Error('Could not copy the visible joints. Check the character photo.');
      this.useRigPose(); this.syncPose(); this.updateShot(true);
      return false;
    }
    const { kps, facingAway } = liftOpenPose(points, rest, flips);
    const distance = Math.hypot(...head.map((value, i) => value - rest.neck[i]));
    const direction = kps.head.map((value, i) => value - kps.neck[i]);
    const norm = Math.hypot(...direction) || 1;
    kps.head = kps.neck.map((value, i) => value + direction[i] / norm * distance);
    const worldKps = Object.fromEntries(Object.entries(WORLD_KEYPOINT_NAMES).map(([key, name]) =>
      [name, new THREE.Vector3(...kps[key].map((value, i) => value + pelvis[i]))]));
    const applied = viewer.applyWorldKeypointImport(worldKps, { drawFigure: false, placeHipRoots: false, alignHead: false,
      alignHands: false, alignFeet: false, dispatchPoseChange: false });
    if (!applied) throw new Error('Could not apply the OpenPose skeleton to the mannequin. Check the skeleton image.');
    this.doc.pose = this.pose();
    this.updateShot(true);
    return facingAway;
  }

  captureOpenPose(width = this.doc.width, height = this.doc.height) {
    if (this.doc.source.kind !== 'human') throw new Error('An OpenPose guide requires a mannequin scene.');
    const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
    const context = canvas.getContext('2d');
    context.fillStyle = '#000'; context.fillRect(0, 0, width, height);
    this.viewer.captureCamera.updateMatrixWorld(true);
    context.lineCap = 'round'; context.lineJoin = 'round'; context.lineWidth = Math.max(3, Math.min(width, height) / 120);
    for (const { positions, hands, features } of this.projectPeople(width, height)) {
    context.lineWidth = Math.max(3, Math.min(width, height) / 120);
    LIMBS.forEach(([from, to], index) => {
      if (!positions[ORDER[from]] || !positions[ORDER[to]]) return;
      context.strokeStyle = COLORS[index]; context.beginPath(); context.moveTo(...positions[ORDER[from]]);
      context.lineTo(...positions[ORDER[to]]); context.stroke();
    });
    ORDER.forEach((name, index) => {
      if (!positions[name]) return;
      context.fillStyle = COLORS[index]; context.beginPath();
      context.arc(...positions[name], Math.max(3, Math.min(width, height) / 85), 0, Math.PI * 2); context.fill();
    });
    for (const [name, color] of [['reye', '#ff00ff'], ['leye', '#aa00ff']]) if (features.nose && features[name]) {
      context.strokeStyle = color; context.beginPath(); context.moveTo(...features.nose); context.lineTo(...features[name]); context.stroke();
      context.fillStyle = color; context.beginPath(); context.arc(...features[name], Math.max(2, Math.min(width,height)/180), 0, Math.PI*2); context.fill();
    }
    for (const side of ['l', 'r']) if (hands?.[side]) {
      const points = hands[side];
      for (let finger = 0; finger < 5; finger++) for (let joint = 0; joint < 4; joint++) {
        const from = joint ? points[1+finger*4+joint-1] : points[0], to = points[1+finger*4+joint];
        if (!from || !to) continue;
        context.strokeStyle = `hsl(${finger*72+joint*12},100%,50%)`; context.lineWidth = Math.max(1, Math.min(width,height)/350);
        context.beginPath(); context.moveTo(...from); context.lineTo(...to); context.stroke();
      }
    }
    }
    return canvas.toDataURL('image/png');
  }

  projectPeople(width = this.doc.width, height = this.doc.height) {
    this.configureCapture(width, height); this.viewer.captureCamera.updateMatrixWorld(true);
    const camera = this.viewer.captureCamera;
    const actors = this.doc.actors?.length ? visibleActors(this.doc).filter(actor => actor.source.kind !== 'animal') : [{ id: null }];
    const names = { head: 'head', rs: 'upperarm_r', re: 'lowerarm_r', rw: 'hand_r', ls: 'upperarm_l', le: 'lowerarm_l', lw: 'hand_l',
      rh: 'thigh_r', rk: 'calf_r', ra: 'foot_r', lh: 'thigh_l', lk: 'calf_l', la: 'foot_l' };
    const meshes = actors.map(actor => actor.id ? this.actorMesh(actor.id) : this.viewer.skinnedMesh).filter(Boolean);
    meshes.forEach(mesh => { mesh.updateMatrixWorld(true); mesh.skeleton?.update(); mesh.computeBoundingSphere?.(); });
    const propMeshes = [];
    if (this.doc.conditioning?.poseOcclusion === 'visible') for (const prop of this.doc.props || []) {
      const root = prop.visible !== false && this.propRoots?.get(prop.id); if (!root) continue;
      root.updateMatrixWorld(true); root.traverseVisible(object => { if (object.isMesh) propMeshes.push(object); });
    }
    const raycaster = new THREE.Raycaster();
    return actors.map(actor => {
      const bones = actor.id ? this.actorBones(actor.id) : this.viewer.bones, positions = {}, visibility = {}, hands = {};
      const mesh = actor.id ? this.actorMesh(actor.id) : this.viewer.skinnedMesh;
      // Joint centers lie inside their own skin; only other actors and visible props occlude them.
      const occluders = this.doc.conditioning?.poseOcclusion === 'visible' ? [...meshes.filter(item => item !== mesh), ...propMeshes] : [];
      const projectWorld = world => {
        const point = world.clone().project(camera);
        if (point.z < -1 || point.z > 1) return null;
        if (this.doc.conditioning?.poseOcclusion === 'visible') {
          const vector = world.clone().sub(camera.position), distance = vector.length();
          raycaster.set(camera.position, vector.normalize()); raycaster.far = Math.max(0, distance - 0.01);
          if (raycaster.intersectObjects(occluders, false).length) return null;
        }
        return [(point.x + 1) * width / 2, (1 - point.y) * height / 2];
      };
      const landmarks = actor.id && actor.id !== this.doc.activeActorId ? this.viewer.passiveCharacters.get(actor.id)?.modelLandmarkIndices : this.viewer.modelLandmarkIndices;
      const features = {};
      for (const [key, name] of [['nose','nose'], ['left_eye','leye'], ['right_eye','reye']]) if (landmarks?.[key]?.length && mesh?.getVertexPosition) {
        const center = new THREE.Vector3();
        for (const index of landmarks[key]) center.add(mesh.getVertexPosition(index, new THREE.Vector3()));
        features[name] = projectWorld(mesh.localToWorld(center.divideScalar(landmarks[key].length)));
      }
      for (const [name, bone] of Object.entries(names)) if (bones?.[bone]) {
        const world = bones[bone].getWorldPosition(new THREE.Vector3()), point = world.clone().project(camera);
        positions[name] = [(point.x + 1) * width / 2, (1 - point.y) * height / 2];
        visibility[name] = point.z >= -1 && point.z <= 1;
        if (this.doc.conditioning?.poseOcclusion === 'visible') {
          const vector = world.clone().sub(camera.position), distance = vector.length();
          raycaster.set(camera.position, vector.normalize()); raycaster.far = Math.max(0, distance - 0.01);
          visibility[name] &&= raycaster.intersectObjects(occluders, false).length === 0;
        }
      }
      if (positions.ls && positions.rs) { positions.neck = positions.ls.map((value, i) => (value + positions.rs[i]) / 2); visibility.neck = visibility.ls || visibility.rs; }
      for (const name of Object.keys(positions)) if (!visibility[name]) delete positions[name];
      if (features.nose) positions.head = features.nose;
      if (this.doc.conditioning?.poseHands) for (const side of ['l', 'r']) {
        const hand = bones?.[`hand_${side}`]; if (!hand) continue;
        hands[side] = [projectWorld(hand.getWorldPosition(new THREE.Vector3()))];
        for (const finger of ['thumb', 'index', 'middle', 'ring', 'pinky']) {
          for (const index of ['01', '02', '03']) {
            const bone = bones[`${finger}_${index}_${side}`]; hands[side].push(bone ? projectWorld(bone.getWorldPosition(new THREE.Vector3())) : null);
          }
          const tip = bones[`${finger}_03_${side}`], head = tip?.userData.headPos, tail = tip?.userData.tailPos;
          hands[side].push(head && tail ? projectWorld(tip.localToWorld(new THREE.Vector3(...tail).sub(new THREE.Vector3(...head)))) : null);
        }
      }
      return { id: actor.id, positions, bones, hands, features };
    });
  }

  poseJSON(width = this.doc.width, height = this.doc.height) {
    return { version: '1.3', canvas_width: width, canvas_height: height,
      people: this.projectPeople(width, height).map(({ id, positions, features, hands }) => ({ actor_id: id,
        pose_keypoints_2d: Array.from({ length: 18 }, (_, i) => {
          // Head-bone location is not a measured nose landmark.
          const point = i === 0 ? features.nose : i === 14 ? features.reye : i === 15 ? features.leye : i < ORDER.length ? positions[ORDER[i]] : null;
          return point ? [...point, 1] : [0, 0, 0];
        }).flat(), face_keypoints_2d: [], hand_left_keypoints_2d: (hands.l || []).flatMap(point => point ? [...point,1] : [0,0,0]),
        hand_right_keypoints_2d: (hands.r || []).flatMap(point => point ? [...point,1] : [0,0,0]) })) };
  }

  groundModel(model) {
    const root = this.propRoots.get(model.id);
    if (!root || model.locked || model.visible === false) return;
    const bounds = worldBounds(root);
    if (bounds.isEmpty()) return;
    const floor = this.grid?.position ? this.grid.position.y + 0.03 : 0;
    model.transform.y += floor - bounds.min.y;
    this.updateProp(model);
  }

  groundActors(ids = [this.doc.activeActorId]) {
    const floor = this.grid?.position ? this.grid.position.y + 0.03 : 0;
    this.viewer.scene.updateMatrixWorld(true);
    for (const actor of this.doc.actors || []) if (ids.includes(actor.id) && !actor.locked) {
      const animal = this.animalActors.get(actor.id);
      if (animal) {
        actor.transform.y += floor - worldBounds(animal.root).min.y;
        this.updateActorTransform(actor);
        continue;
      }
      const mesh = this.actorMesh(actor.id); if (!mesh) continue;
      mesh.skeleton.update();
      const index=mesh.geometry.index, seen=new Set(), point=new THREE.Vector3();
      let minimum=Infinity;
      // The body buffer also contains vertices excluded from the visible index.
      // Their standing-rest positions must not keep a seated figure in the air.
      for(let i=0,count=index?index.count:mesh.geometry.attributes.position.count;i<count;i++){
        const vertex=index?index.getX(i):i;if(seen.has(vertex))continue;seen.add(vertex);
        mesh.getVertexPosition(vertex,point).applyMatrix4(mesh.matrixWorld);minimum=Math.min(minimum,point.y);
      }
      if(!Number.isFinite(minimum))continue;
      actor.transform.y += floor - minimum;
      this.updateActorTransform(actor);
    }
  }

  async alignHands(idA, sideA, idB, sideB) {
    const actors = [idA,idB].map(id=>this.doc.actors.find(actor=>actor.id===id));
    if (actors.some(actor=>!actor||actor.locked)) throw new Error('Hand alignment requires two unlocked characters.');
    const handA=this.actorBones(idA)?.[`hand_${sideA}`], handB=this.actorBones(idB)?.[`hand_${sideB}`];
    if(!handA||!handB) throw new Error('Character is missing hand joints.');
    this.viewer.scene.updateMatrixWorld(true);
    const anchor=handA.getWorldPosition(new THREE.Vector3()).add(handB.getWorldPosition(new THREE.Vector3())).multiplyScalar(.5);
    const active=this.doc.activeActorId;
    for(const[id,side]of [[idA,sideA],[idB,sideB]]){
      await this.selectActor(id);const controller=this.viewer.ikController,key=controller.getChainForEffector(`hand_${side}`),old=controller.getMode(key);
      controller.setMode(key,'ik');try { for(let i=0;i<8;i++)controller.solve(this.viewer.bones,new Map([[`hand_${side}`,anchor]])); }
      finally{controller.setMode(key,old);}
      this.viewer.updateIKEffectorPositions();this.viewer.updateMarkers();this.syncPose();
    }
    await this.selectActor(active);this.doc.contacts=[{id:uuid(),actors:[idA,idB],sides:[sideA,sideB],anchor:anchor.toArray(),mode:'align-once'}];
    this.useRigPose();this.viewer.requestRender();
  }

  async morph() {
    const pose = { bones: this.pose().bones, modelRotation: this.pose().modelRotation };
    this.restoring = true;
    try {
      this.buildHuman(pose);
      // Body changes preserve the common scene target and every camera setting.
      this.setMode(this.mode);
      this.syncPose();
      await this.waitForCaptureReady();
    } finally { this.restoring = false; }
  }

  bindCamera() {
    const canvas = this.canvas;
    let drag = null, beginning = false, rigPointerId = null;
    const beginChange = () => {
      if (!drag.changed) {
        beginning = true;
        try { drag.rollback = this.callbacks.begin(); drag.changed = true; }
        finally { beginning = false; }
      }
    };
    const end = (updateControls = true) => {
      if (!drag || beginning) return false;
      const changed = drag.changed; drag = null;
      if (changed) this.callbacks.change(true, updateControls);
      return true;
    };
    this.finishDrag = (updateControls = true) => {
      if (beginning || this.beginningRigGesture) return false;
      this.rigPointerDown = false;
      let finished = end(updateControls);
      if (this.viewer.directDrag?.active || this.viewer.transform?.dragging) {
        const previous = this.interactionControls;
        this.interactionControls = updateControls;
        try {
          if (this.viewer.directDrag?.active) this.viewer.handlePointerUp({ pointerId: rigPointerId });
          else {
            canvas.removeEventListener('pointermove', this.viewer.transform._onPointerMove);
            this.viewer.transform.pointerUp({ button: 0 });
            if (canvas.hasPointerCapture(rigPointerId)) canvas.releasePointerCapture(rigPointerId);
          }
        }
        finally { this.interactionControls = previous; }
        finished = true;
      }
      return finished;
    };
    const pickRay = event => {
      const rect = canvas.getBoundingClientRect(), raycaster = new THREE.Raycaster();
      raycaster.setFromCamera(new THREE.Vector2((event.clientX - rect.left) / rect.width * 2 - 1, 1 - (event.clientY - rect.top) / rect.height * 2), this.viewer.camera);
      return raycaster;
    };
    const pickScene = raycaster => {
      const mesh = visibleActors(this.doc).map(actor => this.actorMesh(actor.id)).filter(Boolean);
      for (const item of mesh) { item.updateMatrixWorld(true); item.skeleton.update(); item.computeBoundingBox(); item.computeBoundingSphere(); }
      const animals = visibleActors(this.doc).map(actor => this.animalActors.get(actor.id)?.root).filter(Boolean);
      const models = [...(this.propRoots?.values() || [])].filter(root => root.visible);
      return [...raycaster.intersectObjects(mesh, false), ...raycaster.intersectObjects([...animals, ...models], true)]
        .sort((first, second) => first.distance - second.distance)[0];
    };
    canvas.addEventListener('pointerdown', event => {
      if (event.button !== 0 && event.button !== 1) return;
      if (drag) { event.stopImmediatePropagation(); event.preventDefault(); return; }
      if (this.mode !== 'camera' && event.button === 0) { rigPointerId = event.pointerId; this.rigPointerDown = true; }
      if (this.mode !== 'camera' && event.button === 0 && !event.shiftKey) {
        const transform = this.viewer.transform;
        if (transform.object) {
          transform.pointerHover(transform._getPointer(event));
          if (transform.axis) return;
        }
      }
      if (this.animal?.handles.visible && this.mode === 'edit' && event.button === 0 && !event.shiftKey && !event.ctrlKey && !event.metaKey) {
        const transform = this.viewer.transform;
        transform.pointerHover(transform._getPointer(event));
        const raycaster = pickRay(event);
        const hit = raycaster.intersectObjects(this.animal.handles.children, false)[0];
        if (hit) {
          event.stopImmediatePropagation(); event.preventDefault();
          const { name, target } = hit.object.userData;
          this.callbacks.select?.(target ? name + ' root' : name);
          const pose = this.animal.pose();
          const joint = this.animal.joints.get(name);
          const limbBend = this.animal.isLimbBend(joint);
          drag = { pointerId: event.pointerId, animal: this.animal, joint, pose, x: event.clientX, y: event.clientY };
          if (target || limbBend || name === 'Pelvis') {
            const center = hit.object.position.clone();
            const normal = this.viewer.camera.getWorldDirection(new THREE.Vector3());
            const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, center);
            const point = raycaster.ray.intersectPlane(plane, new THREE.Vector3());
            if (!point) { drag = null; return; }
            Object.assign(drag, { plane, offset: center.sub(point), animalTarget: target ? name : null });
            if (name === 'Pelvis') {
              drag.footLimits = this.animal.pelvisFootLimits(this.grid.position.y + 0.03);
            }
          }
          canvas.setPointerCapture(event.pointerId);
          return;
        }
        if (transform.object && transform.axis) return;
        if (this.animalSelection) this.callbacks.select?.('');
      }
      if (this.mode !== 'camera' && event.button === 0 && !event.shiftKey) {
        const raycaster = pickRay(event);
        const humanScene = this.doc.source.kind === 'human';
        if (this.mode === 'edit' && humanScene && !this.animal && this.doc.selectedActorIds?.includes(this.doc.activeActorId)) {
          const handles = [...this.viewer._getRaycastableJointMarkers(), ...Object.values(this.viewer.ikController?.poleTargets || {}).filter(handle => handle.visible)];
          if (raycaster.intersectObjects(handles, false).length) return;
        }
        const hit = humanScene && pickScene(raycaster);
        if (this.mode === 'position' && !hit) {
          const glbHit = this.doc.source.kind === 'glb' && this.glb && raycaster.intersectObject(this.glb, true).length;
          const backgroundHit = this.sceneBackground?.visible && raycaster.intersectObject(this.sceneBackground).length;
          if (glbHit || backgroundHit) {
            this.callbacks.clearSelection?.();
            this.selectedPlacementAsset = glbHit ? 'glb' : 'background';
            this.updatePlacementGizmo();
            event.stopImmediatePropagation(); event.preventDefault();
            return;
          }
        }
        if (!humanScene && this.mode !== 'position') return;
        if (!hit) {
          this.callbacks.clearSelection?.();
          return;
        }
        let object = hit?.object;
        while (object && !object.userData.actorId && !object.userData.modelId) object = object.parent;
        const modelId = object?.userData.modelId;
        const id = object?.userData.actorId;
        if (id && (id !== this.doc.activeActorId || !this.doc.selectedActorIds?.includes(id) || this.selectedModelId || this.selectedPlacementAsset || event.ctrlKey || event.metaKey)) {
          event.stopImmediatePropagation(); event.preventDefault(); this.callbacks.pick?.(id, event.ctrlKey || event.metaKey); return;
        }
        if (this.mode === 'edit' && (modelId || this.selectedModel())) {
          event.stopImmediatePropagation(); event.preventDefault();
          if (modelId && modelId !== this.selectedModelId) this.callbacks.pickModel?.(modelId);
          return;
        }
        if (this.mode === 'position') {
          event.stopImmediatePropagation(); event.preventDefault();
          if (modelId) this.callbacks.pickModel?.(modelId);
          const target = modelId ? this.doc.props.find(model => model.id === modelId) : activeActor(this.doc);
          if (!target || target.locked) return;
          const normal = this.doc.interaction?.movePlane === 'ground' ? new THREE.Vector3(0, 1, 0) : this.viewer.camera.getWorldDirection(new THREE.Vector3());
          const root = modelId ? this.propRoots.get(modelId) : this.actorRoots.get(target.id);
          const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, root.position);
          const point = raycaster.ray.intersectPlane(plane, new THREE.Vector3()); if (!point) return;
          drag = { pointerId: event.pointerId, placementId: target.id, model: !!modelId, plane, point, transform: { ...target.transform } };
          canvas.setPointerCapture(event.pointerId); return;
        }
        return;
      }
      // Non-photo view navigation belongs to OrbitControls; it leaves the shot intact.
      if (this.mode !== 'camera') return;
      event.stopImmediatePropagation(); event.preventDefault();
      drag = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, camera: { ...this.doc.camera }, pan: event.button === 1 || event.shiftKey };
      if (drag.pan && this.doc.source.kind !== 'splat') drag.panQuaternion = this.viewer.captureCamera.quaternion.clone();
      canvas.setPointerCapture(event.pointerId);
    }, true);
    canvas.addEventListener('auxclick', event => { if (this.mode === 'camera' && event.button === 1) event.preventDefault(); });
    canvas.addEventListener('pointermove', event => {
      if (this.mode === 'camera' || drag) event.stopImmediatePropagation();
      if (!drag || event.pointerId !== drag.pointerId) return;
      if (drag.animal && !drag.changed && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 3) return;
      if (drag.joint && !drag.plane) {
        const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
        beginChange();
        drag.animal.restore(drag.pose);
        const axis = new THREE.Vector3(dy, dx, 0).applyQuaternion(this.viewer.camera.quaternion);
        const angle = axis.length() * 0.01;
        if (angle) {
          axis.normalize().applyQuaternion(drag.joint.parent.getWorldQuaternion(new THREE.Quaternion()).invert());
          drag.joint.quaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(axis, angle)).normalize();
        }
        drag.animal.update(this.animalSelection);
        this.viewer.requestRender();
        return;
      }
      if (drag.animal) {
        const rect = canvas.getBoundingClientRect(), raycaster = new THREE.Raycaster();
        raycaster.setFromCamera(new THREE.Vector2((event.clientX - rect.left) / rect.width * 2 - 1, 1 - (event.clientY - rect.top) / rect.height * 2), this.viewer.camera);
        const point = raycaster.ray.intersectPlane(drag.plane, new THREE.Vector3());
        if (!point) return;
        beginChange();
        drag.animal.restore(drag.pose);
        const destination = point.add(drag.offset);
        if (drag.footLimits) drag.animal.dragPelvis(destination, drag.footLimits);
        else if (drag.animalTarget) drag.animal.drag(drag.animalTarget, destination);
        else drag.animal.dragLimbBend(drag.joint, destination);
        drag.animal.update(this.animalSelection);
        this.viewer.requestRender();
        return;
      }
      if (drag.placementId) {
        const target = (drag.model ? this.doc.props : this.doc.actors).find(item => item.id === drag.placementId);
        if (!target || target.locked) return;
        const rect = canvas.getBoundingClientRect(), raycaster = new THREE.Raycaster();
        raycaster.setFromCamera(new THREE.Vector2((event.clientX - rect.left) / rect.width * 2 - 1, 1 - (event.clientY - rect.top) / rect.height * 2), this.viewer.camera);
        const point = raycaster.ray.intersectPlane(drag.plane, new THREE.Vector3()); if (!point) return;
        const delta = point.sub(drag.point);
        const next = { x: drag.transform.x + delta.x, y: drag.transform.y + delta.y, z: drag.transform.z + delta.z };
        if (Object.entries(next).every(([key, value]) => target.transform[key] === value)) return;
        beginChange(); Object.assign(target.transform, next);
        if (drag.model) this.updateProp(target);
        else this.updateActorTransform(target);
        this.callbacks.camera(); return;
      }
      const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
      const next = { ...this.doc.camera };
      if (drag.pan) {
        const delta = new THREE.Vector3(dx * 0.025, -dy * 0.025, 0);
        // Human/GLB offsets are stored in world axes; splat offsets are camera-local.
        if (drag.panQuaternion) delta.applyQuaternion(drag.panQuaternion);
        next.offsetX = drag.camera.offsetX + delta.x;
        next.offsetY = drag.camera.offsetY + delta.y;
        next.offsetZ = (drag.camera.offsetZ || 0) + delta.z;
      } else {
        next.azimuth = dx ? THREE.MathUtils.euclideanModulo(drag.camera.azimuth - dx * 0.35 + 180, 360) - 180 : drag.camera.azimuth;
        if (this.doc.interaction?.mousePitch !== false)
          next.elevation = clamp(drag.camera.elevation + dy * 0.25, -89, 89);
      }
      if (Object.entries(next).every(([key, value]) => this.doc.camera[key] === value)) return;
      beginChange(); Object.assign(this.doc.camera, next);
      this.updateShot(); this.callbacks.camera();
    }, true);
    canvas.addEventListener('pointerup', event => {
      if (event.pointerId === rigPointerId) this.rigPointerDown = false;
      if (drag && event.pointerId === drag.pointerId) {
        event.stopImmediatePropagation();
        const emptyClick = this.mode === 'camera' && this.doc.source.kind === 'human' && !drag.pan && !drag.changed
          && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 3
          && (this.selectedModel() || this.doc.selectedActorIds?.length) && !pickScene(pickRay(event));
        end();
        if (emptyClick) this.callbacks.clearSelection?.();
      }
    }, true);
    const cancel = event => {
      if (event.pointerId === rigPointerId) this.rigPointerDown = false;
      if (drag && event.pointerId === drag.pointerId) this.cancelDrag();
      else if (event.pointerId === rigPointerId && (this.viewer.directDrag?.active || this.viewer.transform?.dragging)) this.finishDrag();
    };
    canvas.addEventListener('pointercancel', cancel, true);
    canvas.addEventListener('lostpointercapture', cancel, true);
    canvas.addEventListener('wheel', event => {
      if (this.mode !== 'camera') return;
      event.stopImmediatePropagation(); event.preventDefault();
      const zoom = clamp(this.doc.camera.zoom * Math.exp(-event.deltaY * 0.001), 0.1, 8);
      if (zoom === this.doc.camera.zoom) return;
      if (drag) beginChange(); else this.callbacks.begin();
      this.doc.camera.zoom = zoom; this.updateShot();
      if (drag) this.callbacks.camera(); else this.callbacks.change();
    }, { capture: true, passive: false });
    this.cancelDrag = () => {
      if (!drag) return false;
      const cancelled = drag; drag = null;
      if (!cancelled.changed) return true;
      if (cancelled.animal) {
        cancelled.animal.restore(cancelled.pose);
        cancelled.animal.update(this.animalSelection);
      } else if (cancelled.placementId) {
        const target = (cancelled.model ? this.doc.props : this.doc.actors).find(item => item.id === cancelled.placementId);
        if (target) {
          target.transform = cancelled.transform;
          if (cancelled.model) this.updateProp(target);
          else this.updateActorTransform(target);
        }
      } else this.doc.camera = cancelled.camera;
      cancelled.rollback?.();
      this.updateShot(); this.callbacks.camera(); return true;
    };
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.resizeObserver?.disconnect();
    this.splat?.dispose();
    for (const animal of this.animalActors.values()) animal.dispose();
    this.animalActors.clear();
    this.actorRoots?.clear();
    this.morphCache?.clear(); this.morphCacheBytes = 0; this.humanStatic = null; this.cachedPack = null; this.pack = null;
    // GLB props, the main GLB and line helpers remain attached: the viewer owns
    // their final disposal and deduplicates shared geometry/material/texture.
    this.propRoots?.clear();
    this.viewer.dispose();
    this.glb = null; this.glbName = null;
    this.grid = this.ring = this.photoFrame = this.shotHelper = null;
  }
}
