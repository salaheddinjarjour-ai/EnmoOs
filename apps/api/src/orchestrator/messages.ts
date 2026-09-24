import { Prisma, type DbClient, type DbTransaction } from "@enmo/db";
import {
  CHAT_MESSAGE_PAYLOAD,
  type AgentName,
  type ChatMessageDto,
  type ChatMessagePayload,
  type MessageRole,
} from "@enmo/shared";
import { parseStored } from "../lib/stored";
import type { EventBatch } from "./events";

/*
 * Chat messages (DESIGN §B "Campaigns and chat"): the DTO mapping every reader shares and the one
 * writer the orchestrator and the services use, which validates the payload for its kind.
 */

type Db = DbClient | DbTransaction;
export type MessageKind = ChatMessageDto["kind"];

export const CHAT_MESSAGE_SELECT = {
  id: true,
  threadId: true,
  role: true,
  kind: true,
  agent: true,
  content: true,
  payload: true,
  createdAt: true,
  updatedAt: true,
  user: { select: { id: true, name: true } },
} as const satisfies Prisma.ChatMessageSelect;

export type ChatMessageRow = Prisma.ChatMessageGetPayload<{ select: typeof CHAT_MESSAGE_SELECT }>;

export function toChatMessageDto(row: ChatMessageRow): ChatMessageDto {
  const payload = parseStored(
    CHAT_MESSAGE_PAYLOAD[row.kind],
    row.payload,
    `ChatMessage ${row.id}.payload`,
  );
  return {
    id: row.id,
    threadId: row.threadId,
    role: row.role,
    agent: row.agent,
    author: row.user,
    content: row.content,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    kind: row.kind,
    payload,
  } as ChatMessageDto;
}

export interface NewMessage<K extends MessageKind> {
  threadId: string;
  role: MessageRole;
  kind: K;
  /** The signing agent (role AGENT). */
  agent?: AgentName | null;
  /** The teammate who wrote it (role USER). */
  userId?: string | null;
  content: string;
  payload: ChatMessagePayload<K>;
}

/** `null` → SQL NULL (Prisma needs the sentinel for nullable Json columns). */
export function jsonOrDbNull(value: unknown): Prisma.InputJsonValue | typeof Prisma.DbNull {
  return value === null || value === undefined ? Prisma.DbNull : value;
}

export async function createMessage<K extends MessageKind>(
  db: Db,
  message: NewMessage<K>,
): Promise<ChatMessageDto> {
  const payload = CHAT_MESSAGE_PAYLOAD[message.kind].parse(message.payload);
  const row = await db.chatMessage.create({
    data: {
      threadId: message.threadId,
      role: message.role,
      kind: message.kind,
      agent: message.agent ?? null,
      userId: message.userId ?? null,
      content: message.content,
      payload: jsonOrDbNull(payload),
    },
    select: CHAT_MESSAGE_SELECT,
  });
  return toChatMessageDto(row);
}

/** A message signed by one of the Arsenal. */
export function createAgentMessage<K extends MessageKind>(
  db: Db,
  message: Omit<NewMessage<K>, "role" | "userId"> & { agent: AgentName },
): Promise<ChatMessageDto> {
  return createMessage(db, { ...message, role: "AGENT" });
}

export function messageCreated(events: EventBatch, message: ChatMessageDto): EventBatch {
  return events.thread(message.threadId, "message.created", {
    threadId: message.threadId,
    message,
  });
}

export function messageUpdated(events: EventBatch, message: ChatMessageDto): EventBatch {
  return events.thread(message.threadId, "message.updated", {
    threadId: message.threadId,
    message,
  });
}
