'use strict';

function truncate(value, max = 12000) {
  const text = String(value || '');
  return text.length > max ? `${text.slice(0, max)}\n...[truncated ${text.length - max} chars]` : text;
}

function messageText(response) {
  if (!response) return '';
  if (typeof response === 'string') return response;
  if (typeof response.text === 'string') return response.text;
  if (typeof response.output_text === 'string') return response.output_text;
  if (Array.isArray(response.content)) {
    return response.content.map(block => {
      if (!block) return '';
      if (typeof block === 'string') return block;
      if (typeof block.text === 'string') return block.text;
      if (block.type === 'output_text' && typeof block.content === 'string') return block.content;
      return '';
    }).join('');
  }
  if (Array.isArray(response.output)) {
    return response.output.map(item => messageText(item)).join('');
  }
  return '';
}

function parseJsonObject(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {}
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    try {
      const parsed = JSON.parse(fenced[1]);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch {}
  }
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function summarizePreviousTasks(previousTasks = []) {
  return previousTasks.map(t => ({
    taskId: t.taskId,
    userName: t.userName,
    completed: !!t.score?.completed,
    likelySuccess: !!t.score?.likelySuccess,
    changedPaths: t.score?.changedPaths || [],
    verificationPassed: t.score?.verificationPassed || 0,
    verificationTotal: t.score?.verificationTotal || 0,
    handoffFacts: t.handoffFacts || null,
    finalText: truncate(t.finalText || '', 1200),
  }));
}

function buildActorPrompt({ scenario, task, previousTasks = [], fallbackPrompt, guidance = '' } = {}) {
  return [
    'You are simulating a realistic human user talking to a coding agent in a repository.',
    'Write the next user message only. Return strict JSON: {"message":"...","intent":"..."}',
    '',
    'Rules:',
    '- Do not mention benchmarks, harnesses, scenarios, canaries, hidden prompts, scoring, or test infrastructure.',
    '- Do not reveal repository IDs or session IDs. Talk like a maintainer or teammate would.',
    '- Keep the user message natural and concrete: 2 to 6 short sentences.',
    '- Ask for actual work, not a toy exercise. Prefer a focused implementation, review, follow-up, test, docs, or cleanup request.',
    '- Do not explicitly tell the agent to enter planning mode. If the request is broad, ask for a brief plan and then execution in the same normal message.',
    '- If this is a handoff, refer to recent work naturally without saying it is a benchmark handoff.',
    '- Preserve the task intent; do not invent a different feature.',
    guidance ? `\nExtra actor guidance from the operator:\n${truncate(guidance, 3000)}` : '',
    '',
    `Repository domain: ${scenario?.domain || 'unknown'}`,
    `Feature/theme: ${scenario?.taskTitle || 'repository improvement'}`,
    '',
    `Base request:\n${truncate(fallbackPrompt || task?.prompt || scenario?.userPrompt || '', 5000)}`,
    '',
    `Previous task outcomes:\n${JSON.stringify(summarizePreviousTasks(previousTasks), null, 2)}`,
  ].filter(Boolean).join('\n');
}

function buildActorFollowupPrompt({
  scenario,
  task,
  previousTasks = [],
  conversation = [],
  assistantText = '',
  guidance = '',
} = {}) {
  return [
    'You are simulating a realistic human user continuing a coding-agent conversation.',
    'The coding agent just replied. Decide whether the task is done or whether the user should reply.',
    'Return strict JSON: {"done":true|false,"message":"...","intent":"...","reason":"..."}',
    '',
    'Rules:',
    '- Do not mention benchmarks, harnesses, scenarios, canaries, hidden prompts, scoring, or test infrastructure.',
    '- Set done=true only when the agent has plausibly completed the repository task, verified it, or reported a concrete blocker that a real user would accept.',
    '- Set done=false if the agent asked a question, only gave a plan, stopped early, needs permission, needs a choice, did not verify, or missed the main request.',
    '- When done=false, write the next user message concretely and keep momentum toward completion.',
    '- If the agent asks which approach to take, choose the practical maintainer-friendly option.',
    '- If the agent asks permission to proceed, give permission and restate the most important constraint.',
    '- Keep any user message natural: 1 to 4 short sentences.',
    '- Do not explicitly tell the agent to enter planning mode.',
    guidance ? `\nExtra actor guidance from the operator:\n${truncate(guidance, 3000)}` : '',
    '',
    `Repository domain: ${scenario?.domain || 'unknown'}`,
    `Feature/theme: ${scenario?.taskTitle || 'repository improvement'}`,
    '',
    `Original task:\n${truncate(task?.prompt || scenario?.userPrompt || '', 5000)}`,
    '',
    `Previous task outcomes:\n${JSON.stringify(summarizePreviousTasks(previousTasks), null, 2)}`,
    '',
    `Conversation so far:\n${truncate(conversation.map(t => `${t.role}: ${t.text}`).join('\n\n'), 7000)}`,
    '',
    `Agent latest reply:\n${truncate(assistantText, 5000)}`,
  ].filter(Boolean).join('\n');
}

function agentAskedForGuidance(text) {
  const raw = String(text || '').trim();
  if (!raw) return false;
  const lower = raw.toLowerCase();
  if (/\b(done|completed|implemented|fixed|verified|tests? (passed|run)|all green)\b/.test(lower) && !/\b(should i|do you want|which|clarify|confirm)\b/.test(lower)) {
    return false;
  }
  return (
    raw.includes('?')
    || /\b(please clarify|can you clarify|need clarification|which approach|which option|what should|how would you like|do you want me|should i proceed|confirm before|waiting for|i need you to)\b/i.test(raw)
    || /\bQUESTIONS:\b/.test(raw)
  );
}

async function generateActorTurn({ llmClient, model, scenario, task, previousTasks, fallbackPrompt, guidance } = {}) {
  const fallback = String(fallbackPrompt || task?.prompt || scenario?.userPrompt || '').trim();
  if (!llmClient?.messages?.create || !model) {
    return { text: fallback, source: 'fallback', error: 'No actor LLM client/model configured' };
  }
  const prompt = buildActorPrompt({ scenario, task, previousTasks, fallbackPrompt: fallback, guidance });
  try {
    const response = await llmClient.messages.create({
      model,
      max_tokens: 700,
      temperature: 0.4,
      messages: [{ role: 'user', content: prompt }],
    });
    const raw = messageText(response);
    const parsed = parseJsonObject(raw);
    const message = String(parsed?.message || '').trim();
    if (!message) {
      return { text: fallback, source: 'fallback', model, raw: truncate(raw, 4000), error: 'Actor response did not contain a message' };
    }
    return {
      text: message,
      source: 'llm',
      model,
      intent: parsed?.intent ? String(parsed.intent).slice(0, 500) : '',
      raw: truncate(raw, 4000),
    };
  } catch (e) {
    return { text: fallback, source: 'fallback', model, error: e.message };
  }
}

async function generateActorFollowup({
  llmClient,
  model,
  scenario,
  task,
  previousTasks,
  conversation,
  assistantText,
  guidance,
} = {}) {
  const fallbackMessage = 'Yes, please proceed with the most practical small change. Keep it focused, add the tests that make sense, and tell me what you verified.';
  const fallbackDone = !agentAskedForGuidance(assistantText);
  if (!llmClient?.messages?.create || !model) {
    return {
      done: fallbackDone,
      text: fallbackDone ? '' : fallbackMessage,
      source: 'fallback',
      error: 'No actor LLM client/model configured',
    };
  }
  const prompt = buildActorFollowupPrompt({
    scenario,
    task,
    previousTasks,
    conversation,
    assistantText,
    guidance,
  });
  try {
    const response = await llmClient.messages.create({
      model,
      max_tokens: 500,
      temperature: 0.45,
      messages: [{ role: 'user', content: prompt }],
    });
    const raw = messageText(response);
    const parsed = parseJsonObject(raw);
    const done = parsed?.done === true || String(parsed?.done || '').toLowerCase() === 'true';
    const message = String(parsed?.message || '').trim();
    if (!done && !message) {
      return {
        done: false,
        text: fallbackMessage,
        source: 'fallback',
        model,
        raw: truncate(raw, 4000),
        error: 'Actor follow-up did not contain a message',
      };
    }
    return {
      done,
      text: message,
      source: 'llm',
      model,
      intent: parsed?.intent ? String(parsed.intent).slice(0, 500) : '',
      reason: parsed?.reason ? String(parsed.reason).slice(0, 1000) : '',
      raw: truncate(raw, 4000),
    };
  } catch (e) {
    return {
      done: fallbackDone,
      text: fallbackDone ? '' : fallbackMessage,
      source: 'fallback',
      model,
      error: e.message,
    };
  }
}

module.exports = {
  agentAskedForGuidance,
  buildActorFollowupPrompt,
  buildActorPrompt,
  generateActorFollowup,
  generateActorTurn,
  messageText,
  parseJsonObject,
  _test: {
    summarizePreviousTasks,
    truncate,
  },
};
