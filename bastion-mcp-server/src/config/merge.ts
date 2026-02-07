/**
 * Strategic merge for layered YAML/JSON configuration.
 *
 * Follows Kubernetes strategic merge patch semantics:
 *   - Scalars: overlay replaces base
 *   - Objects: recursive merge
 *   - Arrays of objects with a `name` field: merge by name
 *   - Scalar arrays: overlay replaces base entirely
 *   - null/undefined overlay values: base preserved
 */

/**
 * Deep-merge `overlay` onto `base`, returning a new object.
 * Neither input is mutated.
 */
export function strategicMerge(base: unknown, overlay: unknown): unknown {
  if (overlay === null || overlay === undefined) {
    return base;
  }

  if (base === null || base === undefined) {
    return overlay;
  }

  // Both are arrays
  if (Array.isArray(base) && Array.isArray(overlay)) {
    return mergeArrays(base, overlay);
  }

  // Both are plain objects
  if (isPlainObject(base) && isPlainObject(overlay)) {
    return mergeObjects(
      base as Record<string, unknown>,
      overlay as Record<string, unknown>
    );
  }

  // Scalar: overlay wins
  return overlay;
}

function mergeObjects(
  base: Record<string, unknown>,
  overlay: Record<string, unknown>
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base };

  for (const key of Object.keys(overlay)) {
    const overlayVal = overlay[key];
    if (overlayVal === null || overlayVal === undefined) {
      // null/undefined in overlay → keep base value
      continue;
    }
    if (key in base) {
      result[key] = strategicMerge(base[key], overlayVal);
    } else {
      result[key] = overlayVal;
    }
  }

  return result;
}

function mergeArrays(base: unknown[], overlay: unknown[]): unknown[] {
  // Check if both arrays contain objects with a `name` field (named resources)
  if (isNamedObjectArray(base) && isNamedObjectArray(overlay)) {
    return mergeNamedArrays(
      base as Array<Record<string, unknown>>,
      overlay as Array<Record<string, unknown>>
    );
  }

  // Scalar arrays: overlay replaces entirely
  return overlay;
}

function mergeNamedArrays(
  base: Array<Record<string, unknown>>,
  overlay: Array<Record<string, unknown>>
): Array<Record<string, unknown>> {
  const result = base.map((item) => ({ ...item }));

  for (const overlayItem of overlay) {
    const name = overlayItem.name;
    const existingIndex = result.findIndex((item) => item.name === name);

    if (existingIndex >= 0) {
      result[existingIndex] = strategicMerge(result[existingIndex], overlayItem) as Record<string, unknown>;
    } else {
      result.push(overlayItem);
    }
  }

  return result;
}

function isPlainObject(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNamedObjectArray(arr: unknown[]): boolean {
  if (arr.length === 0) return false;
  return arr.every(
    (item) => isPlainObject(item) && 'name' in (item as Record<string, unknown>)
  );
}
