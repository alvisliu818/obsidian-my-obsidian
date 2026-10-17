# Navigation

Once attachments live in a folder per note, moving between the two by hand means scrolling the file explorer to a folder whose name you have to remember. Two commands do it for you.

## Custom Attachment Location: Go to attachment folder

Run it on a note and the file explorer reveals the folder that note's attachments are saved into.

The folder is worked out from your **Attachment folder path** pattern, not from a fixed folder name, so it follows whatever you configured — one folder beside every note, a folder per note, a folder per year.

Two cases the command has to answer for:

- **The folder does not exist yet.** A note with no attachments has no folder. Rather than creating one behind your back, the command shows a notice naming the path with a **Create** button. Click it and the folder is created and revealed; ignore it and nothing is written.
- **The pattern depends on the attachment.** If your **Attachment folder path** contains `{{prompt}}` or `{{originalAttachmentFileName}}`, the folder is decided per attachment, so the note has no single folder to go to. The command says so instead of guessing.

## Custom Attachment Location: Go to owning note

Run it on an attachment and the note that owns it opens.

This is not the first command run backwards. A pattern cannot be un-applied — `{{random}}` and `{{prompt}}` throw away the information you would need — so the owner is found from the **links** instead: the notes that reference the attachment.

- **One note references it.** That note opens.
- **Several do.** The **Note priorities** setting decides, exactly as it does when collecting (see [06 Settings](<./06 Settings.md>)). Put `.md` above `.excalidraw.md` and an image shared by both opens the markdown note.
- **The priority list names nobody** — it is empty, nothing matched, or several notes tie — you are asked which one, and told which of the three it was. Only the notes sharing the best rank are offered: the list has already ruled the others out, so picking one would open a note the plugin itself would never have chosen. When the list decides nothing, every referencing note is offered.

If the attachment sits in an **attachment unit folder** (see [06 Settings](<./06 Settings.md>)), the whole folder is consulted, not just the selected file. A saved web page's `_files` folder holds one linked `.html` and a pile of images nothing links to directly; without this they would all be ownerless.

## Try it

The first button creates `Materials/10 Navigation/` with a note, `Navigation demo`, and an image it embeds, saved in that note's attachment folder, `assets/Navigation demo/`. It also puts back this vault's location pattern, `./assets/{{noteFileName}}`, in case another note changed it, and opens the note.

```code-button
---
caption: Set up the navigation demo
---
await require('/demoSetup.ts').setUpNavigationDemo(app);
```

Run **Go to attachment folder** on the note. The file explorer highlights `Materials/10 Navigation/assets/Navigation demo/`.

```code-button
---
caption: Go to the attachment folder of Navigation demo
---
await require('/demoSetup.ts').goToNavigationDemoAttachmentFolder(app);
```

Open the image and run **Go to owning note** on it. You are back in `Navigation demo`.

```code-button
---
caption: Open the image and go to its owning note
---
await require('/demoSetup.ts').goToNavigationDemoOwningNote(app);
```

Manual equivalent: paste an image into a note and run **`Custom Attachment Location`: Go to attachment folder**, then click the image to open it and run **`Custom Attachment Location`: Go to owning note**. Both commands are on the file explorer's right-click menu too: right-click the note for the first and the image for the second.
