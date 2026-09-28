/**
 * Engine randomness is supplied by the caller so a match can replay the same
 * inputs after a retry or server restart.
 */
export interface RandomSource {
  /** Return one finite value in the half-open interval [0, 1). */
  nextFloat(): number;
}

/** Return a Fisher–Yates shuffled copy without changing the input array. */
export function shuffle<T>(items: readonly T[], random: RandomSource): T[] {
  const result = [...items];

  for (let index = result.length - 1; index > 0; index -= 1) {
    const sample = random.nextFloat();
    if (!Number.isFinite(sample) || sample < 0 || sample >= 1) {
      throw new RangeError("RandomSource.nextFloat() must return a finite value in [0, 1).");
    }

    const swapIndex = Math.floor(sample * (index + 1));
    [result[index], result[swapIndex]] = [result[swapIndex]!, result[index]!];
  }

  return result;
}
