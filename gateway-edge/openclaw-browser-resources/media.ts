export function buildAssistantMediaUrl(source: string, resourceBasePath = ''): string {
  return `${resourceBasePath.replace(/\/$/u, '')}/__openclaw__/assistant-media?${new URLSearchParams({ source })}`;
}
