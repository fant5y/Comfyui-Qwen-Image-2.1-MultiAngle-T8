import * as THREE from '../vendor/three.module.mjs';
import { GLTFLoader } from '../vendor/GLTFLoader.mjs';

export async function loadProp(asset) {
  const response = await fetch(`/anyangle-studio/assets/${encodeURIComponent(asset.name)}`);
  if (!response.ok) throw new Error('GLB prop asset missing. Import it again.');
  const manager = new THREE.LoadingManager();
  manager.setURLModifier(url => { if (!url.startsWith('blob:') && !url.startsWith('data:')) throw new Error('GLB props require embedded materials.'); return url; });
  const { scene } = await new GLTFLoader(manager).parseAsync(await response.arrayBuffer(), '');
  scene.updateMatrixWorld(true); const bounds = new THREE.Box3().setFromObject(scene);
  const size = bounds.getSize(new THREE.Vector3()), longest = Math.max(size.x, size.y, size.z);
  if (bounds.isEmpty() || !Number.isFinite(longest) || longest <= 0) { disposeProp(scene); throw new Error('GLB prop has no valid geometry.'); }
  const center = bounds.getCenter(new THREE.Vector3()), normalized = new THREE.Group(), scale = 10 / longest;
  normalized.add(scene); normalized.scale.setScalar(scale); normalized.position.set(-center.x*scale, -bounds.min.y*scale, -center.z*scale);
  const root = new THREE.Group(); root.add(normalized);
  const bones = new Set();
  scene.traverse(object => {
    if (object.isSkinnedMesh) for (const bone of object.skeleton.bones) bones.add(bone);
  });
  root.userData.joints = [...bones].map(bone => ({ bone, rest: bone.quaternion.clone() }));
  return root;
}
export function disposeProp(root) {
  root.traverse(object => {
    object.geometry?.dispose(); object.skeleton?.dispose();
    for (const material of [].concat(object.material || [])) { for (const value of Object.values(material)) if (value?.isTexture) value.dispose(); material.dispose(); }
  }); root.removeFromParent();
}
export function placeProp(root, prop, enabled = true) {
  const t = prop.transform; root.position.set(t.x,t.y,t.z); root.scale.set(t.scale * (t.scaleX ?? 1), t.scale * (t.scaleY ?? 1), t.scale * (t.scaleZ ?? 1)); root.rotation.set(THREE.MathUtils.degToRad(t.pitch ?? 0), THREE.MathUtils.degToRad(t.yaw),
    THREE.MathUtils.degToRad(t.roll ?? 0), "YXZ");
  root.userData.joints.forEach(({ bone, rest }, index) => {
    const rotation = prop.jointRotations?.[index];
    if (rotation) bone.quaternion.fromArray(rotation).normalize();
    else bone.quaternion.copy(rest);
  });
  root.visible = enabled && prop.visible !== false; root.updateMatrixWorld(true);
}
