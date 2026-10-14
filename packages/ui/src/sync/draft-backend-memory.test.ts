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

beforeEach(() => {
  storage = new TestStorage()
})

describe("draft backend memory", () => {
  test("defaults to OpenCode when nothing was picked", () => {
    expect(resolveDraftBackend("/repo/a", storage)).toBeNull()
    expect(resolveDraftBackend(null, storage)).toBeNull()
  })

  test("remembers the pick per directory and the last pick anywhere", () => {
    rememberDraftBackend("/repo/a", "omp", storage)
    rememberDraftBackend("/repo/b", "pi-acp", storage)

    expect(resolveDraftBackend("/repo/a", storage)).toBe("omp")
    expect(resolveDraftBackend("/repo/b", storage)).toBe("pi-acp")
    expect(resolveDraftBackend("/repo/unseen", storage)).toBe("pi-acp")
    expect(resolveDraftBackend(null, storage)).toBe("pi-acp")
  })

  test("an explicit OpenCode pick wins over an earlier agent pick", () => {
    rememberDraftBackend("/repo/a", "omp", storage)
    rememberDraftBackend("/repo/a", null, storage)

    expect(resolveDraftBackend("/repo/a", storage)).toBeNull()
    expect(resolveDraftBackend("/repo/unseen", storage)).toBeNull()
  })

  test("chat drafts (no directory) still move the anywhere fallback", () => {
    rememberDraftBackend("/repo/a", "omp", storage)
    rememberDraftBackend(null, "pi-acp", storage)

    expect(resolveDraftBackend("/repo/a", storage)).toBe("omp")
    expect(resolveDraftBackend("/repo/unseen", storage)).toBe("pi-acp")
  })

  test("normalizes directory spellings so the same folder matches", () => {
    rememberDraftBackend("c:\\repo\\a\\", "omp", storage)

    expect(resolveDraftBackend("C:/repo/a", storage)).toBe("omp")
  })

  test("malformed persisted payload reads as OpenCode, not a crash", () => {
    storage.setItem("oc.draftBackend.v1", "{not json")
    expect(resolveDraftBackend("/repo/a", storage)).toBeNull()

    storage.setItem("oc.draftBackend.v1", JSON.stringify({ version: 99, global: { backendId: "omp", updatedAt: 1 }, byDirectory: {} }))
    expect(resolveDraftBackend("/repo/a", storage)).toBeNull()

    storage.setItem("oc.draftBackend.v1", JSON.stringify({
      version: 1,
      global: { backendId: 42, updatedAt: "now" },
      byDirectory: { "/repo/a": { backendId: "omp", updatedAt: 1 } },
    }))
    expect(resolveDraftBackend("/repo/a", storage)).toBe("omp")
    expect(resolveDraftBackend("/repo/unseen", storage)).toBeNull()
  })

  test("bounds retained directory entries, keeping the newest", () => {
    for (let index = 0; index < 55; index += 1) {
      rememberDraftBackend(`/repo/dir-${index}`, `backend-${index}`, storage)
    }
    const envelope = JSON.parse(storage.getItem("oc.draftBackend.v1") ?? "{}") as { byDirectory?: Record<string, unknown> }
    expect(Object.keys(envelope.byDirectory ?? {})).toHaveLength(50)
    expect(resolveDraftBackend("/repo/dir-54", storage)).toBe("backend-54")
    expect(resolveDraftBackend("/repo/dir-0", storage)).toBe("backend-54")
  })
})
