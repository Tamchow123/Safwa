/**
 * UUIDv7 generation for client-produced identifiers (attempt + review-event
 * ids). DATA_MODEL.md §6 requires review-event ids to be client-generated
 * UUIDv7 so their embedded millisecond timestamp gives a natural, sortable
 * order and stays compatible with the server ingestion contract (the scheduler
 * deliberately delegates id minting to this impure boundary). `crypto.randomUUID`
 * only produces v4, so it must not be used for these ids.
 *
 * Layout (RFC 9562 §5.7): 48-bit big-endian Unix-ms timestamp, 4-bit version
 * (0111), 12 random bits, 2-bit variant (10), 62 random bits.
 */
const HEX: string[] = Array.from({ length: 256 }, (_, byte) =>
  byte.toString(16).padStart(2, "0"),
);

function formatUuid(bytes: Uint8Array): string {
  const h = (index: number) => HEX[bytes[index]];
  return (
    `${h(0)}${h(1)}${h(2)}${h(3)}-${h(4)}${h(5)}-${h(6)}${h(7)}-` +
    `${h(8)}${h(9)}-${h(10)}${h(11)}${h(12)}${h(13)}${h(14)}${h(15)}`
  );
}

/** Generate a UUIDv7 string (lowercase, hyphenated). */
export function uuidv7(nowMs: number = Date.now()): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);

  const timestamp = Math.max(0, Math.floor(nowMs));
  bytes[0] = Math.floor(timestamp / 2 ** 40) & 0xff;
  bytes[1] = Math.floor(timestamp / 2 ** 32) & 0xff;
  bytes[2] = Math.floor(timestamp / 2 ** 24) & 0xff;
  bytes[3] = Math.floor(timestamp / 2 ** 16) & 0xff;
  bytes[4] = Math.floor(timestamp / 2 ** 8) & 0xff;
  bytes[5] = timestamp & 0xff;

  // Version 7 in the high nibble of byte 6; variant 10 in the high bits of byte 8.
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  return formatUuid(bytes);
}

/** The UUID version digit (position 14), for validation/tests. */
export function uuidVersion(uuid: string): number {
  return Number.parseInt(uuid[14], 16);
}
