export function promptForSnapshot(compiled, nodeId, snapshot, frozenScene = null, frozenPrompts = null) {
  if (snapshot?.version !== 1 || !/^[a-f0-9]{64}$/.test(snapshot.id)) throw new Error('Invalid batch scene snapshot');
  const prompt = structuredClone(compiled), id = String(nodeId);
  if (prompt.output[id]?.class_type !== 'AnyAngleStudioT8') throw new Error('This Studio node is absent from the runnable workflow.');
  const value = JSON.stringify(snapshot);
  prompt.output[id].inputs.snapshot = value;
  const node = prompt.workflow.nodes.find(node => String(node.id) === id);
  if (!node) throw new Error('The workflow is missing the Studio node. Reopen Studio.');
  node.widgets_values[0] = value;
  if ([2, 3].includes(frozenScene?.version)) {
    // The batch snapshot owns its photos and guide. Re-evaluating a random upstream
    // image for every queued camera would silently change role identities.
    const frozenNames = new Set(['reference_image', 'structure_image', 'pose_keypoints', 'actor_references']);
    for (const key of Object.keys(prompt.output[id].inputs)) if (frozenNames.has(key) || /^(actor_references\.)?actor_reference_/.test(key)) delete prompt.output[id].inputs[key];
    const links = new Set();
    for (const input of node.inputs || []) if (frozenNames.has(input.name) || /^(actor_references\.)?actor_reference_/.test(input.name)) {
      if (input.link != null) links.add(input.link); input.link = null;
    }
    prompt.workflow.links = prompt.workflow.links?.filter(link => !links.has(Array.isArray(link) ? link[0] : link.id));
    for (const other of prompt.workflow.nodes) for (const output of other.outputs || []) if (output.links) output.links = output.links.filter(link => !links.has(link));
  }
  for (const [encoderId, frozen] of Object.entries(frozenPrompts || {})) {
    const encoder = prompt.output[encoderId];
    if (encoder?.class_type !== 'AnyAngleMultiPersonEncodeT8') throw new Error('The batch encoder changed. Prepare the batch again.');
    Object.assign(encoder.inputs, frozen);
    const gui = prompt.workflow.nodes.find(node => String(node.id) === encoderId);
    if (gui) {
      const removed = new Set();
      for (const input of gui.inputs || []) if (['prompt','negative_prompt','prompt_mode'].includes(input.name) && input.link != null) { removed.add(input.link); input.link = null; }
      prompt.workflow.links = prompt.workflow.links?.filter(link => !removed.has(Array.isArray(link) ? link[0] : link.id));
      for (const other of prompt.workflow.nodes) for (const output of other.outputs || []) if (output.links) output.links = output.links.filter(link => !removed.has(link));
      gui.widgets_values = [encoder.inputs.reference_resolution ?? 512, frozen.prompt, frozen.negative_prompt, frozen.prompt_mode];
    }
  }
  return prompt;
}
