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

/** Blank items carry no record anywhere; they are dropped before folding. */
export const foldAcpPromptText = (text: string, contexts: ReadonlyArray<{ text: string }>): string => {
  const contextText = contexts
    .map((item) => item.text.trim())
    .filter((part) => part.length > 0)
    .join("\n\n")
  return contextText ? `${contextText}\n\n${text}` : text
}
