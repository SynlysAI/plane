/** Build the attachment-download URL for one task-scoped inline image. */
export function taskImageDownloadSource(source: string, imageBase: string) {
  if (!source.startsWith(imageBase)) return source;
  const separator = source.includes("?") ? "&" : "?";
  return `${source}${separator}download=1`;
}
