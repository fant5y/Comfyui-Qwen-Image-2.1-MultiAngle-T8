import * as THREE from '../vendor/three.module.mjs';

// Keep the visible drawing buffer untouched: resizing it during asynchronous
// splat sorting exposes the capture framing for a frame in the workbench.
function capturePixels(renderer, scene, camera, width, height, colorSpace, antialias) {
  const target = new THREE.WebGLRenderTarget(width, height, {
    format: THREE.RGBAFormat, type: THREE.UnsignedByteType,
    depthBuffer: true, stencilBuffer: false,
  });
  target.texture.colorSpace = colorSpace;
  target.samples = antialias && renderer.capabilities.isWebGL2 ? Math.min(4, renderer.capabilities.maxSamples) : 0;
  const previous = renderer.getRenderTarget();
  const viewport = renderer.getViewport(new THREE.Vector4());
  const scissor = renderer.getScissor(new THREE.Vector4());
  const scissorTest = renderer.getScissorTest();
  try {
    renderer.setRenderTarget(target);
    // The target already has a viewport in output pixels. setViewport would
    // multiply it by the display DPR and crop/shift the exported frame.
    renderer.setScissorTest(false);
    renderer.render(scene, camera);
    const pixels = new Uint8Array(width * height * 4);
    renderer.readRenderTargetPixels(target, 0, 0, width, height, pixels);
    // WebGL 1 lacks the WebGL 2 sRGB framebuffer conversion used by this target.
    if (colorSpace === THREE.SRGBColorSpace && !renderer.capabilities.isWebGL2) {
      for (let i = 0; i < pixels.length; i++) if (i % 4 !== 3) {
        const value = pixels[i] / 255;
        pixels[i] = Math.round(255 * (value <= 0.0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - 0.055));
      }
    }
    return pixels;
  } finally {
    renderer.setViewport(viewport);
    renderer.setScissor(scissor);
    renderer.setScissorTest(scissorTest);
    renderer.setRenderTarget(previous);
    target.dispose();
  }
}

export function capturePNG(renderer, scene, camera, width, height, colorSpace = THREE.SRGBColorSpace) {
    const pixels = capturePixels(renderer, scene, camera, width, height, colorSpace, true);
    const canvas = document.createElement('canvas');
    canvas.width = width; canvas.height = height;
    const context = canvas.getContext('2d');
    const image = context.createImageData(width, height);
    const rowBytes = width * 4;
    for (let y = 0; y < height; y++) {
      image.data.set(pixels.subarray(y * rowBytes, (y + 1) * rowBytes), (height - y - 1) * rowBytes);
    }
    context.putImageData(image, 0, 0);
    return canvas.toDataURL('image/png');
}

export function captureSubjectIds(renderer, scene, camera, width, height, subjects, backdrop) {
  if (!subjects.length) return [];
  const background = scene.background, override = scene.overrideMaterial;
  const swaps = [], materials = [];
  try {
    scene.background = new THREE.Color(0);
    scene.overrideMaterial = null;
    if (backdrop?.visible) {
      const material = new THREE.MeshBasicMaterial({ color: 0, side: backdrop.material.side, toneMapped: false });
      swaps.push([backdrop, backdrop.material]);
      materials.push(material);
      backdrop.material = material;
    }
    subjects.forEach(({ root }, index) => {
      const color = new THREE.Color().setRGB(((index + 1) & 255) / 255, ((index + 1) >> 8) / 255, 0);
      root.traverseVisible(mesh => {
        if (!mesh.isMesh || !mesh.material) return;
        const original = mesh.material;
        const identify = source => {
          const material = new THREE.MeshBasicMaterial({
            color, side: source.side, visible: source.visible, toneMapped: false,
            map: source.map, alphaMap: source.alphaMap,
            alphaTest: Math.max(source.alphaTest || 0, source.transparent ? 0.01 : 0),
            opacity: source.opacity, clippingPlanes: source.clippingPlanes,
          });
          material.onBeforeCompile = shader => {
            shader.fragmentShader = shader.fragmentShader.replace('#include <alphatest_fragment>',
              '#include <alphatest_fragment>\n diffuseColor.rgb = diffuse;');
          };
          materials.push(material);
          return material;
        };
        swaps.push([mesh, original]);
        mesh.material = Array.isArray(original) ? original.map(identify) : identify(original);
      });
    });
    const pixels = capturePixels(renderer, scene, camera, width, height, THREE.NoColorSpace, false);
    const seen = new Set();
    for (let index = 0; index < pixels.length; index += 4) {
      if (pixels[index + 2] === 0) seen.add(pixels[index] + (pixels[index + 1] << 8));
    }
    return subjects.filter((_, index) => seen.has(index + 1)).map(({ id }) => id);
  } finally {
    for (const [mesh, material] of swaps) mesh.material = material;
    for (const material of materials) material.dispose();
    scene.background = background; scene.overrideMaterial = override;
  }
}
