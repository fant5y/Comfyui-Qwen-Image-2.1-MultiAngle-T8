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
| Drag a posing dot | Once past the drag threshold, hide the rings and keep the affected dots cyan. Move a limb tip, steer a bend, or turn the body part at the joint. On release, keep the pose and clear the joint selection. The mannequin stays selected. |
| Click empty space | Deselect the mannequin and hide its dots and rings. Keep the viewport in place. |

The floor dot controls the whole model and has no IK chain. A gold limb target selects its terminal joint on click and moves the limb tip on drag. Use each rig's chain definitions to decide which dots highlight together. Dragging an animal’s head, ear, or tail joint turns the body part from its parent joint. For the canine, feline, and bunny, check both forelegs and both hind legs. For the owl, check both wings and both legs.

## Implementation audit

The human column is based on the recording and viewer code. The animal column records the updated source behavior. Canine, feline, bunny, and owl share the same marker and pointer handlers. Their interactions still need a live ComfyUI check.

| Check | Human | Canine, feline, bunny, owl |
| --- | --- | --- |
| Select or deselect without moving the viewport | Edit-mode selection updates the controls without snapping to the output camera. | Same edit-mode path. Switching between animal and human preserves the viewport. |
| Hover without moving the rings | The hovered dot and its active IK chain highlight in cyan. Hand hover has its own highlight. | Hover highlights the hit dot and its related chain in cyan. Moving away restores the selection highlight. The rings stay at the selected pivot. |
| Click and release to show rings | An IK marker click selects its pivot on release if no drag occurred. Ordinary FK markers can attach the rings on pointer-down. | Marker clicks attach the rings on release. Crossing the drag threshold disqualifies the click. |
| Rotate using rings | The floor pivot rotates the full model. Joint pivots rotate their joints. | Joint rings rotate the cyan joint. The cyan floor pivot rotates the animal root. Ring hits take priority over dot hits. |
| Drag a dot directly | A direct IK gesture detaches the rings. Finishing a drag clears the joint selection and keeps the pose. | Dragging a posing dot past the threshold detaches the rings and highlights the affected joints. On release, the pose stays and joint selection clears. The animal stays selected. The floor dot uses its rings for rotation. |
| Click empty space | Clears the mannequin selection. | Same selection-clearing path. |

Source locations: [human viewer](../web/vendor/vnccs_pose_studio_core.mjs), [animal rig and marker colors](../web/editor/animal-mannequin.mjs), [viewport pointer handling](../web/editor/scene.mjs), [mannequin selection](../web/editor/actors-ui.mjs).
