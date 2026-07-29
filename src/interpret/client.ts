/**
 * The only place in this project that talks to a model API.
 *
 * Behind an interface, so `run.ts` never imports the SDK and every test injects
 * a fake. No test in this repository makes a network call, and CI has no
 * credential — the contract in `contract.ts` is a pure function, so the rules
 * that matter are tested exhaustively offline.
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import Anthropic from '@anthropic-ai/sdk';

export interface CompletionRequest {
  system: string;
  prompt: string;
  /** JSON schema for `output_config.format`. */
  schema: Record<string, unknown>;
}

export interface Completion {
  /** Parsed JSON from the model. Null when it declined or returned no text. */
  output: unknown | null;
  /**
   * The model that actually produced the message, as reported by the API.
   *
   * Recorded on every row rather than the configured id: if the two ever differ
   * — an alias resolving elsewhere, a server-side fallback — the row must name
   * what actually wrote it (ADR-0013).
   */
  model: string;
  /** Set when the model declined. The cluster then goes undescribed. */
  refusal: string | null;
}

export interface ModelClient {
  complete(request: CompletionRequest): Promise<Completion>;
}

/**
 * Output cap. The responses here are a name, a few sentences and at most a
 * couple of ADR candidates, so this is headroom rather than a target — and it
 * stays under the SDK's non-streaming timeout.
 */
const MAX_TOKENS = 16_000;

export class InterpretError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InterpretError';
  }
}

/**
 * Whether this machine has a credential the SDK will find.
 *
 * An unset `ANTHROPIC_API_KEY` does not mean there is none: the SDK also reads
 * `ANTHROPIC_AUTH_TOKEN` and the profile `ant auth login` writes. Checking only
 * the env var would tell a logged-in user their interpretation was skipped for
 * want of a key they do not need.
 */
export function credentialAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env['ANTHROPIC_API_KEY'] || env['ANTHROPIC_AUTH_TOKEN']) return true;
  const configDir =
    env['ANTHROPIC_CONFIG_DIR'] ??
    (process.platform === 'win32'
      ? join(env['APPDATA'] ?? '', 'Anthropic')
      : join(homedir(), '.config', 'anthropic'));
  return existsSync(join(configDir, 'credentials'));
}

export function createModelClient(model: string): ModelClient {
  // Zero-arg construction on purpose: the SDK resolves an API key, an auth
  // token or an `ant auth login` profile in that order, and hardcoding one of
  // them here would break the other two.
  const anthropic = new Anthropic();

  return {
    async complete(request: CompletionRequest): Promise<Completion> {
      const response = await anthropic.messages.create({
        model,
        max_tokens: MAX_TOKENS,
        system: request.system,
        messages: [{ role: 'user', content: request.prompt }],
        output_config: { format: { type: 'json_schema', schema: request.schema } },
      });

      // Checked before `content` is read: on a refusal the content array is
      // empty or partial, and indexing into it would throw somewhere unhelpful.
      if (response.stop_reason === 'refusal') {
        return {
          output: null,
          model: response.model,
          refusal: response.stop_details?.explanation ?? 'the model declined the request',
        };
      }

      const text = response.content
        .filter((block): block is Anthropic.TextBlock => block.type === 'text')
        .map((block) => block.text)
        .join('');

      if (text.trim().length === 0) {
        return { output: null, model: response.model, refusal: 'the model returned no text' };
      }

      try {
        return { output: JSON.parse(text) as unknown, model: response.model, refusal: null };
      } catch {
        // Structured output should make this unreachable. Returning null rather
        // than throwing keeps a malformed response on the same path as a
        // rejected one: the cluster goes undescribed and says so.
        return {
          output: null,
          model: response.model,
          refusal: 'the model returned text that is not JSON',
        };
      }
    },
  };
}
