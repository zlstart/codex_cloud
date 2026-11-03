import type { Artifact } from "../types";

/** Resolve only known session files; never guess when a basename is ambiguous. */
export function resolveArtifactLink(
  link: string | undefined,
  files: Artifact[],
) {
  if (!link) return undefined;
  const direct = files.find((file) => file.url === link);
  if (direct) return direct;
  let relative: string;
  try {
    relative = decodeURIComponent(link.replace(/^sandbox:/, ""))
      .replace(/^\/workspace\//, "")
      .replace(/^\/mnt\/data\//, "outputs/");
  } catch {
    return undefined;
  }
  if (
    relative.includes("\\") ||
    relative.includes("\0") ||
    relative.split("/").some((part) => part === ".." || part === ".")
  )
    return undefined;
  const kind = relative.startsWith("outputs/")
    ? "output"
    : relative.startsWith("uploads/")
      ? "upload"
      : undefined;
  if (!kind && (relative.includes("/") || relative.includes(":")))
    return undefined;
  const name = relative.split("/").at(-1);
  const candidates = files.filter(
    (file) => file.name === name && (!kind || file.kind === kind),
  );
  return candidates.length === 1 ? candidates[0] : undefined;
}
