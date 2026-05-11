// Default User-Agent regex for known LLM crawlers and AI fetchers. Extend
// this in your own worker by composing a new RegExp with the source:
//   new RegExp(LLM_BOT_UA.source + "|mybot", "i")
//
// Sources / references:
//   - https://platform.openai.com/docs/bots
//   - https://docs.anthropic.com/en/docs/agents-and-tools/claude-bot
//   - https://docs.perplexity.ai/guides/bots
//   - https://support.apple.com/en-us/119829 (Applebot-Extended)
//   - https://developers.google.com/search/docs/crawling-indexing/google-special-case-crawlers (Google-Extended)

export const LLM_BOT_UA =
  /gptbot|chatgpt-user|oai-searchbot|claudebot|claude-web|anthropic-ai|perplexitybot|ccbot|applebot-extended|google-extended|cohere-ai|bytespider|diffbot/i;
