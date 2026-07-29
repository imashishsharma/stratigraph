/**
 * The only place in this project that talks to a model API.
 *
 * Behind an interface, so `run.ts` never imports the SDK and every test injects
 * a fake. No test in this repository makes a network call, and CI has no
 * credential — the contract in `contract.ts` is a pure function, so the rules
 * that matter are tested exhaustively offline.
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import Anthropic from '@anthropic-ai/sdk';

import { LOCAL_CONFIG_FILENAME, type LlmConfig } from '../config.js';

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

export type CredentialSource =
  | 'config'
  | 'key-file'
  | 'environment'
  | 'auth-token'
  | 'profile';

export interface Credential {
  source: CredentialSource;
  /** Where it came from, for `doctor` to print. Never the key itself. */
  describe: string;
  /**
   * The key, when we resolved one ourselves. Null means "the SDK will find it"
   * — an auth token or an `ant auth login` profile, which the SDK reads and we
   * deliberately do not.
   */
  apiKey: string | null;
}

/**
 * Find the credential, in the order someone would expect to be able to
 * override things.
 *
 * A config file first, because that is the thing a person just edited; the
 * environment next, because that is what CI sets; then the two the SDK can
 * find on its own. An unset `ANTHROPIC_API_KEY` does not mean there is no
 * credential — checking only that would tell a logged-in user their
 * interpretation was skipped for want of a key they do not need.
 */
export function resolveCredential(
  llm: Pick<LlmConfig, 'apiKey' | 'apiKeyFile' | 'apiKeyEnv'>,
  env: NodeJS.ProcessEnv = process.env,
): Credential | null {
  if (llm.apiKey) {
    return { source: 'config', describe: LOCAL_CONFIG_FILENAME, apiKey: llm.apiKey };
  }

  if (llm.apiKeyFile) {
    // A configured key file that cannot be read is an error, not a fall-through
    // to whatever else happens to be lying around: someone asked for a specific
    // credential and silently using a different one is how the wrong account
    // gets billed.
    let contents: string;
    try {
      contents = readFileSync(llm.apiKeyFile, 'utf8');
    } catch (cause) {
      throw new InterpretError(
        `llm.apiKeyFile: cannot read ${llm.apiKeyFile}: ${(cause as Error).message}`,
      );
    }
    const key = contents.trim();
    if (key.length === 0) {
      throw new InterpretError(`llm.apiKeyFile: ${llm.apiKeyFile} is empty`);
    }
    return { source: 'key-file', describe: llm.apiKeyFile, apiKey: key };
  }

  const fromEnv = env[llm.apiKeyEnv];
  if (fromEnv) {
    return { source: 'environment', describe: `$${llm.apiKeyEnv}`, apiKey: fromEnv };
  }

  // The remaining two are the SDK's to read, so no key is carried here.
  if (env['ANTHROPIC_AUTH_TOKEN']) {
    return { source: 'auth-token', describe: '$ANTHROPIC_AUTH_TOKEN', apiKey: null };
  }
  const configDir =
    env['ANTHROPIC_CONFIG_DIR'] ??
    (process.platform === 'win32'
      ? join(env['APPDATA'] ?? '', 'Anthropic')
      : join(homedir(), '.config', 'anthropic'));
  if (existsSync(join(configDir, 'credentials'))) {
    return { source: 'profile', describe: `${configDir} (ant auth login)`, apiKey: null };
  }

  return null;
}

export function createModelClient(model: string, credential: Credential): ModelClient {
  // A resolved key is passed explicitly; otherwise the SDK is left to find the
  // auth token or profile itself, which it does in that order.
  const anthropic = credential.apiKey
    ? new Anthropic({ apiKey: credential.apiKey })
    : new Anthropic();

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
