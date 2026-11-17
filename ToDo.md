# AnyAngle Studio UI

- [x] Reuse the mannequin placement layout and row actions for imported GLBs.
- [x] Give imported GLBs the existing rotation rings for the whole model and individual bones where available.
- [x] Review the source changes for placement, rotation, and UI consistency.
- [x] Prepare the changes for the fork.
- [x] Remove the stray brace that prevented the editor module from loading.
- [ ] Verify Studio startup and rotate a rigid and a skinned GLB in ComfyUI.

## Styling postponed

- [x] Restore the styles from before the typography changes.
- [ ] Give labels, fields, buttons, hints, and library text a readable default.
- [ ] Keep section headings modest and use the same spacing and chevrons on both sidebars.
- [ ] Follow ComfyUI’s page font and size automatically. Keep supporting text close to the base size.
- [ ] Let narrow sidebars wrap guide controls and source-image instructions.

## Workflow restructuring

Status: source review complete for the reference card. The changes below are proposed. Live behavior and accessibility still need verification.

The user arranges an editable scene and sends its composition guide, prompt, and selected images to the generator. Keep the route from each reference to its visible effect and output easy to follow.

| Area | What the user does there |
| --- | --- |
| References | Add photos, assign their purpose, see their targets, and repair broken assignments. |
| Scene | Select and arrange characters, GLBs, placed images, and the background. Show controls for the selection and keep the camera steady when selection changes. |
| Output | Review the guide, prompt, and actual ordered generator inputs before applying. |

### Start with References → Scene

- [x] Trace reference actions through the card, scene mutations, coarse guide, and generator input manifest. Start in [references-ui.mjs](web/editor/references-ui.mjs), [actors-ui.mjs](web/editor/actors-ui.mjs), and [reference-library.mjs](web/editor/reference-library.mjs).
- [ ] Give each action an outcome-first label. Distinguish assigning appearance, creating a posed mannequin, placing a flat image, setting the visible background, and setting the source for extraction or reconstruction.
- [ ] Show the result on the reference card, such as *Appearance reference for Pip*. In the pose picker, make the optional appearance assignment visible before confirmation. A future baked mannequin texture is a separate scene state.
- [ ] Explain excluded roles at the field that needs attention. For example, show *Character deleted* and let the user choose a replacement. Distinguish a missing target from a hidden target, a disabled role, and a missing image.
- [ ] Clarify background behavior. The current action sets the visible background and adds a generation role, while clearing the background leaves the role behind. Make both effects visible and define what clearing each one does before changing behavior.
- [ ] Keep keyboard focus on the corresponding control when the reference card refreshes. Use visible labels and inline recovery instructions. Tooltips can hold supplemental detail. Check the flow with keyboard navigation.
- [ ] Review Output next. Use the same names across all three areas and show the guide first, followed by the prompt and ordered generator inputs. Keep the existing visual theme during this workflow pass.
