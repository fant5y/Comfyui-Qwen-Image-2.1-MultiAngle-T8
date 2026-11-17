# Edit Scene posing controls

Applies to the human, canine, feline, bunny, and owl mannequins. The human interaction in recording `23102-ShareX.mp4` is the reference.

## Target behavior

| Gesture | Expected response |
| --- | --- |
| Select a mannequin | Show its joint dots and the gold whole-model dot beneath it. Keep the viewport in place. |
| Hover a dot | Show it in cyan. For an active IK chain, highlight the related dots together. Any existing rotation rings stay at the selected pivot. |
| Move away | Clear the hover highlight. Keep the selected dot and its active chain highlighted. |
| Click and release a dot | Show the rotation rings at that pivot. A click stays below the drag threshold. |
| Drag a rotation ring | Keep the rings visible. A joint ring rotates the joint. A ring at the floor dot rotates the whole mannequin while preserving its limb pose. If a ring overlaps a dot, the ring takes priority. |
| Drag an IK dot | Once past the drag threshold, hide the rings and keep the affected chain cyan. Move the limb tip or steer the bend, according to the dot. On release, keep the pose and clear the joint selection. The mannequin stays selected. |
| Click empty space | Deselect the mannequin and hide its dots and rings. Keep the viewport in place. |

The floor dot controls the whole model and has no IK chain. Use each rig's chain definitions to decide which dots highlight together and which dots support direct IK dragging. For the canine, feline, and bunny, check both forelegs and both hind legs. For the owl, check both wings and both legs.

## Implementation audit

Reviewed at `a6393eb`. The human column is based on the recording and the viewer code. The animal column is based on source inspection. All four animals share the same marker and pointer code. Animal interactions were not run in ComfyUI.

| Check | Human | Canine, feline, bunny, owl |
| --- | --- | --- |
| Select or deselect without moving the viewport | Edit-mode selection updates the controls without snapping to the output camera. | Same edit-mode path. Switching between animal and human preserves the viewport. |
| Hover without moving the rings | The hovered dot and its active IK chain highlight in cyan. Hand hover has its own highlight. | Partial. Hover leaves the rings alone, but only the hit dot changes to pale gold. Chain dots do not light up together. |
| Click and release to show rings | An IK marker click selects its pivot on release if no drag occurred. Ordinary FK markers can attach the rings on pointer-down. | Gap. Marker selection starts on pointer-down, before the drag threshold is evaluated. |
| Rotate using rings | The floor pivot rotates the full model. Joint pivots rotate their joints. | Implemented in source. The floor dot selects the animal root, and the rings rotate it. Ordinary selected joint dots are white rather than cyan. |
| Drag a dot directly | A direct IK gesture detaches the rings. Finishing a drag clears the joint selection and keeps the pose. | Gap. Direct limb posing exists, but the handler does not explicitly detach rings when dragging starts or clear the joint selection on release. Whether rings are visible during the drag depends on the marker path. The floor dot can also rotate the model by direct dragging. |
| Click empty space | Clears the mannequin selection. | Same selection-clearing path. |

Source locations: [human viewer](../web/vendor/vnccs_pose_studio_core.mjs), [animal rig and marker colors](../web/editor/animal-mannequin.mjs), [viewport pointer handling](../web/editor/scene.mjs), [mannequin selection](../web/editor/actors-ui.mjs).
