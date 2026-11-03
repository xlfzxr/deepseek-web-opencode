// Incrementally separates ordinary text from complete DSML/legacy tool-call blocks.
const OPEN_INVOKE = /<\s*(?:\|\s*DSML\s*\|\s*)?invoke\b[^>]*>/i;
const CLOSE_INVOKE = /<\/\s*(?:\|\s*DSML\s*\|\s*)?invoke\s*>/i;
const OPEN_INVOKE_PREFIX = /^<\s*(?:\|\s*DSML\s*\|\s*)?invoke\b[^>]*$/i;
const OPEN_TOOL_CALL = /<\s*tool_call\b[^>]*>/i;
const CLOSE_TOOL_CALL = /<\/\s*tool_call\s*>/i;
const OPEN_TOOL_CALL_PREFIX = /^<\s*tool_call\b[^>]*$/i;
const SAFE_START_TAIL = 64;
const JSON_TOOL_FENCES = ["```tool_json", "```json"];

function normalizeForDetection(text) {
  // Fullwidth pipes are canonical in the prompt. Replacement preserves string indices.
  return String(text || "").replace(/\uFF5C/g, "|");
}

function findOpeningTag(text) {
  const normalized = normalizeForDetection(text);
  const candidates = [
    { type: "dsml", match: OPEN_INVOKE.exec(normalized) },
    { type: "legacy", match: OPEN_TOOL_CALL.exec(normalized) },
  ].filter((candidate) => candidate.match);
  candidates.sort((left, right) => left.match.index - right.match.index);
  return candidates[0] || null;
}

export class DSMLStreamParser {
  constructor() {
    this.buffer = "";
    this.inToolCall = false;
    this.incompleteToolCall = false;
    this.deferredToolCandidate = false;
    this.toolCallCount = 0;
    this.initialized = false;
    this.currentTagType = "";
  }

  push(chunk, onText = () => {}, onToolCall = () => {}) {
    if (chunk !== undefined && chunk !== null) this.buffer += String(chunk);
    if (!this.buffer) return;

    if (!this.initialized) {
      const firstContent = this.buffer.trimStart();
      if (!firstContent) return;
      const lower = firstContent.toLowerCase();
      const matchingFence = JSON_TOOL_FENCES.find((fence) => lower.startsWith(fence));
      const partialFence = JSON_TOOL_FENCES.some(
        (fence) => lower.length < fence.length && fence.startsWith(lower),
      );
      if (firstContent.startsWith("{")) {
        // Legacy JSON tool calls must be classified before any part is streamed as text.
        this.deferredToolCandidate = true;
        this.initialized = true;
        return;
      }
      if (matchingFence) {
        this.deferredToolCandidate = true;
        this.initialized = true;
        return;
      }
      if (partialFence) return;
      this.initialized = true;
    }

    if (this.deferredToolCandidate) return;

    while (this.buffer.length > 0) {
      if (!this.inToolCall) {
        const normalizedBuffer = normalizeForDetection(this.buffer);
        const opening = findOpeningTag(this.buffer);
        if (!opening) {
          // Hold a trailing '<' candidate, including a long unfinished opening tag.
          const pendingStart = normalizedBuffer.lastIndexOf("<");
          const candidate = pendingStart >= 0 ? normalizedBuffer.slice(pendingStart) : "";
          const couldBeStart =
            candidate &&
            (candidate.length <= SAFE_START_TAIL ||
              OPEN_INVOKE_PREFIX.test(candidate) ||
              OPEN_TOOL_CALL_PREFIX.test(candidate));
          const safeLength = couldBeStart ? pendingStart : this.buffer.length;
          if (safeLength > 0) {
            onText(this.buffer.slice(0, safeLength));
            this.buffer = this.buffer.slice(safeLength);
          }
          break;
        }

        if (opening.match.index > 0) onText(this.buffer.slice(0, opening.match.index));
        this.buffer = this.buffer.slice(opening.match.index);
        this.inToolCall = true;
        this.currentTagType = opening.type;
        continue;
      }

      const closingPattern = this.currentTagType === "legacy" ? CLOSE_TOOL_CALL : CLOSE_INVOKE;
      const closing = closingPattern.exec(normalizeForDetection(this.buffer));
      if (!closing) break;

      const end = closing.index + closing[0].length;
      const block = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end);
      this.inToolCall = false;
      this.currentTagType = "";
      this.toolCallCount += 1;
      onToolCall(block);
    }
  }

  flush(onText = () => {}) {
    if (this.buffer) {
      if (this.inToolCall) {
        // Preserve incomplete markup as text; never silently drop a truncated stream tail.
        this.incompleteToolCall = true;
      }
      onText(this.buffer);
    }
    this.buffer = "";
    this.inToolCall = false;
    this.currentTagType = "";
  }

  reset() {
    this.buffer = "";
    this.inToolCall = false;
    this.incompleteToolCall = false;
    this.deferredToolCandidate = false;
    this.toolCallCount = 0;
    this.initialized = false;
    this.currentTagType = "";
  }
}
