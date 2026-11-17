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

**Current direction:** Start with the [blank-slate Studio redesign](docs/studio-redesign.md). The canvas command strip, empty start, and targeted appearance picker are implemented on the preview branch. See the acceptance checks before extending the rest of the redesign.

Status: the reference-card labels, status and keyboard focus restoration are implemented. Output displays inputs by image number after Prompt. Live behavior and accessibility still need verification.

The user arranges an editable scene and sends its composition guide, prompt, and selected images to the generator. Keep the route from each reference to its visible effect and output easy to follow.

| Area | What the user does there |
| --- | --- |
| References | Add photos, assign their purpose, see their targets, and repair broken assignments. |
| Scene | Select and arrange characters, GLBs, placed images, and the background. Show controls for the selection and keep the camera steady when selection changes. |
| Output | Review the guide, prompt, and actual ordered generator inputs before applying. |

### Start with References → Scene

- [x] Trace reference actions through the card, scene mutations, coarse guide, and generator input manifest. Start in [references-ui.mjs](web/editor/references-ui.mjs), [actors-ui.mjs](web/editor/actors-ui.mjs), and [reference-library.mjs](web/editor/reference-library.mjs).
- [x] Give each action an outcome-first label. Distinguish assigning appearance, creating a posed mannequin, placing a flat image, setting the visible background, and setting the source for extraction or reconstruction.
- [x] Show the result on the reference card, such as *Appearance reference for Pip*. In the pose picker, make the optional appearance assignment visible before confirmation. A future baked mannequin texture is a separate scene state.
- [x] Explain excluded roles at the field that needs attention. For example, show *Character deleted* and let the user choose a replacement. Distinguish a missing target from a hidden target, a disabled role, and a missing image.
- [x] Clarify background behavior. Setting the background enables the visible background and the generation role. Clear Visible Background clears the visible background. The generation role can be disabled separately.
- [x] Restore focus on a matching control when the reference card refreshes, with a fallback to the card heading or Add Reference.
- [ ] Verify focus, status feedback, and narrow sidebar layout in ComfyUI.
- [ ] Review Output next. Use the same names across all three areas and show the guide first, followed by the prompt and ordered generator inputs. Keep the existing visual theme during this workflow pass.

### Full-editor workflow preview

- [x] Keep creation and the ordered object list together in Scene.
- [x] Keep Ground, Frame, and Object Scale with reset under the scene list. Use the viewport for placement and show one optional settings group at a time beside it. Show joint sliders only for a chosen joint.
- [x] Keep References in a dialog. Open Camera Settings or Review Output beside the viewport with the scene sidebar out of the way. Keep the camera and selection when switching panels.
- [x] Keep saved camera views and scene variations together under the viewport.
- [ ] Review the solo-pose and four-character picnic workflows in ComfyUI. Check keyboard selection and focus, narrow sidebars, camera framing across panels, and saving a view versus saving a variation.
- [ ] Unify direct viewport placement and posing using the existing 3D interaction paths.