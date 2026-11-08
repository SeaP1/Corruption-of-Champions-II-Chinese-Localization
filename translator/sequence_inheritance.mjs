// Conservative, order-preserving alignment for extracted string records.
// Identity is determined only from exact original text and sequence context.
// Translation state is deliberately not consulted here.

function occurrenceCounts(rows, lo, hi) {
  const counts = new Map();
  for (let i = lo; i < hi; i += 1) {
    const key = rows[i].original;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

function longestIncreasingSubsequence(candidates) {
  if (!candidates.length) return [];
  const tails = [];
  const tailsAt = [];
  const previous = new Int32Array(candidates.length).fill(-1);
  for (let i = 0; i < candidates.length; i += 1) {
    const value = candidates[i].newIndex;
    let lo = 0, hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (tails[mid] < value) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) previous[i] = tailsAt[lo - 1];
    tails[lo] = value;
    tailsAt[lo] = i;
  }
  const result = [];
  let at = tailsAt[tails.length - 1];
  while (at >= 0) {
    result.push(candidates[at]);
    at = previous[at];
  }
  return result.reverse();
}

function refineDuplicatePairsByContext(oldRows, newRows, pairs, matchScore) {
  if (!matchScore) return 0;
  const oldGroups = new Map();
  const newGroups = new Map();
  const groupKey = (row) => JSON.stringify([row.original, row.category]);
  for (let i = 0; i < oldRows.length; i += 1) {
    const key = groupKey(oldRows[i]);
    if (!oldGroups.has(key)) oldGroups.set(key, []);
    oldGroups.get(key).push(i);
  }
  for (let i = 0; i < newRows.length; i += 1) {
    const key = groupKey(newRows[i]);
    if (!newGroups.has(key)) newGroups.set(key, []);
    newGroups.get(key).push(i);
  }
  const pairByNew = new Map(pairs.map((pair) => [pair.newIndex, pair]));
  const pairByOld = new Map(pairs.map((pair) => [pair.oldIndex, pair]));
  let refinements = 0;

  for (const [key, oldIndexes] of oldGroups) {
    const newIndexes = newGroups.get(key) || [];
    if (!oldIndexes.length || !newIndexes.length || Math.max(oldIndexes.length, newIndexes.length) <= 1 || Math.max(oldIndexes.length, newIndexes.length) > 200) continue;
    const oldIndexSet = new Set(oldIndexes);
    const groupPairs = newIndexes.map((newIndex) => pairByNew.get(newIndex)).filter((pair) => pair && oldIndexSet.has(pair.oldIndex));
    // Context can refine an existing sequence assignment or recover an
    // otherwise unresolved duplicate, but only through a mutual, high-margin
    // source-context match of an exactly equal literal.

    const forced = new Map();
    for (const newIndex of newIndexes) {
      const rankedOld = oldIndexes
        .map((oldIndex) => ({ oldIndex, score: matchScore(oldIndex, newIndex) }))
        .sort((a, b) => b.score - a.score);
      if (rankedOld[0].score < 24 || (rankedOld[1] && rankedOld[0].score - rankedOld[1].score < 8)) continue;
      const oldIndex = rankedOld[0].oldIndex;
      const rankedNew = newIndexes
        .map((candidateNew) => ({ newIndex: candidateNew, score: matchScore(oldIndex, candidateNew) }))
        .sort((a, b) => b.score - a.score);
      if (rankedNew[0].newIndex !== newIndex) continue;
      if (rankedNew[1] && rankedNew[0].score - rankedNew[1].score < 8) continue;
      forced.set(newIndex, oldIndex);
    }
    const groupPairSet = new Set(groupPairs);
    for (const [newIndex, oldIndex] of [...forced]) {
      const existing = pairByOld.get(oldIndex);
      if (existing && !groupPairSet.has(existing)) forced.delete(newIndex);
    }
    if (!forced.size) continue;

    const forcedOld = new Set(forced.values());
    const targetPairCount = Math.max(groupPairs.length, forced.size);
    const assignments = new Map(forced);
    const assignedOld = new Set(forcedOld);
    // Preserve every non-conflicting sequence assignment first.
    for (const pair of groupPairs.sort((a, b) => a.newIndex - b.newIndex)) {
      if (assignments.size >= targetPairCount) break;
      if (assignments.has(pair.newIndex) || assignedOld.has(pair.oldIndex)) continue;
      assignments.set(pair.newIndex, pair.oldIndex);
      assignedOld.add(pair.oldIndex);
    }
    // If a forced assignment displaced another occurrence, fill the remaining
    // slots deterministically in source order.
    const remainingOld = oldIndexes.filter((index) => !assignedOld.has(index)).sort((a, b) => a - b);
    const remainingNew = newIndexes.filter((index) => !assignments.has(index)).sort((a, b) => a - b);
    while (assignments.size < targetPairCount) {
      const oldIndex = remainingOld.shift();
      const newIndex = remainingNew.shift();
      if (oldIndex === undefined || newIndex === undefined) break;
      assignments.set(newIndex, oldIndex);
      assignedOld.add(oldIndex);
    }
    if (assignments.size !== targetPairCount) continue;
    const changed = groupPairs.some((pair) => assignments.get(pair.newIndex) !== pair.oldIndex) ||
      [...forced].some(([newIndex, oldIndex]) => pairByNew.get(newIndex)?.oldIndex !== oldIndex);
    if (!changed) continue;
    for (let i = pairs.length - 1; i >= 0; i -= 1) {
      if (groupPairSet.has(pairs[i])) {
        pairByNew.delete(pairs[i].newIndex);
        pairByOld.delete(pairs[i].oldIndex);
        pairs.splice(i, 1);
      }
    }
    for (const [newIndex, oldIndex] of assignments) {
      const previous = pairByNew.get(newIndex);
      const pair = {
        oldIndex,
        newIndex,
        reason: forced.has(newIndex)
          ? "strong_mutual_source_context"
          : (previous?.oldIndex === oldIndex ? previous.reason : "duplicate_sequence_after_context"),
      };
      pairs.push(pair);
      pairByNew.set(newIndex, pair);
      pairByOld.set(oldIndex, pair);
    }
    refinements += 1;
  }
  return refinements;
}

function localLcs(oldRows, newRows, oldLo, oldHi, newLo, newHi, allowedKeys, matchScore) {
  const oldLength = oldHi - oldLo;
  const newLength = newHi - newLo;
  const width = newLength + 1;
  const cells = (oldLength + 1) * width;
  // Local dynamic programming is intentionally bounded. Large repetitive
  // regions remain unmatched instead of being guessed.
  if (cells > 1_000_000) return [];
  // One additional exact match must always outweigh every possible tie-break
  // accumulated by a shorter alignment. Context/category only decide between
  // alignments with the same number of exact-original matches.
  const base = (Math.min(oldLength, newLength) + 1) * 2048;
  const table = new Uint32Array(cells);
  const get = (i, j) => table[i * width + j];
  for (let i = oldLength - 1; i >= 0; i -= 1) {
    for (let j = newLength - 1; j >= 0; j -= 1) {
      const oldRow = oldRows[oldLo + i];
      const newRow = newRows[newLo + j];
      const down = get(i + 1, j);
      const right = get(i, j + 1);
      let best = Math.max(down, right);
      if (oldRow.original === newRow.original && allowedKeys.has(oldRow.original)) {
        const categoryBonus = oldRow.category === newRow.category ? 1024 : 0;
        const contextBonus = Math.min(1023, Math.max(0, matchScore?.(oldLo + i, newLo + j) || 0));
        best = Math.max(best, get(i + 1, j + 1) + base + categoryBonus + contextBonus);
      }
      table[i * width + j] = best;
    }
  }
  const pairs = [];
  let i = 0, j = 0;
  while (i < oldLength && j < newLength) {
    const oldRow = oldRows[oldLo + i];
    const newRow = newRows[newLo + j];
    const categoryBonus = oldRow.category === newRow.category ? 1024 : 0;
    const contextBonus = Math.min(1023, Math.max(0, matchScore?.(oldLo + i, newLo + j) || 0));
    const diagonal = oldRow.original === newRow.original && allowedKeys.has(oldRow.original)
      ? get(i + 1, j + 1) + base + categoryBonus + contextBonus
      : -1;
    if (diagonal >= 0 && get(i, j) === diagonal) {
      pairs.push({ oldIndex: oldLo + i, newIndex: newLo + j, reason: "local_sequence_lcs" });
      i += 1;
      j += 1;
    } else if (get(i + 1, j) >= get(i, j + 1)) {
      i += 1;
    } else {
      j += 1;
    }
  }
  return pairs;
}

export function alignExtractedRows(oldRows, newRows, options = {}) {
  const matchScore = options.matchScore;
  const rawPairs = [];
  const unresolvedSegments = [];

  function alignSegment(oldLo, oldHi, newLo, newHi, depth = 0) {
    if (oldLo >= oldHi || newLo >= newHi) return;
    const oldCounts = occurrenceCounts(oldRows, oldLo, oldHi);
    const newCounts = occurrenceCounts(newRows, newLo, newHi);

    // Equal-count edge runs are safe within the current pair of anchors.
    while (
      oldLo < oldHi && newLo < newHi &&
      oldRows[oldLo].original === newRows[newLo].original &&
      oldCounts.get(oldRows[oldLo].original) === newCounts.get(newRows[newLo].original)
    ) {
      rawPairs.push({ oldIndex: oldLo, newIndex: newLo, reason: "anchored_common_prefix" });
      oldLo += 1;
      newLo += 1;
    }
    const suffix = [];
    while (
      oldLo < oldHi && newLo < newHi &&
      oldRows[oldHi - 1].original === newRows[newHi - 1].original &&
      oldCounts.get(oldRows[oldHi - 1].original) === newCounts.get(newRows[newHi - 1].original)
    ) {
      oldHi -= 1;
      newHi -= 1;
      suffix.push({ oldIndex: oldHi, newIndex: newHi, reason: "anchored_common_suffix" });
    }
    if (oldLo >= oldHi || newLo >= newHi) {
      rawPairs.push(...suffix.reverse());
      return;
    }

    const oldPositions = new Map();
    const newPositions = new Map();
    for (let i = oldLo; i < oldHi; i += 1) {
      const key = oldRows[i].original;
      if (!oldPositions.has(key)) oldPositions.set(key, []);
      oldPositions.get(key).push(i);
    }
    for (let i = newLo; i < newHi; i += 1) {
      const key = newRows[i].original;
      if (!newPositions.has(key)) newPositions.set(key, []);
      newPositions.get(key).push(i);
    }

    const candidates = [];
    for (const [key, oldIndexes] of oldPositions) {
      const newIndexes = newPositions.get(key) || [];
      if (oldIndexes.length === 1 && newIndexes.length === 1) {
        candidates.push({ oldIndex: oldIndexes[0], newIndex: newIndexes[0], reason: "patience_unique_anchor" });
      }
    }
    candidates.sort((a, b) => a.oldIndex - b.oldIndex || a.newIndex - b.newIndex);
    const anchors = longestIncreasingSubsequence(candidates);
    if (anchors.length) {
      let previousOld = oldLo;
      let previousNew = newLo;
      for (const anchor of anchors) {
        alignSegment(previousOld, anchor.oldIndex, previousNew, anchor.newIndex, depth + 1);
        rawPairs.push(anchor);
        previousOld = anchor.oldIndex + 1;
        previousNew = anchor.newIndex + 1;
      }
      alignSegment(previousOld, oldHi, previousNew, newHi, depth + 1);
      rawPairs.push(...suffix.reverse());
      return;
    }

    // Duplicates are eligible only when their counts agree inside this anchored
    // segment. Inserted/deleted identical literals are left unresolved.
    const allowedKeys = new Set(
      [...oldPositions.keys()].filter((key) => oldPositions.get(key).length === (newPositions.get(key) || []).length),
    );
    const localPairs = localLcs(oldRows, newRows, oldLo, oldHi, newLo, newHi, allowedKeys, matchScore);
    if (localPairs.length) rawPairs.push(...localPairs);
    if (!localPairs.length || localPairs.length < Math.min(oldHi - oldLo, newHi - newLo)) {
      unresolvedSegments.push({ oldLo, oldHi, newLo, newHi, depth, matched: localPairs.length });
    }
    rawPairs.push(...suffix.reverse());
  }

  alignSegment(0, oldRows.length, 0, newRows.length);
  rawPairs.sort((a, b) => a.oldIndex - b.oldIndex || a.newIndex - b.newIndex);

  const oldUsed = new Set();
  const newUsed = new Set();
  const pairs = [];
  let previousOld = -1, previousNew = -1;
  for (const pair of rawPairs) {
    if (oldUsed.has(pair.oldIndex) || newUsed.has(pair.newIndex)) continue;
    if (pair.oldIndex <= previousOld || pair.newIndex <= previousNew) continue;
    if (oldRows[pair.oldIndex].original !== newRows[pair.newIndex].original) continue;
    oldUsed.add(pair.oldIndex);
    newUsed.add(pair.newIndex);
    previousOld = pair.oldIndex;
    previousNew = pair.newIndex;
    pairs.push(pair);
  }

  // Exact duplicate literals can legitimately move as code blocks move. Once
  // sequence matching has established complete group membership, uniquely
  // strong source context may refine which old identity belongs to which new
  // occurrence. State/translation never participate in this decision.
  const contextRefinements = refineDuplicatePairsByContext(oldRows, newRows, pairs, matchScore);
  pairs.sort((a, b) => a.newIndex - b.newIndex || a.oldIndex - b.oldIndex);
  oldUsed.clear();
  newUsed.clear();
  for (const pair of pairs) {
    oldUsed.add(pair.oldIndex);
    newUsed.add(pair.newIndex);
  }

  return { pairs, oldUsed, newUsed, unresolvedSegments, contextRefinements };
}

