import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { canonicalJson } from "./canonical-json.ts";
import { WorkingPlanInput, directCandidate, missingWorkingConfirmations } from "./lifecycle-tools.ts";
import { bytesForPreparedSource, templateSeriesDigest, type WorkingRevisionPlan, type PublishPlan,
  type GateUpdatePlan, type TemplateContentV1, type ReviewSnapshotV1, type VersionedTemplateLibrary } from "./versioned-library.ts";
import type { OpenFigurePublicationService, OpenFigurePrPlan } from "./open-figure-pr-tools.ts";
import type { LocalPublishedExactSelector } from "./types.ts";
import { OperationRegistry } from "./service/operations.ts";
import { assertMcpImageBytes } from "./image-validation.ts";
import { prepareTransportImage, singlePreviewBudget } from "./transport-image.ts";
import { ensureLibraryRootMarker, readLibraryRootMarker, type LibraryOperationContext } from "./library-runtime.ts";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const ID = /^(?!\.{1,2}$)[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const HASH = /^[a-f0-9]{64}$/u;
const TTL = 30 * 60 * 1_000;
const Proposal = WorkingPlanInput.omit({ confirmations: true, figureCodeLinks: true, primaryPreviewOverride: true }).extend({
  mode: z.enum(["create", "update"]), templateId: z.string().regex(ID),
  title: z.string().trim().min(1).max(500), titleEn: z.string().trim().min(1).max(300),
  scientificQuestion: z.string().trim().min(1).max(2000),
  figureCodeLinks: z.array(WorkingPlanInput.shape.figureCodeLinks.unwrap().unwrap().element.omit({ confirmedBy: true })).max(100).default([]),
  primaryPreviewOverride: z.object({ reason: z.string().trim().min(1).max(4000) }).optional(),
});
const Input = z.object({
  target: z.enum(["local", "open_module"]).default("local"),
  candidate: Proposal.optional(),
  working: z.object({ templateId: z.string().regex(ID), revisionId: z.string().regex(ID),
    contentDigest: z.string().regex(HASH), reviewDigest: z.string().regex(HASH) }).optional(),
  gateDecisions: z.array(z.object({ gateId: z.string().min(1), decision: z.literal("resolved"), note: z.string().min(1).max(4000) })).max(100).default([]),
}).refine(v => Boolean(v.candidate) !== Boolean(v.working), "provide exactly one candidate or exact working identity");
const Apply = z.object({ planDigest: z.string().regex(HASH), operationId: z.string().regex(ID),
  acceptSimilarCandidates: z.boolean().optional() });

interface Prepared {
  schema: "figure-library.publish-plan.v1";
  root: string;
  libraryContext?: VersionedTemplateLibrary["runtimeContext"];
  directorySource: VersionedTemplateLibrary["directorySource"];
  configRevision: number | null;
  target: "local" | "open_module";
  content: TemplateContentV1;
  review: ReviewSnapshotV1;
  expectedSeriesDigest: string | null;
  workingPlan?: WorkingRevisionPlan;
  gatePlan?: GateUpdatePlan;
  openModule?: OpenFigurePrPlan;
  createdAt: string;
  planDigest: string;
}
interface Journal {
  schema: "figure-library.publish-operation.v1";
  operationId: string;
  prepared: Prepared;
  publishPlan?: PublishPlan;
  stage: "confirmed" | "working" | "local_published" | "complete";
  result?: Record<string, unknown>;
  openPlan?: OpenFigurePrPlan;
  initializedContext?: LibraryOperationContext;
}

function result(outcome: string, code: string, summary: string, nextAction: string, data: Record<string, unknown> = {}): CallToolResult {
  const envelope = { schema: "figure-library.tool-outcome.v1", outcome, code, summary, nextAction,
    terminal: true, retrySameCall: false };
  return { content: [{ type: "text", text: [`OUTCOME: ${outcome}`, "TERMINAL: true", "RETRY_SAME_CALL: false",
    `CODE: ${code}`, `NEXT_ACTION: ${nextAction}`, summary].join("\n") }], structuredContent: { envelope, ...data } };
}
function digest(plan: Prepared) { const { planDigest: _, ...body } = plan; return hash(canonicalJson(body)); }
function reviewCheck(review: ReviewSnapshotV1) {
  if (review.validationErrors.length) throw new Error(`validation errors: ${review.validationErrors.map(e => e.code).join(", ")}`);
  const gates = review.blockingGates.filter(g => g.status === "open");
  if (gates.length) throw new Error(`blocking review gates: ${gates.map(g => g.gateId).join(", ")}`);
}

async function verifyJournal(library: VersionedTemplateLibrary, journal: Journal) {
  if (journal.schema !== "figure-library.publish-operation.v1" || !["confirmed", "working", "local_published", "complete"].includes(journal.stage)) throw new Error("invalid publication operation journal");
  const planned = journal.publishPlan?.release;
  const { content, review } = journal.prepared;
  if (planned && (planned.templateId !== content.templateId || planned.revisionId !== content.revisionId || planned.contentDigest !== content.contentDigest || planned.reviewId !== review.reviewId || planned.reviewDigest !== review.reviewDigest)) throw new Error("publication journal Release does not match the confirmed content/review");
  if (journal.stage === "local_published" || journal.stage === "complete") {
    if (!planned) throw new Error("publication journal lacks its local Release");
    const actual = await library.getRelease(content.templateId, planned.releaseId);
    if (!actual || canonicalJson(actual) !== canonicalJson(planned) || canonicalJson(journal.result?.release ?? null) !== canonicalJson(actual) || journal.result?.localPublished !== true) throw new Error("publication journal result does not match its immutable local Release");
  }
}
function reader(library: VersionedTemplateLibrary, prepared: Pick<Prepared, "content" | "workingPlan">): Pick<VersionedTemplateLibrary, "readAsset"> {
  return { readAsset: async (selector) => {
    const content = prepared.content;
    if (selector.templateId !== content.templateId || selector.revisionId !== content.revisionId || selector.contentDigest !== content.contentDigest) throw new Error("pending content selector mismatch");
    if (!prepared.workingPlan) return library.readAsset(selector);
    const asset = content.assets.find(a => a.logicalPath === selector.logicalPath);
    const source = prepared.workingPlan.assetSources.find(a => a.logicalPath === selector.logicalPath);
    if (!asset || !source) throw new Error("pending asset missing");
    const bytes = await bytesForPreparedSource(source, asset);
    return { ...selector, asset, bytes: new Uint8Array(bytes) };
  } };
}
async function json(file: string): Promise<Journal | undefined> {
  try { return JSON.parse(await fs.readFile(file, "utf8")) as Journal; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}
async function write(file: string, value: Journal) {
  const tmp = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value), { flag: "wx" });
  await fs.rename(tmp, file);
}

/** Host-owned Gallery preparation is deliberately outside this asset publication service. */
export function definePublishOperations(options: {
  operations: OperationRegistry;
  currentLibrary: () => Promise<VersionedTemplateLibrary>;
  publicService?: OpenFigurePublicationService;
  now?: () => number;
}) {
  const plans = new Map<string, Prepared>();
  const now = options.now ?? Date.now;
  const prune = () => { for (const [id, p] of plans) if (now() - Date.parse(p.createdAt) >= TTL) plans.delete(id); };

  options.operations.define("figure_library_plan_publish", {
    title: "Prepare one publication for human review",
    description: "Read-only proposal or exact Working preflight. Default local; propose readable bilingual titles and a scientific question. Show the preview and this complete plan once. No pre-confirmation booleans, Gallery writes, Library writes, GitHub writes or code execution.",
    inputSchema: Input, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  }, async input => {
    try {
      const library = await options.currentLibrary();
      if (!library.writesEnabled) throw new Error("library_not_bound: select a writable Library before publication");
      let workingPlan: WorkingRevisionPlan | undefined;
      let gatePlan: GateUpdatePlan | undefined;
      let content: TemplateContentV1;
      let review: ReviewSnapshotV1;
      let expectedSeriesDigest: string | null;
      if (input.candidate) {
        if (input.gateDecisions.length) throw new Error("gate decisions require an existing exact Working revision");
        const proposal = input.candidate;
        const series = await library.getSeries(proposal.templateId);
        if (proposal.mode === "create" && series) throw new Error("template already exists; explicitly propose update");
        if (proposal.mode === "update" && !series) throw new Error("update template does not exist");
        // These are prospective final selections, not a claim of an earlier human approval.
        // They only become stored decisions after Apply of this exact immutable proposal.
        const request = WorkingPlanInput.parse({ ...proposal,
          figureCodeLinks: proposal.figureCodeLinks.map(link => ({ ...link, confirmedBy: "user" })),
          ...(proposal.primaryPreviewOverride ? { primaryPreviewOverride: { ...proposal.primaryPreviewOverride, confirmedBy: "user" } } : {}),
        });
        const missing = missingWorkingConfirmations(request).filter(m => !m.startsWith("confirmation:"));
        if (missing.length) return result("needs_user_input", "publish_input_missing", `Missing proposal fields: ${missing.join(", ")}`, "ask_user", { missing });
        const candidate = await directCandidate(request, true);
        workingPlan = series?.workingHead
          ? await library.planUpdateWorking({ templateId: proposal.templateId, candidate, assessment: proposal.assessment })
          : await library.planCreateWorking({ templateId: proposal.templateId, candidate, assessment: proposal.assessment });
        ({ content, review, expectedSeriesDigest } = workingPlan);
      } else {
        const selected = input.working!;
        const series = await library.getSeries(selected.templateId);
        if (!series?.workingHead || series.workingHead.revisionId !== selected.revisionId || series.workingHead.contentDigest !== selected.contentDigest || series.workingHead.reviewDigest !== selected.reviewDigest) throw new Error("stale Working identity");
        content = (await library.getContent(selected.templateId, selected.revisionId, selected.contentDigest))!;
        review = (await library.getReview(selected.templateId, series.workingHead.reviewId))!;
        if (input.gateDecisions.length) {
          gatePlan = await library.planGateUpdate({ templateId: selected.templateId, decisions: input.gateDecisions });
          review = gatePlan.review;
        }
        expectedSeriesDigest = templateSeriesDigest(series);
      }
      reviewCheck(review);
      const marker = await readLibraryRootMarker(library.root);
      const context = marker ? { libraryId: marker.value.libraryId, configRevision: library.configRevision } : undefined;
      const prepared: Prepared = { schema: "figure-library.publish-plan.v1", root: library.root, ...(context ? { libraryContext: context } : {}),
        directorySource: library.directorySource, configRevision: library.configRevision,
        target: input.target, content, review, expectedSeriesDigest, ...(workingPlan ? { workingPlan } : {}),
        ...(gatePlan ? { gatePlan } : {}), createdAt: new Date(now()).toISOString(), planDigest: "" };
      const source = reader(library, prepared);
      await library.validateRuntimeClosure(content, source.readAsset);
      if (!content.primaryPreview) throw new Error("publication requires a primary preview");
      const preview = await source.readAsset({ templateId: content.templateId, revisionId: content.revisionId, contentDigest: content.contentDigest, logicalPath: content.primaryPreview });
      assertMcpImageBytes({ bytes: preview.bytes, mimeType: preview.asset.mediaType, extension: path.extname(content.primaryPreview) });
      const transport = await prepareTransportImage({ sourceBytes: preview.bytes, sourceMime: preview.asset.mediaType,
        sourceSha256: preview.asset.sha256, purpose: "WorkingPreview", maxDataUrlBytes: singlePreviewBudget(), libraryRoot: library.root, cache: false });
      if (!transport.ok) throw new Error(`publication preview unavailable: ${transport.reason}`);
      if (input.target === "open_module") {
        if (!options.publicService) throw new Error("public publication is unavailable");
        prepared.openModule = await options.publicService.planContent(content, source);
      }
      prepared.planDigest = digest(prepared);
      prune();
      if (plans.size >= 64) plans.delete(plans.keys().next().value!);
      plans.set(prepared.planDigest, prepared);
      const plan = { schema: prepared.schema, planDigest: prepared.planDigest, approval: "pending", written: false,
        target: input.target, templateId: content.templateId, expectedSeriesDigest,
        title: content.title, titleEn: content.titleEn, scientificQuestion: content.scientificQuestion,
        description: content.description, application: content.application, dataProfile: content.dataProfile,
        primaryPreview: content.primaryPreview, canonicalImplementation: content.canonicalImplementation,
        proposedIdentity: { templateId: content.templateId, revisionId: content.revisionId, contentDigest: content.contentDigest },
        assets: content.assets.map(a => ({ path: a.logicalPath, role: a.role, bytes: a.bytes, sha256: a.sha256 })),
        ...(prepared.openModule ? { openModule: prepared.openModule } : {}),
        ...(input.gateDecisions.length ? { proposedGateDecisions: input.gateDecisions } : {}),
      };
      const response = result("needs_user_confirmation", "publish_plan_ready", [content.title,
        content.titleEn, `科学问题：${content.scientificQuestion ?? "待确认"}`, content.description, content.application,
        `发布范围：${input.target === "local" ? "Gallery → Local Published" : "Gallery → Local Published → Open Module PR（不合并）"}`,
        prepared.openModule ? [`公开目标：${prepared.openModule.target.repository}（创建 PR，不合并）`,
          `公开文件：${prepared.openModule.files.map(f => f.path).join("、")}`,
          `资产许可：${[...new Set(content.assets.filter(a => a.rights?.distribution === "public").map(a => a.rights!.license))].join("；")}`,
          `相似候选：${prepared.openModule.similarCandidates.map(c => `${c.title}（${c.sourceLabel}）`).join("；") || "无"}`].join("\n") : undefined,
        `PLAN_DIGEST: ${prepared.planDigest}`, "确认后执行；Gallery 文件操作由宿主按同一内容计划完成。"].filter(Boolean).join("\n"), "apply_confirmed_plan", {
          plan, technical: { validationState: content.validationState, review, libraryWrites: false, galleryManagedByHost: true },
        });
      response.content.unshift({ type: "image", mimeType: transport.transportMime, data: Buffer.from(transport.transportBytes).toString("base64") });
      return response;
    } catch (error) {
      return result("blocked", "publish_preflight_blocked", (error as Error).message, "inspect_review");
    }
  });

  options.operations.define("figure_library_apply_publish", {
    title: "Apply the single human-confirmed publication",
    description: "Only after the user approves the exact plan and the host completes its Gallery actions. Publish locally by default; an explicitly planned Open Module PR follows without another approval. Same operationId resumes completed stages; never merges or executes plotting code.",
    inputSchema: Apply, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async input => {
    let journal: Journal | undefined;
    let lock: Awaited<ReturnType<typeof fs.open>> | undefined;
    let lockPath: string | undefined;
    try {
      const library = await options.currentLibrary();
      if (!library.writesEnabled) throw new Error("library_not_bound");
      const directory = path.join(library.operationsDirectory, "unified-publications");
      const file = path.join(directory, `${hash(input.operationId)}.json`);
      journal = await json(file);
      const existing = journal;
      prune();
      const prepared = journal?.prepared ?? plans.get(input.planDigest);
      if (!prepared) throw new Error("publication plan expired or belongs to another session; create a new plan");
      if (prepared.planDigest !== input.planDigest || digest(prepared) !== input.planDigest || (journal && journal.operationId !== input.operationId)) throw new Error("operationId or planDigest mismatch");
      const marker = await readLibraryRootMarker(library.root);
      const actualContext = marker ? { libraryId: marker.value.libraryId, configRevision: library.configRevision } : undefined;
      const expectedContext = prepared.libraryContext ?? journal?.initializedContext;
      if (prepared.root !== library.root || prepared.directorySource !== library.directorySource || prepared.configRevision !== library.configRevision || canonicalJson(expectedContext ?? null) !== canonicalJson(actualContext ?? null)) throw new Error("stale Library binding");
      if (journal) await verifyJournal(library, journal);
      if (journal?.stage === "complete") {
        if (prepared.openModule) {
          if (!journal.openPlan || !options.publicService) throw new Error("completed public publication has no receipt context");
          const completed = await options.publicService.completedResult(journal.openPlan.planDigest, `publish-${hash(input.operationId).slice(0, 40)}-public`);
          if (!completed || canonicalJson(completed.receipt) !== canonicalJson(journal.result?.publicPullRequest ?? null)) throw new Error("public publication receipt mismatch");
        }
        return result("replayed", "publish_replayed", "Existing publication returned; no duplicate writes.", "none", { result: journal.result });
      }
      if (!journal && prepared.openModule?.similarReviewRequired && input.acceptSimilarCandidates !== true) return result("needs_user_input", "publish_similar_decision_required", "Confirm the similar candidates already included in this publication plan.", "ask_user");
      await fs.mkdir(directory, { recursive: true });
      lockPath = `${file}.lock`;
      lock = await fs.open(lockPath, "wx");
      await lock.writeFile(JSON.stringify({ operationId: input.operationId, pid: process.pid, createdAt: new Date(now()).toISOString() }));
      // Re-read after acquiring the operation lock to reject a concurrent completion/update.
      journal = await json(file);
      if (canonicalJson(journal ?? null) !== canonicalJson(existing ?? null)) throw new Error("publication operation changed; inspect its current result");
      if (!journal) {
        const series = await library.getSeries(prepared.content.templateId);
        if ((series ? templateSeriesDigest(series) : null) !== prepared.expectedSeriesDigest) throw new Error("stale Series changed after planning");
        // Validate every selected source before starting any lifecycle mutation.
        const source = reader(library, prepared);
        for (const asset of prepared.content.assets) await source.readAsset({ templateId: prepared.content.templateId, revisionId: prepared.content.revisionId, contentDigest: prepared.content.contentDigest, logicalPath: asset.logicalPath });
        // An explicitly selected but empty Library is initialized only after confirmation.
        // Persist its identity before template writes so a fresh runtime can safely resume.
        const initialized = await ensureLibraryRootMarker(library.root, prepared.libraryContext?.libraryId);
        journal = { schema: "figure-library.publish-operation.v1", operationId: input.operationId, prepared, stage: "confirmed",
          initializedContext: { libraryId: initialized.value.libraryId, configRevision: library.configRevision } };
        await write(file, journal);
      }
      const stepId = (stage: string) => `publish-${hash(input.operationId).slice(0, 40)}-${stage}`;
      if (journal.stage === "confirmed") {
        if (prepared.workingPlan) {
          if (prepared.workingPlan.action === "create_working") await library.applyCreateWorking(prepared.workingPlan, stepId("working"));
          else await library.applyUpdateWorking(prepared.workingPlan, stepId("working"));
        }
        if (prepared.gatePlan) await library.applyGateUpdate(prepared.gatePlan, stepId("gates"));
        journal.stage = "working";
        await write(file, journal);
      }
      if (journal.stage === "working") {
        if (!journal.publishPlan) {
          const series = await library.getSeries(prepared.content.templateId);
          if (series?.workingHead?.contentDigest !== prepared.content.contentDigest || series.workingHead.reviewDigest !== prepared.review.reviewDigest) throw new Error("Working content or review changed after confirmation");
          journal.publishPlan = await library.planPublish({ templateId: prepared.content.templateId });
          await write(file, journal);
        }
        await library.applyPublish(journal.publishPlan, stepId("local"));
        journal.stage = "local_published";
        journal.result = { localPublished: true, templateId: prepared.content.templateId, release: journal.publishPlan.release, target: prepared.target };
        await write(file, journal);
      }
      if (prepared.openModule) {
        if (!options.publicService || !journal.publishPlan) throw new Error("public service unavailable; local publication retained");
        const release = journal.publishPlan.release;
        const selector: LocalPublishedExactSelector = { schema: "figure-library.provider-selector.v1", providerId: "org.scientificfigurelibrary.local", kind: "local-published.v1", identity: {
          templateId: release.templateId, revisionId: release.revisionId, contentDigest: release.contentDigest, releaseId: release.releaseId,
        } };
        const completed = journal.openPlan ? await options.publicService.completedResult(journal.openPlan.planDigest, stepId("public")) : undefined;
        let applied: Awaited<ReturnType<OpenFigurePublicationService["apply"]>> | undefined = completed;
        if (!applied) {
          const openPlan = await options.publicService.bindPublished(prepared.openModule, selector, journal.openPlan);
          journal.openPlan = openPlan;
          await write(file, journal);
          applied = await options.publicService.apply({ planDigest: openPlan.planDigest, operationId: stepId("public") });
        }
        journal.result = { ...journal.result, publicPullRequest: applied!.receipt };
      }
      journal.stage = "complete";
      await write(file, journal);
      return result("applied", "publish_completed", "Publication completed within the confirmed scope.", "none", { result: journal.result });
    } catch (error) {
      const message = (error as Error).message;
      return result("blocked", "publish_apply_blocked", message, /stale|changed|expired|mismatch/u.test(message) ? "create_new_plan" : "inspect_review", {
        completedStage: journal?.stage ?? "none", ...(journal?.result ? { result: journal.result } : {}), operationId: input.operationId,
      });
    } finally {
      if (lock) { await lock.close(); await fs.unlink(lockPath!); }
    }
  });
}
