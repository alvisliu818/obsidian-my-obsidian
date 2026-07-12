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
- Mode switching: start playback, switch between Reading view and Live Preview or Source mode, then pause, resume, and seek with the floating player.
- Long-note scrolling: scroll far enough for the original audio embed to be unloaded, then select several timestamps in sequence.
- Multiple panes: open two transcript notes side by side and confirm each timestamp uses the audio embedded in the pane that was selected.
- Continuous seeking: select several earlier and later timestamps while audio is playing and confirm only one player remains active.

The plugin-level player should remain mounted until the plugin is disabled or Obsidian closes.
