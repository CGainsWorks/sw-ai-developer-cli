export declare const MOCK_MODEL: string;

export interface MockRequest {
  headers: Record<string, string | string[] | undefined>;
  body: Record<string, any>;
}

export interface MockOpenAIOptions {
  port?: number;
  models?: string[];
  apiKey?: string;
  rejectSchema?: boolean;
  omitUsage?: boolean;
  failStatus?: number;
  respond?: (body: Record<string, any>) => string;
}

export interface MockOpenAIServer {
  url: string;
  port: number;
  requests: MockRequest[];
  close(): Promise<void>;
}

export declare function startMockOpenAI(options?: MockOpenAIOptions): Promise<MockOpenAIServer>;

export declare function firstAddedLine(text: string): { file: string; line: number } | undefined;
