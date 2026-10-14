/**
 * ACP prompt shaping shared by the transport and the optimistic layer.
 *
 * ACP has no synthetic-message route, so context items (inline comments,
 * terminal output, session knowledge) are folded into the prompt text ahead
 * of it. Both `OpencodeService.sendAcpMessage` (what the server echoes) and
 * `optimisticSend` (what the UI shows instantly) fold through here, so the
 * optimistic user record matches the server echo exactly and reconciles in
 * place when it arrives. Changing the join changes both sides together.
 */

/**
 * Blank items carry no record anywhere; they are dropped before folding.
 *
 * A leading slash command stays first: ACP agents recognize `/name` textually
 * at the start of the prompt, so context folded ahead of it would bury the
 * command and the agent would answer in prose instead of running it.
 */
export const foldAcpPromptText = (text: string, contexts: ReadonlyArray<{ text: string }>): string => {
  const contextText = contexts
    .map((item) => item.text.trim())
    .filter((part) => part.length > 0)
    .join("\n\n")
  if (!contextText) return text
  if (text.startsWith("/")) return `${text}\n\n${contextText}`
  return `${contextText}\n\n${text}`
}
