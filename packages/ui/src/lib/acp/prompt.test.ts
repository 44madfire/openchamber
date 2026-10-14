import { describe, expect, test } from "bun:test"
import { foldAcpPromptText } from "./prompt"

describe("foldAcpPromptText", () => {
  test("joins non-blank context ahead of the prompt", () => {
    expect(foldAcpPromptText("question", [{ text: "one" }, { text: "  " }, { text: "two" }])).toBe(
      "one\n\ntwo\n\nquestion",
    )
  })

  test("leaves the prompt untouched without context", () => {
    expect(foldAcpPromptText("question", [])).toBe("question")
    expect(foldAcpPromptText("question", [{ text: "   " }])).toBe("question")
  })
})
