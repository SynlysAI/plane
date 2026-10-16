import React from "react";
import type { Meta, StoryObj } from "@storybook/react";
import { ListFilterField, ListFilterInput, ListFilterSelect, ListFilterCheckbox } from "./list-controls";

const meta: Meta<typeof ListFilterField> = {
  title: "List Controls/Filter Field",
  component: ListFilterField,
};
export default meta;
type Story = StoryObj<typeof ListFilterField>;

export const Toolbar: Story = {
  render: () => (
    <div className="flex flex-wrap items-end gap-3 p-4">
      <ListFilterField label="Status">
        <ListFilterSelect defaultValue="">
          <option value="">All statuses</option>
          <option value="active">Active</option>
          <option value="archived">Archived</option>
        </ListFilterSelect>
      </ListFilterField>
      <ListFilterField label="Keyword" className="sm:w-48">
        <ListFilterInput placeholder="Search" />
      </ListFilterField>
      <ListFilterField label="Date">
        <ListFilterInput type="date" />
      </ListFilterField>
      <ListFilterField label="Disabled">
        <ListFilterInput disabled value="Unavailable" readOnly />
      </ListFilterField>
      <ListFilterField label="File" className="w-full sm:w-64">
        <ListFilterInput type="file" />
      </ListFilterField>
      <ListFilterCheckbox label="Enabled" defaultChecked />
    </div>
  ),
};
