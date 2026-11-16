import { parseMorphPack } from '../vendor/vnccs_pose_morph_runtime.mjs';

export class HumanAssetError extends Error {
  constructor(message) { super(message); this.name = 'HumanAssetError'; }
}

export async function loadHumanPack(timeout = 45000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(new URL('../vendor/assets/pose_studio_makehuman.v2.bin', import.meta.url),
      { signal: controller.signal, cache: 'no-cache' });
    if (!response.ok) throw new HumanAssetError(response.status === 404
      ? 'The bundled mannequin is missing (HTTP 404). Repair the assets, then retry.'
      : `Could not read the mannequin file (HTTP ${response.status}). Check ComfyUI’s access permissions.`);
    return parseMorphPack(await response.arrayBuffer());
  } catch (error) {
    if (error instanceof HumanAssetError) throw error;
    throw new HumanAssetError(controller.signal.aborted ? 'Reading the mannequin assets timed out. Retry or repair the assets.'
      : `Could not read the mannequin assets:${error.message}`);
  } finally { clearTimeout(timer); }
}
