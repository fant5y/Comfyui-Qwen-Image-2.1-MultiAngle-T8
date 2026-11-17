import * as THREE from '../vendor/three.module.mjs';

const AXES = [
  ['x', '#ff7979', new THREE.Vector3(1, 0, 0)],
  ['y', '#a9e67c', new THREE.Vector3(0, 1, 0)],
  ['z', '#82baff', new THREE.Vector3(0, 0, 1)],
];

export class PlacementHandles {
  constructor(canvas) {
    this.canvas = canvas;
    this.svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.svg.id = 'placement-handles';
    this.svg.setAttribute('aria-hidden', 'true');
    canvas.after(this.svg);
    this.handles = [];
  }

  update(root, camera) {
    this.handles = [];
    this.svg.replaceChildren();
    if (!root || !camera) return;
    const { width, height } = this.canvas.getBoundingClientRect();
    if (!width || !height) return;
    const world = root.getWorldPosition(new THREE.Vector3());
    const project = point => {
      const projected = point.clone().project(camera);
      return { x: (projected.x + 1) * width / 2, y: (1 - projected.y) * height / 2, depth: projected.z };
    };
    const origin = project(world);
    if (origin.depth < -1 || origin.depth > 1) return;
    this.svg.setAttribute('viewBox', '0 0 ' + width + ' ' + height);
    const sample = Math.max(0.01, camera.position.distanceTo(world) * 0.01);
    for (const [key, color, axis] of AXES) {
      const end = project(world.clone().addScaledVector(axis, sample));
      const dx = end.x - origin.x, dy = end.y - origin.y, length = Math.hypot(dx, dy);
      if (length < 0.35) continue;
      const ux = dx / length, uy = dy / length;
      const reach = key === 'y' ? 51 : 35;
      const x = origin.x + ux * reach, y = origin.y + uy * reach;
      this.add('line', { x1: origin.x + ux * 9, y1: origin.y + uy * 9, x2: x, y2: y, stroke: color, 'stroke-width': 2 });
      this.add('polygon', { points: [[x,y],[x-ux*8-uy*4,y-uy*8+ux*4],[x-ux*8+uy*4,y-uy*8-ux*4]].map(pair => pair.join(',')).join(' '), fill: color });
      this.add('text', { x: x + ux * 12, y: y + uy * 12, fill: color }, key.toUpperCase());
      this.handles.push({ key, x, y, ux, uy, unitsPerPixel: sample / length });
    }
    const x = origin.x + 31, y = origin.y + 25;
    this.add('rect', { x: x - 4, y: y - 4, width: 8, height: 8, fill: '#fff3da', stroke: '#252422' });
    this.handles.push({ key: 'scale', x, y });
  }

  hit(event) {
    const rect = this.canvas.getBoundingClientRect();
    let nearest, gap = 10;
    for (const handle of this.handles) {
      const distance = Math.hypot(event.clientX - rect.left - handle.x, event.clientY - rect.top - handle.y);
      if (distance < gap) { nearest = handle; gap = distance; }
    }
    return nearest;
  }

  add(tag, attributes, content = '') {
    const element = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
    element.textContent = content;
    this.svg.append(element);
  }

  dispose() {
    this.svg.remove();
  }
}
