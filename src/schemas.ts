import { z } from "@zod/zod";

export const ClaimedBySchema = z.object({
  agent_id: z.string().describe("Agent identifier (human-readable)."),
  worktree: z.string().optional().describe("Worktree name/path (optional)."),
  branch: z.string().optional().describe("Branch name (optional)."),
}).passthrough();

export const TaskSchema = z.object({
  task_id: z.string().describe("Task UUID (also used as Qdrant point ID)."),
  title: z.string().describe("Short task title."),
  description: z.string().describe("Task description."),
  status: z.enum([
    "open",
    "claimed",
    "in_progress",
    "blocked",
    "done",
    "abandoned",
  ]).describe("Task lifecycle status."),
  claimed_by: ClaimedBySchema.nullable().optional().describe(
    "Current task owner, if any.",
  ),
  related_paths: z.array(z.string().min(1)).default([]).describe(
    "Best-effort list of related repo paths.",
  ),
  base_commit: z.string().optional().describe(
    "Base commit SHA the task started from (optional).",
  ),
  last_update_at: z.number().int().describe(
    "Unix timestamp in milliseconds of the last update.",
  ),
  lease_until: z.number().int().nullable().optional().describe(
    "Unix timestamp in milliseconds when the lease expires.",
  ),
  version: z.number().int().describe(
    "Monotonic version for optimistic concurrency.",
  ),
  priority: z.number().int().optional().describe(
    "Optional priority (higher means more important).",
  ),
  tags: z.array(z.string().min(1)).optional().describe(
    "Optional tags for grouping/search.",
  ),
  result_commit: z.string().nullable().optional().describe(
    "Optional result commit SHA associated with completion.",
  ),
}).passthrough();

export const LockSchema = z.object({
  path: z.string().describe("Repo path being locked."),
  agent_id: z.string().describe("Agent identifier that holds the lock."),
  mode: z.enum(["soft", "hard"]).default("soft").describe(
    "Soft locks are advisory; hard locks should block edits.",
  ),
  expires_at: z.number().int().describe(
    "Unix timestamp in milliseconds when this lock expires.",
  ),
}).passthrough();

export const ActivityEventSchema = z.object({
  event_id: z.string().describe("Event UUID (also used as Qdrant point ID)."),
  ts: z.number().int().describe("Unix timestamp in milliseconds for ordering."),
  type: z.string().describe("Event type identifier."),
  message: z.string().describe("Human-readable event message."),
  related_paths: z.array(z.string().min(1)).optional().describe(
    "Optional related repo paths.",
  ),
  task_id: z.string().optional().describe("Optional related task_id."),
}).passthrough();

export const RepoChunkSchema = z.object({
  chunk_id: z.string().min(1).describe(
    "Stable chunk identifier (payload field; point ID is derived).",
  ),
  kind: z.string().min(1).describe(
    "Chunk kind (facts|adr|architecture|guardrail|code_doc|...).",
  ),
  path: z.string().min(1).describe("Repo-relative file path for provenance."),
  commit: z.string().min(1).nullable().describe(
    "Commit SHA for provenance (nullable when unknown).",
  ),
  authority: z.number().int().min(1).max(5).nullable().describe(
    "Authority level 1–5 (nullable when unknown).",
  ),
  content_hash: z.string().min(1).nullable().describe(
    "Hash of the chunk text for upserts (nullable when unknown).",
  ),
  chunk: z.object({
    start_line: z.number().int().nullable().describe(
      "Start line number (1-based), nullable.",
    ),
    end_line: z.number().int().nullable().describe(
      "End line number (1-based), nullable.",
    ),
    byte_start: z.number().int().nullable().describe(
      "Start byte offset, nullable.",
    ),
    byte_end: z.number().int().nullable().describe(
      "End byte offset, nullable.",
    ),
  }).strict().nullable().describe("Optional positional metadata."),
  text: z.string().min(1).describe("Chunk text content."),
}).strict();

// Tool parameter schemas (strict, with descriptions on every property)

export const ActivityPostParams = z.object({
  type: z.string().min(1).describe("Event type identifier."),
  message: z.string().min(1).describe("Event message."),
  related_paths: z.array(z.string().min(1)).nullable().describe(
    "Related repo paths, or null.",
  ),
  task_id: z.string().min(1).nullable().describe("Related task_id, or null."),
}).strict();

export const ActivityDigestParams = z.object({
  since_cursor: z.number().int().nullable().describe(
    "Return events strictly after this cursor (ms), or null for start.",
  ),
  limit: z.number().int().min(1).max(200).describe(
    "Maximum number of events to return.",
  ),
}).strict();

export const TasksCreateParams = z.object({
  title: z.string().min(1).describe("Short task title."),
  description: z.string().min(1).describe("Task description."),
  related_paths: z.array(z.string().min(1)).describe(
    "Best-effort list of related repo paths.",
  ),
  priority: z.number().int().nullable().describe("Optional priority, or null."),
  tags: z.array(z.string().min(1)).nullable().describe(
    "Optional tags, or null.",
  ),
  base_commit: z.string().min(1).nullable().describe(
    "Base commit SHA, or null.",
  ),
}).strict();

export const TasksListActiveParams = z.object({
  status_in: z.array(z.enum([
    "open",
    "claimed",
    "in_progress",
    "blocked",
    "done",
    "abandoned",
  ])).nullable().describe(
    "Statuses to include, or null for default active statuses.",
  ),
  limit: z.number().int().min(1).max(200).describe(
    "Maximum number of tasks to return.",
  ),
}).strict();

export const TasksSearchSimilarParams = z.object({
  query: z.string().min(1).describe("Semantic query text."),
  status_in: z.array(z.enum([
    "open",
    "claimed",
    "in_progress",
    "blocked",
    "done",
    "abandoned",
  ])).nullable().describe(
    "Statuses to include, or null for default active statuses.",
  ),
  k: z.number().int().min(1).max(50).describe(
    "Number of similar results to return.",
  ),
}).strict();

export const TasksClaimParams = z.object({
  task_id: z.string().min(1).describe("Task UUID to claim."),
  agent_id: z.string().min(1).describe("Agent identifier claiming the task."),
  worktree: z.string().min(1).nullable().describe(
    "Worktree name/path, or null.",
  ),
  branch: z.string().min(1).nullable().describe("Branch name, or null."),
  lease_seconds: z.number().int().min(30).max(60 * 60 * 24).describe(
    "Lease duration in seconds.",
  ),
}).strict();

export const TasksUpdateParams = z.object({
  task_id: z.string().min(1).describe("Task UUID to update."),
  status: z.enum([
    "open",
    "claimed",
    "in_progress",
    "blocked",
    "done",
    "abandoned",
  ]).nullable().describe("New status, or null to keep unchanged."),
  progress_note: z.string().min(1).nullable().describe(
    "Progress note to append to activity, or null.",
  ),
  related_paths: z.array(z.string().min(1)).nullable().describe(
    "Replacement related_paths, or null.",
  ),
  lease_extend_seconds: z.number().int().min(30).max(60 * 60 * 24).nullable()
    .describe("Extend lease to now+N seconds, or null."),
}).strict();

export const TasksCompleteParams = z.object({
  task_id: z.string().min(1).describe("Task UUID to mark done."),
  result_commit: z.string().min(1).nullable().describe(
    "Optional result commit SHA, or null.",
  ),
}).strict();

export const LocksAcquireParams = z.object({
  paths: z.array(z.string().min(1)).min(1).describe("Repo paths to lock."),
  agent_id: z.string().min(1).describe(
    "Agent identifier acquiring the lock(s).",
  ),
  ttl_seconds: z.number().int().min(30).max(60 * 60 * 24).describe(
    "Lock TTL in seconds.",
  ),
  mode: z.enum(["soft", "hard"]).describe("Lock mode."),
}).strict();

export const LocksReleaseParams = z.object({
  paths: z.array(z.string().min(1)).min(1).describe("Repo paths to unlock."),
  agent_id: z.string().min(1).describe(
    "Agent identifier releasing the lock(s).",
  ),
}).strict();

export const LocksListParams = z.object({
  limit: z.number().int().min(1).max(500).describe(
    "Maximum number of locks to return.",
  ),
}).strict();

export const MemoryUpsertChunksParams = z.object({
  chunks: z.array(RepoChunkSchema).min(1).describe("Chunks to upsert."),
}).strict();

export const MemorySearchParams = z.object({
  query: z.string().min(1).describe("Semantic query text."),
  kind: z.string().min(1).nullable().describe("Optional kind filter, or null."),
  path: z.string().min(1).nullable().describe(
    "Optional exact path filter, or null.",
  ),
  k: z.number().int().min(1).max(50).describe("Number of results to return."),
}).strict();

export const MemoryGetFileContextParams = z.object({
  path: z.string().min(1).describe(
    "Exact repo-relative path to retrieve chunks for.",
  ),
  query: z.string().min(1).nullable().describe(
    "Optional semantic query to rank chunks, or null.",
  ),
  k: z.number().int().min(1).max(50).describe("Number of results to return."),
}).strict();
