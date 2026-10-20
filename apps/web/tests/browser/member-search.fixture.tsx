import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { CustomSearchSelect, EModalWidth, ModalCore } from "@plane/ui";
// oxlint-disable-next-line import/no-unassigned-import -- Use app styles in browser verification.
import "../../styles/globals.css";

const options = [
  { value: "alice", query: "Alice 陈小明", content: "Alice 陈小明" },
  { value: "bob", query: "Bob 王芳", content: "Bob 王芳" },
  { value: "carol", query: "Carol 刘华", content: "Carol 刘华" },
];
const rowIds = ["first-member", "second-member"];
function MemberSearchFixture() {
  const [members, setMembers] = useState(["", ""]);
  return (
    <ModalCore isOpen width={EModalWidth.XXL}>
      <form
        className="space-y-4 p-5"
        onSubmit={(event) => {
          event.preventDefault();
          document.body.dataset.submitted = JSON.stringify(members);
        }}
      >
        <h1>邀请成员</h1>
        {rowIds.map((rowId, index) => (
          <div key={rowId} className="flex gap-3">
            <CustomSearchSelect
              ariaLabel={`选择成员 ${index + 1}`}
              value={members[index]}
              onChange={(next) => setMembers((current) => current.map((item, row) => (row === index ? next : item)))}
              options={options}
              customButton={
                <span>{options.find((item) => item.value === members[index])?.content || "Select co-worker"}</span>
              }
              className="min-w-0 flex-1"
              customButtonClassName="w-full rounded-md border border-subtle px-3 py-2"
            />
            <select aria-label={`角色 ${index + 1}`} className="rounded-md border border-subtle px-2">
              <option>Member</option>
              <option>Guest</option>
            </select>
          </div>
        ))}
        <button type="submit" className="rounded-md border border-subtle p-2">
          添加成员
        </button>
        <output data-testid="selection">{JSON.stringify(members)}</output>
      </form>
    </ModalCore>
  );
}
createRoot(document.getElementById("root")!).render(<MemberSearchFixture />);
