/**
 * NanoClaw Agent Runner
 * Runs inside a container, receives config via stdin, outputs result to stdout
 * Uses OpenCode SDK instead of Claude Agent SDK
 *
 * Input protocol:
 *   Stdin: Full ContainerInput JSON (read until EOF)
 *   IPC:   Follow-up messages written as JSON files to /workspace/ipc/input/
 *          Files: {type:"message", text:"..."}.json — polled and consumed
 *          Sentinel: /workspace/ipc/input/_close — signals session end
 *
 * Stdout protocol:
 *   Each result is wrapped in OUTPUT_START_MARKER / OUTPUT_END_MARKER pairs.
 *   Multiple results may be emitted (one per agent teams result).
 *   Final marker after loop ends signals completion.
 */

import fs from 'fs';
import path from 'path';
import { createOpencodeClient, type TextPart } from '@opencode-ai/sdk';

interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
}

interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

const IPC_INPUT_DIR = '/workspace/ipc/input';
const IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, '_close');
const IPC_POLL_MS = 500;

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

const GROUP_CLAUDE_MD_PATH = '/workspace/group/CLAUDE.md';
const GLOBAL_CLAUDE_MD_PATH = '/workspace/global/CLAUDE.md';
const CONVERSATIONS_DIR = '/workspace/group/conversations';
const TRANSCRIPT_PATH = '/workspace/group/transcript.jsonl';

const SCHEDULED_TASK_PREFIX =
  '[SCHEDULED TASK - The following message was sent automatically and is not coming directly from the user or group.]';

function writeOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
}

function log(message: string): void {
  console.error(`[agent-runner] ${message}`);
}

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

function shouldClose(): boolean {
  if (fs.existsSync(IPC_INPUT_CLOSE_SENTINEL)) {
    try {
      fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL);
    } catch {
      /* ignore */
    }
    return true;
  }
  return false;
}

function drainIpcInput(): string[] {
  try {
    fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
    const files = fs
      .readdirSync(IPC_INPUT_DIR)
      .filter((f) => f.endsWith('.json'))
      .sort();

    const messages: string[] = [];
    for (const file of files) {
      const filePath = path.join(IPC_INPUT_DIR, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        fs.unlinkSync(filePath);
        if (data.type === 'message' && data.text) {
          messages.push(data.text);
        }
      } catch (err) {
        log(
          `Failed to process input file ${file}: ${err instanceof Error ? err.message : String(err)}`,
        );
        try {
          fs.unlinkSync(filePath);
        } catch {
          /* ignore */
        }
      }
    }
    return messages;
  } catch (err) {
    log(`IPC drain error: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

function waitForIpcMessage(): Promise<string | null> {
  return new Promise((resolve) => {
    const poll = () => {
      if (shouldClose()) {
        resolve(null);
        return;
      }
      const messages = drainIpcInput();
      if (messages.length > 0) {
        resolve(messages.join('\n'));
        return;
      }
      setTimeout(poll, IPC_POLL_MS);
    };
    poll();
  });
}

function extractPromptText(result: { info: unknown; parts: unknown }): string {
  if (!result.parts || !Array.isArray(result.parts)) {
    return 'I could not parse the assistant response.';
  }

  const textParts = result.parts.filter(
    (part): part is TextPart =>
      typeof part === 'object' &&
      part !== null &&
      'type' in part &&
      (part as Partial<TextPart>).type === 'text',
  );

  if (textParts.length === 0) {
    return 'I could not parse the assistant response.';
  }

  const text = textParts
    .map((part) => part.text)
    .join('\n')
    .trim();
  return text || 'I could not parse the assistant response.';
}

function archiveConversation(
  sessionId: string,
  transcriptPath: string,
  assistantName?: string,
): void {
  try {
    if (!fs.existsSync(transcriptPath)) {
      log('No transcript found for archiving');
      return;
    }

    const content = fs.readFileSync(transcriptPath, 'utf-8');
    const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [];

    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (entry.type === 'user' && entry.message?.content) {
          const text =
            typeof entry.message.content === 'string'
              ? entry.message.content
              : entry.message.content
                  .map((c: { text?: string }) => c.text || '')
                  .join('');
          if (text) messages.push({ role: 'user', content: text });
        } else if (entry.type === 'assistant' && entry.message?.content) {
          const textParts = entry.message.content
            .filter((c: { type: string }) => c.type === 'text')
            .map((c: { text: string }) => c.text);
          const text = textParts.join('');
          if (text) messages.push({ role: 'assistant', content: text });
        }
      } catch (err) {
        log(
          `Failed to parse transcript line: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    if (messages.length === 0) {
      log('No messages to archive');
      return;
    }

    fs.mkdirSync(CONVERSATIONS_DIR, { recursive: true });

    const date = new Date().toISOString().split('T')[0];
    const name = sanitizeFilename(sessionId);
    const filename = `${date}-${name}.md`;
    const filePath = path.join(CONVERSATIONS_DIR, filename);

    const markdown = formatTranscriptMarkdown(
      messages,
      sessionId,
      assistantName,
    );
    fs.writeFileSync(filePath, markdown);

    log(`Archived conversation to ${filePath}`);
  } catch (err) {
    log(
      `Failed to archive transcript: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function sanitizeFilename(id: string): string {
  return id
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}

function formatTranscriptMarkdown(
  messages: Array<{ role: string; content: string }>,
  title?: string,
  assistantName?: string,
): string {
  const now = new Date();
  const formatDateTime = (d: Date) =>
    d.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });

  const lines: string[] = [];
  lines.push(`# ${title || 'Conversation'}`);
  lines.push('');
  lines.push(`Archived: ${formatDateTime(now)}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  for (const msg of messages) {
    const sender = msg.role === 'user' ? 'User' : assistantName || 'Assistant';
    const content =
      msg.content.length > 2000
        ? msg.content.slice(0, 2000) + '...'
        : msg.content;
    lines.push(`**${sender}**: ${content}`);
    lines.push('');
  }

  return lines.join('\n');
}

function parseModelConfig(modelString: string): {
  providerID: string;
  modelID: string;
} {
  const parts = modelString.split('/');
  if (parts.length === 1) {
    return { providerID: 'opencode', modelID: parts[0] };
  }
  return {
    providerID: parts[0],
    modelID: parts.slice(1).join('/'),
  };
}

async function runPrompt(
  client: ReturnType<typeof createOpencodeClient>,
  sessionId: string | undefined,
  prompt: string,
  isMain: boolean,
): Promise<{ newSessionId?: string; result: string }> {
  let currentSessionId = sessionId;

  const modelEnv = process.env.OPENCODE_MODEL || 'opencode/minimax-m2.5-free';
  const { providerID, modelID } = parseModelConfig(modelEnv);

  if (!currentSessionId) {
    const session = await client.session.create({
      body: { title: `chat:${Date.now()}` },
    });

    const sessionData = session as {
      data: { id: string; slug?: string };
      error?: unknown;
    };
    if (sessionData.error) {
      throw new Error(
        `Session creation failed: ${JSON.stringify(sessionData.error)}`,
      );
    }

    currentSessionId = sessionData.data.id ?? sessionData.data.slug;
    log(`Created new session: ${currentSessionId}`);
  }

  let systemPrompt = '';
  try {
    if (fs.existsSync(GROUP_CLAUDE_MD_PATH)) {
      systemPrompt = fs.readFileSync(GROUP_CLAUDE_MD_PATH, 'utf-8');
    } else if (!isMain && fs.existsSync(GLOBAL_CLAUDE_MD_PATH)) {
      systemPrompt = fs.readFileSync(GLOBAL_CLAUDE_MD_PATH, 'utf-8');
    }
  } catch {
    // No CLAUDE.md, use default
  }

  const result = await Promise.race([
    client.session.prompt({
      path: { id: currentSessionId },
      body: {
        model: { providerID, modelID },
        parts: [{ type: 'text', text: prompt }],
        ...(systemPrompt ? { system: systemPrompt } : {}),
      },
    }),
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error('Session prompt timed out after 5 minutes')),
        5 * 60 * 1000,
      ),
    ),
  ]);

  if (!result.data) {
    throw new Error('Session prompt returned no data');
  }

  const text = extractPromptText({
    info: result.data.info,
    parts: result.data.parts,
  });

  return {
    newSessionId: currentSessionId,
    result: text,
  };
}

async function main(): Promise<void> {
  let containerInput: ContainerInput;

  try {
    const stdinData = await readStdin();
    containerInput = JSON.parse(stdinData);
    log(`Received input for group: ${containerInput.groupFolder}`);
  } catch (err) {
    writeOutput({
      status: 'error',
      result: null,
      error: `Failed to parse input: ${err instanceof Error ? err.message : String(err)}`,
    });
    process.exit(1);
  }

  // Initialize OpenCode
  let client: ReturnType<typeof createOpencodeClient>;

  const opencodeUrl = process.env.OPENCODE_SERVER_URL;
  const opencodePassword = process.env.OPENCODE_SERVER_PASSWORD;

  if (opencodeUrl) {
    // External OpenCode server
    const opencodeUsername = process.env.OPENCODE_SERVER_USERNAME || 'opencode';
    const authHeader = opencodePassword
      ? 'Basic ' +
        Buffer.from(`${opencodeUsername}:${opencodePassword}`).toString(
          'base64',
        )
      : undefined;

    const clientOptions: { baseUrl: string; headers?: Record<string, string> } =
      {
        baseUrl: opencodeUrl,
      };
    if (authHeader) {
      clientOptions.headers = { Authorization: authHeader };
    }
    client = createOpencodeClient(clientOptions);
    log(
      `Using external OpenCode server: ${opencodeUrl}${opencodePassword ? ' (with password)' : ''}`,
    );
  } else {
    // Local server - connects to existing OpenCode instance
    const clientOptions: { baseUrl: string; fetch?: typeof fetch } = {
      baseUrl: 'http://127.0.0.1:1984',
    };

    try {
      client = createOpencodeClient(clientOptions);
      log('Connected to local OpenCode server');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      writeOutput({
        status: 'error',
        result: null,
        error: `Failed to connect to OpenCode: ${message}`,
      });
      process.exit(1);
    }
  }

  let sessionId = containerInput.sessionId;
  fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });

  // Clean up stale _close sentinel
  try {
    fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL);
  } catch {
    /* ignore */
  }

  // Build initial prompt
  const promptParts: string[] = [];
  if (containerInput.isScheduledTask) {
    promptParts.push(SCHEDULED_TASK_PREFIX);
  }
  promptParts.push(containerInput.prompt);
  const pending = drainIpcInput();
  if (pending.length > 0) {
    log(`Draining ${pending.length} pending IPC messages into initial prompt`);
    promptParts.push(...pending);
  }
  let prompt = promptParts.join('\n');

  // Query loop
  try {
    while (true) {
      log(`Starting prompt (session: ${sessionId || 'new'})...`);

      let promptResult: { newSessionId?: string; result: string };
      try {
        promptResult = await runPrompt(
          client,
          sessionId || undefined,
          prompt,
          containerInput.isMain,
        );
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        writeOutput({
          status: 'error',
          result: null,
          newSessionId: sessionId,
          error: errorMessage,
        });
        break;
      }

      if (promptResult.newSessionId) {
        sessionId = promptResult.newSessionId;
      }

      // Emit result
      writeOutput({
        status: 'success',
        result: promptResult.result,
        newSessionId: sessionId,
      });

      // Archive conversation after each result
      try {
        if (sessionId) {
          archiveConversation(
            sessionId,
            TRANSCRIPT_PATH,
            containerInput.assistantName,
          );
        }
      } catch {
        /* ignore archiving errors */
      }

      // Check for close sentinel after result
      if (shouldClose()) {
        log('Close sentinel detected, exiting');
        break;
      }

      log('Prompt ended, waiting for next IPC message...');

      // Wait for next message or close sentinel
      const nextMessage = await waitForIpcMessage();
      if (nextMessage === null) {
        log('Close sentinel received, exiting');
        break;
      }

      log(`Got new message (${nextMessage.length} chars), starting new prompt`);
      prompt = nextMessage;
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log(`Agent error: ${errorMessage}`);
    writeOutput({
      status: 'error',
      result: null,
      newSessionId: sessionId,
      error: errorMessage,
    });
  }
}

main();
