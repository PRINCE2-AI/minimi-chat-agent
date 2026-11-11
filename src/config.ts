export interface LlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface SearchConfig {
  tavilyKey?: string;
  braveKey?: string;
}

export interface AppConfig {
  llm: LlmConfig;
  search: SearchConfig;
  port: number;
  dataDir: string;
  tz: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    llm: {
      baseUrl: (env.LLM_BASE_URL?.trim() || "https://api.openai.com/v1").replace(/\/+$/, ""),
      apiKey: env.LLM_API_KEY?.trim() ?? "",
      model: env.LLM_MODEL?.trim() || "gpt-4o-mini",
    },
    search: {
      tavilyKey: env.TAVILY_API_KEY?.trim() || undefined,
      braveKey: env.BRAVE_API_KEY?.trim() || undefined,
    },
    port: Number(env.PORT) || 3000,
    dataDir: env.DATA_DIR?.trim() || ".data",
    tz: env.TZ_NAME?.trim() || "Asia/Kolkata",
  };
}
