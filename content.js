(() => {
  "use strict";

  const editors = new Map();
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
        if (!textarea.closest(".CodeMirror") && !editors.has(textarea)) enhance(textarea);
      }
    }
  }

  let pending = false;
  new MutationObserver(records => {
    // Ignore editor-internal rendering and status changes.
    const relevant = records.some(record =>
      !record.target.closest?.(".jsh-toolbar, .jsh-editor")
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
    attributeFilter: ["disabled", "readonly"]
  });
  scan();
})();
