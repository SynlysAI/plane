import { describe, expect, it } from "vitest";

import { getFileMetaDataForUpload } from "../../../../packages/services/src/file/helper";

/** 构造仅包含 OLE/CFB 文件头的最小二进制文件。 */
function makeCfbFile(name: string): File {
  const bytes = new Uint8Array(512);
  bytes.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1], 0);
  return new File([bytes], name);
}

describe("getFileMetaDataForUpload", () => {
  it.each([
    ["行政材料.doc", "application/msword"],
    ["预算表.xls", "application/vnd.ms-excel"],
    ["汇报材料.ppt", "application/vnd.ms-powerpoint"],
  ])("将 %s 的 CFB 签名归一为旧版 Office MIME", async (name, expectedType) => {
    const metadata = await getFileMetaDataForUpload(makeCfbFile(name));

    expect(metadata).toEqual({ name, size: 512, type: expectedType });
  });

  it("未知 CFB 文件保持 application/x-cfb", async () => {
    const metadata = await getFileMetaDataForUpload(makeCfbFile("compound.cfb"));

    expect(metadata.type).toBe("application/x-cfb");
  });
});
