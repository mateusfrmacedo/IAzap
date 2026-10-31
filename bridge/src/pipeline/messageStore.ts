/**
 * Local message store for context windows (SQLite via node:sqlite).
 * Persists recent text messages per chat under Application Support / IAZAP_DATA.
 */

import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export type StoredDirection = "in" | "out";

export interface StoredMessage {
  chatId: string;
  messageId: string;
  text: string;
  fromMe: boolean;
  direction: StoredDirection;
  timestamp: number;
}

export class MessageStore {
  private db: DatabaseSync;
  private readonly maxPerChat: number;

  constructor(dbPath: string, maxPerChat = 200) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.maxPerChat = maxPerChat;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        chat_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        text TEXT NOT NULL,
        from_me INTEGER NOT NULL,
        direction TEXT NOT NULL,
        ts INTEGER NOT NULL,
        PRIMARY KEY (chat_id, message_id)
      );
      CREATE INDEX IF NOT EXISTS idx_messages_chat_ts
        ON messages (chat_id, ts DESC);
    `);
  }

  close(): void {
    this.db.close();
  }

  upsert(msg: StoredMessage): void {
    this.db
      .prepare(
        `INSERT INTO messages (chat_id, message_id, text, from_me, direction, ts)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(chat_id, message_id) DO UPDATE SET
           text = excluded.text,
           from_me = excluded.from_me,
           direction = excluded.direction,
           ts = excluded.ts`,
      )
      .run(
        msg.chatId,
        msg.messageId,
        msg.text,
        msg.fromMe ? 1 : 0,
        msg.direction,
        msg.timestamp,
      );

    // Trim oldest beyond maxPerChat
    this.db
      .prepare(
        `DELETE FROM messages
         WHERE chat_id = ?
           AND message_id IN (
             SELECT message_id FROM messages
             WHERE chat_id = ?
             ORDER BY ts DESC
             LIMIT -1 OFFSET ?
           )`,
      )
      .run(msg.chatId, msg.chatId, this.maxPerChat);
  }

  /** Newest-last (chronological) for prompt building. */
  recent(chatId: string, limit: number): StoredMessage[] {
    const rows = this.db
      .prepare(
        `SELECT chat_id, message_id, text, from_me, direction, ts
         FROM messages
         WHERE chat_id = ?
         ORDER BY ts DESC
         LIMIT ?`,
      )
      .all(chatId, limit) as Array<{
      chat_id: string;
      message_id: string;
      text: string;
      from_me: number;
      direction: string;
      ts: number;
    }>;

    return rows
      .map((r) => ({
        chatId: r.chat_id,
        messageId: r.message_id,
        text: r.text,
        fromMe: Boolean(r.from_me),
        direction: (r.direction === "out" ? "out" : "in") as StoredDirection,
        timestamp: Number(r.ts),
      }))
      .reverse();
  }

  /**
   * Build a compact Portuguese context string for the reply engine.
   * Lines: `[in]` / `[out]` with text.
   */
  buildContextString(chatId: string, limit: number): string {
    const msgs = this.recent(chatId, limit);
    if (msgs.length === 0) return "(sem histórico)";
    return msgs
      .map((m) => {
        const who = m.fromMe || m.direction === "out" ? "eu" : "contato";
        return `${who}: ${m.text}`;
      })
      .join("\n");
  }
}
