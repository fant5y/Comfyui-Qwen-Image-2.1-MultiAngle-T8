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
    this.bodyVolumes = [];
    this.skins = [];
    this.targets = new Map();
    this.markers = new Map();
    this.sphere = new THREE.SphereGeometry(1, 20, 14);
    this.colors = ['#c8b598', '#eadbc4', '#69584c'].map(color => new THREE.MeshStandardMaterial({ color }));
    this.jointMaterial = new THREE.MeshBasicMaterial({ color: '#a1ddea', depthTest: false });
    this.targetMaterial = new THREE.MeshBasicMaterial({ color: '#ffb64c', depthTest: false });
    this.selectedMaterial = new THREE.MeshBasicMaterial({ color: '#ffffff', depthTest: false });
    if (shape === 'feline') {
      const profile = new THREE.Shape();
      profile.moveTo(-0.38, -0.33);
      profile.quadraticCurveTo(-0.28, 0.23, -0.02, 0.62);
      profile.quadraticCurveTo(0.09, 0.78, 0.18, 0.57);
      profile.quadraticCurveTo(0.34, 0.25, 0.43, -0.33);
      profile.closePath();
      this.catEarGeometry = new THREE.ExtrudeGeometry(profile, { depth: 0.12, bevelSize: 0.075, bevelThickness: 0.07, bevelSegments: 3 });
      this.catEarGeometry.translate(0, 0, -0.06);
    }
    if (shape === 'owl') this.owl();
    else if (shape === 'bunny') this.bunny();
    else this.quadruped(shape === 'feline');
    for (const [name] of this.joints) this.marker(name, false);
    for (const [name] of this.targets) this.marker(name, true);
    this.update();
    const bounds = new THREE.Box3().setFromObject(this.root);
    const center = bounds.getCenter(new THREE.Vector3());
    this.root.children[0].position.sub(new THREE.Vector3(center.x, bounds.min.y, center.z));
  }

  joint(name, parent, offset) {
    const joint = new THREE.Group();
    joint.name = name;
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
    if (['Torso', 'Chest', 'Pelvis'].includes(parent.name)) this.bodyVolumes.push({ mesh, scale: mesh.scale.clone() });
    return mesh;
  }

  segment(parent, end, width, color = 0, thickness = width) {
    const offset = new THREE.Vector3(...end);
    const mesh = this.volume(parent, offset.clone().multiplyScalar(0.5).toArray(),
      [width, offset.length() * 0.5 + width * 0.38, thickness], color);
    mesh.quaternion.setFromUnitVectors(Y, offset.normalize());
  }

  skin(joints, radii, flatten = 1, body = false) {
    const sides = 12, slices = (joints.length - 1) * 6;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array((slices + 1) * sides * 3), 3));
    const indices = [];
    for (let row = 0; row < slices; row++) for (let side = 0; side < sides; side++) {
      const a = row * sides + side, b = row * sides + (side + 1) % sides;
      indices.push(a, b, a + sides, b, b + sides, a + sides);
    }
    geometry.setIndex(indices);
    const mesh = new THREE.Mesh(geometry, this.colors[0]);
    mesh.frustumCulled = false;
    joints[0].add(mesh);
    this.skins.push({ joints, radii, flatten, body, sides, slices, geometry });
  }

  updateSkins() {
    for (const { joints, radii, flatten, body, sides, slices, geometry } of this.skins) {
      const origin = joints[0];
      const curve = new THREE.CatmullRomCurve3(joints.map(joint => origin.worldToLocal(joint.getWorldPosition(new THREE.Vector3()))));
      const position = geometry.attributes.position;
      const normal = new THREE.Vector3(1, 0, 0);
      for (let row = 0; row <= slices; row++) {
        const progress = row / slices;
        const center = curve.getPoint(progress), tangent = curve.getTangent(progress);
        const direction = Math.abs(tangent.dot(Y)) > 0.96 ? new THREE.Vector3(1, 0, 0) : Y;
        normal.addScaledVector(tangent, -normal.dot(tangent));
        if (normal.lengthSq() < 1e-6) normal.crossVectors(tangent, direction);
        normal.normalize();
        const binormal = new THREE.Vector3().crossVectors(tangent, normal);
        const jointIndex = progress * (radii.length - 1);
        const before = Math.min(radii.length - 2, Math.floor(jointIndex));
        const radius = THREE.MathUtils.lerp(radii[before], radii[before + 1], jointIndex - before) * (body ? this.build ?? 1 : 1);
        for (let side = 0; side < sides; side++) {
          const angle = side * 2 * Math.PI / sides;
          const point = center.clone().addScaledVector(normal, radius * Math.cos(angle))
            .addScaledVector(binormal, radius * flatten * Math.sin(angle));
          position.setXYZ(row * sides + side, point.x, point.y, point.z);
        }
      }
      position.needsUpdate = true;
      geometry.computeVertexNormals();
      geometry.computeBoundingBox();
      geometry.computeBoundingSphere();
    }
  }

  limb(name, body, origin, offsets, widths, foot) {
    let joint = this.joint(name + ' root', body, origin);
    const chain = [joint];
    for (const [index, offset] of offsets.entries()) {
      joint = this.joint(name + (index === offsets.length - 1 ? ' tip' : ' joint ' + (index + 1)), joint, offset);
      chain.push(joint);
    }
    const radii = [widths[0], ...widths.slice(1).map(width => width * 0.9), Math.min(foot.radii[0], widths.at(-1)) * 0.85];
    this.skin(chain, radii, name.endsWith('wing') ? 0.68 : 0.88);
    this.volume(joint, foot.offset, foot.radii, foot.color ?? 0);
    const tip = new THREE.Object3D();
    tip.position.fromArray(foot.offset);
    tip.position.z += foot.radii[2] * 0.65;
    joint.add(tip);
    this.targets.set(name, { tip, chain });
  }

  quadruped(feline) {
    const body = this.joint('Torso', this.root, [0, 0, 0]);
    const chest = this.joint('Chest', body, [0, 0, 1.37]);
    const pelvis = this.joint('Pelvis', body, [0, 0, -1.39]);
    const torsoSections = [
      [pelvis, [0, 0.04, -2.1]], [pelvis, [0, 0.08, -1.43]], [pelvis, [0, 0.04, -0.63]],
      [body, [0, 0.07, 0.2]], [chest, [0, 0.02, 0.4]], [chest, [0, -0.09, 1.28]], [chest, [0, 0.18, 1.85]],
    ].map(([parent, position]) => {
      const section = new THREE.Object3D();
      section.position.fromArray(position);
      parent.add(section);
      return section;
    });
    this.skin(torsoSections, feline ? [0.05, 0.91, 1.2, 0.94, 1.17, 0.91, 0.06]
      : [0.05, 1.08, 1.42, 1.28, 1.57, 1.22, 0.06], 1.2, true);
    const neck = this.joint('Neck', chest, [0, 0.62, 1.18]);
    const neckEnd = feline ? [0, 0.77, 1.22] : [0, 1.8, 1.28];
    const head = this.joint('Head', neck, neckEnd);
    this.skin([neck, head], feline ? [0.82, 0.63] : [1.18, 0.88], 0.9);
    this.volume(head, [0, 0.15, 0.32], feline ? [1.05, 0.91, 0.9] : [1.26, 1.15, 1.25]);
    this.volume(head, [0, -0.27, feline ? 0.91 : 1.58], [feline ? 0.51 : 0.69, feline ? 0.28 : 0.55, feline ? 0.27 : 1.08], 1);
    this.volume(head, [0, -0.18, feline ? 1.14 : 2.48], feline ? [0.2, 0.12, 0.12] : [0.33, 0.24, 0.24], 2);
    for (const [side, sign] of [['Left', 1], ['Right', -1]]) {
      const ear = this.joint(side + ' ear', head, [sign * 0.75, 0.66, 0.19]);
      if (feline) {
        const earMesh = new THREE.Mesh(this.catEarGeometry, this.colors[0]);
        earMesh.position.set(sign * 0.07, 0.41, 0);
        earMesh.rotation.z = -sign * 0.19;
        ear.add(earMesh);
      } else this.volume(ear, [sign * 0.19, 0.55, 0], [0.37, 0.86, 0.24]);
      this.volume(head, [sign * 0.72, 0.22, feline ? 1.04 : 1.21], [0.17, 0.17, 0.17], 2);
      this.limb(side + ' foreleg', chest, [sign * 0.91, -0.53, 0.86],
        [[0, -2.15, -0.44], [0, -2.07, 0.48], [0, -0.53, 0.16]], feline ? [0.48, 0.30, 0.24] : [0.64, 0.42, 0.35],
        { offset: [0, 0, 0.26], radii: [0.48, 0.33, 0.72] });
      this.limb(side + ' hind leg', pelvis, [sign * 0.97, -0.24, -1.01],
        [[0, -1.88, 0.84], [0, -1.76, -1.03], [0, -1.05, 0.41]], feline ? [0.72, 0.43, 0.23] : [0.91, 0.58, 0.31],
        { offset: [0, 0, 0.29], radii: [0.48, 0.33, 0.71] });
    }
    let tail = this.joint('Tail base', pelvis, [0, 0.58, -1.66]);
    const tailJoints = [tail];
    const offsets = feline ? [[0, 0.5, -1.51], [0, 1.11, -1.39], [0, 0.95, -0.78]]
      : [[0, -0.31, -1.56], [0, -0.45, -1.65], [0, 0.11, -1.25]];
    for (const [index, offset] of offsets.entries()) {
      if (index < offsets.length - 1) tail = this.joint('Tail joint ' + (index + 1), tail, offset);
      else {
        const end = new THREE.Object3D();
        end.position.fromArray(offset);
        tail.add(end);
        tail = end;
      }
      tailJoints.push(tail);
    }
    this.skin(tailJoints, feline ? [0.44, 0.36, 0.27, 0.025] : [0.63, 0.49, 0.33, 0.025]);
  }

  bunny() {
    const body = this.joint('Torso', this.root, [0, 0, 0]);
    const chest = this.joint('Chest', body, [0, 0, 0.92]);
    const pelvis = this.joint('Pelvis', body, [0, 0, -0.72]);
    this.volume(body, [0, 0.1, 0], [1.6, 1.82, 1.94]);
    this.volume(pelvis, [0, 0, 0.07], [2.05, 2.12, 2.48]);
    this.volume(chest, [0, 0.29, 0.31], [1.57, 1.92, 1.83]);
    const head = this.joint('Head', chest, [0, 1.55, 1.5]);
    this.volume(head, [0, 0.38, 0.35], [1.42, 1.4, 1.35]);
    this.volume(head, [0, -0.21, 1.19], [0.82, 0.63, 0.8], 1);
    this.volume(head, [0, -0.05, 1.89], [0.26, 0.19, 0.2], 2);
    const tail = this.joint('Tail', pelvis, [0, 0.27, -2.23]);
    this.volume(tail, [0, 0.22, -0.39], [0.72, 0.72, 0.8], 1);
    for (const [side, sign] of [['Left', 1], ['Right', -1]]) {
      const ear = this.joint(side + ' ear', head, [sign * 0.65, 1.19, 0.04]);
      const tip = this.joint(side + ' ear tip', ear, [sign * 0.38, 1.55, -0.29]);
      this.segment(ear, tip.position.toArray(), 0.47, 0, 0.27);
      this.segment(tip, [sign * 0.19, 1.61, -0.29], 0.42, 1, 0.22);
      this.volume(head, [sign * 1.08, 0.55, 0.83], [0.2, 0.22, 0.19], 2);
      this.limb(side + ' foreleg', chest, [sign * 0.83, -0.52, 0.96],
        [[0, -1.26, -0.22], [0, -1.1, 0.48]], [0.49, 0.39],
        { offset: [0, 0, 0.23], radii: [0.4, 0.29, 0.62] });
      this.limb(side + ' hind leg', pelvis, [sign * 1.39, -0.41, -0.19],
        [[sign * 0.14, -1.34, 0.84], [0, -1.04, -0.54]], [1.03, 0.56],
        { offset: [0, 0, 0.52], radii: [0.55, 0.32, 1.11] });
    }
  }

  owl() {
    const body = this.joint('Torso', this.root, [0, 0, 0]);
    const chest = this.joint('Chest', body, [0, 0.89, 0]);
    const pelvis = this.joint('Pelvis', body, [0, -1.07, 0]);
    this.volume(body, [0, -0.16, 0], [2.03, 2.15, 1.84]);
    this.volume(chest, [0, 0.06, 0.1], [2.19, 1.99, 1.87]);
    this.volume(pelvis, [0, -0.17, 0.16], [1.75, 1.67, 1.58]);
    this.volume(chest, [0, -0.74, 1.12], [1.57, 1.95, 0.83], 1);
    const head = this.joint('Head', chest, [0, 1.44, 0.18]);
    this.volume(head, [0, 0.69, 0], [2.2, 1.84, 1.69]);
    const beak = this.volume(head, [0, 0.15, 1.72], [0.41, 0.61, 0.51], 2);
    beak.rotation.x = -0.42;
    const tail = this.joint('Tail', pelvis, [0, -0.89, -1.15]);
    this.segment(tail, [0, -1.5, -1.35], 0.92, 0, 0.38);
    for (const [side, sign] of [['Left', 1], ['Right', -1]]) {
      this.volume(head, [sign * 0.88, 0.68, 1.24], [0.98, 1.02, 0.55], 1);
      this.volume(head, [sign * 0.86, 0.72, 1.77], [0.36, 0.42, 0.19], 2);
      this.limb(side + ' wing', chest, [sign * 1.77, 0.36, 0],
        [[sign * 1.77, -0.58, -0.42], [sign * 2.05, -0.63, -0.72], [sign * 1.51, -0.41, -0.68]],
        [0.92, 0.81, 0.57],
        { offset: [sign * 0.31, -0.13, -0.23], radii: [0.72, 0.29, 0.44], color: 0 });
      this.limb(side + ' leg', pelvis, [sign * 0.83, -1.18, 0.08],
        [[0, -0.85, -0.15], [0, -0.69, 0.35]], [0.4, 0.27],
        { offset: [0, 0, 0.25], radii: [0.38, 0.22, 0.63], color: 2 });
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

  setBuild(build = 1) {
    this.build = build;
    for (const { mesh, scale } of this.bodyVolumes) mesh.scale.set(scale.x * build, scale.y * build, scale.z);
    this.updateSkins();
  }

  update(selected = '', color) {
    if (color) this.colors[0].color.set(color);
    this.root.updateMatrixWorld(true);
    this.updateSkins();
    for (const [marker, joint] of this.markers) {
      joint.getWorldPosition(marker.position);
      marker.material = marker.userData.target ? this.targetMaterial
        : marker.userData.name === selected ? this.selectedMaterial : this.jointMaterial;
    }
    this.handles.updateMatrixWorld(true);
  }

  restore(pose = {}) {
    pose ||= {};
    for (const [name, joint] of this.joints) {
      const angles = Object.hasOwn(pose, name) ? pose[name] : null;
      joint.rotation.set(...(Array.isArray(angles) && angles.length === 3 && angles.every(Number.isFinite) ? angles : [0, 0, 0]));
    }
  }

  pose() {
    return Object.fromEntries(Array.from(this.joints, ([name, joint]) => [name, [joint.rotation.x, joint.rotation.y, joint.rotation.z]]));
  }

  applyAP10K(points, facing) {
    const direction = (from, to) => points[from] && points[to]
      ? new THREE.Vector3(0, points[from][1] - points[to][1], facing * (points[to][0] - points[from][0]))
      : null;
    const aim = (joint, rest, desired) => {
      if (!joint || !desired || desired.lengthSq() < 1e-8) return;
      desired.applyQuaternion(joint.parent.getWorldQuaternion(new THREE.Quaternion()).invert());
      desired.x = 0;
      if (desired.lengthSq() < 1e-8) return;
      const angle = Math.atan2(rest.y * desired.z - rest.z * desired.y, rest.y * desired.y + rest.z * desired.z);
      joint.rotation.set(angle, 0, 0);
    };
    const torso = this.joints.get('Torso');
    const forward = direction(4, 3);
    // Work in the mannequin's sagittal plane, independent of its scene placement.
    const worldRotation = this.root.getWorldQuaternion(new THREE.Quaternion());
    const worldDirection = (from, to) => direction(from, to)?.applyQuaternion(worldRotation);
    if (forward) aim(torso, new THREE.Vector3(0, 0, 1), forward.applyQuaternion(worldRotation));
    const neck = this.joints.get('Neck'), head = this.joints.get('Head');
    if (neck) {
      aim(neck, head.position.clone(), worldDirection(3, 2));
      neck.rotation.x = THREE.MathUtils.clamp(neck.rotation.x, -0.55, 0.4);
    }
    if (head && points[0] && points[1] && points[2]) {
      const eyeSpan = Math.hypot(points[0][0] - points[1][0], points[0][1] - points[1][1]);
      const eyeY = (points[0][1] + points[1][1]) / 2;
      const frontality = THREE.MathUtils.clamp(eyeSpan / (Math.abs(points[2][1] - eyeY) * 1.6 + 1), 0, 1);
      head.rotation.y = -facing * frontality * 1.52;
      head.rotation.x = THREE.MathUtils.clamp(-0.12 - (neck?.rotation.x || 0), -0.55, 0.4);
    }
    const legs = [['Left foreleg', 5], ['Right foreleg', 8], ['Left hind leg', 11], ['Right hind leg', 14]];
    // First match visible segment directions, then align the paws relative to the source floor.
    for (const [name, start] of legs) {
      const { chain, tip } = this.targets.get(name);
      // For digitigrade legs the labeled hip and knee correspond to the visible knee and hock.
      const first = name.endsWith('hind leg') && chain.length >= 4 ? 1 : 0;
      for (let segment = 0; segment < 2; segment++) {
        const joint = chain[first + segment], child = chain[first + segment + 1] || tip;
        if (joint) aim(joint, child.position.clone(), worldDirection(start + segment, start + segment + 1));
      }
    }
    const paws = legs.filter(([, start]) => points[start + 2]);
    if (paws.length >= 2) {
      const floorInImage = Math.max(...paws.map(([, start]) => points[start + 2][1]));
      const floor = Math.min(...paws.map(([name]) => this.targets.get(name).tip.getWorldPosition(new THREE.Vector3()).y));
      const averageHeight = paws.reduce((total, [, start]) => total + (points[start] ? Math.abs(points[start + 2][1] - points[start][1]) : 0), 0) / paws.length;
      const units = this.root.getWorldScale(new THREE.Vector3()).y;
      const scale = units * 3.8 / Math.max(averageHeight, 1);
      const side = new THREE.Vector3(1, 0, 0).applyQuaternion(worldRotation);
      for (const [name, start] of paws) {
        const destination = this.targets.get(name).tip.getWorldPosition(new THREE.Vector3());
        destination.y = floor + Math.min(2.2 * units, (floorInImage - points[start + 2][1]) * scale);
        this.drag(name, destination, side);
      }
    }
    this.update();
  }

  drag(name, destination, planeNormal = null) {
    const { chain, tip } = this.targets.get(name);
    const origin = new THREE.Vector3(), current = new THREE.Vector3(), wanted = new THREE.Vector3();
    const parentInverse = new THREE.Quaternion(), delta = new THREE.Quaternion(), identity = new THREE.Quaternion();
    for (let iteration = 0; iteration < 10; iteration++) {
      if (tip.getWorldPosition(current).distanceToSquared(destination) < 0.0004) break;
      for (let index = chain.length - 1; index >= 0; index--) {
        const joint = chain[index];
        joint.getWorldPosition(origin);
        tip.getWorldPosition(current).sub(origin);
        wanted.copy(destination).sub(origin);
        if (planeNormal) {
          current.addScaledVector(planeNormal, -current.dot(planeNormal));
          wanted.addScaledVector(planeNormal, -wanted.dot(planeNormal));
        }
        if (current.lengthSq() < 1e-8 || wanted.lengthSq() < 1e-8) continue;
        joint.parent.getWorldQuaternion(parentInverse).invert();
        current.applyQuaternion(parentInverse).normalize();
        wanted.applyQuaternion(parentInverse).normalize();
        delta.setFromUnitVectors(current, wanted);
        // Small steps retain the current knee bend and reduce sudden flips near full extension.
        delta.slerp(identity, 0.42);
        joint.quaternion.premultiply(delta).normalize();
        joint.updateMatrixWorld(true);
      }
    }
  }

  dispose() {
    this.root.removeFromParent();
    this.handles.removeFromParent();
    this.sphere.dispose();
    for (const { geometry } of this.skins) geometry.dispose();
    this.catEarGeometry?.dispose();
    for (const material of [...this.colors, this.jointMaterial, this.targetMaterial, this.selectedMaterial]) material.dispose();
  }
}
