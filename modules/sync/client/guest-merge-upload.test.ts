import "fake-indexeddb/auto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SafwaDb } from "@/modules/content/db";
import {
  emptyGuestMergeSummary,
  SYNC_PROTOCOL_VERSION,
  type GuestMergeRequest,
} from "@/modules/sync/protocol";

import { readGuestImport } from "./guest-import-key";
import type { GuestSnapshot } from "./guest-snapshot";
import type { GuestMergeApiResult } from "./guest-merge-api";
import { uploadGuestMerge } from "./guest-merge-upload";

const USER = "11111111-1111-4111-8111-111111111111";

let db: SafwaDb;
let counter = 0;

beforeEach(async () => {
  db = new SafwaDb(`safwa-merge-upload-test-${counter++}`);
  await db.open();
});
afterEach(() => db.close());

/**
 * A snapshot with `pairs` attempt+event pairs. The driver never inspects an
 * item — the planner does, and it is tested separately — so these carry only
 * the identity the planner needs.
 */
function snapshot(pairs = 2): GuestSnapshot {
  const attempts = Array.from({ length: pairs }, (_v, i) => ({ id: `a${i}` }));
  const events = Array.from({ length: pairs }, (_v, i) => ({
    eventId: `e${i}`,
    attemptId: `a${i}`,
  }));
  return {
    version: 1,
    deviceId: "device-1",
    attempts: attempts as GuestSnapshot["attempts"],
    events: events as unknown as GuestSnapshot["events"],
    bookmarks: [],
    lists: [],
    settings: [],
    skipped: { events: 0, attempts: 0, bookmarks: 0, lists: 0, settings: 0 },
  };
}

function begun(overrides: Record<string, unknown> = {}): GuestMergeApiResult {
  return {
    ok: true,
    data: {
      protocolVersion: SYNC_PROTOCOL_VERSION,
      stage: "begin",
      importStatus: "open",
      reasonCode: "accepted",
      resumeFromChunk: 0,
      acceptedItems: 0,
      ...overrides,
    } as GuestMergeApiResult extends { ok: true; data: infer D } ? D : never,
  };
}

function chunked(overrides: Record<string, unknown> = {}): GuestMergeApiResult {
  return {
    ok: true,
    data: {
      protocolVersion: SYNC_PROTOCOL_VERSION,
      stage: "chunk",
      importStatus: "open",
      reasonCode: "accepted",
      chunkIndex: 0,
      results: [],
      acceptedItems: 4,
      ...overrides,
    } as GuestMergeApiResult extends { ok: true; data: infer D } ? D : never,
  };
}

function finalized(
  overrides: Record<string, unknown> = {},
): GuestMergeApiResult {
  return {
    ok: true,
    data: {
      protocolVersion: SYNC_PROTOCOL_VERSION,
      stage: "finalize",
      result: "applied",
      reasonCode: "accepted",
      summary: { ...emptyGuestMergeSummary(), eventsApplied: 2 },
      serverCursor: 41,
      activeReleaseId: "rel-1",
      listIdMappings: [],
      ...overrides,
    } as GuestMergeApiResult extends { ok: true; data: infer D } ? D : never,
  };
}

/** A scripted `post` returning one queued reply per call, recording requests. */
function scripted(replies: GuestMergeApiResult[]) {
  const sent: GuestMergeRequest[] = [];
  const post = vi.fn(async (request: GuestMergeRequest) => {
    sent.push(request);
    const reply = replies.shift();
    if (!reply) throw new Error("unscripted merge call");
    return Promise.resolve(reply);
  });
  return { post, sent };
}

describe("uploadGuestMerge", () => {
  it("runs begin → chunk → finalize and reports the server's summary", async () => {
    const { post, sent } = scripted([begun(), chunked(), finalized()]);
    const outcome = await uploadGuestMerge(db, USER, snapshot(), {
      post: post as never,
    });

    expect(sent.map((r) => r.stage)).toEqual(["begin", "chunk", "finalize"]);
    expect(outcome).toMatchObject({
      status: "completed",
      result: "applied",
      serverCursor: 41,
      summary: { eventsApplied: 2 },
    });
  });

  it("declares exactly what the snapshot carries and repeats the hash on every stage", async () => {
    // The hash on every chunk is what lets the server refuse a chunk belonging
    // to a different snapshot on ARRIVAL rather than at finalisation, after it
    // has been stored.
    const { post, sent } = scripted([begun(), chunked(), finalized()]);
    await uploadGuestMerge(db, USER, snapshot(3), { post: post as never });

    const begin = sent[0];
    expect(begin?.stage === "begin" && begin.declared).toEqual({
      attempts: 3,
      events: 3,
      bookmarks: 0,
      lists: 0,
      settings: 0,
    });
    const hashes = new Set(sent.map((r) => r.snapshotHash));
    expect(hashes.size).toBe(1);
    const keys = new Set(sent.map((r) => r.importKey));
    expect(keys.size).toBe(1);
  });

  it("sends no chunk at all for an empty snapshot", async () => {
    const empty = snapshot(0);
    const { post, sent } = scripted([begun(), finalized({ result: "no_op" })]);
    const outcome = await uploadGuestMerge(db, USER, empty, {
      post: post as never,
    });
    expect(sent.map((r) => r.stage)).toEqual(["begin", "finalize"]);
    expect(outcome).toMatchObject({ status: "completed", result: "no_op" });
  });

  it("persists the import key before the first network call", async () => {
    // §12: a key held only in memory is regenerated after a crash, and the same
    // guest history imports twice.
    let keyAtFirstCall: string | undefined;
    const post = vi.fn(async () => {
      const record = await readGuestImport(db, USER);
      keyAtFirstCall = record?.importKey;
      return Promise.resolve(begun());
    });
    await uploadGuestMerge(db, USER, snapshot(0), { post: post as never });
    expect(keyAtFirstCall).toBeTruthy();
  });

  it("resumes from the chunk index the server names, re-sending nothing before it", async () => {
    // 1,500 pairs = 3,000 items = 3 chunks. The server says it already holds
    // chunk 0, so this attempt sends 1 and 2 only.
    const { post, sent } = scripted([
      begun({ resumeFromChunk: 1, acceptedItems: 1000 }),
      chunked({ chunkIndex: 1, acceptedItems: 2000 }),
      chunked({ chunkIndex: 2, acceptedItems: 3000 }),
      finalized(),
    ]);
    await uploadGuestMerge(db, USER, snapshot(1500), { post: post as never });

    const indexes = sent
      .filter((r) => r.stage === "chunk")
      .map((r) => (r.stage === "chunk" ? r.chunkIndex : -1));
    expect(indexes).toEqual([1, 2]);
  });

  it("sends no chunks for an import the server already completed, and still finalises", async () => {
    // `begin` carries the stored summary but NOT the durable cursor or the list
    // mappings, and local finalisation needs both to re-key its rows.
    const { post, sent } = scripted([
      begun({
        importStatus: "completed",
        reasonCode: "already_completed",
        resumeFromChunk: 0,
        acceptedItems: 4,
        summary: emptyGuestMergeSummary(),
      }),
      finalized({ result: "no_op", reasonCode: "already_completed" }),
    ]);
    const outcome = await uploadGuestMerge(db, USER, snapshot(2), {
      post: post as never,
    });
    expect(sent.map((r) => r.stage)).toEqual(["begin", "finalize"]);
    expect(outcome).toMatchObject({
      status: "completed",
      result: "no_op",
      serverCursor: 41,
    });
  });

  it("records durable progress after each accepted chunk", async () => {
    const { post } = scripted([
      begun(),
      chunked({ chunkIndex: 0, acceptedItems: 1000 }),
      chunked({ chunkIndex: 1, acceptedItems: 1400 }),
      finalized(),
    ]);
    await uploadGuestMerge(db, USER, snapshot(700), { post: post as never });
    const record = await readGuestImport(db, USER);
    expect(record?.uploadedItems).toBe(1400);
  });

  it("reports a network interruption as interrupted-and-retryable, never as a rollback", async () => {
    // §29: once mutation has begun, cancellation must not produce a false
    // rollback claim. Whatever the server accepted stays accepted.
    const { post } = scripted([
      begun(),
      chunked({ chunkIndex: 0, acceptedItems: 1000 }),
      { ok: false, reason: "network" },
    ]);
    const outcome = await uploadGuestMerge(db, USER, snapshot(700), {
      post: post as never,
    });
    expect(outcome).toMatchObject({
      status: "interrupted",
      retryable: true,
      failure: "network",
    });
    // The key and its progress survive, so the next attempt resumes rather than
    // re-importing the history.
    const record = await readGuestImport(db, USER);
    expect(record?.status).toBe("failed");
    expect(record?.uploadedItems).toBe(1000);
  });

  it("does not offer a retry for a lost session", async () => {
    const { post } = scripted([{ ok: false, reason: "unauthorized" }]);
    expect(
      await uploadGuestMerge(db, USER, snapshot(1), { post: post as never }),
    ).toMatchObject({ status: "interrupted", retryable: false });
  });

  it("surfaces a refusal with the server's own reason code", async () => {
    const { post } = scripted([
      begun({ importStatus: "rejected", reasonCode: "snapshot_mismatch" }),
    ]);
    expect(
      await uploadGuestMerge(db, USER, snapshot(1), { post: post as never }),
    ).toMatchObject({ status: "rejected", reasonCode: "snapshot_mismatch" });
  });

  it("treats an incomplete finalisation as retryable under the same key", async () => {
    const { post } = scripted([
      begun(),
      chunked(),
      finalized({ result: "incomplete", reasonCode: "incomplete_upload" }),
    ]);
    const outcome = await uploadGuestMerge(db, USER, snapshot(2), {
      post: post as never,
    });
    expect(outcome).toMatchObject({
      status: "interrupted",
      retryable: true,
      reasonCode: "incomplete_upload",
    });
  });

  it("does not mark the import completed — local finalisation owns that", async () => {
    // §20: the database must never claim a completed merge while the ownership
    // conversion has not run. A reload here must resume into finalisation, not
    // into a merge that looks done.
    const { post } = scripted([begun(), chunked(), finalized()]);
    await uploadGuestMerge(db, USER, snapshot(2), { post: post as never });
    const record = await readGuestImport(db, USER);
    expect(record?.status).not.toBe("completed");
  });

  it("reports progress that never claims more chunks than the plan has", async () => {
    const seen: { chunksSent: number; chunksTotal: number }[] = [];
    const { post } = scripted([
      begun({ resumeFromChunk: 1, acceptedItems: 1000 }),
      chunked({ chunkIndex: 1, acceptedItems: 1400 }),
      finalized(),
    ]);
    await uploadGuestMerge(db, USER, snapshot(700), {
      post: post as never,
      onProgress: (p) => seen.push(p),
    });
    for (const p of seen) {
      expect(p.chunksSent).toBeLessThanOrEqual(p.chunksTotal);
    }
    expect(seen.at(-1)).toMatchObject({ chunksSent: 2, chunksTotal: 2 });
  });
});
