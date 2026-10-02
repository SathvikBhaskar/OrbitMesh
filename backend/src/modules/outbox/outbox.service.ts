import { eq, and, lte, inArray, sql, count } from "drizzle-orm";
import crypto from "crypto";
import { db } from "../../db/client";
import {
  reservations,
  dispatchAttempts,
  outboundDispatchMessages,
} from "../../db/schema";
import {
  OutboxMessageRecord,
  CreateOutboxMessageInput,
  AtomicExecutionReadyResult,
} from "./outbox.types";
import { logger } from "../../config/logger";

export class OutboxService {
  public static readonly DEFAULT_MAX_ATTEMPTS = 5;
  public static readonly BASE_BACKOFF_MS = 1000;
  public static readonly MAX_BACKOFF_MS = 60000;

  /**
   * 1. Atomic Transaction Unit (§2.1):
   * Transitions reservation from SCHEDULED -> EXECUTION_READY,
   * creates dispatch attempt D_n in PREPARED state,
   * and creates outbound dispatch message M_n in PENDING status,
   * ALL IN ONE DATABASE TRANSACTION.
   */
  async transitionToExecutionReadyWithOutbox(
    reservationId: string,
    providerId: string = "default-provider",
    options: {
      customDispatchId?: string;
      expiresAt?: Date;
      payload?: Record<string, unknown>;
    } = {}
  ): Promise<AtomicExecutionReadyResult> {
    return await db.transaction(async (tx) => {
      // 1. Fetch and lock reservation
      const resRows = await tx
        .select()
        .from(reservations)
        .where(eq(reservations.id, reservationId));

      if (resRows.length === 0) {
        throw new Error(`Reservation ${reservationId} not found`);
      }

      const res = resRows[0]!;
      if (res.executionState !== "SCHEDULED") {
        throw new Error(
          `Cannot transition to EXECUTION_READY from execution state: ${res.executionState}`
        );
      }

      // 2. Determine sequential attempt number
      const countResult = await tx
        .select({ value: count() })
        .from(dispatchAttempts)
        .where(eq(dispatchAttempts.reservationId, reservationId));

      const attemptNumber = (countResult[0]?.value || 0) + 1;
      const dispatchId =
        options.customDispatchId || `disp-${crypto.randomUUID().slice(0, 8)}`;
      const messageId = `msg-${crypto.randomUUID().slice(0, 12)}`;
      const expiresAt =
        options.expiresAt || new Date(res.allocatedStart.getTime() + 600000);

      // 3. Transition reservation to EXECUTION_READY
      await tx
        .update(reservations)
        .set({
          executionState: "EXECUTION_READY",
          activeDispatchId: dispatchId,
          dispatchedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(reservations.id, reservationId));

      // 4. Create dispatch attempt in PREPARED state
      await tx.insert(dispatchAttempts).values({
        reservationId,
        dispatchId,
        attemptNumber,
        state: "PREPARED",
        transportHealth: "CONNECTED",
        metadata: options.payload || {},
      });

      // 5. Create outbox message in PENDING status
      const [msg] = await tx
        .insert(outboundDispatchMessages)
        .values({
          messageId,
          dispatchId,
          reservationId,
          providerId,
          messageType: "STAGE_DISPATCH",
          payload: options.payload || {},
          status: "PENDING",
          attemptCount: 0,
          maxAttempts: OutboxService.DEFAULT_MAX_ATTEMPTS,
          nextAttemptAt: new Date(),
          expiresAt,
        })
        .returning();

      logger.info(
        {
          reservationId,
          dispatchId,
          messageId,
          attemptNumber,
        },
        "Atomically transitioned reservation to EXECUTION_READY with dispatch attempt and outbox message"
      );

      return {
        reservationId,
        dispatchId,
        messageId,
        attemptNumber,
        outboxMessage: msg as OutboxMessageRecord,
      };
    });
  }

  /**
   * 2. Enqueue an arbitrary outbox message in an existing transaction
   */
  async enqueueOutboxMessage(
    tx: any,
    input: CreateOutboxMessageInput
  ): Promise<OutboxMessageRecord> {
    const [msg] = await tx
      .insert(outboundDispatchMessages)
      .values({
        messageId: input.messageId,
        dispatchId: input.dispatchId,
        reservationId: input.reservationId,
        providerId: input.providerId,
        messageType: input.messageType,
        payload: input.payload || {},
        status: "PENDING",
        attemptCount: 0,
        maxAttempts: input.maxAttempts || OutboxService.DEFAULT_MAX_ATTEMPTS,
        nextAttemptAt: new Date(),
        expiresAt: input.expiresAt,
      })
      .returning();

    return msg as OutboxMessageRecord;
  }

  /**
   * 3. Fetch pending or retryable outbox messages ready for delivery
   */
  async fetchPendingOutboxMessages(
    limit: number = 50
  ): Promise<OutboxMessageRecord[]> {
    const rows = await db
      .select()
      .from(outboundDispatchMessages)
      .where(
        and(
          inArray(outboundDispatchMessages.status, ["PENDING", "RETRY"]),
          lte(outboundDispatchMessages.nextAttemptAt, new Date())
        )
      )
      .limit(limit);

    return rows as OutboxMessageRecord[];
  }

  /**
   * 4. Deliver a single outbox message via provider handler
   */
  async deliverOutboxMessage(
    messageId: string,
    sender: (msg: OutboxMessageRecord) => Promise<void>
  ): Promise<{ delivered: boolean; status: string; error?: string }> {
    // 1. Fetch message
    const rows = await db
      .select()
      .from(outboundDispatchMessages)
      .where(eq(outboundDispatchMessages.messageId, messageId));

    if (rows.length === 0) {
      throw new Error(`Outbox message ${messageId} not found`);
    }

    const msg = rows[0] as OutboxMessageRecord;

    // Check expiry
    if (msg.expiresAt && msg.expiresAt.getTime() < Date.now()) {
      logger.warn({ messageId }, "Outbox message expired before delivery; moving to DLQ");
      await this.markMessageDLQ(messageId, "MESSAGE_EXPIRED_BEFORE_DELIVERY");
      return { delivered: false, status: "DLQ", error: "MESSAGE_EXPIRED" };
    }

    // 2. Mark DELIVERING
    await db
      .update(outboundDispatchMessages)
      .set({
        status: "DELIVERING",
        lastAttemptAt: new Date(),
        attemptCount: sql`${outboundDispatchMessages.attemptCount} + 1`,
      })
      .where(eq(outboundDispatchMessages.messageId, messageId));

    try {
      // 3. Invoke external delivery function
      await sender(msg);

      // 4. Mark DELIVERED on success
      await db
        .update(outboundDispatchMessages)
        .set({
          status: "DELIVERED",
          sentAt: new Date(),
          lastError: null,
        })
        .where(eq(outboundDispatchMessages.messageId, messageId));

      logger.info({ messageId, dispatchId: msg.dispatchId }, "Outbox message successfully delivered");
      return { delivered: true, status: "DELIVERED" };
    } catch (err: any) {
      logger.warn({ messageId, error: err.message }, "Outbox message delivery failed");
      const nextStatus = await this.handleDeliveryFailure(msg, err);
      return { delivered: false, status: nextStatus, error: err.message };
    }
  }

  /**
   * 5. Delivery failure handling with exponential backoff & DLQ transition
   */
  private async handleDeliveryFailure(
    msg: OutboxMessageRecord,
    err: Error
  ): Promise<string> {
    const currentAttempts = msg.attemptCount + 1;

    // Cardinal Rule: DLQ indicates delivery failure, NOT physical execution failure.
    if (currentAttempts >= msg.maxAttempts) {
      await this.markMessageDLQ(msg.messageId, err.message);
      return "DLQ";
    }

    // Exponential backoff with jitter
    const backoffMs = Math.min(
      OutboxService.MAX_BACKOFF_MS,
      OutboxService.BASE_BACKOFF_MS * Math.pow(2, currentAttempts - 1)
    ) + Math.floor(Math.random() * 200);

    const nextAttemptAt = new Date(Date.now() + backoffMs);

    await db
      .update(outboundDispatchMessages)
      .set({
        status: "RETRY",
        nextAttemptAt,
        lastError: err.message,
      })
      .where(eq(outboundDispatchMessages.messageId, msg.messageId));

    logger.info(
      {
        messageId: msg.messageId,
        attempt: currentAttempts,
        nextAttemptAt,
      },
      "Scheduled outbox message for retry"
    );

    return "RETRY";
  }

  /**
   * 6. Transition message to DLQ (Dead Letter Queue)
   * Invariant: A dispatch message in DLQ means delivery could not be completed,
   * NOT that physical execution failed.
   */
  async markMessageDLQ(messageId: string, reason: string): Promise<void> {
    await db
      .update(outboundDispatchMessages)
      .set({
        status: "DLQ",
        lastError: `DLQ: ${reason}`,
      })
      .where(eq(outboundDispatchMessages.messageId, messageId));

    logger.error(
      { messageId, reason },
      "[OUTBOX_DLQ] Outbound dispatch delivery exhausted. Alerting operators. Physical execution state preserved."
    );
  }

  /**
   * 7. Process a batch of pending outbox messages
   */
  async processPendingBatch(
    senderResolver: (msg: OutboxMessageRecord) => Promise<void>,
    limit: number = 20
  ): Promise<{ processed: number; succeeded: number; failed: number }> {
    const messages = await this.fetchPendingOutboxMessages(limit);
    let succeeded = 0;
    let failed = 0;

    for (const msg of messages) {
      const result = await this.deliverOutboxMessage(msg.messageId, senderResolver);
      if (result.delivered) {
        succeeded++;
      } else {
        failed++;
      }
    }

    return { processed: messages.length, succeeded, failed };
  }
}

export const outboxService = new OutboxService();
