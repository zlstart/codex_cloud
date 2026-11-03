import createDOMPurify from "dompurify";

// Inline generated apps run only inside an opaque-origin sandbox. The parent
// document additionally enforces frame-src 'none', which blocks self-navigation
// out of srcdoc; child resource CSP alone cannot enforce that boundary.
export function isolatedHtmlDocument(content: string): string {
  const purifier = createDOMPurify(window);
  purifier.addHook("uponSanitizeAttribute", (node, data) => {
    const name = data.attrName.toLowerCase();
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
  const clean = purifier.sanitize(content, {
    WHOLE_DOCUMENT: true,
    ADD_TAGS: ["script"],
    FORBID_TAGS: ["meta", "base", "iframe", "object", "embed", "link"],
    FORBID_ATTR: ["srcset", "action", "formaction", "target", "ping"],
  });
  const policy =
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none';";
  const head = `<head><meta http-equiv="Content-Security-Policy" content="${policy}"><meta name="referrer" content="no-referrer"><meta name="viewport" content="width=device-width, initial-scale=1">`;
  return `<!doctype html>${clean.replace(/<head>/i, head)}`;
}
