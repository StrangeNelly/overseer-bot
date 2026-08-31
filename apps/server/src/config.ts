function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable ${name} (see .env.example)`);
  }
  return value;
}

export interface Config {
  botToken: string;
  databaseUrl: string;
  webAppUrl: string;
  port: number;
}

export function loadConfig(): Config {
  return {
    botToken: required('BOT_TOKEN'),
    databaseUrl: required('DATABASE_URL'),
    webAppUrl: process.env.WEB_APP_URL ?? 'http://localhost:3000',
    port: Number(process.env.PORT ?? 3000),
  };
}
