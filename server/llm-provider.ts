import { completion, type Settings } from './agent';
import type { TokenUsage } from '../src/decision/types';

export interface LlmRequest {
  model: string;
  messages: Array<{ role: string; content: string }>;
  sampling: Record<string, unknown>;
  timeoutMs: number;
}

export interface LlmResponse {
  raw: unknown;
  text: string;
  usage: TokenUsage;
  latencyMs: number;
  providerRequestId?: string;
}

export interface LlmProvider {
  readonly id: string;
  complete(request: LlmRequest, signal?: AbortSignal): Promise<LlmResponse>;
}

export class NullLlmProvider implements LlmProvider {
  readonly id = 'null';
  async complete(): Promise<LlmResponse> { throw new Error('no LLM provider configured'); }
}

export class OpenAiCompatibleProvider implements LlmProvider {
  constructor(readonly id: string, private readonly settings: Settings) {}
  async complete(request: LlmRequest, signal?: AbortSignal): Promise<LlmResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), request.timeoutMs);
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    const started = Date.now();
    try {
      const result = await completion({ ...this.settings, model: request.model || this.settings.model }, request.messages, controller.signal);
      const raw = result.rawResponse as { id?: unknown };
      return {
        raw: result.rawResponse, text: result.content, latencyMs: Date.now() - started,
        providerRequestId: typeof raw?.id === 'string' ? raw.id : undefined,
        usage: { total: result.tokens, prompt: result.promptTokens, cacheHit: result.cacheHitTokens, cacheMiss: result.cacheMissTokens },
      };
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
    }
  }
}

export class ReplayLlmProvider implements LlmProvider {
  readonly id = 'replay';
  private index = 0;
  constructor(private readonly responses: LlmResponse[]) {}
  async complete(): Promise<LlmResponse> {
    const response = this.responses[this.index++];
    if (!response) throw new Error('replay provider exhausted');
    return structuredClone(response);
  }
}

