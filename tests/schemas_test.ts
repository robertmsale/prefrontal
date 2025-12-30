import { assert } from "@std/assert";
import { z } from "@zod/zod";
import {
  ActivityDigestParams,
  ActivityPostParams,
  LocksAcquireParams,
  LocksListParams,
  LocksReleaseParams,
  MemoryGetFileContextParams,
  MemorySearchParams,
  MemoryUpsertChunksParams,
  RepoChunkSchema,
  TasksClaimParams,
  TasksCompleteParams,
  TasksCreateParams,
  TasksListActiveParams,
  TasksSearchSimilarParams,
  TasksUpdateParams,
} from "../src/schemas.ts";

function assertObjectPropertiesDescribed(jsonSchema: any) {
  const props = jsonSchema?.properties;
  if (!props || typeof props !== "object") return;
  for (const [key, value] of Object.entries(props)) {
    assert(
      typeof (value as any)?.description === "string" &&
        ((value as any).description as string).trim().length > 0,
      `Missing description for property '${key}'`,
    );
  }
}

Deno.test("tool schemas serialize with descriptions", () => {
  const schemas = [
    ActivityPostParams,
    ActivityDigestParams,
    TasksCreateParams,
    TasksListActiveParams,
    TasksSearchSimilarParams,
    TasksClaimParams,
    TasksUpdateParams,
    TasksCompleteParams,
    LocksAcquireParams,
    LocksReleaseParams,
    LocksListParams,
    MemoryUpsertChunksParams,
    MemorySearchParams,
    MemoryGetFileContextParams,
    RepoChunkSchema,
  ];

  for (const schema of schemas) {
    const json = z.toJSONSchema(schema);
    assert(json && typeof json === "object");
    assertObjectPropertiesDescribed(json);
  }
});
