# Studio layout correction

1. Move the scene list and active-character controls into a dock on the right of the canvas. Use a compact layer-style list. Keep joint selection, body controls and supported pose actions inline and open. Keep image selection in its own dialog.
2. Remove the viewport mode switch and the duplicate bottom action bar. Use direct joint and root manipulation in the same viewport. Add an object-move gesture and preserve access to precise movement. Keep camera framing explicit. Use the existing placement interaction for standalone scene assets.
3. Add a Y-up orientation indicator in the upper-right. Read the working camera orientation while orbiting and updating the shot. Exclude the indicator from output.
4. Put an accessible horizontal resize handle above Camera Views and Scene Variations. Support drag, arrows and Home. Bound the height so the canvas stays usable. Scope scrollbar rules to the editing dock and views.
5. Make targeted layout and control-style changes to the current stylesheet. Have an independent UI design reviewer inspect the actual diff, then address findings before publishing. Check the two-character case, idle and selected states, long names, narrow layout, and camera versus guide behavior. Live ComfyUI validation stays with Vroni.
