(() => {
  "use strict";

  const editors = new Map();
  const markdownPreviews = new Map();
  const markdownSelector = 'textarea#personality, textarea#scenario';
  let previewId = 0;
  const options = {
    indent_size: 2,
    indent_char: " ",
    preserve_newlines: true,
    max_preserve_newlines: 2,
    wrap_line_length: 0,
    wrap_attributes: "auto",
    // Leave whitespace-sensitive content alone, including embedded templates.
    content_unformatted: ["pre", "textarea", "script"],
    extra_liners: [],
    end_with_newline: false
  };

  function writeValue(textarea, value) {
    // Use the native setter, not React's instance-level value tracker.
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
    setter.call(textarea, value);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    textarea.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function enhanceMarkdown(textarea) {
    const label = textarea.id === "personality" ? "Personality" : "Scenario";
    const imageSources = new Map();
    const imageKey = node => JSON.stringify([node.getAttribute("href"), node.textContent]);
    const renderer = new marked.Renderer();
    // Never fetch remote images; keep their original Markdown when editing nearby text.
    renderer.image = ({ href, text, raw }) => {
      const link = document.createElement("a");
      link.setAttribute("href", href);
      link.className = "jsh-markdown-image-link";
      link.textContent = text ? `Image: ${text}` : "View image";
      imageSources.set(imageKey(link), raw);
      return link.outerHTML;
    };
    const markdown = new marked.Marked({ gfm: true, breaks: true, renderer });
    const toMarkdown = new TurndownService({
      headingStyle: "atx",
      bulletListMarker: "-",
      codeBlockStyle: "fenced",
      emDelimiter: "*",
      // Marked already renders soft newlines as breaks. Do not add hard-break
      // escapes/spaces when serializing contenteditable's <br> elements.
      br: ""
    });
    toMarkdown.use(turndownPluginGfm.gfm);
    toMarkdown.addRule("previewImages", {
      filter: node => node.nodeName === "A" && node.classList.contains("jsh-markdown-image-link") &&
        imageSources.has(imageKey(node)),
      replacement: (content, node) => imageSources.get(imageKey(node))
    });
    // Keep safe HTML constructs that do not have a standard Markdown equivalent.
    toMarkdown.keep(["sup", "sub", "details", "summary"]);
    const toolbar = document.createElement("div");
    toolbar.className = "jsh-toolbar jsh-markdown-toolbar";
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "jsh-button jsh-secondary";
    toggle.textContent = "Preview";
    toggle.setAttribute("aria-label", `Preview ${label} Markdown`);
    toggle.setAttribute("aria-pressed", "false");
    const hint = document.createElement("span");
    hint.className = "jsh-markdown-hint";
    hint.id = `jsh-markdown-hint-${++previewId}`;
    hint.textContent = "Type Markdown to format · Start bullets with - or * then Space";
    const status = document.createElement("span");
    status.className = "jsh-status";
    status.setAttribute("role", "status");
    toolbar.append(hint, toggle, status);

    const preview = document.createElement("div");
    preview.id = `jsh-markdown-preview-${previewId}`;
    preview.className = "jsh-markdown-preview";
    preview.hidden = true;
    preview.tabIndex = 0;
    preview.setAttribute("role", "textbox");
    preview.setAttribute("aria-multiline", "true");
    preview.setAttribute("aria-label", `${label} editable Markdown preview`);
    preview.setAttribute("aria-describedby", hint.id);
    preview.dataset.placeholder = "Nothing to preview yet. Click here to start writing.";
    toggle.setAttribute("aria-controls", preview.id);
    textarea.before(toolbar);
    textarea.after(preview);

    let showing = false;
    let renderedValue = null;
    let textareaScroll = 0;
    let syncedHTML = "";
    let syncingFromPreview = false;
    let composing = false;
    let applyingInputRule = false;
    let insertingPlainText = false;
    let completedInlineCode = null;
    let lastEnter = null;
    let formatExitId = 0;
    const formatExitHistory = [];
    const pendingBlockNodes = new Set();
    const locked = () => textarea.disabled || textarea.readOnly;
    const updateEmpty = () => {
      preview.dataset.empty = String(!preview.textContent && !preview.querySelector("hr, input, table"));
    };
    const sanitize = html => DOMPurify.sanitize(html, {
      RETURN_DOM_FRAGMENT: true,
      ALLOWED_TAGS: ["div", "p", "br", "hr", "h1", "h2", "h3", "h4", "h5", "h6",
        "strong", "b", "em", "i", "del", "s", "ul", "ol", "li", "blockquote",
        "pre", "code", "a", "table", "thead", "tbody", "tr", "th", "td",
        "input", "sup", "sub", "details", "summary"],
      ALLOWED_ATTR: ["href", "title", "class", "start", "align", "type", "checked", "disabled"],
      ALLOW_DATA_ATTR: false,
      ALLOW_ARIA_ATTR: false
    });
    const update = () => {
      preview.contentEditable = String(!locked());
      preview.setAttribute("aria-readonly", String(locked()));
      preview.setAttribute("aria-disabled", String(textarea.disabled));
      preview.tabIndex = textarea.disabled ? -1 : 0;
      if (!showing || syncingFromPreview || renderedValue === textarea.value) return;
      try {
        // An explicit allowlist excludes scripts, CSS, embedded content, images,
        // and other elements that could affect the page or make network requests.
        imageSources.clear();
        const fragment = sanitize(markdown.parse(textarea.value));
        for (const link of fragment.querySelectorAll("a")) {
          link.target = "_blank";
          link.rel = "noopener noreferrer";
        }
        for (const input of fragment.querySelectorAll("input")) {
          input.type = "checkbox";
          input.disabled = true;
        }
        preview.replaceChildren(fragment);
        completedInlineCode = null;
        lastEnter = null;
        formatExitHistory.length = 0;
        pendingBlockNodes.clear();
        updateEmpty();
        syncedHTML = preview.innerHTML;
        renderedValue = textarea.value;
        status.textContent = "";
      } catch (error) {
        preview.contentEditable = "false";
        preview.setAttribute("aria-readonly", "true");
        status.textContent = "Could not render this Markdown. Use Edit Markdown to view your text.";
        console.warn("JanitorAI Source Helper: Markdown preview failed", error);
      }
    };
    const codeText = node => {
      if (node.nodeType === Node.TEXT_NODE) return node.textContent;
      if (node.nodeName === "BR") return "\n";
      let text = "";
      for (const child of node.childNodes) {
        const block = /^(DIV|P)$/.test(child.nodeName);
        if (block && text && !text.endsWith("\n")) text += "\n";
        text += codeText(child);
        if (block && child.nextSibling && !text.endsWith("\n")) text += "\n";
      }
      return text;
    };
    const syncPreview = () => {
      if (!showing || locked() || composing || preview.innerHTML === syncedHTML) return true;
      try {
        const container = document.createElement("div");
        container.append(sanitize(preview.innerHTML));
        // Chromium inserts <br>/<div> for Enter inside contenteditable code.
        // Turndown reads code.textContent, so normalize those breaks on the
        // detached copy only; never flatten lines in the user's editable DOM.
        for (const pre of container.querySelectorAll("pre")) {
          const text = codeText(pre);
          const code = pre.querySelector("code") || document.createElement("code");
          code.textContent = text;
          pre.replaceChildren(code);
        }
        const value = toMarkdown.turndown(container);
        // Do not rebuild the editable DOM on our own input events: that would
        // move the caret and break the browser's native rich-text undo history.
        syncingFromPreview = true;
        try {
          renderedValue = value;
          writeValue(textarea, value);
          syncedHTML = preview.innerHTML;
          updateEmpty();
          status.textContent = "";
        } finally {
          syncingFromPreview = false;
        }
        // Honour any value normalization performed synchronously by the site.
        update();
        return true;
      } catch (error) {
        status.textContent = "Could not sync this edit. Copy your preview text before switching modes or saving.";
        console.warn("JanitorAI Source Helper: Markdown edit sync failed", error);
        return false;
      }
    };
    // Keep DOM positions for logical lines: Chromium uses paragraphs/divs for
    // Enter and <br> for Shift+Enter, sometimes in the same editable field.
    const editableLines = () => {
      const lines = [];
      let line = null;
      const point = (node, offset) => ({ node, offset });
      const begin = position => { line ||= { start: position, end: position, text: "" }; };
      const end = position => {
        if (!line) return;
        line.end = position;
        lines.push(line);
        line = null;
      };
      const walk = node => {
        if (node.nodeType === Node.TEXT_NODE) {
          // Ignore Marked's whitespace between rendered block elements.
          if (node.parentNode === preview && /^\n+$/.test(node.textContent)) return;
          for (let offset = 0; offset < node.length; offset++) {
            begin(point(node, offset));
            if (node.data[offset] === "\n") end(point(node, offset));
            else {
              line.text += node.data[offset].replace(/\u00a0/g, " ");
              line.end = point(node, offset + 1);
            }
          }
          return;
        }
        if (node.nodeType !== Node.ELEMENT_NODE) return;
        const index = () => Array.prototype.indexOf.call(node.parentNode.childNodes, node);
        if (node.nodeName === "BR") {
          begin(point(node.parentNode, index()));
          // The final <br> on an empty browser line is a caret placeholder.
          if (!node.nextSibling && !line.text) return;
          end(point(node.parentNode, index()));
          begin(point(node.parentNode, index() + 1));
          return;
        }
        const block = node !== preview && /^(P|DIV|H[1-6]|BLOCKQUOTE|LI|UL|OL|PRE)$/.test(node.nodeName);
        if (block) {
          end(point(node.parentNode, index()));
          if (!node.querySelector("p, div, h1, h2, h3, h4, h5, h6, blockquote, li, ul, ol, pre")) {
            begin(point(node, 0));
          }
        }
        for (const child of node.childNodes) walk(child);
        if (block) end(point(node, node.childNodes.length));
      };
      walk(preview);
      end(point(preview, preview.childNodes.length));
      return lines;
    };
    const lineRange = (first, last = first) => {
      const range = document.createRange();
      range.setStart(first.start.node, first.start.offset);
      range.setEnd(last.end.node, last.end.offset);
      return range;
    };
    const applyBlockRules = trigger => {
      if (!showing || locked() || composing) return false;
      const selection = window.getSelection();
      if (!selection?.rangeCount || !selection.isCollapsed || !preview.contains(selection.anchorNode)) return false;
      const caret = selection.getRangeAt(0).cloneRange();
      const element = caret.startContainer.nodeType === Node.ELEMENT_NODE ? caret.startContainer : caret.startContainer.parentElement;
      const pre = element.closest("pre");
      const commit = trigger === "commit" || trigger === "insertParagraph" || trigger === "insertLineBreak";
      const replace = (range, fragment, restoreCaret = false) => {
        const wrapper = document.createElement("div");
        wrapper.append(fragment);
        selection.removeAllRanges();
        selection.addRange(range);
        const changed = document.execCommand("insertHTML", false, wrapper.innerHTML);
        if (changed && restoreCaret && caret.startContainer.isConnected) {
          selection.removeAllRanges();
          selection.addRange(caret);
        }
        return changed;
      };
      if (pre) {
        if (!commit) return false;
        const remaining = caret.cloneRange();
        remaining.setEnd(pre, pre.childNodes.length);
        if (remaining.toString().trim()) return false;
        const text = codeText(pre);
        const closing = /(?:^|\n) {0,3}(?:`{3,}|~{3,})[ \t]*\n*$/.exec(text);
        if (!closing) return false;
        const fragment = document.createDocumentFragment();
        const savedPre = pre.cloneNode(false);
        const code = pre.querySelector("code")?.cloneNode(false) || document.createElement("code");
        code.textContent = text.slice(0, closing.index);
        savedPre.append(code);
        const paragraph = document.createElement("p");
        paragraph.append(document.createElement("br"));
        fragment.append(savedPre, paragraph);
        const closingLine = editableLines().filter(line =>
          pre.contains(line.start.node) && /^ {0,3}(?:`{3,}|~{3,})[ \t]*$/.test(line.text)
        ).pop();
        if (closingLine) {
          // Enter leaves an extra empty caret line inside <pre>. Remove it
          // before formatBlock, otherwise Chromium keeps a nested <pre> shell.
          const trailing = document.createRange();
          trailing.setStart(closingLine.end.node, closingLine.end.offset);
          trailing.setEnd(pre, pre.childNodes.length);
          selection.removeAllRanges();
          selection.addRange(trailing);
          document.execCommand("delete");
        }
        const range = document.createRange();
        range.selectNode(pre);
        selection.removeAllRanges();
        selection.addRange(range);
        // Chromium retains an enclosing <pre> when replacing its contents.
        // Leave that editing context first, using an undoable native command.
        document.execCommand("formatBlock", false, "div");
        return replace(selection.getRangeAt(0).cloneRange(), fragment);
      }
      if (element.closest("code, a, li, blockquote, h1, h2, h3, h4, h5, h6")) return false;
      // Ordinary typing only needs a line scan for indentation or a completed
      // backtick fence. Check the whole logical line below before converting.
      if (!commit && (caret.startContainer.nodeType !== Node.TEXT_NODE ||
          !/^(?:[ \u00a0]{4}|\t)|`{3}$/.test(caret.startContainer.data.slice(0, caret.startOffset)))) return false;
      const lines = editableLines();
      let index = lines.findIndex(line => lineRange(line).isPointInRange(caret.startContainer, caret.startOffset));
      if (index < 0) return false;
      // Enter has already created the next line; commit the line just finished.
      const entered = trigger === "insertParagraph" || trigger === "insertLineBreak";
      const current = index;
      if (entered) index--;
      if (index < 0) return false;
      const line = lines[index];
      const context = line.start.node.nodeType === Node.ELEMENT_NODE ? line.start.node : line.start.node.parentElement;
      if (context.closest("pre, code, a, li, blockquote, h1, h2, h3, h4, h5, h6")) return false;
      const previous = lines[index - 1];
      if (commit && previous?.text.trim() && /^ {0,3}(?:={2,}|-{2,})[ \t]*$/.test(line.text)) {
        const titleContext = previous.start.node.nodeType === Node.ELEMENT_NODE ? previous.start.node : previous.start.node.parentElement;
        if (titleContext.closest("pre, li, blockquote, h1, h2, h3, h4, h5, h6")) return false;
        const heading = document.createElement(line.text.trim().startsWith("=") ? "h1" : "h2");
        const title = lineRange(previous).cloneContents();
        // Preserve rich-text edits in the title, not just its textContent.
        heading.append(title.querySelector("*") ? title : sanitize(markdown.parseInline(previous.text)));
        const fragment = document.createDocumentFragment();
        fragment.append(heading);
        return replace(lineRange(previous, line), fragment, entered);
      }
      const fence = /^ {0,3}(`{3,}|~{3,})([^`]*)$/.exec(line.text);
      const indent = /^(?: {4}|\t)/.exec(line.text);
      const prefix = lineRange(line);
      prefix.setEnd(caret.startContainer, caret.startOffset);
      const immediateFence = fence && /^ {0,3}`{3}$/.test(line.text) &&
        prefix.toString().replace(/\u00a0/g, " ") === line.text;
      if (!(fence && (commit || immediateFence)) && !indent) return false;
      const fragment = document.createDocumentFragment();
      const newPre = document.createElement("pre");
      const code = document.createElement("code");
      if (fence) {
        const language = fence[2].trim().split(/\s+/)[0];
        if (language) code.className = `language-${language}`;
        code.textContent = "\n";
      } else code.textContent = line.text.slice(indent[0].length) || "\n";
      newPre.append(code);
      fragment.append(newPre);
      const existing = new Set(preview.querySelectorAll("pre"));
      const changed = replace(lineRange(line, entered && !lines[current].text ? lines[current] : line), fragment);
      if (changed) {
        const inserted = Array.from(preview.querySelectorAll("pre")).find(node => !existing.has(node));
        const text = inserted?.querySelector("code")?.firstChild;
        if (text) selection.collapse(text, code.textContent === "\n" ? 0 : text.length);
      }
      return changed;
    };
    const commitBlockRules = () => {
      // Switching modes must also commit a just-typed underline/fence when the
      // user has since clicked elsewhere. Only inspect edited text nodes: never
      // reinterpret literal Markdown that was already present when we opened.
      const selection = window.getSelection();
      for (const node of pendingBlockNodes) {
        if (!node.isConnected || !preview.contains(node) || node.parentElement.closest("pre, code, a")) continue;
        const line = editableLines().find(candidate =>
          /^ {0,3}(?:={2,}|-{2,}|`{3,}[^`]*|~{3,}.*)[ \t]*$/.test(candidate.text) &&
          lineRange(candidate).intersectsNode(node)
        );
        if (!line) continue;
        selection.collapse(line.end.node, line.end.offset);
        applyBlockRules("commit");
      }
      pendingBlockNodes.clear();
    };
    const applyInputRules = (trigger = "insertText") => {
      if (!showing || locked() || composing) return;
      if (applyBlockRules(trigger)) return;
      const selection = window.getSelection();
      if (!selection?.rangeCount || !selection.isCollapsed ||
          !preview.contains(selection.anchorNode)) return;
      const caret = selection.getRangeAt(0);
      const element = caret.startContainer.nodeType === Node.ELEMENT_NODE ?
        caret.startContainer : caret.startContainer.parentElement;
      // Code and links are literal editing contexts, not Markdown shortcuts.
      if (element.closest("pre, code, a")) return;
      const block = element.closest("p, div, li, h1, h2, h3, h4, h5, h6");
      if (!block || (block !== preview && !preview.contains(block))) return;
      const prefix = caret.cloneRange();
      prefix.setStart(block, 0);
      const prefixContent = prefix.cloneContents();
      const text = prefix.toString().replace(/\u00a0/g, " ");
      // Only recognize block shortcuts on an otherwise plain first line.
      const marker = !prefixContent.querySelector("br, p, div, li, pre") &&
        /^(?:([-+*]) |(1)[.)] |(#{1,6}) |(>) )$/.exec(text);
      if (marker && !element.closest("li") &&
          !/^H[1-6]$/.test(block.nodeName) &&
          !(marker[4] && element.closest("blockquote"))) {
        selection.removeAllRanges();
        selection.addRange(prefix);
        document.execCommand("delete");
        if (marker[1]) document.execCommand("insertUnorderedList");
        else if (marker[2]) document.execCommand("insertOrderedList");
        else document.execCommand("formatBlock", false, marker[3] ? `h${marker[3].length}` : "blockquote");
        return;
      }
      // Parse only the text node immediately before the caret, never the entire
      // preview. Existing formatting, other blocks, and the caret stay intact.
      if (caret.startContainer.nodeType !== Node.TEXT_NODE) return;
      const typed = caret.startContainer.textContent.slice(0, caret.startOffset);
      // Most inline shortcuts commit on Space. Single-backtick code spans also
      // commit immediately on their closing backtick, without adding a space.
      const spaced = /[ \u00a0]$/.test(typed);
      if (!spaced && !typed.endsWith("`")) return;
      const source = spaced ? typed.slice(0, -1) : typed;
      const tokens = marked.Lexer.lexInline(source, { gfm: true });
      const token = tokens[tokens.length - 1];
      if (!token || !["strong", "em", "del", "codespan", "link"].includes(token.type)) return;
      if (!spaced && (token.type !== "codespan" || !/^`[^`]+`$/.test(token.raw))) return;
      if (token.type === "link" && !token.raw.startsWith("[")) return;
      const start = source.length - token.raw.length;
      // Do not reinterpret an escaped shortcut or a partial delimiter run.
      if (start && /[*_`~\\]/.test(source[start - 1])) return;
      const fragment = sanitize(markdown.parseInline(token.raw));
      if (!fragment.firstElementChild) return;
      for (const link of fragment.querySelectorAll("a")) {
        link.target = "_blank";
        link.rel = "noopener noreferrer";
      }
      const wrapper = document.createElement("div");
      wrapper.append(fragment);
      if (spaced) wrapper.append(document.createTextNode("\u00a0"));
      const replacement = caret.cloneRange();
      replacement.setStart(caret.startContainer, start);
      selection.removeAllRanges();
      selection.addRange(replacement);
      const existingCode = !spaced && new Set(preview.querySelectorAll("code"));
      document.execCommand("insertHTML", false, wrapper.innerHTML);
      if (!spaced) {
        const code = Array.from(preview.querySelectorAll("code")).find(node => !existingCode.has(node));
        if (code) {
          completedInlineCode = { code, text: code.textContent, caret: selection.getRangeAt(0).cloneRange() };
        }
      }
    };
    const leaveCompletedInlineCode = () => {
      const completed = completedInlineCode;
      completedInlineCode = null;
      if (!completed?.code.isConnected || !preview.contains(completed.code)) return;
      const selection = window.getSelection();
      if (!selection?.rangeCount || !selection.isCollapsed || !completed.code.contains(selection.anchorNode) ||
          !completed.code.textContent.startsWith(completed.text)) return;
      // Chromium otherwise inherits <code> when typing just after its closing
      // delimiter. Move only the newly typed suffix out, using undoable edits;
      // no invisible caret markers or extra spaces are stored in the document.
      const suffix = completed.code.textContent.slice(completed.text.length);
      if (!suffix) return;
      const range = completed.caret.cloneRange();
      range.setEnd(selection.anchorNode, selection.anchorOffset);
      if (range.toString() !== suffix) return;
      selection.removeAllRanges();
      selection.addRange(range);
      document.execCommand("delete");
      range.setStartAfter(completed.code);
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);
      const plain = document.createElement("span");
      plain.textContent = suffix.replace(/ /g, "\u00a0");
      document.execCommand("insertHTML", false, plain.outerHTML);
    };
    const exitFormatting = () => {
      const selection = window.getSelection();
      if (!showing || locked() || composing || !selection?.rangeCount ||
          !selection.isCollapsed || !preview.contains(selection.anchorNode)) return false;
      const states = [preview.innerHTML];
      let commandCount = 0;
      const command = (name, value) => {
        commandCount++;
        const changed = document.execCommand(name, false, value);
        const html = preview.innerHTML;
        if (html !== states[states.length - 1]) states.push(html);
        return changed;
      };
      const caret = selection.getRangeAt(0).cloneRange();
      const element = caret.startContainer.nodeType === Node.ELEMENT_NODE ? caret.startContainer : caret.startContainer.parentElement;
      const formatted = element.closest("pre, code, ul, ol, li, blockquote, h1, h2, h3, h4, h5, h6, strong, b, em, i, del, s, strike, a, sup, sub, span, table, details, summary");
      if (formatted && preview.contains(formatted)) {
        let root = formatted;
        while (root.parentNode !== preview) root = root.parentNode;
        const before = caret.cloneRange();
        before.setStart(root, 0);
        const after = caret.cloneRange();
        after.setEnd(root, root.childNodes.length);
        const prefix = root.cloneNode(false);
        prefix.append(before.cloneContents());
        const suffix = root.cloneNode(false);
        suffix.append(after.cloneContents());
        const meaningful = node => !!node.textContent.trim() || !!node.querySelector?.("hr, input, table, img");
        const trim = (node, end) => {
          for (let child = end ? node.lastChild : node.firstChild; child; child = end ? node.lastChild : node.firstChild) {
            if (child.nodeType === Node.TEXT_NODE) {
              child.textContent = end ? child.textContent.replace(/\n[\s\u00a0]*$/, "") : child.textContent.replace(/^[\s\u00a0]*\n/, "");
              if (child.textContent.trim()) break;
            } else {
              trim(child, end);
              if (meaningful(child)) break;
            }
            child.remove();
          }
        };
        trim(prefix, true);
        trim(suffix, false);
        const fragment = document.createElement("div");
        if (meaningful(prefix)) fragment.append(prefix);
        const paragraph = document.createElement("p");
        const marker = `jsh-format-exit-${previewId}-${++formatExitId}`;
        paragraph.className = `jsh-plain-paragraph ${marker}`;
        paragraph.append(document.createElement("br"));
        fragment.append(paragraph);
        if (meaningful(suffix)) fragment.append(suffix);
        // Preserve code text, including internal blank lines, on either side
        // of a split. Only the empty Enter lines at the split are discarded.
        for (const pre of fragment.querySelectorAll("pre")) {
          const code = pre.querySelector("code")?.cloneNode(false) || document.createElement("code");
          code.textContent = codeText(pre);
          pre.replaceChildren(code);
        }
        const depth = root.querySelectorAll("ul, ol, blockquote").length +
          Number(root.matches("ul, ol, blockquote"));
        const range = document.createRange();
        range.selectNodeContents(root);
        selection.removeAllRanges();
        selection.addRange(range);
        // Empty the editing context before leaving it. formatBlock on a
        // populated multiline <pre> can otherwise absorb neighboring blocks.
        command("delete");
        for (let index = 0; index < depth; index++) command("outdent");
        command("formatBlock", "p");
        command("removeFormat");
        command("insertHTML", fragment.innerHTML);
        const inserted = preview.querySelector(`.${marker}`);
        if (inserted) selection.collapse(inserted, 0);
      } else {
        command("formatBlock", "p");
      }
      // Clear browser typing state as well as element-level formatting.
      command("removeFormat");
      for (const name of ["bold", "italic", "strikeThrough", "subscript", "superscript"]) {
        if (document.queryCommandState(name)) command(name);
      }
      if (states.length > 2) {
        formatExitHistory.push({ states, commandCount, undoHTML: null });
        if (formatExitHistory.length > 25) formatExitHistory.shift();
      }
      completedInlineCode = null;
      return true;
    };
    const finishFormatExitHistory = trigger => {
      if (trigger !== "historyUndo" && trigger !== "historyRedo") return;
      const undo = trigger === "historyUndo";
      // syncedHTML is the document immediately before the browser's first
      // undo/redo command. Match that boundary, not intermediate DOM shapes:
      // Chromium can normalize empty wrappers while replaying its history.
      const entry = [...formatExitHistory].reverse().find(item =>
        syncedHTML === (undo ? item.states[item.states.length - 1] : item.undoHTML)
      );
      if (!entry) return;
      const states = entry.states;
      // Treat the native commands used by Double Enter as one undo/redo step,
      // never exposing the temporary emptied block or syncing it to the site.
      const target = undo ? states[0] : states[states.length - 1];
      for (let index = 0; index < entry.commandCount + 2 && preview.innerHTML !== target; index++) {
        if (!document.execCommand(undo ? "undo" : "redo")) break;
      }
      if (undo) entry.undoHTML = preview.innerHTML;
    };
    const finishInput = (format, trigger = "insertText") => {
      // Run after the browser's edit command returns, so our undoable commands
      // are not rejected as recursive execCommand calls (also used by paste).
      queueMicrotask(() => {
        if (composing) return;
        applyingInputRule = true;
        try {
          finishFormatExitHistory(trigger);
          const paragraph = format && trigger === "insertParagraph";
          const doubleEnter = paragraph && lastEnter;
          lastEnter = null;
          if (doubleEnter && exitFormatting()) return;
          if (completedInlineCode) {
            if (format && trigger === "insertText") leaveCompletedInlineCode();
            else completedInlineCode = null;
          }
          if (format) applyInputRules(trigger);
          if (paragraph && showing && !locked()) {
            const selection = window.getSelection();
            if (selection?.isCollapsed && preview.contains(selection.anchorNode)) {
              lastEnter = { node: selection.anchorNode, offset: selection.anchorOffset };
            }
          }
        } finally {
          applyingInputRule = false;
          syncPreview();
        }
      });
    };
    preview.addEventListener("input", event => {
      if (!applyingInputRule && !insertingPlainText &&
          ["insertText", "insertCompositionText"].includes(event.inputType)) {
        const node = window.getSelection()?.anchorNode;
        if (node?.nodeType === Node.TEXT_NODE && preview.contains(node)) pendingBlockNodes.add(node);
      }
      if (!event.isComposing && !composing && !applyingInputRule) {
        finishInput(!insertingPlainText && ["insertText", "insertParagraph", "insertLineBreak"].includes(event.inputType), event.inputType);
      }
    });
    preview.addEventListener("compositionstart", () => { lastEnter = null; composing = true; });
    preview.addEventListener("compositionend", () => { composing = false; finishInput(true); });
    preview.addEventListener("keydown", event => {
      if (event.key !== "Enter" || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) lastEnter = null;
    });
    preview.addEventListener("beforeinput", event => {
      if (!lastEnter || applyingInputRule) return;
      const selection = window.getSelection();
      if (event.inputType !== "insertParagraph" || !selection?.isCollapsed ||
          selection.anchorNode !== lastEnter.node || selection.anchorOffset !== lastEnter.offset) lastEnter = null;
    });
    preview.addEventListener("pointerdown", () => { lastEnter = null; });
    preview.addEventListener("blur", () => { lastEnter = null; syncPreview(); });
    const insertPlainText = text => {
      lastEnter = null;
      if (locked() || !showing || !text) return;
      preview.focus();
      const selection = window.getSelection();
      if (!selection.rangeCount || !preview.contains(selection.anchorNode) ||
          !preview.contains(selection.focusNode)) return;
      // insertText retains native undo/redo in Chrome. The Range fallback also
      // inserts only text, never clipboard HTML or remote images.
      insertingPlainText = true;
      let inserted;
      try {
        inserted = document.execCommand?.("insertText", false, text);
      } finally {
        insertingPlainText = false;
      }
      if (!inserted) {
        const range = selection.getRangeAt(0);
        const fragment = document.createDocumentFragment();
        text.replace(/\r\n?/g, "\n").split("\n").forEach((line, index) => {
          if (index) fragment.append(document.createElement("br"));
          fragment.append(document.createTextNode(line));
        });
        const last = fragment.lastChild;
        range.deleteContents();
        range.insertNode(fragment);
        if (last) range.setStartAfter(last);
        range.collapse(true);
        selection.removeAllRanges();
        selection.addRange(range);
      }
      syncPreview();
    };
    // Never let pasted/dropped HTML introduce scripts, styling, or network loads.
    preview.addEventListener("paste", event => {
      event.preventDefault();
      if (event.clipboardData) insertPlainText(event.clipboardData.getData("text/plain"));
    });
    preview.addEventListener("dragover", event => event.preventDefault());
    preview.addEventListener("drop", event => {
      event.preventDefault();
      if (event.dataTransfer) insertPlainText(event.dataTransfer.getData("text/plain"));
    });
    preview.addEventListener("click", event => {
      // Ordinary clicks position the caret instead of navigating away mid-edit.
      // Ctrl/Cmd-click still opens a sanitized link in a new tab.
      if (event.target.closest("a") && !event.ctrlKey && !event.metaKey) event.preventDefault();
    });
    const setPreview = active => {
      if (active === showing) return;
      lastEnter = null;
      if (!active && !locked() && !composing) {
        applyingInputRule = true;
        try { commitBlockRules(); }
        finally { applyingInputRule = false; }
      }
      if (!active && !syncPreview()) return;
      if (active) {
        textareaScroll = textarea.scrollTop;
        preview.style.height = `${Math.max(97, textarea.getBoundingClientRect().height)}px`;
      }
      showing = active;
      update();
      textarea.classList.toggle("jsh-markdown-hidden", active);
      preview.hidden = !active;
      toggle.textContent = active ? "Edit Markdown" : "Preview";
      toggle.setAttribute("aria-label", active ? `Edit ${label} as raw Markdown` : `Preview ${label} Markdown`);
      toggle.setAttribute("aria-pressed", String(active));
      hint.hidden = !active;
      if (!active) textarea.scrollTop = textareaScroll;
    };
    toggle.addEventListener("click", () => {
      setPreview(!showing);
      if (!showing) textarea.focus();
    });
    // Required fields must be visible when the browser focuses an invalid field.
    const onInvalid = () => setPreview(false);
    const onReset = () => requestAnimationFrame(update);
    const form = textarea.form;
    textarea.addEventListener("input", update);
    textarea.addEventListener("change", update);
    textarea.addEventListener("invalid", onInvalid);
    form?.addEventListener("reset", onReset);
    markdownPreviews.set(textarea, {
      toolbar,
      preview,
      update,
      dispose() {
        textarea.classList.remove("jsh-markdown-hidden");
        textarea.removeEventListener("input", update);
        textarea.removeEventListener("change", update);
        textarea.removeEventListener("invalid", onInvalid);
        form?.removeEventListener("reset", onReset);
        toolbar.remove();
        preview.remove();
      }
    });
    setPreview(true);
  }

  function enhance(textarea) {
    const originalHeight = Math.max(180, textarea.getBoundingClientRect().height || 462);
    const toolbar = document.createElement("div");
    toolbar.className = "jsh-toolbar";
    toolbar.setAttribute("role", "group");
    toolbar.setAttribute("aria-label", "Source code formatting");

    const format = document.createElement("button");
    format.type = "button";
    format.className = "jsh-button";
    format.textContent = "Beautify HTML";
    format.title = "Indent HTML and embedded CSS with two spaces. Review before saving.";

    const undo = document.createElement("button");
    undo.type = "button";
    undo.className = "jsh-button jsh-secondary";
    undo.textContent = "Undo format";
    undo.disabled = true;

    const status = document.createElement("span");
    status.className = "jsh-status";
    status.setAttribute("role", "status");
    toolbar.append(format, undo, status);

    // Leave the original textarea in its React-owned location. CodeMirror is a
    // sibling, and every edit is mirrored back into JanitorAI's original field.
    textarea.before(toolbar);
    const editor = CodeMirror(node => textarea.after(node), {
      value: textarea.value,
      mode: "htmlmixed",
      theme: "jsh",
      lineNumbers: true,
      lineWrapping: true,
      indentUnit: 2,
      tabSize: 2,
      indentWithTabs: false,
      readOnly: textarea.disabled || textarea.readOnly,
      screenReaderLabel: "Source Code — HTML editor",
      // Keep Tab available for keyboard navigation through the modal.
      extraKeys: { Tab: false, "Shift-Tab": false }
    });
    const wrapper = editor.getWrapperElement();
    wrapper.classList.add("jsh-editor");
    textarea.classList.add("jsh-native-textarea");
    editor.setSize("100%", originalHeight);

    let syncingFromSite = false;
    let backup = null;
    let formattedValue = null;
    const invalidateUndo = value => {
      if (value !== formattedValue) {
        undo.disabled = true;
        backup = null;
        status.textContent = "";
      }
    };
    const update = () => {
      const locked = textarea.disabled || textarea.readOnly;
      editor.setOption("readOnly", locked);
      format.disabled = locked;
      undo.disabled = locked || backup === null || textarea.value !== formattedValue;
      if (editor.getValue() !== textarea.value) {
        syncingFromSite = true;
        try {
          editor.setValue(textarea.value);
          invalidateUndo(textarea.value);
        } finally {
          syncingFromSite = false;
        }
      }
    };
    const onEditorChange = () => {
      if (syncingFromSite) return;
      const value = editor.getValue();
      invalidateUndo(value);
      writeValue(textarea, value);
    };
    editor.on("change", onEditorChange);

    const replaceSource = value => {
      // A single undoable edit, without clearing normal typing history.
      const lastLine = editor.lastLine();
      editor.replaceRange(value, { line: 0, ch: 0 },
        { line: lastLine, ch: editor.getLine(lastLine).length }, "+format");
    };

    format.addEventListener("click", () => {
      if (textarea.disabled || textarea.readOnly) return;
      try {
        const original = editor.getValue();
        const pretty = html_beautify(original, options);
        if (pretty === original) {
          status.textContent = "Already formatted";
          return;
        }
        formattedValue = pretty;
        backup = original;
        replaceSource(pretty);
        undo.disabled = false;
        editor.focus();
        editor.setCursor(0, 0);
        editor.scrollTo(0, 0);
        status.textContent = "Formatted · review before saving";
      } catch (error) {
        status.textContent = "Could not format this source. Your text was not changed.";
        console.warn("JanitorAI Source Helper: formatting failed", error);
      }
    });

    undo.addEventListener("click", () => {
      if (backup === null || textarea.value !== formattedValue || textarea.disabled || textarea.readOnly) return;
      const original = backup;
      backup = null;
      formattedValue = null;
      replaceSource(original);
      undo.disabled = true;
      editor.focus();
      status.textContent = "Original formatting restored";
    });

    textarea.addEventListener("input", update);
    textarea.addEventListener("change", update);
    // Recompute wrapped line heights and number positions when resized.
    const resize = new ResizeObserver(() => editor.refresh());
    resize.observe(wrapper);
    editors.set(textarea, {
      update,
      wrapper,
      dispose() {
        resize.disconnect();
        textarea.removeEventListener("input", update);
        textarea.removeEventListener("change", update);
        editor.off("change", onEditorChange);
        textarea.classList.remove("jsh-native-textarea");
        wrapper.remove();
        toolbar.remove();
      }
    });
    update();
  }

  function scan() {
    for (const [textarea, controller] of markdownPreviews) {
      if (!textarea.isConnected || !textarea.matches(markdownSelector) ||
          !controller.toolbar.isConnected || !controller.preview.isConnected ||
          textarea.parentNode !== controller.preview.parentNode ||
          textarea.parentNode !== controller.toolbar.parentNode) {
        controller.dispose();
        markdownPreviews.delete(textarea);
      } else {
        controller.update();
      }
    }
    for (const textarea of document.querySelectorAll(markdownSelector)) {
      if (!markdownPreviews.has(textarea)) enhanceMarkdown(textarea);
    }
    for (const [textarea, editor] of editors) {
      if (!textarea.isConnected || !editor.wrapper.isConnected || !textarea.closest('[role="dialog"]')) {
        editor.dispose();
        editors.delete(textarea);
      } else {
        editor.update();
      }
    }
    for (const dialog of document.querySelectorAll('[role="dialog"]')) {
      const labelledBy = dialog.getAttribute("aria-labelledby")?.split(/\s+/) || [];
      const title = labelledBy.map(id => document.getElementById(id)?.textContent || "").join(" ") ||
        dialog.querySelector("header, .chakra-modal__header, h1, h2, h3")?.textContent || "";
      if (!/edit\s+source\s+code/i.test(title)) continue;
      for (const textarea of dialog.querySelectorAll("textarea")) {
        // CodeMirror has its own hidden input textarea; never enhance that.
        if (!textarea.closest(".CodeMirror") && !textarea.matches(markdownSelector) &&
            !editors.has(textarea)) enhance(textarea);
      }
    }
  }

  let pending = false;
  new MutationObserver(records => {
    // Ignore editor-internal rendering and status changes.
    const relevant = records.some(record =>
      !record.target.closest?.(".jsh-toolbar, .jsh-editor, .jsh-markdown-preview")
    );
    if (!relevant || pending) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      scan();
    });
  }).observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["disabled", "readonly", "id"]
  });
  scan();
})();
