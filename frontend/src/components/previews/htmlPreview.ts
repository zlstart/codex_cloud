import createDOMPurify from "dompurify";

// Inline generated apps run only inside an opaque-origin sandbox. The parent
// document additionally enforces frame-src 'none', which blocks self-navigation
// out of srcdoc; child resource CSP alone cannot enforce that boundary.
export function isolatedHtmlDocument(content: string): string {
  const purifier = createDOMPurify(window);
  const scriptText = new Map<Node, string>();
  const elementIds = new Map<Element, string>();
  purifier.addHook("uponSanitizeElement", (node, data) => {
    if (
      data.tagName === "script" &&
      (node as Element).namespaceURI === "http://www.w3.org/1999/xhtml"
    ) {
      // JavaScript templates and JSON may contain HTML-looking text. Keep that
      // raw text separate from markup checks; still sanitize the script element
      // and every attribute, including external sources. Only surviving HTML
      // script nodes receive their original text after sanitization.
      scriptText.set(node, node.textContent ?? "");
      node.textContent = "";
    }
  });
  purifier.addHook("uponSanitizeAttribute", (node, data) => {
    const name = data.attrName.toLowerCase();
    if (name === "id" && node.namespaceURI === "http://www.w3.org/1999/xhtml") {
      elementIds.set(node, data.attrValue);
    }
    if (name.startsWith("on")) {
      // Inline event handlers have the same sandbox/CSP boundary as inline JS.
      data.forceKeepAttr = true;
    } else if (["src", "href", "xlink:href"].includes(name)) {
      const value = data.attrValue.trim();
      const embeddedImage =
        ["img", "image"].includes(node.nodeName.toLowerCase()) &&
        /^data:image\/(?:png|jpeg|gif|webp|avif);base64,/i.test(value);
      const fragment = name !== "src" && value.startsWith("#");
      if (!embeddedImage && !fragment) data.keepAttr = false;
    }
  });
  const document = purifier.sanitize(content, {
    WHOLE_DOCUMENT: true,
    RETURN_DOM: true,
    ADD_TAGS: ["script"],
    FORBID_TAGS: ["meta", "base", "iframe", "object", "embed", "link"],
    FORBID_ATTR: ["srcset", "action", "formaction", "target", "ping"],
  });
  for (const [node, text] of scriptText) {
    if (document.contains(node)) node.textContent = text;
  }
  // IDs such as "reset" overlap form API names but are ordinary app selectors.
  // Restore them only after the sanitizer has finished using its own DOM. This
  // document runs in the opaque iframe; names and removed nodes stay sanitized.
  for (const [node, id] of elementIds) {
    if (document.contains(node)) node.setAttribute("id", id);
  }
  const policy =
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none';";
  const root = document as HTMLElement;
  const head =
    root.querySelector("head") ??
    root.insertBefore(
      root.ownerDocument.createElement("head"),
      root.firstChild,
    );
  const meta = (attributes: Record<string, string>) => {
    const node = root.ownerDocument.createElement("meta");
    for (const [name, value] of Object.entries(attributes))
      node.setAttribute(name, value);
    return node;
  };
  // DOM insertion also handles attributed heads and always puts the policy
  // before user scripts or styles, without depending on serialized tag text.
  head.prepend(
    meta({ "http-equiv": "Content-Security-Policy", content: policy }),
    meta({ name: "referrer", content: "no-referrer" }),
    meta({ name: "viewport", content: "width=device-width, initial-scale=1" }),
  );
  return `<!doctype html>${root.outerHTML}`;
}
