# Studio layout correction

1. Give the scene list and character inspector their own adjacent left columns. Keep the viewport and camera gestures available while working in either column.
2. Keep placement on the model. Remove the precise-placement disclosure and numeric fields. Keep one keyboard-operable scale slider with reset, and show joint adjustments inline when a joint is selected.
3. Put photo operations under Add to Scene. Offer pose transfer and 3D reconstruction as distinct tasks. Reveal reconstruction settings in the reconstruction flow.
4. Allow outside clicks to dismiss task popups while preserving the Studio draft. Keep confirmation dialogs explicit.
5. Reuse the palette and give the scene list, inspector and selected controls distinct visual roles. Obtain an independent review of every stylesheet change. Inspect the source; live ComfyUI validation stays with Vroni.

## Camera and Output coexistence

- [x] Keep Scene and its selection available when opening Camera or Output. Compress character controls alongside the viewport on wide layouts and place them beneath Scene in the same column on narrower desktop layouts. At tablet widths keep both under the viewport, followed by Camera or Output. Restore the separate left columns when closing the right panel.
