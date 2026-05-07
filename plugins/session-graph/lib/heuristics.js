// Heuristic: does the user message look task-shaped (filesystem-driven
// coding work)? Used by the recall-skip decision in core's
// graph/context.js — a positive answer skips the per-turn LLM-driven
// recall pipeline because tool-using agents on a coding turn need
// filesystem access, not "what did we talk about last week".
//
// Conservative — any positive signal trips skip; everything else still
// gets full recall. Aggregation/recall-shaped queries are filtered
// upstream by queryType, so this only sees specific/task-shaped ones.

const _CODING_FILE_RE = /[\/\\]?[A-Za-z0-9_.\-]+\.(?:py|js|jsx|ts|tsx|mjs|cjs|go|rs|java|kt|c|cc|cpp|h|hpp|cs|rb|php|lua|sh|bash|zsh|fish|sql|html|css|scss|less|md|json|jsonc|toml|yaml|yml|xml|ini|env|dockerfile|makefile|gradle|cmake|proto|graphql|gql|svelte|vue)\b/i;
const _CODING_VERB_RE = /\b(?:read|edit|write|create|delete|rename|move|copy|fix|refactor|build|run|exec|test|debug|grep|find|search|implement|add|remove|update|patch|merge|rebase|commit|push|deploy|install|compile|lint|format|stub|mock|wire|hook|port|migrate|generate|scaffold)\b/i;
const _CODING_TOOL_RE = /\b(?:read_file|write_file|edit_file|exec|glob|grep|web_fetch|web_search|bash|terminal|file)\b/i;
const _CODE_FENCE_RE = /```/;
const _COMMAND_RE = /^\s*[\$>]?\s*(?:npm|yarn|pnpm|bun|go|cargo|pip|pip3|python|python3|node|deno|make|just|docker|git|ls|cd|cat|grep|sed|awk|find|curl|wget)\s/i;
const _GENERAL_CAPABILITY_RE = /\b(?:what|which|tell\s+me|show|list)\b[\s\S]{0,40}\b(?:can|could|are\s+you\s+able\s+to)\b[\s\S]{0,40}\bdo\b/i;
const _CAPABILITY_RE = /\b(?:what|which|list|show|tell\s+me|do\s+you|can\s+you|available|have|access)\b[\s\S]{0,80}\b(?:tools?|capabilit(?:y|ies)|browser|browse|web|internet|graph|memory|shell|terminal|files?|exec)\b/i;
const _CAPABILITY_REVERSE_RE = /\b(?:tools?|capabilit(?:y|ies)|browser|browse|web|internet|graph|memory|shell|terminal|files?|exec)\b[\s\S]{0,80}\b(?:what|which|list|show|available|have|access|can\s+you|do\s+you)\b/i;

function looksLikeCodingTurn(text) {
  if (!text || typeof text !== 'string') return false;
  if (_CODE_FENCE_RE.test(text)) return true;
  if (_CODING_FILE_RE.test(text)) return true;
  if (_CODING_TOOL_RE.test(text)) return true;
  if (_COMMAND_RE.test(text)) return true;
  // Verb check is the loosest — only count it when paired with some
  // code-context cue (short and direct, OR includes another code-
  // shaped fragment). Pure prose like "I should refactor my schedule"
  // shouldn't trip this.
  if (_CODING_VERB_RE.test(text) && (text.length < 240 || /\.[a-z]{1,5}\b/i.test(text))) return true;
  return false;
}

function looksLikeCapabilityQuestion(text) {
  if (!text || typeof text !== 'string') return false;
  return _GENERAL_CAPABILITY_RE.test(text) || _CAPABILITY_RE.test(text) || _CAPABILITY_REVERSE_RE.test(text);
}

module.exports = { looksLikeCodingTurn, looksLikeCapabilityQuestion };
