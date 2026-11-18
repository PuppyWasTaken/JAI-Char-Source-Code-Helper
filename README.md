# JanitorAI Source Helper

the edit character source code editor sucks. i complained and they did nothing about it. here's my solution.

![demo image](https://file.garden/aWyedZylm2AE_XoC/JanitorAISourceCodeHelper.png)
![demo image2](https://file.garden/aWyedZylm2AE_XoC/SourceCodeHelper2.png)

## Install in Chrome

1. Download the repo zip and extract it into a folder.
2. Open `chrome://extensions`.
3. Toggle on **Developer mode** (top right).
4. Click **Load unpacked** and select the `janitorai-source-helper` folder
5. Refresh any already-open JanitorAI tabs.
6. Edit your character and open **Edit source code**.

Line numbers, word wrap, and syntax colours appear automatically. HTML tags, attributes, strings, comments, and embedded CSS/JavaScript have language-aware highlighting. Click **Beautify HTML** to indent the source with two spaces, including CSS inside `<style>` tags. Use JanitorAI's existing save/apply button when ready; this extension never saves for you.

## Personality and Scenario Markdown previews

The **Personality** and **Scenario** fields open with Markdown preview on by default. Click **Edit** to turn preview off and use the original textarea, then **Preview** to turn it back on. Each field toggles independently and stays in your selected mode while you work; previewing never changes your text, token count, or saved character data. Required-field validation can also reveal an empty textarea so you can fill it in.

## Notes

- Formatting is opt-in: opening the dialog never rewrites your source.
- **Undo format** restores the exact pre-format text, until you make another edit. Formatting can change meaningful HTML whitespace; review the result before saving.
- Long lines wrap automatically without inserting newlines into your actual source. Wrapped continuations keep their original line number, and numbers remain aligned when resizing the editor.
- Drag the lower-right corner to resize the editor vertically.
- CodeMirror provides the visible editor. The site's original textarea stays in its original location and is kept in sync through normal input/change events, including after formatting and undo.
- The HTML editor only enhances dialogs titled **Edit source code**. Markdown previews only attach to the `personality` and `scenario` textareas, including when the site loads them dynamically.
- No account access, network requests, analytics, storage, background worker, or extra Chrome permissions. All code runs locally; the extension only loads on `janitorai.com` and its subdomains.
- Standard editor undo/redo works. This is not a full IDE; no code completion is included.

## Bundled dependencies

`vendor/beautify*.js`: js-beautify **1.15.4**, MIT licensed. The original license is included in `vendor/LICENSE`. No CDN is used at runtime.

`vendor/codemirror/`: CodeMirror **5.65.21**, MIT licensed, with HTML/XML, CSS, and JavaScript modes. Its license is included in `vendor/codemirror/LICENSE`. All editor assets are bundled locally.

`vendor/marked.js`: Marked **18.2.1**, MIT licensed, with its license in `vendor/marked-LICENSE`.

`vendor/purify.min.js`: DOMPurify **3.4.18**, dual licensed under Apache-2.0 or MPL-2.0. License information is in `vendor/dompurify-LICENSE` and `vendor/dompurify-LICENSE-MPL`. Markdown parsing and sanitizing both run locally, with no CDN at runtime.

`vendor/turndown.js`: Turndown **7.2.5**, and `vendor/turndown-plugin-gfm.js`: turndown-plugin-gfm **1.0.2**, both MIT licensed. Licenses are included in `vendor/turndown-LICENSE` and `vendor/turndown-plugin-gfm-LICENSE`. These bundled libraries convert rich-text edits back into Markdown locally.

## Disclaimer 
Extension heavily assisted by GPT Sol 6.1, I do not take credit. Icon image generated on Tensor.art 
