import { describe, expect, test } from "bun:test"
import { isAcpSessionId } from "./session-key"

describe("isAcpSessionId", () => {
  test("accepts raw-native keys", () => {
    expect(isAcpSessionId("ses_acp-omp_rs01ABc-_2")).toBe(true)
    expect(isAcpSessionId("ses_acp-opencode_rs1")).toBe(true)
    expect(isAcpSessionId("ses_acp-pi-acp_rnative-id_09")).toBe(true)
  })

  test("accepts base64url-native keys", () => {
    expect(isAcpSessionId("ses_acp-omp_eYWJjLWRlZg")).toBe(true)
  })

  test("accepts undecodable base64url (shape only, routing must not depend on it)", () => {
    expect(isAcpSessionId("ses_acp-omp_e!!!")).toBe(false) // not even the alphabet
    expect(isAcpSessionId("ses_acp-omp_e____")).toBe(true)
  })

  test("rejects OpenCode HTTP ids and near-misses", () => {
    expect(isAcpSessionId("ses_01ABc2")).toBe(false)
    expect(isAcpSessionId("ses_acp-")).toBe(false)
    expect(isAcpSessionId("ses_acp-omp")).toBe(false)
    expect(isAcpSessionId("ses_acp-omprnative")).toBe(false)
    expect(isAcpSessionId("ses_acp-Omp_rnative")).toBe(false)
    expect(isAcpSessionId("ses_acp-omp_xnative")).toBe(false)
    expect(isAcpSessionId("ses_acp-omp_r")).toBe(false)
    expect(isAcpSessionId("ses_acp-omp_rnative with space")).toBe(false)
    expect(isAcpSessionId("")).toBe(false)
    expect(isAcpSessionId(undefined)).toBe(false)
    expect(isAcpSessionId(null)).toBe(false)
    expect(isAcpSessionId(42)).toBe(false)
  })

  test("rejects keys longer than 128 characters", () => {
    expect(isAcpSessionId(`ses_acp-omp_r${"a".repeat(128)}`)).toBe(false)
    expect(isAcpSessionId(`ses_acp-omp_r${"a".repeat(114)}`)).toBe(true)
  })
})
