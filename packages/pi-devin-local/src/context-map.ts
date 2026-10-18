import {
  type Api,
  collapseSystemMessages,
  getCurrentSystemPrompt,
  getCurrentTools,
  type Message,
  type Model,
  type Tool,
  type TranscriptContext,
  withoutInitialSystemMessage,
} from "@earendil-works/pi-ai";
import { transformMessages } from "@earendil-works/pi-ai/api/transform-messages";
import { type ChatThinking, unpackThinkingSignature } from "./thinking.js";

export interface ContentPart {
  type: "text" | "image";
  text?: string;
  mimeType?: string;
  data?: string;
}

export interface ChatHistoryItem {
  role: "user" | "assistant" | "tool";
  content: string | ContentPart[];
  tool_call_id?: string;
  tool_result_is_error?: boolean;
  tool_calls?: Array<{ id: string; name: string; arguments: string }>;
  /** Prior reasoning, replayed so the server can verify and continue it. */
  thinking?: ChatThinking;
}

export interface ToolDef {
  name: string;
  description: string;
  parameters: unknown;
}

export interface MappedChat {
  /** Sent in GetChatMessageRequest.prompt, separately from conversation history. */
  systemPrompt?: string;
  messages: ChatHistoryItem[];
  tools: ToolDef[];
}

function userContent(content: Message["content"]): string | ContentPart[] {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: ContentPart[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    if (part.type === "text") parts.push({ type: "text", text: part.text });
    if (part.type === "image") {
      parts.push({ type: "image", mimeType: part.mimeType, data: part.data });
    }
  }
  return parts;
}

export function mapContextToChat(context: TranscriptContext, model?: Model<Api>): MappedChat {
  const modelId = model?.id;
  // Fold later system updates into the single prompt sent separately to Devin.
  const transcript = collapseSystemMessages(context);
  const systemPrompt = getCurrentSystemPrompt(transcript.messages);
  const messages: ChatHistoryItem[] = [];
  const history = withoutInitialSystemMessage(transcript.messages);
  // Drop aborted/errored turns and answer orphaned tool calls, like Pi's built-in
  // providers do. Replaying an interrupted tool call without a result makes the
  // server reject every later request ("please try a different model").
  for (const message of model ? transformMessages(history as Message[], model) : history) {
    if (message.role === "user") {
      messages.push({ role: "user", content: userContent(message.content) });
      continue;
    }
    if (message.role === "assistant") {
      const texts: string[] = [];
      const toolCalls: Array<{ id: string; name: string; arguments: string }> = [];
      let thinking: ChatThinking | undefined;
      for (const part of message.content) {
        if (part.type === "text") texts.push(part.text);
        if (part.type === "toolCall") {
          toolCalls.push({
            id: part.id,
            name: part.name,
            arguments: JSON.stringify(part.arguments ?? {}),
          });
        }
        if (part.type === "thinking") {
          const decoded = unpackThinkingSignature(part.thinkingSignature);
          // One thinking slot per message on the wire, and an unsigned trace is
          // not replayable — keep the newest block that the server can verify.
          if (
            decoded.signature &&
            message.provider === "devin" &&
            message.api === "devin-local" &&
            (!modelId || message.model === modelId)
          ) {
            thinking = {
              text: part.thinking,
              signature: decoded.signature,
              signatureType: decoded.signatureType,
              redacted: part.redacted,
            };
          }
        }
      }
      messages.push({
        role: "assistant",
        content: texts.join("\n"),
        tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
        thinking,
      });
      continue;
    }
    if (message.role === "toolResult") {
      messages.push({
        role: "tool",
        content: userContent(message.content),
        tool_call_id: message.toolCallId,
        tool_result_is_error: message.isError,
      });
    }
  }

  const tools: ToolDef[] = getCurrentTools(transcript.messages).map((tool: Tool) => ({
    name: tool.name,
    description:
      tool.description.length > 6_998 ? `${tool.description.slice(0, 6_995)}...` : tool.description,
    parameters: tool.parameters,
  }));

  return { systemPrompt: systemPrompt || undefined, messages: capImages(messages), tools };
}

// server.codeium.com's nginx rejects request bodies over ~10 MB with a 413, and
// every turn replays all history images as base64, which barely gzips. Keep the
// newest images within budget and stub out older ones.
const IMAGE_BUDGET_CHARS = 7 * 1024 * 1024;
export const OMITTED_IMAGE_TEXT = "[image omitted: request size limit]";

export function capImages(
  messages: ChatHistoryItem[],
  budget = IMAGE_BUDGET_CHARS,
): ChatHistoryItem[] {
  let used = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const content = messages[i].content;
    if (typeof content === "string") continue;
    for (let j = content.length - 1; j >= 0; j--) {
      const part = content[j];
      if (part.type !== "image") continue;
      used += part.data?.length ?? 0;
      if (used > budget) content[j] = { type: "text", text: OMITTED_IMAGE_TEXT };
    }
  }
  return messages;
}
