import { TempestStroke } from 'ayvajs';

/**
 * By default every stroke in the built-in TempestStroke library keeps the Twist
 * axis (R0) centered at 0.5, so it never actually twists. This module duplicates
 * each built-in stroke into a "<name>-twist" variant where R0 sweeps its full
 * range. The variants are registered into the TempestStroke library, so they
 * show up next to the originals in the Strokes panel and behave like built-ins.
 */

const TWIST_SUFFIX = '-twist';

const TWIST_PARAMETERS = {
  from: 0,
  to: 1,
  phase: 0,
  ecc: 0,
};

export function createTwistVariant (stroke) {
  return {
    ...stroke,
    R0: { ...TWIST_PARAMETERS },
  };
}

export function registerTwistVariants () {
  // Snapshot the keys first so registering new strokes does not affect the loop.
  const names = Object.keys(TempestStroke.library);

  names.forEach((name) => {
    if (name.endsWith(TWIST_SUFFIX)) {
      return;
    }

    const variantName = `${name}${TWIST_SUFFIX}`;

    // Never overwrite an existing stroke (built-in or user created).
    if (TempestStroke.library[variantName]) {
      return;
    }

    TempestStroke.update(variantName, createTwistVariant(TempestStroke.library[name]));
  });
}

registerTwistVariants();
