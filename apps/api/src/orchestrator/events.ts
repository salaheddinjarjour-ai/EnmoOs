import {
  GLOBAL_CHANNEL,
  threadChannel,
  type AlertPayload,
  type RealtimeChannel,
  type RealtimeEventType,
  type RealtimePayload,
} from "@enmo/shared";
import type { Deps } from "../deps";

/*
 * Events are collected while a transaction runs and published once it has committed, so a client
 * never hears about a row it then can't read (and a rollback emits nothing).
 */

interface QueuedEvent {
  channel: RealtimeChannel;
  type: RealtimeEventType;
  payload: unknown;
}

/** REALTIME_EVENT_SCOPE's "thread" types (events.test.ts keeps the two in step). */
export const THREAD_EVENT_TYPES = [
  "message.created",
  "message.updated",
  "agent.status",
  "plan.proposed",
] as const satisfies readonly RealtimeEventType[];
export type ThreadEventType = (typeof THREAD_EVENT_TYPES)[number];
export type GlobalEventType = Exclude<RealtimeEventType, ThreadEventType>;

export class EventBatch {
  readonly #events: QueuedEvent[] = [];

  /** A thread-scoped event (message.*, agent.status, plan.proposed). */
  thread<T extends ThreadEventType>(threadId: string, type: T, payload: RealtimePayload<T>): this {
    this.#events.push({ channel: threadChannel(threadId), type, payload });
    return this;
  }

  /** A global event (post.*, approval.*, alert, budget.updated, …). */
  global<T extends GlobalEventType>(type: T, payload: RealtimePayload<T>): this {
    this.#events.push({ channel: GLOBAL_CHANNEL, type, payload });
    return this;
  }

  alert(payload: AlertPayload): this {
    return this.global("alert", payload);
  }

  append(other: EventBatch): this {
    this.#events.push(...other.#events);
    return this;
  }

  get size(): number {
    return this.#events.length;
  }

  /** Publishes in the order the events were added, then empties the batch. */
  async publish(deps: Pick<Deps, "realtime">): Promise<void> {
    const events = this.#events.splice(0);
    for (const event of events) {
      await deps.realtime.publish(
        event.channel,
        event.type,
        event.payload as RealtimePayload<typeof event.type>,
      );
    }
  }
}

/** Publishes a single global event right away (outside any transaction). */
export function publishGlobal<T extends GlobalEventType>(
  deps: Pick<Deps, "realtime">,
  type: T,
  payload: RealtimePayload<T>,
): Promise<void> {
  return new EventBatch().global(type, payload).publish(deps);
}
