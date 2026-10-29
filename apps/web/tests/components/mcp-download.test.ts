// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { downloadMCPConfiguration } from "@/components/mcp/connection-download";
it("downloads explicit configuration using a temporary URL and releases it", () => {
  const create = vi.fn().mockReturnValue("blob:test");
  const revoke = vi.fn();
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: create });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revoke });
  const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
    expect(this.download).toBe("plane-mcp-connections.json");
    expect(this.href).toBe("blob:test");
  });
  downloadMCPConfiguration('{"mcpServers":{}}', "json");
  expect(create.mock.calls[0][0]).toBeInstanceOf(Blob);
  expect(revoke).toHaveBeenCalledWith("blob:test");
  click.mockRestore();
});
