// The quality floor: a message only counts toward the reveal ladder if it has
// at least 5 alphanumeric characters and isn't a throwaway filler word.
const FILLER = new Set([
  'hmm', 'hmmm', 'ok', 'okay', 'okk', 'okie', 'yes', 'ya', 'yaa', 'yeah', 'yep', 'yup',
  'ig', 'k', 'kk', 'lol', 'haha', 'hahaha', 'hehe', 'lmao', 'rofl',
  'hi', 'hii', 'hiii', 'hey', 'heyy', 'hello', 'hellooo', 'yo', 'sup',
  'nice', 'cool', 'oh', 'ohh', 'ah', 'ahh', 'acha', 'accha', 'hm',
  'idk', 'same', 'true', 'fr', 'frr', 'wow', 'omg', 'bye', 'gn', 'gm',
  'thanks', 'thx', 'ty', 'welcome', 'np', 'sure', 'fine', 'good', 'great',
]);

const MSGS_PER_STAGE = 4; // 4 → stage 1, 8 → stage 2, 12 → stage 3 (shatter)
const MAX_STAGE = 3;

function isMeaningful(text) {
  const trimmed = String(text || '').trim();
  const alnum = (trimmed.match(/[\p{L}\p{N}]/gu) || []).length;
  if (alnum < 5) return false;
  const normalized = trimmed.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  if (FILLER.has(normalized)) return false;
  return true;
}

/**
 * Stage from the thread state. The ladder only starts once BOTH people have
 * sent at least one message; from then on every 4 meaningful messages
 * (combined) advances one stage.
 */
function computeStage({ bothSent, meaningfulCount }) {
  if (!bothSent) return 0;
  return Math.min(MAX_STAGE, Math.floor(meaningfulCount / MSGS_PER_STAGE));
}

function progressToNext({ bothSent, meaningfulCount }) {
  const stage = computeStage({ bothSent, meaningfulCount });
  if (stage >= MAX_STAGE) return { stage, toNext: 0 };
  if (!bothSent) return { stage: 0, toNext: MSGS_PER_STAGE };
  return { stage, toNext: (stage + 1) * MSGS_PER_STAGE - meaningfulCount };
}

module.exports = { isMeaningful, computeStage, progressToNext, MSGS_PER_STAGE, MAX_STAGE, FILLER };
