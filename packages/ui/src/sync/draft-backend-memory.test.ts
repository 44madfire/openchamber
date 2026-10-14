import { beforeEach, describe, expect, test } from "bun:test"
import { rememberDraftBackend, resolveDraftBackend } from "./draft-backend-memory"

class TestStorage implements Storage {
  readonly values = new Map<string, string>()
  get length() { return this.values.size }
  clear() { this.values.clear() }
  getItem(key: string) { return this.values.get(key) ?? null }
  key(index: number) { return [...this.values.keys()][index] ?? null }
  removeItem(key: string) { this.values.delete(key) }
  setItem(key: string, value: string) { this.values.set(key, value) }
}

let storage: TestStorage

const RUNTIME_A = "runtime-a"
const RUNTIME_B = "runtime-b"

beforeEach(() => {
  storage = new TestStorage()
})

describe("draft backend memory", () => {
  test("defaults to OpenCode when nothing was picked", () => {
    expect(resolveDraftBackend("/repo/a", RUNTIME_A, storage)).toBeNull()
    expect(resolveDraftBackend(null, RUNTIME_A, storage)).toBeNull()
  })

  test("remembers the pick per directory and the last pick anywhere", () => {
    rememberDraftBackend(RUNTIME_A, "/repo/a", "omp", storage)
    rememberDraftBackend(RUNTIME_A, "/repo/b", "pi-acp", storage)

    expect(resolveDraftBackend("/repo/a", RUNTIME_A, storage)).toBe("omp")
    expect(resolveDraftBackend("/repo/b", RUNTIME_A, storage)).toBe("pi-acp")
    expect(resolveDraftBackend("/repo/unseen", RUNTIME_A, storage)).toBe("pi-acp")
    expect(resolveDraftBackend(null, RUNTIME_A, storage)).toBe("pi-acp")
  })

  test("an explicit OpenCode pick wins over an earlier agent pick", () => {
    rememberDraftBackend(RUNTIME_A, "/repo/a", "omp", storage)
    rememberDraftBackend(RUNTIME_A, "/repo/a", null, storage)

    expect(resolveDraftBackend("/repo/a", RUNTIME_A, storage)).toBeNull()
    expect(resolveDraftBackend("/repo/unseen", RUNTIME_A, storage)).toBeNull()
  })

  test("chat drafts (no directory) still move the anywhere fallback", () => {
    rememberDraftBackend(RUNTIME_A, "/repo/a", "omp", storage)
    rememberDraftBackend(RUNTIME_A, null, "pi-acp", storage)

    expect(resolveDraftBackend("/repo/a", RUNTIME_A, storage)).toBe("omp")
    expect(resolveDraftBackend("/repo/unseen", RUNTIME_A, storage)).toBe("pi-acp")
  })

  test("normalizes directory spellings so the same folder matches", () => {
    rememberDraftBackend(RUNTIME_A, "c:\\repo\\a\\", "omp", storage)

    expect(resolveDraftBackend("C:/repo/a", RUNTIME_A, storage)).toBe("omp")
  })

  test("keeps independent defaults per runtime endpoint", () => {
    rememberDraftBackend(RUNTIME_A, "/repo/a", "omp", storage)

    expect(resolveDraftBackend("/repo/a", RUNTIME_A, storage)).toBe("omp")
    expect(resolveDraftBackend("/repo/a", RUNTIME_B, storage)).toBeNull()
    expect(resolveDraftBackend("/repo/unseen", RUNTIME_B, storage)).toBeNull()
  })

  test("the same directory and backend IDs on two endpoints do not collide", () => {
    rememberDraftBackend(RUNTIME_A, "/workspace/repo", "omp", storage)
    rememberDraftBackend(RUNTIME_B, "/workspace/repo", "pi-acp", storage)

    expect(resolveDraftBackend("/workspace/repo", RUNTIME_A, storage)).toBe("omp")
    expect(resolveDraftBackend("/workspace/repo", RUNTIME_B, storage)).toBe("pi-acp")
    // Each endpoint's anywhere fallback is its own pick, not the other's.
    expect(resolveDraftBackend("/workspace/other", RUNTIME_A, storage)).toBe("omp")
    expect(resolveDraftBackend("/workspace/other", RUNTIME_B, storage)).toBe("pi-acp")
  })

  test("switching back restores the original endpoint's preference", () => {
    rememberDraftBackend(RUNTIME_A, "/repo/a", "omp", storage)
    rememberDraftBackend(RUNTIME_B, "/repo/a", "pi-acp", storage)

    expect(resolveDraftBackend("/repo/a", RUNTIME_A, storage)).toBe("omp")
  })

  test("transient runtimes (no instance connected) never persist or resolve", () => {
    for (const transient of ["", "url:default", "mobile-disconnected"]) {
      rememberDraftBackend(transient, "/repo/a", "omp", storage)
      expect(resolveDraftBackend("/repo/a", transient, storage)).toBeNull()
    }
    expect(storage.getItem("oc.draftBackend.v1")).toBeNull()
  })

  test("malformed persisted payload reads as OpenCode, not a crash", () => {
    storage.setItem("oc.draftBackend.v1", "{not json")
    expect(resolveDraftBackend("/repo/a", RUNTIME_A, storage)).toBeNull()

    storage.setItem("oc.draftBackend.v1", JSON.stringify({ version: 99, runtimes: { [RUNTIME_A]: { global: { backendId: "omp", updatedAt: 1 }, byDirectory: {} } } }))
    expect(resolveDraftBackend("/repo/a", RUNTIME_A, storage)).toBeNull()

    storage.setItem("oc.draftBackend.v1", JSON.stringify({
      version: 1,
      runtimes: {
        [RUNTIME_A]: {
          global: { backendId: 42, updatedAt: "now" },
          byDirectory: { "/repo/a": { backendId: "omp", updatedAt: 1 } },
        },
      },
    }))
    expect(resolveDraftBackend("/repo/a", RUNTIME_A, storage)).toBe("omp")
    expect(resolveDraftBackend("/repo/unseen", RUNTIME_A, storage)).toBeNull()
  })

  test("bounds retained directory entries, keeping the newest", () => {
    for (let index = 0; index < 55; index += 1) {
      rememberDraftBackend(RUNTIME_A, `/repo/dir-${index}`, `backend-${index}`, storage)
    }
    const envelope = JSON.parse(storage.getItem("oc.draftBackend.v1") ?? "{}") as { runtimes?: Record<string, { byDirectory?: Record<string, unknown> }> }
    expect(Object.keys(envelope.runtimes?.[RUNTIME_A]?.byDirectory ?? {})).toHaveLength(50)
    expect(resolveDraftBackend("/repo/dir-54", RUNTIME_A, storage)).toBe("backend-54")
    expect(resolveDraftBackend("/repo/dir-0", RUNTIME_A, storage)).toBe("backend-54")
  })

  test("bounds retained runtime namespaces, keeping the newest", () => {
    for (let index = 0; index < 10; index += 1) {
      rememberDraftBackend(`runtime-${index}`, "/repo/a", `backend-${index}`, storage)
    }
    const retained = Array.from({ length: 10 }, (_, index) => resolveDraftBackend("/repo/a", `runtime-${index}`, storage))
      .filter(Boolean)
    expect(retained.length).toBe(8)
    expect(resolveDraftBackend("/repo/a", "runtime-9", storage)).toBe("backend-9")
    expect(resolveDraftBackend("/repo/a", "runtime-0", storage)).toBeNull()
  })
})
