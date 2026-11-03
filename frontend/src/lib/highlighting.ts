import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import cpp from "highlight.js/lib/languages/cpp";
import csharp from "highlight.js/lib/languages/csharp";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import go from "highlight.js/lib/languages/go";
import ini from "highlight.js/lib/languages/ini";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import powershell from "highlight.js/lib/languages/powershell";
import python from "highlight.js/lib/languages/python";
import r from "highlight.js/lib/languages/r";
import rust from "highlight.js/lib/languages/rust";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

const languages = {
  bash,
  cpp,
  csharp,
  css,
  diff,
  dockerfile,
  go,
  ini,
  java,
  javascript,
  json,
  markdown,
  powershell,
  python,
  r,
  rust,
  sql,
  typescript,
  xml,
  yaml,
};
for (const [name, grammar] of Object.entries(languages))
  hljs.registerLanguage(name, grammar);

const aliases: Record<string, string> = {
  text: "plaintext",
  txt: "plaintext",
  plain: "plaintext",
  plaintext: "plaintext",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  py: "python",
  pyw: "python",
  pyi: "python",
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  yml: "yaml",
  md: "markdown",
  mdx: "markdown",
  mdown: "markdown",
  markdown: "markdown",
  jsonl: "json",
  ndjson: "json",
  ipynb: "json",
  html: "xml",
  htm: "xml",
  xhtml: "xml",
  svg: "xml",
  vue: "xml",
  svelte: "xml",
  c: "cpp",
  h: "cpp",
  cc: "cpp",
  hpp: "cpp",
  cs: "csharp",
  rs: "rust",
  ps1: "powershell",
  patch: "diff",
  toml: "ini",
  cfg: "ini",
  conf: "ini",
  env: "ini",
};

function knownLanguage(value: string | undefined) {
  const name = value
    ?.toLowerCase()
    .trim()
    .split(/\s+/)[0]
    .replace(/^language-/, "");
  if (!name) return undefined;
  return Object.hasOwn(aliases, name)
    ? aliases[name]
    : Object.hasOwn(languages, name)
      ? name
      : undefined;
}

export function codeLanguage(language?: string, filename?: string) {
  const name = filename?.split(/[\\/]/).at(-1)?.toLowerCase();
  const fileLanguage =
    name === "dockerfile" || name?.startsWith("dockerfile.")
      ? "dockerfile"
      : name === ".env" || name?.startsWith(".env.")
        ? "ini"
        : knownLanguage(name?.split(".").at(-1));
  return fileLanguage ?? knownLanguage(language) ?? "plaintext";
}

export function highlightedCode(code: string, language: string) {
  // Avoid expensive grammar work on large generated files. Keep all source visible.
  if (language === "plaintext" || code.length > 100_000) return null;
  try {
    return hljs.highlight(code, { language, ignoreIllegals: true }).value;
  } catch {
    return null;
  }
}
