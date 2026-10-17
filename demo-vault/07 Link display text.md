# Link display text

By default, a link Obsidian inserts to an attachment shows the file path (or, for an embed, nothing readable). With **`shouldSetLinkDisplayTextToAttachmentFileName`** turned on, every link the plugin generates to an **attachment** uses the attachment's base name (the file name without its extension) as the visible display text - so `report-2026.pdf` shows up as `report-2026` instead of a long path.

Notes are deliberately left alone: a link from one note to another keeps Obsidian's normal display text. And if you provide an explicit alias, or the image has a cached size, that wins over the base-name default.

## Try it

1. Open **Settings -> Community plugins -> `Custom Attachment Location`** and turn on **Set link display text to attachment file name**.
2. Open a note and drag a non-image attachment, for example a PDF, into it.
3. Look at the inserted link: it now reads `[[.../report-2026.pdf|report-2026]]`, showing `report-2026` as the display text.
4. Insert a link to another **note** and confirm its display text is unchanged - the setting only affects attachments.

The first button does step 1:

```code-button
---
caption: Turn on Set link display text to attachment file name
---
await require('/demoSetup.ts').changeSettings(app, { shouldSetLinkDisplayTextToAttachmentFileName: true });
```

The second does steps 2 to 4. It creates `Materials/07 Link display text/` with `report-2026.pdf`, a note, `Other note`, and a note, `Link display demo`, into which it writes the link Obsidian generates to each - the same call a drop and a link suggestion make. It opens that note and names both links in a notice. Press it with the setting off, then on, to see the difference:

```code-button
---
caption: Insert a PDF link and a note link
---
await require('/demoSetup.ts').insertLinksForDisplayTextDemo(app);
```

```code-button
---
caption: Turn the setting off again
---
await require('/demoSetup.ts').changeSettings(app, { shouldSetLinkDisplayTextToAttachmentFileName: false });
```

Manual equivalent: the four steps above.

Relevant setting: `shouldSetLinkDisplayTextToAttachmentFileName` (see [06 Settings](<./06 Settings.md>)).
