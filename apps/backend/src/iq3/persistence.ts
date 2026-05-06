import type { Iq3UserState } from "@protege/types";
import { createRequire } from "node:module";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Iq3 user-state repo abstraction.
 *
 * Matches the `UserStateRepo` interface declared in routes/iq.ts. Two
 * concrete implementations live below: `supabaseRepo` (cloud) and
 * `localJsonRepo` (dev fallback). `autoRepo` picks the cloud repo when
 * `SUPABASE_URL` + `SUPABASE_SERVICE_KEY` are present, otherwise the
 * JSON file repo so a developer without Supabase env can still hit the
 * iq3 routes without crashing.
 */
export interface Iq3UserStateRepo {
  load(userId: string): Promise<Iq3UserState | null>;
  save(state: Iq3UserState): Promise<void>;
}

/* ----- Local JSON repo (dev fallback) ----- */

export function localJsonRepo(filePath: string): Iq3UserStateRepo {
  function readAll(): Record<string, Iq3UserState> {
    if (!existsSync(filePath)) return {};
    return JSON.parse(readFileSync(filePath, "utf-8"));
  }
  function writeAll(map: Record<string, Iq3UserState>) {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify(map, null, 2));
  }
  return {
    async load(userId) {
      return readAll()[userId] ?? null;
    },
    async save(state) {
      const all = readAll();
      all[state.userId] = state;
      writeAll(all);
    },
  };
}

/* ----- Supabase repo ----- */

/**
 * Minimal duck-typed view of the Supabase client surface this repo touches.
 * Keeping it structural lets us avoid `import type` from
 * `@supabase/supabase-js` here (the package is loaded lazily in
 * `autoRepo` so dev environments without env stay clean).
 */
export interface SupabaseClientLike {
  from(table: string): {
    select: (cols: string) => {
      eq: (col: string, val: string) => {
        single: () => Promise<{ data: any; error: any }>;
      };
    };
    upsert: (row: any) => Promise<{ error: any }>;
  };
}

export function supabaseRepo(client: SupabaseClientLike): Iq3UserStateRepo {
  return {
    async load(userId) {
      const { data, error } = await client
        .from("iq3_user_state")
        .select("*")
        .eq("user_id", userId)
        .single();
      if (error) {
        // PGRST116 = "Results contain 0 rows" from PostgREST .single().
        // Treat that as a missing row; everything else (auth, network,
        // schema mismatch) MUST throw so callers don't silently overwrite
        // a real user's state with a fresh blank one.
        if (error.code === "PGRST116") return null;
        throw new Error(
          `iq3_user_state load failed: ${error.message ?? String(error)}`,
        );
      }
      if (!data) return null;
      return {
        userId: data.user_id,
        traits: data.traits,
        field: data.field_vector,
        eventCount: data.event_count,
        aiEventCount: data.ai_event_count,
        schemaVersion: data.schema_version,
        updatedAt: data.updated_at,
      };
    },
    async save(state) {
      const { error } = await client.from("iq3_user_state").upsert({
        user_id: state.userId,
        traits: state.traits,
        field_vector: state.field,
        event_count: state.eventCount,
        ai_event_count: state.aiEventCount,
        schema_version: state.schemaVersion,
        updated_at: state.updatedAt,
      });
      if (error) throw new Error(`iq3_user_state upsert failed: ${error.message}`);
    },
  };
}

/**
 * Auto-pick: Supabase if env present, else local JSON.
 *
 * Supabase is loaded via `createRequire` so we don't pay the import
 * cost (or break the import graph) when env is missing. Under Node 18+
 * with `module: ESNext`, top-level `require` isn't available — hence
 * `createRequire(import.meta.url)`.
 */
export function autoRepo(): Iq3UserStateRepo {
  if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY) {
    const require = createRequire(import.meta.url);
    const { createClient } = require("@supabase/supabase-js");
    const client = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY,
    );
    return supabaseRepo(client);
  }
  return localJsonRepo("./.protege-store-iq3.json");
}
