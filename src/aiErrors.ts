/**
 * Turn an AI provider error into one plain sentence that says what to do (the chat shows it when a request fails).
 * The original text is kept short at the end for whoever needs the detail.
 */
export function friendlyAiError(raw: string): string {
  const m = String(raw ?? "");
  const detail = m.length > 160 ? m.slice(0, 157) + "…" : m;
  const say = (text: string) => `${text} (Details: ${detail})`;
  if (/No API key for|API key is missing|OPENAI_API_KEY is not set/i.test(m)) return m;          // already plain
  if (/insufficient_quota|exceeded your current quota|credit balance is too low|billing|payment required|out of credits?/i.test(m))
    return say("Your AI key has no credit left. Add credit with your AI provider (for OpenAI: platform.openai.com → Billing), or pick another AI model in the Livecrafts app → Integrations → AI models. Then press Retry.");
  if (/incorrect api key|invalid[_ -]?api[_ -]?key|invalid x-api-key|authentication|unauthorized|\b401\b/i.test(m))
    return say("Your AI key was rejected. Check it in the Livecrafts app → Integrations → AI models (copy it again from your provider), then press Retry.");
  if (/model .*(does not exist|not found|not available)|no access to (the )?model|model_not_found|\b404\b.*model/i.test(m))
    return say("This AI model is not available on your key. Pick another model in the chat's model menu or in Integrations → AI models.");
  if (/rate.?limit|too many requests|\b429\b|overloaded|\b529\b/i.test(m))
    return say("The AI service is busy or rate-limited right now. Wait a minute, then press Retry.");
  if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|fetch failed|network|socket hang up|Cannot connect to API/i.test(m))
    return say("Livecrafts could not reach the AI service. Check this computer's internet connection, then press Retry.");
  return m;
}
