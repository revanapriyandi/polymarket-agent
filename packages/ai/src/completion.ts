import { generateText, streamText } from 'ai';
import type { ProviderConfig } from '../../shared/src/index.js';

type CompletionRequest = Parameters<typeof generateText>[0];

/** Provider protocol parsing belongs to the SDK; financial wrappers still own each invocation. */
export async function completeText(config: ProviderConfig, request: CompletionRequest) {
  if (config.responseMode !== 'sse') return generateText(request);
  let failure: unknown;
  const result = streamText({ ...request, streamRetries: 0, onError: event => { failure = event.error; } });
  await result.consumeStream();
  if (failure !== undefined) throw failure;
  const [text, toolCalls, usage, output] = await Promise.all([result.text, result.toolCalls, result.usage, request.output ? result.output : undefined]);
  return { text, toolCalls, usage, output };
}
