import OpenAI from "openai";
import type {
  ChatCompletionContentPart,
  ChatCompletionMessageParam,
} from "openai/resources/chat/completions.js";

export interface ImagePart {
  data: Buffer;
  mimeType: string;
}

export interface ModelConfig {
  apiKey: string;
  baseURL?: string;
  model: string;
  contextLimit?: number;
}

export interface CurrentModelInfo {
  name: string;
  model: string;
  baseURL?: string;
}

export interface ChatSession {
  history: ChatCompletionMessageParam[];
}

export interface SessionStats {
  userId: string;
  messageCount: number;
  userMessages: number;
  assistantMessages: number;
  estimatedTokens: number;
  contextLimit: number;
  contextPercent: number;
}

export class AIChat {
  private client: OpenAI;
  private model: string;
  private apiKey: string;
  private baseURL?: string;
  private currentName: string;
  private currentContextLimit: number;
  private systemPrompt: string;
  private sessions = new Map<string, ChatSession>();

  constructor(opts: {
    apiKey: string;
    baseURL?: string;
    model?: string;
    name?: string;
    contextLimit?: number;
    systemPrompt?: string;
  }) {
    this.apiKey = opts.apiKey;
    this.baseURL = opts.baseURL;
    this.model = opts.model || "gpt-4o";
    this.currentName = opts.name ?? "default";
    this.currentContextLimit = opts.contextLimit ?? 16384;
    this.systemPrompt = opts.systemPrompt || "你是一个友好的AI助手，简洁明了地回答问题。";
    this.client = this.buildClient();
  }

  private buildClient(): OpenAI {
    return new OpenAI({
      apiKey: this.apiKey,
      baseURL: this.baseURL,
    });
  }

  private getSession(userId: string): ChatSession {
    let session = this.sessions.get(userId);
    if (!session) {
      session = { history: [] };
      this.sessions.set(userId, session);
    }
    return session;
  }

  /** v2 chat_integration 内部使用：拿 in-memory session（含 history），用于拼 messages */
  getSessionPublic(userId: string): ChatSession {
    return this.getSession(userId);
  }

  /** v2 chat_integration 内部使用：直接读当前 OpenAI client（用于 retrieval 路径绕过自带的 chat 拼装） */
  getClient(): OpenAI { return this.client; }

  clearSession(userId: string): void {
    this.sessions.delete(userId);
  }

  getCurrentModel(): CurrentModelInfo {
    return { name: this.currentName, model: this.model, baseURL: this.baseURL };
  }

  /** Switch to a different model config. Sessions are preserved across switches. */
  setModel(
    name: string,
    opts: { apiKey: string; baseURL?: string; model: string; contextLimit?: number },
  ): void {
    this.currentName = name;
    this.apiKey = opts.apiKey;
    this.baseURL = opts.baseURL;
    this.model = opts.model;
    this.currentContextLimit = opts.contextLimit ?? this.currentContextLimit;
    this.client = this.buildClient();
  }

  /**
   * Replace the system prompt at runtime. Used by /new to reload the prompt
   * without rebuilding the OpenAI client (setModel does that on its own path).
   */
  setSystemPrompt(text: string): void {
    this.systemPrompt = text;
  }

  /**
   * v2 chat_integration 内部使用：读当前 system prompt。
   * 提供 public getter 而非反射访问 private 字段——production build 后
   * 字段重命名/移除会让 (ai as any).systemPrompt 直接 undefined。
   */
  getSystemPrompt(): string {
    return this.systemPrompt;
  }

  /**
   * Snapshot session statistics for /status display.
   * Returns null when no session has been touched yet for this user.
   *
   * Token estimate: ceil(totalChars / 3) — heuristic; over-estimates Latin,
   * under-estimates CJK. Good enough as a "rough order of magnitude" hint.
   */
  getSessionStats(userId: string): SessionStats | null {
    const session = this.sessions.get(userId);
    if (!session) return null;

    let userMessages = 0;
    let assistantMessages = 0;
    let totalChars = 0;
    for (const msg of session.history) {
      if (msg.role === "user") userMessages++;
      else if (msg.role === "assistant") assistantMessages++;
      const c = msg.content;
      if (typeof c === "string") {
        totalChars += c.length;
      } else if (Array.isArray(c)) {
        for (const part of c) {
          if (part.type === "text") totalChars += part.text.length;
        }
      }
    }
    const estimatedTokens = Math.ceil(totalChars / 3);
    const contextPercent = this.currentContextLimit > 0
      ? (estimatedTokens / this.currentContextLimit) * 100
      : 0;

    return {
      userId,
      messageCount: session.history.length,
      userMessages,
      assistantMessages,
      estimatedTokens,
      contextLimit: this.currentContextLimit,
      contextPercent,
    };
  }

  async chat(
    userId: string,
    userMessage: string,
    images?: ImagePart[],
  ): Promise<string> {
    const session = this.getSession(userId);

    const hasImages = !!images && images.length > 0;

    // History stores a text-only marker when images are present —
    // raw image bytes are not persisted across turns to keep context small.
    const historyNote = hasImages
      ? `${userMessage || "[用户发送了一张图片]"}\n[用户发送了一张图片]`
      : userMessage;
    session.history.push({ role: "user", content: historyNote });

    // Build the live request message — multimodal when images are present.
    let liveUserMsg: ChatCompletionMessageParam;
    if (hasImages) {
      const userContent: ChatCompletionContentPart[] = [
        { type: "text", text: userMessage || "请看图片" },
        ...images!.map((img) => ({
          type: "image_url" as const,
          image_url: {
            url: `data:${img.mimeType};base64,${img.data.toString("base64")}`,
          },
        })),
      ];
      liveUserMsg = { role: "user", content: userContent };
    } else {
      liveUserMsg = { role: "user", content: userMessage };
    }

    const messages: ChatCompletionMessageParam[] = [
      { role: "system", content: this.systemPrompt },
      ...session.history.slice(0, -1),
      liveUserMsg,
    ];

    const completion = await this.client.chat.completions.create({
      model: this.model,
      messages,
      // DeepSeek reasoning models 默认会输出 reasoning_content；
      // 某些上下文下 SDK 会把思考过程合并到 content 字段。
      // 双重防御：(1) 源头禁用 reasoning (2) 末端正则剥离 <think> 块。
      // non-standard param accepted by DeepSeek / OpenAI-compat APIs (silenced via as any)
      thinking: { type: "disabled" },
    } as any);

    const rawReply = completion.choices[0]?.message?.content || "";
    // 末端防御：剥离残留的 <think>...</think> 块（多行/单行都覆盖）
    const reply = rawReply
      .replace(/<think>[\s\S]*?<\/think>/g, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim() || "（AI 未返回内容）";

    session.history.push({ role: "assistant", content: reply });

    return reply;
  }
}
