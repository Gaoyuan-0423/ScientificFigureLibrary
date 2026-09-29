import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { OperationRegistry } from "../src/service/operations.ts";
import { definePublishOperations } from "../src/publish-tools.ts";
import { VersionedTemplateLibrary } from "../src/versioned-library.ts";
import { ensureLibraryRootMarker } from "../src/library-runtime.ts";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
function registry(library: VersionedTemplateLibrary, now?: () => number) {
  const operations = new OperationRegistry();
  definePublishOperations({ operations, currentLibrary: async () => library, now });
  return operations;
}
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sfl-unified-publish-"));
  const libraryRoot = path.join(root, "library");
  await ensureLibraryRootMarker(libraryRoot);
  const library = new VersionedTemplateLibrary(libraryRoot);
  const source = path.join(root, "source.png"), render = path.join(root, "render.png"), code = path.join(root, "plot.R"), evidence = path.join(root, "run.txt");
  await Promise.all([fs.writeFile(source, PNG), fs.writeFile(render, PNG), fs.writeFile(code, "plot(1:3)\n"), fs.writeFile(evidence, "Synthetic test fixture execution record\n")]);
  const candidate = {
    mode: "create", templateId: "synthetic-example", title: "组合图模板", titleEn: "Combined Plot Template",
    description: "Compare groups with a reusable plotting layout.", scientificQuestion: "How do patterns differ across groups?",
    application: "Compare grouped observations.", dataProfile: "A group/value table.",
    assetKind: "plot_template", language: "R", codeStatus: "scaffold", executionStatus: "passed",
    visualAssets: [{ assetId: "source", sourcePath: source, visualRole: "source_reference" }, { assetId: "render", sourcePath: render, visualRole: "rendered_output" }],
    codeAssets: [{ assetId: "plot", sourcePath: code, language: "R", codeOrigin: "agent_generated" }],
    evidenceAssets: [{ assetId: "run", sourcePath: evidence }], primaryVisualAssetId: "render",
    primaryPreviewOverride: { reason: "Use the generated example as the template preview." }, canonicalCodeAssetId: "plot",
    figureCodeLinks: [{ visualAssetId: "render", codeAssetIds: ["plot"], relationship: "generated_output", evidence: "Fixture code generated the selected output." }],
    validationState: { schema: "figure-library.validation-state.v1", plotExecution: { status: "passed", scope: "synthetic_data", evidenceAssetIds: ["run"] },
      upstreamWorkflow: { status: "not_run" }, scientificValidation: { status: "not_assessed" } },
    assessment: { warnings: [{ code: "synthetic_values", message: "Example input values are synthetic." }] },
  };
  return { root, library, candidate, code, ops: registry(library) };
}
function data(value: Awaited<ReturnType<OperationRegistry["execute"]>>): any { return value.structuredContent; }

test("one local confirmation: bilingual proposal is read-only, source is unpaired, scaffold can execute, replay survives restart", async () => {
  const f = await fixture();
  try {
    const planned = await f.ops.execute("figure_library_plan_publish", { candidate: f.candidate });
    const p = data(planned);
    assert.equal(p.envelope.code, "publish_plan_ready", JSON.stringify(p));
    assert.equal(p.plan.target, "local"); assert.equal(p.plan.approval, "pending");
    assert.equal(p.plan.titleEn, "Combined Plot Template");
    assert.equal(await f.library.getSeries(f.candidate.templateId), undefined);
    await assert.rejects(fs.access(path.join(f.library.operationsDirectory, "unified-publications")));
    assert.deepEqual(p.technical.review.blockingGates, []);
    assert.equal(p.technical.validationState.plotExecution.scope, "synthetic_data");
    assert.ok(planned.content.some(b => b.type === "image"));
    const text = planned.content.filter(b => b.type === "text").map(b => b.text).join("\n");
    assert.doesNotMatch(text, /synthetic_values|upstream_not_run|not_assessed/);
    const apply = { planDigest: p.plan.planDigest, operationId: "single-confirmation" };
    assert.equal(data(await f.ops.execute("figure_library_apply_publish", apply)).envelope.outcome, "applied");
    const published = (await f.library.listPublishedCandidates())[0]!;
    assert.equal(published.titleEn, "Combined Plot Template");
    assert.equal(published.codeStatus, "scaffold");
    assert.equal(published.executionStatus, "passed");
    assert.equal(data(await registry(f.library).execute("figure_library_apply_publish", apply)).envelope.outcome, "replayed");
    assert.equal((await f.library.history(f.candidate.templateId)).releases.length, 1);
  } finally { await fs.rm(f.root, { recursive: true, force: true }); }
});

test("visual inference plus generated output records passed execution without claiming original analysis", async () => {
  const f = await fixture();
  try {
    f.candidate.figureCodeLinks.push({ visualAssetId: "source", codeAssetIds: ["plot"], relationship: "visual_inference", evidence: "Reference layout inspired the independently generated renderer." });
    const p = data(await f.ops.execute("figure_library_plan_publish", { candidate: f.candidate }));
    assert.equal(p.envelope.code, "publish_plan_ready", JSON.stringify(p));
    assert.equal(data(await f.ops.execute("figure_library_apply_publish", { planDigest: p.plan.planDigest, operationId: "inferred" })).envelope.outcome, "applied");
    assert.equal((await f.library.listPublishedCandidates())[0]!.validationState.upstreamWorkflow.status, "not_run");
  } finally { await fs.rm(f.root, { recursive: true, force: true }); }
});

test("missing evidence, rendered output pairing and runtime inputs still block", async () => {
  const f = await fixture();
  try {
    const noEvidence = { ...f.candidate, evidenceAssets: [] };
    assert.equal(data(await f.ops.execute("figure_library_plan_publish", { candidate: noEvidence })).envelope.outcome, "blocked");
    const unpaired = { ...f.candidate, figureCodeLinks: [{ ...f.candidate.figureCodeLinks[0], relationship: "user_supplied_pair" }] };
    assert.equal(data(await f.ops.execute("figure_library_plan_publish", { candidate: unpaired })).envelope.outcome, "blocked");
    const orphan = { ...f.candidate, visualAssets: [...f.candidate.visualAssets, { ...f.candidate.visualAssets[1], assetId: "unpaired-output" }] };
    const rejected = data(await f.ops.execute("figure_library_plan_publish", { candidate: orphan }));
    assert.equal(rejected.envelope.outcome, "blocked");
    assert.match(rejected.envelope.summary, /rendered_output_relationship_required/);
    await fs.writeFile(f.code, "read.csv('missing.csv')\n");
    const missingInput = data(await f.ops.execute("figure_library_plan_publish", { candidate: f.candidate }));
    assert.equal(missingInput.envelope.outcome, "blocked");
    assert.match(missingInput.envelope.summary, /runtime/);
    assert.equal(await f.library.getSeries(f.candidate.templateId), undefined);
  } finally { await fs.rm(f.root, { recursive: true, force: true }); }
});

test("changed source, expired plan, rebound library and reused operationId fail closed", async () => {
  const f = await fixture(), other = await fixture();
  try {
    let time = Date.now(); const ops = registry(f.library, () => time);
    const p = data(await ops.execute("figure_library_plan_publish", { candidate: f.candidate }));
    await fs.writeFile(f.code, "plot(4:8)\n");
    const a = { planDigest: p.plan.planDigest, operationId: "changed" };
    assert.equal(data(await ops.execute("figure_library_apply_publish", a)).envelope.outcome, "blocked");
    assert.equal(await f.library.getSeries(f.candidate.templateId), undefined);
    time += 31 * 60 * 1000;
    assert.match(data(await ops.execute("figure_library_apply_publish", a)).envelope.summary, /expired/);
    assert.equal(data(await registry(other.library).execute("figure_library_apply_publish", a)).envelope.outcome, "blocked");
    const q = data(await f.ops.execute("figure_library_plan_publish", { candidate: f.candidate }));
    assert.equal(data(await f.ops.execute("figure_library_apply_publish", { planDigest: q.plan.planDigest, operationId: "bound" })).envelope.outcome, "applied");
    assert.equal(data(await f.ops.execute("figure_library_apply_publish", { planDigest: p.plan.planDigest, operationId: "bound" })).envelope.outcome, "blocked");
  } finally { await fs.rm(f.root, { recursive: true, force: true }); await fs.rm(other.root, { recursive: true, force: true }); }
});

test("resume after a local publish failure does not recreate Working or a Release", async () => {
  const f = await fixture();
  try {
    const p = data(await f.ops.execute("figure_library_plan_publish", { candidate: f.candidate }));
    const applyPublish = f.library.applyPublish.bind(f.library);
    f.library.applyPublish = async () => { throw new Error("fixture temporary failure"); };
    const request = { planDigest: p.plan.planDigest, operationId: "resume-local" };
    const blocked = data(await f.ops.execute("figure_library_apply_publish", request));
    assert.equal(blocked.completedStage, "working");
    const before = (await f.library.getSeries(f.candidate.templateId))!.workingHead!.revisionId;
    f.library.applyPublish = applyPublish;
    assert.equal(data(await registry(f.library).execute("figure_library_apply_publish", request)).envelope.outcome, "applied");
    const after = await f.library.history(f.candidate.templateId);
    assert.equal(after.revisions.length, 1); assert.equal(after.releases.length, 1);
    assert.equal(after.releases[0]!.revisionId, before);
  } finally { await fs.rm(f.root, { recursive: true, force: true }); }
});

test("exact Working digest is required, create cannot silently update, updates preserve the old release", async () => {
  const f = await fixture();
  try {
    const p = data(await f.ops.execute("figure_library_plan_publish", { candidate: f.candidate }));
    await f.ops.execute("figure_library_apply_publish", { planDigest: p.plan.planDigest, operationId: "first" });
    const old = (await f.library.history(f.candidate.templateId)).releases[0]!;
    assert.equal(data(await f.ops.execute("figure_library_plan_publish", { candidate: f.candidate })).envelope.outcome, "blocked");
    const q = data(await f.ops.execute("figure_library_plan_publish", { candidate: { ...f.candidate, mode: "update", titleEn: "Updated Combined Plot" } }));
    assert.equal(q.envelope.code, "publish_plan_ready");
    await f.ops.execute("figure_library_apply_publish", { planDigest: q.plan.planDigest, operationId: "second" });
    assert.equal((await f.library.history(f.candidate.templateId)).releases.length, 2);
    assert.deepEqual(await f.library.getRelease(f.candidate.templateId, old.releaseId), old);
  } finally { await fs.rm(f.root, { recursive: true, force: true }); }
});


test("tampered completed publication journals cannot report invented success", async () => {
  const f = await fixture();
  try {
    const p = data(await f.ops.execute("figure_library_plan_publish", { candidate: f.candidate }));
    const request = { planDigest: p.plan.planDigest, operationId: "tamper-result" };
    await f.ops.execute("figure_library_apply_publish", request);
    const directory = path.join(f.library.operationsDirectory, "unified-publications");
    const file = path.join(directory, (await fs.readdir(directory)).find(n => n.endsWith(".json"))!);
    const journal = JSON.parse(await fs.readFile(file, "utf8"));
    journal.result.release.releaseId = "invented-release";
    await fs.writeFile(file, JSON.stringify(journal));
    const replay = data(await registry(f.library).execute("figure_library_apply_publish", request));
    assert.equal(replay.envelope.outcome, "blocked");
    assert.match(replay.envelope.summary, /journal.*immutable local Release/);
    assert.equal((await f.library.history(f.candidate.templateId)).releases.length, 1);
  } finally { await fs.rm(f.root, { recursive: true, force: true }); }
});


test("first publication initializes an explicitly selected empty Library only on Apply and replays in a fresh runtime", async () => {
  const f = await fixture();
  try {
    const root = path.join(f.root, "empty-library"); const library = new VersionedTemplateLibrary(root);
    const ops = registry(library);
    const p = data(await ops.execute("figure_library_plan_publish", { candidate: f.candidate }));
    assert.equal(p.envelope.code, "publish_plan_ready", JSON.stringify(p));
    await assert.rejects(fs.access(path.join(root, "library.json")));
    const args = { planDigest: p.plan.planDigest, operationId: "first-in-empty" };
    const applied = data(await ops.execute("figure_library_apply_publish", args));
    assert.equal(applied.envelope.code, "publish_completed", JSON.stringify(applied));
    const replay = data(await registry(new VersionedTemplateLibrary(root)).execute("figure_library_apply_publish", args));
    assert.equal(replay.envelope.code, "publish_replayed", JSON.stringify(replay));
  } finally { await fs.rm(f.root, { recursive: true, force: true }); }
});
