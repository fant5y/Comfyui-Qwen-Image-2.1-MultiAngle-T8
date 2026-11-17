# AnyAngle Studio redesign

The current preview is a reference for behavior and saved data. Design the editor surface from a blank canvas. Begin with journeys, then choose the controls each step needs. The earlier preview kept the property form and changed how it opened. This design supersedes that approach.

## Three journeys

| I want to… | First action | What happens while I work | Done when… |
| --- | --- | --- | --- |
| Make a pose | Add a character from the empty canvas | The character appears selected and ready to pose. Drag a hand, paw or wing handle. Select a joint to rotate it. | I can send the pose guide directly to the node. |
| Build the picnic | Add Finn, Pip, Curly and Owly as needed | Place and pose them in one canvas. Start an appearance assignment from Pip. Add the basket and backdrop as scene objects. | I can see all four in the intended output frame and tell which images affect the guide and which reach the generator. |
| Try another shot or scene | Save the current take | Save an angle from the camera or save an arrangement from the scene. Both appear with thumbnails and distinct labels. | I can return to the wide shot while keeping the current pose, or restore a different arrangement. |

These journeys come from the user's examples and recordings. They are design hypotheses for the next editor, not observed results from a new usability session. Map the whole task before choosing widgets. [GOV.UK Service Manual](https://www.gov.uk/service-manual/design/map-a-users-whole-problem)

## Workspace sketch

    EMPTY SCENE             CHARACTERS IN SCENE           REVIEW
    ┌──────────────────┐    ┌─────────────────────────┐   ┌────────────────────┐
    │                  │    │                         │   │ Actual output frame│
    │ Add a character  │    │  Finn   Pip  Curly Owly │   │                    │
    │ Add from file    │    │               ◉ wing   │   │ Guide    Prompt    │
    │                  │    │                   ◉ root│   │ Images sent        │
    └──────────────────┘    └─────────────────────────┘   │ Return     Apply   │
                              Pip · Appearance              └────────────────────┘
                              Wide shot / Owl lands

The sketch places actions by task. It does not specify pixels or production widgets.

## Decisions from the reference interfaces

- **Blender.** Separate the working view, the selected object, and the output camera. Orbit, pan and zoom remain available while editing. Selecting an item from the canvas or object index never changes the view. Dragging the root moves or rotates the whole model; dragging a limb affects the pose. Explicitly adopt the working view as the output camera. Use Studio's Y-up convention. [Blender navigation](https://docs.blender.org/manual/en/latest/editors/3dview/navigate/introduction.html) · [Camera view](https://docs.blender.org/manual/en/5.2/editors/3dview/navigate/camera_view.html)
- **Photoshop.** Derive the immediate action from the target. A selected Pip can have an Appearance action near the canvas. A selected wing offers adjustments for that wing. Pin the action area to a predictable edge so changes in selection do not move the next target around or cover handles. [Adobe interface screenshot and documentation](https://helpx.adobe.com/photoshop/desktop/get-started/learn-the-basics/workspace-overview.html) · [Contextual Task Bar](https://helpx.adobe.com/photoshop/desktop/get-started/learn-the-basics/boost-workflows-with-the-contextual-task-bar.html)
- **Cura.** Editing the source and inspecting what the machine will receive are distinct tasks. Output review uses the actual guide, prompt and ordered inputs. Return to the same selection and working view. Review is available as needed for complex scenes. The solo pose can go straight to Apply. [Cura interface overview](https://support.ultimaker.com/articles/Knowledge/1667411132925) · [Cura workflow](https://support.ultimaker.com/s/article/1667411295200)
- **Accessibility.** Provide named joint and object targets and a click or keyboard equivalent for drag actions, with labeled steps or precise editing. Preserve focus across changes, make selected/locked/hidden state readable without color, and restore focus after closing a dialog. [Dragging movements](https://www.w3.org/WAI/WCAG22/Understanding/dragging-movements.html) · [Modal dialog pattern](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/)

## An image popup answers one question

Open a picker from the operation when the operation is already known. **Pip → Appearance** opens with Pip named in the title. Pick a photo and confirm. If opening from a photo, first choose its intended effect with a one-line result. Show only the inputs required for that effect.

| Intent | Result | What the popup needs |
| --- | --- | --- |
| Match appearance | The generator uses the image to guide a named character's look. | Character and image |
| Create a posed character | Studio adds an editable mannequin inferred from a photo alongside existing characters. | Image and detected subject, then rig choice when needed |
| Place a flat image | The image becomes a transformable object visible in the guide. | Image, then placement on canvas |
| Set a backdrop | The image fills the shot by default, with placement and resize in the scene. | Image, then placement on canvas |
| Reconstruct 3D | The selected image goes to reconstruction. Model settings belong with that operation. | Source image and reconstruction options |

Applying a texture to the mannequin would be a separate action with its own visible result. Appearance assignment cannot claim that effect. References-only generation also needs a direct output route, available without adding any scene objects.

## Reject layouts that add friction

| Check | Pass condition |
| --- | --- |
| Multiple inputs | Moving, turning, resizing and posing a character require zero typed fields. Exact entry is available on demand for the selected action, keyboard access or repeatability. Selecting an object never opens a stack of numeric fields. |
| Multiple toggles | A common task requires zero expand/collapse steps and zero category dropdowns. A real toggle changes a persistent state, such as visibility, and explicitly shows that state. A popup has a specific outcome and never contains a second menu of unrelated tasks. |
| Long mouse paths | After selecting a character or limb, the next edit is on that target or at the nearest fixed canvas edge. Moving from posing to appearance or precision must not cross to the far sidebar and back. Changing selection, closing a popup and returning from Review preserve the working view. |
| Repeated actions | Switching Pip → Owly → Pip requires one selection each. Returning to Pip restores his context without reopening panels, scrolling or reassigning the photo. |
| Attention and accessibility | Show the active target by name and visible selection. Provide focus indicators, labeled actions, a non-drag pointer alternative and a keyboard route. Make the same tasks work at narrow widths without clipped labels, hover-only actions or menus parked over the target. |

For each proposal, trace the solo pose and picnic twice, once with a pointer and once with a keyboard. Record clicks or key steps, typed fields, section opens, scrolls and canvas crossings. For pointer paths, mark the point of selection and the next two control positions at normal and narrow widths. A layout that fails a condition goes back to design even if it looks cleaner. Use the live editor only for the separately authorized usability pass.

## Interaction model and acceptance

Keep working viewpoint, output camera, selection, scene content, image assignments and output decisions independently addressable. A dialog takes a stable target ID and returns a result to the invoking operation. Cancel leaves scene and draft intact. The scene index supports discovery and selection of crowded or hidden objects. Keep frequent edits near the selected object and secondary controls discoverable by name.

1. From an empty scene, add a character and pose it without opening an image or settings picker. Verify a selected joint and the whole-model root affect different targets. Run this for a human and an animal.
2. Build the picnic. Assign Pip's appearance, place the basket and set a backdrop. Switch between identical display names and check that the assignment follows the actual selected object. Confirm no view jump when switching.
3. Save Wide Shot. Orbit to inspect Owly's wing, then return to Wide Shot. Save and recall Owl Lands as an arrangement. Inspect the actual output and return to editing without losing the draft.
4. Repeat selection, an adjustment, image assignment and return from review with only the keyboard. Repeat a drag action using the click alternative. At a narrow width, make sure the canvas and dialog labels remain usable.
5. Before replacing the live editor, trace existing node outputs and saved scenes against all three journeys. Include imported and rebuilt objects, external guides, reference-only generation, scene ZIPs, presets and saved views. Preserve the data contracts while rebuilding the visible interaction surface.
