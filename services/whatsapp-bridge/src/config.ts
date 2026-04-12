export interface Config {
  port: number;
  webhookUrl: string;
  logLevel: "debug" | "info" | "warn" | "error";
}

export function loadConfig(): Config {
  return {
    port: parseInt(process.env.PORT ?? "3001", 10),
    webhookUrl:
      process.env.WEBHOOK_URL ?? "http://localhost:8000/webhook/whatsapp",
    logLevel: (process.env.LOG_LEVEL ?? "info") as Config["logLevel"],
  };
}
