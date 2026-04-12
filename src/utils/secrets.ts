import crypto from "node:crypto";

function toBuffer(value: string): Buffer {
  return Buffer.from(value, "utf8");
}

export function matchesAnySecret(candidate: string | null | undefined, secrets: string[]): boolean {
  if (!candidate) {
    return false;
  }

  const candidateBuffer = toBuffer(candidate);
  return secrets.some((secret) => {
    const secretBuffer = toBuffer(secret);
    return (
      candidateBuffer.length === secretBuffer.length &&
      crypto.timingSafeEqual(candidateBuffer, secretBuffer)
    );
  });
}
