export const responsesProviders = {
  wbllm: { name: 'WBLLM', endpoint: 'https://llm.wb.ru/api/v1', envKey: 'WBLLM_API_KEY', port: 8093 },
  glm: { name: 'GLM', endpoint: 'https://api.z.ai/api/v1', envKey: 'GLM_API_KEY', port: 8094 },
} as const;

export type ResponsesProviderId = keyof typeof responsesProviders;

export function isResponsesProvider(id: string): id is ResponsesProviderId {
  return Object.hasOwn(responsesProviders, id);
}
