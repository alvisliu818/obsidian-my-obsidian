# Regression testing

Run the automated checks before every release:

```bash
npm test
npm run lint
npm run build
```

Then install the production build in a test vault and verify these scenarios:

- Reading view: select timestamps near the beginning and end of a long transcript.
- Live Preview: select the rendered timestamp label and confirm immediate seeking and playback.
- Source mode: select the link label and URL portion of a Markdown timestamp link.
- Multiple recordings: use overlapping timestamps with explicit aliases and verify each selects the intended file.
- Mode switching: start playback, switch between Reading view and Live Preview or Source mode, then pause, resume, and seek with the floating player.
- Navigation behavior: verify continue, pause, and close while opening Markdown, images, PDFs, canvases, and empty tabs.
- Close control: close the floating player and confirm playback stops and the media resource is released.
- Long-note scrolling: scroll far enough for the original audio embed to be unloaded, then select several timestamps in sequence.
- Multiple panes: open two transcript notes side by side and confirm each timestamp uses the audio embedded in the pane that was selected.
- Continuous seeking: select several earlier and later timestamps while audio is playing and confirm only one player remains active.

The player should remain mounted across view-mode changes. Across page changes it follows the configured navigation behavior, which defaults to preserving the current state.
