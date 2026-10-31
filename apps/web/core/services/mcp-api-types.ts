export type McpToolAvailability = {
  enabled: boolean;
  reason_code: string;
  reason: string;
  required_connection_scope?: string;
  required_actions?: string[];
  object_level_permission?: string;
};

export type McpActionAvailability = Record<string, McpToolAvailability>;

export type McpApiTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  category: string;
  group: string;
  execution_mode: string;
  required_role: string;
  availability: McpToolAvailability;
  usage: {
    when_to_use: string;
    workflow: string[];
    example: { arguments: Record<string, unknown> };
    action_examples?: Record<string, { arguments: Record<string, unknown> }>;
  };
  action_availability?: McpActionAvailability;
};

export type McpCatalogSummary = {
  total: number;
  available: number;
  unavailable: number;
};
