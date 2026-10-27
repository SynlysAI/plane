/** Download only on an explicit user gesture; release the temporary object URL. */
export function downloadMCPConfiguration(text: string, extension: "json" | "toml") {
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `plane-mcp-connections.${extension}`;
  try {
    anchor.click();
  } finally {
    URL.revokeObjectURL(url);
  }
}
