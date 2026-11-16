import * as THREE from '../vendor/three.module.mjs';

export const ANIMAL_SHAPES = {
  canine: 'Canine',
  feline: 'Feline',
  bunny: 'Bunny',
  owl: 'Owl',
};

const Y = new THREE.Vector3(0, 1, 0);

export class AnimalMannequin {
  constructor(shape) {
    this.root = new THREE.Group();
    this.handles = new THREE.Group();
    this.joints = new Map();
    this.targets = new Map();
    this.markers = new Map();
    this.sphere = new THREE.SphereGeometry(1, 20, 14);
    this.colors = ['#c8b598', '#eadbc4', '#69584c'].map(color => new THREE.MeshStandardMaterial({ color }));
    this.jointMaterial = new THREE.MeshBasicMaterial({ color: '#a1ddea', depthTest: false });
    this.targetMaterial = new THREE.MeshBasicMaterial({ color: '#ffb64c', depthTest: false });
    this.selectedMaterial = new THREE.MeshBasicMaterial({ color: '#ffffff', depthTest: false });
    if (shape === 'owl') this.owl();
    else if (shape === 'bunny') this.bunny();
    else this.quadruped(shape === 'feline');
    for (const [name] of this.joints) this.marker(name, false);
    for (const [name] of this.targets) this.marker(name, true);
    const bounds = new THREE.Box3().setFromObject(this.root);
    const center = bounds.getCenter(new THREE.Vector3());
    this.root.children[0].position.sub(new THREE.Vector3(center.x, bounds.min.y, center.z));
    this.center = new THREE.Vector3(0, center.y - bounds.min.y, 0);
  }

  joint(name, parent, offset) {
    const joint = new THREE.Group();
    joint.position.fromArray(offset);
    parent.add(joint);
    this.joints.set(name, joint);
    return joint;
  }

  volume(parent, offset, radii, color = 0) {
    const mesh = new THREE.Mesh(this.sphere, this.colors[color]);
    mesh.position.fromArray(offset);
    mesh.scale.fromArray(radii);
    parent.add(mesh);
    return mesh;
  }

  segment(parent, end, width, color = 0, thickness = width) {
    const offset = new THREE.Vector3(...end);
    const mesh = this.volume(parent, offset.clone().multiplyScalar(0.5).toArray(),
      [width, offset.length() * 0.5 + width * 0.38, thickness], color);
    mesh.quaternion.setFromUnitVectors(Y, offset.normalize());
  }

  limb(name, body, origin, offsets, widths, foot, colors = [0, 0]) {
    let joint = this.joint(name + ' root', body, origin);
    const chain = [joint];
    for (const [index, offset] of offsets.entries()) {
      this.segment(joint, offset, widths[index], colors[index] ?? 0);
      joint = this.joint(name + (index === offsets.length - 1 ? ' tip' : ' joint ' + (index + 1)), joint, offset);
      chain.push(joint);
    }
    this.volume(joint, foot.offset, foot.radii, foot.color ?? 2);
    this.targets.set(name, { tip: chain.pop(), chain });
  }

  quadruped(feline) {
    const body = this.joint('Torso', this.root, [0, 0, 0]);
    this.volume(body, [0, 0, 0], feline ? [1.53, 1.62, 3.65] : [1.78, 1.97, 3.46]);
    this.volume(body, [0, 0.1, 2.02], feline ? [1.34, 1.65, 1.55] : [1.72, 2.03, 1.66]);
    const neck = this.joint('Neck', body, [0, 0.62, 2.55]);
    const neckEnd = feline ? [0, 1.25, 1.46] : [0, 1.8, 1.28];
    this.segment(neck, neckEnd, feline ? 0.9 : 1.18);
    const head = this.joint('Head', neck, neckEnd);
    this.volume(head, [0, 0.15, 0.32], feline ? [1.13, 1.02, 1.0] : [1.26, 1.15, 1.25]);
    this.volume(head, [0, -0.27, feline ? 1.03 : 1.58], [0.69, 0.55, feline ? 0.55 : 1.08], 1);
    this.volume(head, [0, -0.18, feline ? 1.52 : 2.48], [0.33, 0.24, 0.24], 2);
    for (const [side, sign] of [['Left', 1], ['Right', -1]]) {
      const ear = this.joint(side + ' ear', head, [sign * 0.75, 0.66, 0.19]);
      this.volume(ear, [sign * 0.19, 0.55, 0], [0.37, feline ? 0.66 : 0.86, 0.24]);
      this.volume(head, [sign * 0.72, 0.22, feline ? 1.04 : 1.21], [0.17, 0.17, 0.17], 2);
      this.limb(side + ' foreleg', body, [sign * 1.03, -0.53, 2.23],
        [[0, -2.15, -0.44], [0, -2.07, 0.48], [0, -0.53, 0.16]], [0.64, 0.42, 0.35],
        { offset: [0, 0, 0.26], radii: [0.48, 0.33, 0.72] });
      this.limb(side + ' hind leg', body, [sign * 1.06, -0.24, -2.4],
        [[0, -1.88, 0.84], [0, -1.76, -1.03], [0, -1.05, 0.41]], [0.91, 0.58, 0.31],
        { offset: [0, 0, 0.29], radii: [0.48, 0.33, 0.71] });
    }
    let tail = this.joint('Tail base', body, [0, 0.58, -3.05]);
    const offsets = feline ? [[0, 0.5, -1.51], [0, 1.11, -1.39], [0, 0.95, -0.78]]
      : [[0, -0.31, -1.56], [0, -0.45, -1.65], [0, 0.11, -1.25]];
    for (const [index, offset] of offsets.entries()) {
      this.segment(tail, offset, (feline ? 0.43 : 0.72) * (1 - index * 0.23), index === 2 ? 1 : 0);
      if (index < offsets.length - 1) tail = this.joint('Tail joint ' + (index + 1), tail, offset);
    }
  }

  bunny() {
    const body = this.joint('Torso', this.root, [0, 0, 0]);
    this.volume(body, [0, 0, -0.65], [2.05, 2.12, 2.85]);
    this.volume(body, [0, 0.29, 1.23], [1.57, 1.92, 1.83]);
    const head = this.joint('Head', body, [0, 1.55, 2.42]);
    this.volume(head, [0, 0.38, 0.35], [1.42, 1.4, 1.35]);
    this.volume(head, [0, -0.21, 1.19], [0.82, 0.63, 0.8], 1);
    this.volume(head, [0, -0.05, 1.89], [0.26, 0.19, 0.2], 2);
    const tail = this.joint('Tail', body, [0, 0.27, -2.95]);
    this.volume(tail, [0, 0.22, -0.39], [0.72, 0.72, 0.8], 1);
    for (const [side, sign] of [['Left', 1], ['Right', -1]]) {
      const ear = this.joint(side + ' ear', head, [sign * 0.65, 1.19, 0.04]);
      const tip = this.joint(side + ' ear tip', ear, [sign * 0.38, 1.55, -0.29]);
      this.segment(ear, tip.position.toArray(), 0.47, 0, 0.27);
      this.segment(tip, [sign * 0.19, 1.61, -0.29], 0.42, 1, 0.22);
      this.volume(head, [sign * 1.08, 0.55, 0.83], [0.2, 0.22, 0.19], 2);
      this.limb(side + ' foreleg', body, [sign * 0.83, -0.52, 1.88],
        [[0, -1.26, -0.22], [0, -1.1, 0.48]], [0.49, 0.39],
        { offset: [0, 0, 0.23], radii: [0.4, 0.29, 0.62] });
      this.limb(side + ' hind leg', body, [sign * 1.39, -0.41, -0.91],
        [[sign * 0.14, -1.34, 0.84], [0, -1.04, -0.54]], [1.03, 0.56],
        { offset: [0, 0, 0.52], radii: [0.55, 0.32, 1.11] });
    }
  }

  owl() {
    const body = this.joint('Torso', this.root, [0, 0, 0]);
    this.volume(body, [0, 0, 0], [2.25, 3.03, 1.87]);
    this.volume(body, [0, -0.42, 1.36], [1.57, 2.18, 0.81], 1);
    const head = this.joint('Head', body, [0, 2.33, 0.18]);
    this.volume(head, [0, 0.69, 0], [2.2, 1.84, 1.69]);
    const beak = this.volume(head, [0, 0.15, 1.72], [0.41, 0.61, 0.51], 2);
    beak.rotation.x = -0.42;
    const tail = this.joint('Tail', body, [0, -1.96, -1.15]);
    this.segment(tail, [0, -1.5, -1.35], 0.92, 0, 0.38);
    for (const [side, sign] of [['Left', 1], ['Right', -1]]) {
      this.volume(head, [sign * 0.88, 0.68, 1.24], [0.98, 1.02, 0.55], 1);
      this.volume(head, [sign * 0.86, 0.72, 1.77], [0.36, 0.42, 0.19], 2);
      this.limb(side + ' wing', body, [sign * 1.77, 1.25, 0],
        [[sign * 1.77, -0.58, -0.42], [sign * 2.05, -0.63, -0.72], [sign * 1.51, -0.41, -0.68]],
        [0.92, 0.81, 0.57],
        { offset: [sign * 0.31, -0.13, -0.23], radii: [0.72, 0.29, 0.44], color: 0 });
      this.limb(side + ' leg', body, [sign * 0.83, -2.25, 0.08],
        [[0, -0.85, -0.15], [0, -0.69, 0.35]], [0.4, 0.27],
        { offset: [0, 0, 0.25], radii: [0.38, 0.22, 0.63] }, [0, 2]);
    }
  }

  marker(name, target) {
    const mesh = new THREE.Mesh(this.sphere, target ? this.targetMaterial : this.jointMaterial);
    mesh.scale.setScalar(target ? 0.29 : 0.19);
    mesh.renderOrder = 1000;
    mesh.userData = { name, target };
    this.handles.add(mesh);
    this.markers.set(mesh, target ? this.targets.get(name).tip : this.joints.get(name));
  }

  update(selected = '') {
    this.root.updateMatrixWorld(true);
    for (const [marker, joint] of this.markers) {
      joint.getWorldPosition(marker.position);
      marker.material = marker.userData.target ? this.targetMaterial
        : marker.userData.name === selected ? this.selectedMaterial : this.jointMaterial;
    }
    this.handles.updateMatrixWorld(true);
  }

  restore(pose = {}) {
    for (const [name, joint] of this.joints) {
      const angles = Object.hasOwn(pose, name) ? pose[name] : null;
      joint.rotation.set(...(Array.isArray(angles) && angles.length === 3 && angles.every(Number.isFinite) ? angles : [0, 0, 0]));
    }
  }

  pose() {
    return Object.fromEntries(Array.from(this.joints, ([name, joint]) => [name, [joint.rotation.x, joint.rotation.y, joint.rotation.z]]));
  }

  drag(name, destination) {
    const { chain, tip } = this.targets.get(name);
    const origin = new THREE.Vector3(), current = new THREE.Vector3(), wanted = new THREE.Vector3();
    const parentInverse = new THREE.Quaternion(), delta = new THREE.Quaternion();
    for (let iteration = 0; iteration < 10; iteration++) {
      if (tip.getWorldPosition(current).distanceToSquared(destination) < 0.0004) break;
      for (let index = chain.length - 1; index >= 0; index--) {
        const joint = chain[index];
        joint.getWorldPosition(origin);
        tip.getWorldPosition(current).sub(origin);
        wanted.copy(destination).sub(origin);
        if (current.lengthSq() < 1e-8 || wanted.lengthSq() < 1e-8) continue;
        joint.parent.getWorldQuaternion(parentInverse).invert();
        current.applyQuaternion(parentInverse).normalize();
        wanted.applyQuaternion(parentInverse).normalize();
        joint.quaternion.premultiply(delta.setFromUnitVectors(current, wanted)).normalize();
        joint.updateMatrixWorld(true);
      }
    }
  }

  dispose() {
    this.root.removeFromParent();
    this.handles.removeFromParent();
    this.sphere.dispose();
    for (const material of [...this.colors, this.jointMaterial, this.targetMaterial, this.selectedMaterial]) material.dispose();
  }
}
