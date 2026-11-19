// Paseo applies this policy to this agent on creation. No global permission listener is needed.
export function clydeLookupPolicy() {
  return {
    preapproved: ["clyde_recall", "clyde_recall_more"].map(tool => ({
      kind: "mcp" as const, server: "paseo", tool,
    })),
  };
}
