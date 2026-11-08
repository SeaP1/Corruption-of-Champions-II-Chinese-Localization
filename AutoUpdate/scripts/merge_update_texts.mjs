// Source-order migration for Prettier-formatted builds.
// 0.9.12 is treated as the manually verified authority for translation state.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  sha,
  key,
  read,
  write,
  list,
  text,
  stamp,
  byPosition,
  assertRanges,
} from "./migration_common.mjs";
import { alignExtractedRows } from "./sequence_inheritance.mjs";

const args = process.argv.slice(2);
const arg = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const oldRoot = path.resolve(arg("--old-root", "."));
const newRoot = path.resolve(arg("--new-root", process.cwd()));
const baseDir = path.resolve(arg("--old-dir", path.join(oldRoot, "translator/translated_json")));
const version = arg("--version", read(path.join(newRoot, "resources/app/package.json")).version);
const oldVersion = read(path.join(oldRoot, "resources/app/package.json")).version;
const inputTranslatorRoot = path.join(newRoot, "translator");
const translatorRoot = path.resolve(arg("--output-translator-root", inputTranslatorRoot));
const outputRoot = path.join(translatorRoot, "translated_json");

if (fs.existsSync(outputRoot) && list(outputRoot).length && !args.includes("--overwrite")) {
  throw new Error("translated_json already contains data; refusing overwrite");
}

const oldNames = list(baseDir);
const oldByKey = new Map(oldNames.map((name) => [key(name), name]));
const transferredFields = [
  "translation",
  "shouldTranslate",
  "translationStatus",
  "translationModel",
  "translationError",
  "rejectedTranslation",
  "disabledReason",
  "curatedReason",
  "state",
  "status",
  "translationCompleteness",
  "reviewRequired",
];

const unmatched = [];
const pending = [];
const ambiguous = [];
const stateConflicts = [];
const newEntries = [];
const files = [];
const seenModules = new Set();
let oldTranslated = 0;
let inheritedTranslations = 0;
let inheritedRows = 0;
let unresolvedSegments = 0;
let contextRefinements = 0;

function reportRow(row, file, rowIndex, reason) {
  return {
    file,
    rowIndex,
    recordId: row.recordId,
    id: row.id,
    line: row.line,
    start: row.start,
    end: row.end,
    category: row.category,
    shouldTranslate: row.shouldTranslate,
    original: row.original,
    translation: row.translation || "",
    reason,
  };
}

function cleanFreshRow(sourceRow) {
  const row = { ...sourceRow };
  for (const field of [
    "recordId",
    "introducedVersion",
    "lastSeenVersion",
    "previousId",
    "migrationMatch",
    "stateSource",
    "updateStatus",
    "heuristicStateConflict",
    "newHeuristicShouldTranslate",
    "needsStateReview",
    "stateSyncedFromTranslated",
  ]) delete row[field];
  row.translation = "";
  return row;
}

function compactContext(value) {
  return value.replace(/\s+/g, "");
}

function sourceContext(source, row) {
  return [
    compactContext(source.slice(Math.max(0, row.start - 96), row.start)),
    compactContext(source.slice(row.end, row.end + 96)),
  ];
}

function contextSimilarity(left, right) {
  let before = 0;
  let after = 0;
  while (
    before < Math.min(left[0].length, right[0].length) &&
    left[0].at(-1 - before) === right[0].at(-1 - before)
  ) before += 1;
  while (
    after < Math.min(left[1].length, right[1].length) &&
    left[1][after] === right[1][after]
  ) after += 1;
  return before + after;
}

for (const name of list(path.join(inputTranslatorRoot, "extracted_json"))) {
  const module = key(name);
  if (!/^(103|505|673|Content_.*)$/.test(module)) continue;
  seenModules.add(module);

  const freshDoc = read(path.join(inputTranslatorRoot, "extracted_json", name));
  const curatedInputPath = path.join(inputTranslatorRoot, "extracted_json_curated", name);
  const fresh = byPosition((fs.existsSync(curatedInputPath) ? read(curatedInputPath) : freshDoc).rows);
  const newFile = name.slice(0, -5);
  const newSource = fs.readFileSync(path.join(newRoot, "resources/app", newFile), "utf8");
  const oldName = oldByKey.get(module);
  const priorDoc = oldName ? read(path.join(baseDir, oldName)) : { rows: [] };
  const prior = byPosition(priorDoc.rows || []);
  const oldSource = oldName ? fs.readFileSync(path.join(oldRoot, "resources/app", oldName.slice(0, -5)), "utf8") : "";

  if (prior.some((row) => row.manualTextOverlay)) {
    throw new Error(`${oldName}: manualTextOverlay remains; consolidate fragments before migration`);
  }
  if (oldName) assertRanges(prior, oldSource, oldName);
  assertRanges(fresh, newSource, name);

  const oldContexts = prior.map((row) => sourceContext(oldSource, row));
  const newContexts = fresh.map((row) => sourceContext(newSource, row));
  const aligned = alignExtractedRows(prior, fresh, {
    // Source context is only a tie-breaker between otherwise equally good,
    // order-preserving exact-original alignments. It never creates a match.
    matchScore: (oldIndex, newIndex) => contextSimilarity(oldContexts[oldIndex], newContexts[newIndex]),
  });
  unresolvedSegments += aligned.unresolvedSegments.length;
  contextRefinements += aligned.contextRefinements || 0;
  const pairByNewIndex = new Map(aligned.pairs.map((pair) => [pair.newIndex, pair]));
  const rows = [];
  let fileInheritedTranslations = 0;
  let fileStateConflicts = 0;

  for (let newIndex = 0; newIndex < fresh.length; newIndex += 1) {
    const sourceRow = fresh[newIndex];
    const freshRow = cleanFreshRow(sourceRow);
    const pair = pairByNewIndex.get(newIndex);
    let row;
    if (pair) {
      const oldRow = prior[pair.oldIndex];
      const heuristicState = Boolean(sourceRow.shouldTranslate);
      row = freshRow;
      for (const field of transferredFields) {
        if (Object.hasOwn(oldRow, field)) row[field] = oldRow[field];
      }
      row.recordId = oldRow.recordId || stamp(oldRow, oldVersion, module, pair.oldIndex).recordId;
      row.introducedVersion = oldRow.introducedVersion || oldVersion;
      row.lastSeenVersion = version;
      row.previousId = oldRow.id;
      row.migrationMatch = pair.reason;
      row.stateSource = `inherited_${oldVersion}`;
      row.updateStatus = text(row) ? "inherited_translation" : "inherited_state";
      if (!row.shouldTranslate) row.translation = "";
      if (heuristicState !== Boolean(row.shouldTranslate)) {
        row.heuristicStateConflict = true;
        row.newHeuristicShouldTranslate = heuristicState;
        fileStateConflicts += 1;
        stateConflicts.push({
          file: name,
          recordId: row.recordId,
          id: row.id,
          line: row.line,
          original: row.original,
          oldShouldTranslate: Boolean(oldRow.shouldTranslate),
          newHeuristicShouldTranslate: heuristicState,
          resolution: `inherited_${oldVersion}`,
          migrationMatch: pair.reason,
        });
      }
      inheritedRows += 1;
      if (text(row)) {
        inheritedTranslations += 1;
        fileInheritedTranslations += 1;
      }
    } else {
      row = stamp({
        ...freshRow,
        translation: "",
        updateStatus: "new_in_version",
        stateSource: "new_extractor_heuristic",
        needsStateReview: true,
      }, version, module, newIndex);
      if (!row.shouldTranslate) row.translation = "";
      newEntries.push(reportRow(row, name, newIndex, "new_or_changed_source"));
    }
    rows.push(row);
  }

  const oldIndexByRow = new Map(prior.map((row, index) => [row, index]));
  for (let oldIndex = 0; oldIndex < prior.length; oldIndex += 1) {
    const oldRow = prior[oldIndex];
    if (text(oldRow)) oldTranslated += 1;
    if (aligned.oldUsed.has(oldIndex)) continue;
    const candidates = fresh
      .map((row, index) => ({ row, index }))
      .filter(({ row }) => row.original === oldRow.original);
    const reason = candidates.length ? "sequence_ambiguous_or_occurrence_removed" : "original_changed_or_removed";
    const entry = reportRow(oldRow, oldName, oldIndexByRow.get(oldRow), reason);
    unmatched.push(entry);
    if (candidates.length) {
      ambiguous.push({
        ...entry,
        newCandidates: candidates.slice(0, 20).map(({ row, index }) => ({
          rowIndex: index,
          id: row.id,
          start: row.start,
          end: row.end,
          line: row.line,
          category: row.category,
          shouldTranslate: row.shouldTranslate,
        })),
      });
    }
  }

  assertRanges(rows, newSource, name);
  const recordIds = rows.map((row) => row.recordId);
  if (new Set(recordIds).size !== recordIds.length) throw new Error(`duplicate recordId ${name}`);
  for (let i = 1; i < rows.length; i += 1) {
    if (rows[i - 1].start > rows[i].start) throw new Error(`source order changed ${name}`);
  }

  const final = {
    ...freshDoc,
    schemaVersion: 4,
    sourceFormat: "prettier-multiline",
    version,
    rowOrder: "new_source_order",
    sourceSha1: sha(newSource),
    total: rows.length,
    shouldTranslate: rows.filter((row) => row.shouldTranslate).length,
    rows,
  };
  write(path.join(outputRoot, name), final);
  write(path.join(translatorRoot, "position_index", name), {
    sourceSha1: final.sourceSha1,
    rows: rows.map((row) => ({ recordId: row.recordId, start: row.start, end: row.end })),
  });

  const byId = new Map(rows.map((row) => [row.id, row]));
  const syncedRows = freshDoc.rows.map((sourceRow) => {
    const row = byId.get(sourceRow.id);
    if (!row) return sourceRow;
    return {
      ...sourceRow,
      recordId: row.recordId,
      introducedVersion: row.introducedVersion,
      lastSeenVersion: version,
      shouldTranslate: row.shouldTranslate,
      stateSource: row.stateSource,
      translation: "",
    };
  });
  const synced = { ...freshDoc, version, rows: syncedRows };
  write(path.join(translatorRoot, "extracted_json", name), synced);
  if (fs.existsSync(curatedInputPath)) {
    const curatedDoc = read(curatedInputPath);
    write(path.join(translatorRoot, "extracted_json_curated", name), { ...curatedDoc, version, rows: syncedRows });
  }

  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex];
    if (row.shouldTranslate && !text(row)) {
      pending.push(reportRow(row, name, rowIndex, row.updateStatus === "new_in_version" ? "new_or_changed_source" : "old_untranslated"));
    }
  }

  const fileSummary = {
    file: name,
    oldRows: prior.length,
    newExtractedRows: fresh.length,
    inheritedRows: aligned.pairs.length,
    inheritedTranslations: fileInheritedTranslations,
    oldUnmatched: prior.length - aligned.oldUsed.size,
    appendedRows: fresh.length - aligned.newUsed.size,
    pendingTrue: rows.filter((row) => row.shouldTranslate && !text(row)).length,
    stateConflicts: fileStateConflicts,
    categoryChanges: aligned.pairs.filter((pair) => prior[pair.oldIndex].category !== fresh[pair.newIndex].category).length,
    unresolvedSegments: aligned.unresolvedSegments.length,
    contextRefinements: aligned.contextRefinements || 0,
    nonlinearOrder: false,
    activeFragments: 0,
  };
  files.push(fileSummary);
  console.log(`${module}: inherited=${fileSummary.inheritedRows}, new=${fileSummary.appendedRows}, old-unmatched=${fileSummary.oldUnmatched}`);
}

for (const oldName of oldNames) {
  if (seenModules.has(key(oldName))) continue;
  const rows = read(path.join(baseDir, oldName)).rows || [];
  rows.forEach((row, index) => {
    if (text(row)) oldTranslated += 1;
    unmatched.push(reportRow(row, oldName, index, "module_missing_in_new_version"));
  });
}

const totals = {
  files: files.length,
  oldTranslated,
  inheritedTranslations,
  inheritedRows,
  legacyFragmentsRetained: 0,
  oldUnmatched: unmatched.length,
  oldTranslatedUnmatched: unmatched.filter((row) => text(row)).length,
  newTrueUntranslated: pending.length,
  newAppended: files.reduce((sum, file) => sum + file.appendedRows, 0),
  ambiguousRecords: ambiguous.length,
  stateConflicts: stateConflicts.length,
  unresolvedSegments,
  contextRefinements,
  falseWithTranslation: 0,
};

write(path.join(translatorRoot, "reports/migration_summary.json"), {
  oldVersion,
  newVersion: version,
  generatedAt: new Date().toISOString(),
  inheritanceAuthority: oldVersion,
  matchingMode: "conservative_sequence_alignment_with_unique_context_recovery",
  totals,
  files,
});
write(path.join(translatorRoot, "reports/old_unmatched.json"), { rows: unmatched });
write(path.join(translatorRoot, "reports/matching_ambiguities.json"), { rows: ambiguous });
write(path.join(translatorRoot, "reports/new_true_untranslated.json"), { rows: pending });
write(path.join(translatorRoot, "reports/new_records.json"), { rows: newEntries });
write(path.join(translatorRoot, "reports/state_conflicts.json"), { rows: stateConflicts });

console.log(JSON.stringify({ files: files.length, ...totals }, null, 2));

