'use strict';

const DEFAULTS = {
  enabled: true,
  mode: 'adaptive',
  maxInputTokens: 4000,
  maxOutputTokens: 700,
  cooldownIterations: 2,
  allowEscalation: true,
};

const SPORE_CODE_POLICIES = new Set(['off', 'manual', 'adaptive', 'aggressive']);

function asBool(value, fallback = false) {
  if (value === undefined || value === null) return fallback;
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;
  return /^(1|true|yes|on)$/i.test(String(value));
}

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function textFromContent(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) {
    try { return JSON.stringify(content); } catch { return String(content); }
  }
  return content.map(block => {
    if (!block) return '';
    if (typeof block === 'string') return block;
    if (block.type === 'text') return block.text || '';
    if (block.type === 'tool_use') return `[tool_use ${block.name || 'tool'} ${safeStringify(block.input || {})}]`;
    if (block.type === 'tool_result') return `[tool_result ${block.tool_use_id || '?'} ${String(block.content || '').slice(0, 800)}]`;
    return block.text || block.content || safeStringify(block);
  }).filter(Boolean).join('\n');
}

function safeStringify(value) {
  try { return JSON.stringify(value); } catch { return String(value); }
}

function stripCodeFence(text) {
  const raw = String(text || '').trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(raw);
  return fenced ? fenced[1].trim() : raw;
}

function extractJsonObject(text) {
  const raw = stripCodeFence(text);
  try { return JSON.parse(raw); } catch { /* fall through */ }
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(raw.slice(start, end + 1)); } catch { /* fall through */ }
  }
  return null;
}

function normalizeAdvice(value) {
  if (!value || typeof value !== 'object') return null;
  const arr = key => Array.isArray(value[key])
    ? value[key].map(v => String(v || '').trim()).filter(Boolean).slice(0, 8)
    : [];
  return {
    reason: String(value.reason || '').trim().slice(0, 240),
    risk: String(value.risk || 'medium').trim().slice(0, 80),
    goal: String(value.goal || '').trim().slice(0, 300),
    constraints: arr('constraints'),
    next_actions: arr('next_actions'),
    avoid: arr('avoid'),
    verification: arr('verification'),
    escalate_to_planner: asBool(value.escalate_to_planner, false),
  };
}

function failureKey(entry) {
  const tool = String(entry?.tool || 'tool');
  const exit = entry?.exitCode ?? entry?.exit_code ?? '';
  const preview = String(entry?.resultPreview || entry?.error || '')
    .toLowerCase()
    .replace(/\b\d+\b/g, '#')
    .replace(/\s+/g, ' ')
    .slice(0, 120);
  return `${tool}:${exit}:${preview}`;
}

class PlannerAdvisor {
  constructor(config, logger) {
    this.config = config || {};
    this.log = logger || console;
  }

  settings() {
    const raw = this.config?.plannerAdvisor || {};
    return {
      ...DEFAULTS,
      ...raw,
      enabled: asBool(raw.enabled, DEFAULTS.enabled),
      maxInputTokens: clampInt(raw.maxInputTokens, DEFAULTS.maxInputTokens, 500, 20000),
      maxOutputTokens: clampInt(raw.maxOutputTokens, DEFAULTS.maxOutputTokens, 128, 4000),
      cooldownIterations: clampInt(raw.cooldownIterations, DEFAULTS.cooldownIterations, 0, 20),
      allowEscalation: asBool(raw.allowEscalation, DEFAULTS.allowEscalation),
    };
  }

  sporeCodeExtendedEnabled(opts = {}) {
    return this.sporeCodeAutomaticEnabled(opts);
  }

  sporeCodePolicy(opts = {}) {
    if (!(opts.platform === 'cli' && opts.projectContext)) return null;
    const slot = this.config?.plugins?.['spore-code'] || {};
    const raw = String(slot.plannerAdvisorPolicy || '').trim().toLowerCase();
    if (SPORE_CODE_POLICIES.has(raw)) return raw;
    if (slot.plannerAdvisorExtendedUsage !== undefined) {
      return asBool(slot.plannerAdvisorExtendedUsage, true) ? 'adaptive' : 'off';
    }
    return 'adaptive';
  }

  sporeCodeAutomaticEnabled(opts = {}) {
    const policy = this.sporeCodePolicy(opts);
    if (!policy) return true;
    return policy === 'adaptive' || policy === 'aggressive';
  }

  sporeCodeManualEnabled(opts = {}) {
    const policy = this.sporeCodePolicy(opts);
    if (!policy) return true;
    return policy !== 'off';
  }

  sporeCodeAggressiveEnabled(opts = {}) {
    return this.sporeCodePolicy(opts) === 'aggressive';
  }

  shouldAdvise(input = {}) {
    const {
      sessionKey,
      opts = {},
      activeModel,
      plannerModel,
      isCasualChat = false,
      iteration = 1,
      toolLog = [],
      tokenState = {},
      workflowStatus = null,
    } = input;
    const settings = this.settings();
    if (!settings.enabled || settings.mode === 'off') return { run: false, reason: 'disabled' };
    if (!plannerModel) return { run: false, reason: 'planner_unset' };
    if (activeModel && String(activeModel) === String(plannerModel)) return { run: false, reason: 'same_model' };
    if (isCasualChat) return { run: false, reason: 'casual' };
    if (!this.sporeCodeAutomaticEnabled(opts)) {
      const policy = this.sporeCodePolicy(opts);
      return { run: false, reason: policy === 'manual' ? 'spore_code_policy_manual' : 'spore_code_policy_off' };
    }

    const isSporeCode = opts.platform === 'cli' && !!opts.projectContext;
    const reasons = [];
    const content = String(opts.content || opts.messageContent || '').trim();
    const mode = String(opts.projectContext?.mode || '').toLowerCase();

    if (settings.mode === 'always') {
      reasons.push('always');
    }

    if (isSporeCode && iteration === 1 && this._looksLikeCliTask(content, opts)) {
      reasons.push('cli_task_start');
    }

    if (isSporeCode && iteration === 1 && mode === 'plan') {
      if (/^\s*\[RESEARCH\]/.test(content)) reasons.push('plan_phase_research');
      else if (/^\s*\[BUILD_PLAN\]/.test(content)) reasons.push('plan_phase_build');
      else if (/^\s*\[REVIEW\]/.test(content)) reasons.push('plan_phase_review');
      else reasons.push('plan_phase_intake');
    }

    if (isSporeCode && iteration === 1 && mode === 'execute' && workflowStatus?.artifacts?.planReady) {
      reasons.push('plan_to_execute');
    }

    if (isSporeCode && workflowStatus?.artifacts?.recovery?.active) {
      reasons.push('workflow_recovery');
    }

    if (opts.trigger === 'task_complete') reasons.push('delegate_result');

    const repeatedFailure = this._repeatedFailure(toolLog);
    if (repeatedFailure) reasons.push(`repeated_failure:${repeatedFailure.tool}`);

    const usedPercent = Number(tokenState.usedPercent || 0);
    if (usedPercent >= 70) reasons.push('context_pressure');
    if (isSporeCode && usedPercent >= 45) {
      reasons.push(`early_context_pressure:${Math.floor(usedPercent / 10) * 10}`);
    }

    if (isSporeCode && iteration >= 40) {
      reasons.push(`long_session:${Math.floor(iteration / 10) * 10}`);
    }

    const toolCount = Array.isArray(toolLog) ? toolLog.length : 0;
    if (isSporeCode && toolCount >= 50) {
      reasons.push(`many_tools:${Math.floor(toolCount / 25) * 25}`);
    }

    const repeatedRead = isSporeCode ? this._repeatedRead(toolLog) : null;
    if (repeatedRead) reasons.push(`repeated_read:${repeatedRead.path.slice(-80)}`);

    const largeToolResult = isSporeCode ? this._largeToolResult(toolLog) : null;
    if (largeToolResult) reasons.push(`large_tool_result:${largeToolResult.tool}`);

    if (!reasons.length) return { run: false, reason: 'no_trigger' };

    const seen = opts._plannerAdvisorReasons || (opts._plannerAdvisorReasons = new Set());
    const reasonKey = reasons.sort().join('|');
    if (seen.has(reasonKey)) return { run: false, reason: 'already_advised', reasons };
    seen.add(reasonKey);

    const last = opts._plannerAdvisorLast || null;
    if (last && iteration - last.iteration < settings.cooldownIterations && !reasons.some(r => r.startsWith('repeated_failure'))) {
      return { run: false, reason: 'cooldown', reasons };
    }
    opts._plannerAdvisorLast = { iteration, reasonKey, sessionKey };

    return { run: true, reasons, settings, repeatedFailure, repeatedRead, largeToolResult, toolCount };
  }

  async advise(input = {}) {
    let decision;
    if (input.force) {
      const settings = this.settings();
      const opts = input.opts || {};
      if (!settings.enabled || settings.mode === 'off') {
        return { run: false, skipped: true, reason: 'disabled' };
      }
      if (!input.plannerModel) {
        return { run: false, skipped: true, reason: 'planner_unset' };
      }
      if (!this.sporeCodeManualEnabled(opts)) {
        return { run: false, skipped: true, reason: 'spore_code_policy_off' };
      }
      decision = {
        run: true,
        reasons: Array.isArray(input.reasons) && input.reasons.length ? input.reasons : ['agent_requested'],
        settings,
        repeatedFailure: null,
      };
    } else {
      decision = this.shouldAdvise(input);
    }
    if (!decision.run) return { ...decision, skipped: true };
    const { client, plannerModel, opts = {}, abortSignal } = input;
    if (!client?.messages?.create) return { run: false, skipped: true, reason: 'no_client' };
    const prompt = this._systemPrompt();
    const userPayload = this._buildPayload(input, decision);
    const request = {
      model: plannerModel,
      max_tokens: decision.settings.maxOutputTokens,
      system: [{ type: 'text', text: prompt }],
      messages: [{ role: 'user', content: userPayload }],
      tools: [],
      _usageMeta: {
        source: 'planner-advisor',
        route: opts.trigger || opts.platform || null,
        platform: opts.platform || null,
        channelName: opts.channelName || opts.channelId || null,
        channelId: opts.channelId || null,
        trigger: opts.trigger || null,
        sessionKey: input.sessionKey || null,
      },
    };
    const started = Date.now();
    const response = abortSignal
      ? await client.messages.create(request, { signal: abortSignal })
      : await client.messages.create(request);
    const text = Array.isArray(response?.content)
      ? response.content.filter(b => b?.type === 'text').map(b => b.text || '').join('')
      : '';
    const parsed = normalizeAdvice(extractJsonObject(text));
    if (!parsed) {
      const fallback = this._fallbackAdvice(input, decision, text);
      return {
        ...decision,
        skipped: false,
        reason: 'malformed_response_fallback',
        advice: fallback,
        rendered: this.renderAdvice(fallback),
        plannerModel,
        fallback: true,
        malformed: true,
        rawText: text.slice(0, 1000),
        elapsedMs: Date.now() - started,
        usage: response?.usage || null,
        escalate: false,
      };
    }
    return {
      ...decision,
      skipped: false,
      advice: parsed,
      rendered: this.renderAdvice(parsed),
      plannerModel,
      elapsedMs: Date.now() - started,
      usage: response?.usage || null,
      escalate: decision.settings.allowEscalation && parsed.escalate_to_planner,
    };
  }

  renderAdvice(advice = {}) {
    const lines = [
      '## Planner Advisor Guidance',
      '[Hidden advisory context from the planner model. Use it to guide this turn, but do not mention that a hidden planner was used.]',
    ];
    if (advice.reason) lines.push(`Reason: ${advice.reason}`);
    if (advice.risk) lines.push(`Risk: ${advice.risk}`);
    if (advice.goal) lines.push(`Goal: ${advice.goal}`);
    const add = (label, values) => {
      if (!Array.isArray(values) || !values.length) return;
      lines.push(`${label}:`);
      for (const value of values.slice(0, 8)) lines.push(`- ${value}`);
    };
    add('Constraints', advice.constraints);
    add('Next actions', advice.next_actions);
    add('Avoid', advice.avoid);
    add('Verification', advice.verification);
    if (advice.escalate_to_planner) lines.push('Escalation: run this turn on the planner model.');
    return lines.join('\n');
  }

  _systemPrompt() {
    return [
      'You are Spore\'s planner advisor. Your job is to cheaply guide a lower-tier agent, not to solve the task.',
      'Return compact JSON only. No markdown, no prose outside JSON.',
      'Be concrete, evidence-driven, and skeptical of premature claims.',
      'If the lower-tier model should keep executing, set escalate_to_planner=false.',
      'Set escalate_to_planner=true only when the next turn is high-risk, stuck, or requires stronger synthesis.',
      '',
      'JSON schema:',
      '{"reason":"string","risk":"low|medium|high","goal":"string","constraints":["string"],"next_actions":["string"],"avoid":["string"],"verification":["string"],"escalate_to_planner":false}',
    ].join('\n');
  }

  _buildPayload(input = {}, decision = {}) {
    const settings = decision.settings || this.settings();
    const maxChars = Math.max(1000, settings.maxInputTokens * 4);
    const opts = input.opts || {};
    const messages = Array.isArray(input.messages) ? input.messages : [];
    const recent = messages.slice(-10).map((msg, i) => ({
      i,
      role: msg.role,
      text: textFromContent(msg.content).slice(0, 1200),
    }));
    const failures = (input.toolLog || [])
      .filter(t => t && !t.pending && (t.succeeded === false || (Number.isFinite(Number(t.exitCode)) && Number(t.exitCode) !== 0)))
      .slice(-8)
      .map(t => ({
        tool: t.tool,
        exitCode: t.exitCode ?? null,
        input: String(t.input || '').slice(0, 240),
        result: String(t.resultPreview || '').slice(0, 500),
      }));
    const payload = {
      triggers: decision.reasons || [],
      activeModel: input.activeModel || null,
      plannerModel: input.plannerModel || null,
      platform: opts.platform || null,
      trigger: opts.trigger || null,
      projectContext: opts.projectContext ? {
        mode: opts.projectContext.mode || null,
        cwd: opts.projectContext.cwd || null,
        project: opts.projectContext.project || null,
        os: opts.projectContext.os || opts.projectContext.platform || null,
        hasCodeIndex: !!opts.projectContext.hasCodeIndex,
      } : null,
      workflowStatus: input.workflowStatus ? {
        phase: input.workflowStatus.phase,
        status: input.workflowStatus.status,
        taskSummary: input.workflowStatus.taskSummary || input.workflowStatus.tasks || null,
        recovery: input.workflowStatus.artifacts?.recovery || null,
        contextPressure: input.workflowStatus.artifacts?.contextPressure || null,
      } : null,
      tokenState: input.tokenState || null,
      userRequest: String(opts.content || opts.messageContent || '').slice(0, 1800),
      advisorRequest: input.advisorRequest || null,
      recentMessages: recent,
      recentFailures: failures,
      toolTelemetry: {
        totalToolCalls: Array.isArray(input.toolLog) ? input.toolLog.length : 0,
        repeatedRead: decision.repeatedRead || null,
        largeToolResult: decision.largeToolResult || null,
      },
      instruction: 'Advise the lower-tier model on what to do next. Keep it compact and operational.',
    };
    const text = JSON.stringify(payload, null, 2);
    if (text.length <= maxChars) return text;
    payload.recentMessages = recent.slice(-4);
    payload.userRequest = payload.userRequest.slice(0, 1000);
    const shorter = JSON.stringify(payload, null, 2);
    return shorter.length <= maxChars ? shorter : shorter.slice(0, maxChars);
  }

  _fallbackAdvice(input = {}, decision = {}, rawText = '') {
    const reasons = Array.isArray(decision.reasons) ? decision.reasons : [];
    const recovery = input.workflowStatus?.artifacts?.recovery || null;
    const repeated = decision.repeatedFailure || null;
    const repeatedRead = decision.repeatedRead || null;
    const largeToolResult = decision.largeToolResult || null;
    const constraints = [
      'Base claims only on current tool output and workflow_status, not on assumptions from earlier attempts.',
      'Before declaring done, name the exact changed files and exact verification commands that passed.',
    ];
    const next = [];
    const avoid = [
      'Do not repeat a failed command unchanged unless a relevant edit landed after that failure.',
      'Do not create duplicate task_create rows for approved workflow tasks; use existing task_progress ids.',
    ];
    const verification = ['Run the smallest relevant verification first, then a broader check when the narrow check passes.'];
    if (recovery?.active || reasons.includes('workflow_recovery')) {
      next.push('Call workflow_status, then git_status/git_diff to establish current WIP before editing.');
      next.push('Use the latest failing command output to make one narrow edit, then rerun that exact check.');
      constraints.push('Recovery is active: avoid large write_file rewrites and avoid destructive git commands.');
    } else if (repeated) {
      next.push('Stop retrying the same failing path; inspect the exact error and read the smallest relevant file range.');
      next.push('If the environment/tool is the blocker, report it precisely instead of fabricating a workaround.');
    } else {
      next.push('Identify the current workflow task, mark it in_progress, and do the next concrete edit or check.');
      next.push('If uncertain about the repo state, use workflow_status plus targeted read/grep before editing.');
    }
    if (reasons.some(r => r.startsWith('long_session') || r.startsWith('many_tools') || r.startsWith('early_context_pressure'))) {
      constraints.push('Context/tool budget is under pressure: continue the current workflow task, avoid broad re-reading, and prefer one narrow command at a time.');
      avoid.push('Do not restart discovery from the beginning or re-state the full plan unless workflow_status shows it is missing.');
    }
    if (repeatedRead) {
      next.push(`Stop re-reading ${repeatedRead.path}; use the already observed facts or read a narrower range only if the file changed.`);
      avoid.push('Do not use helper scripts to read files when read_file/read_many_files already work.');
    }
    if (largeToolResult) {
      next.push(`The recent ${largeToolResult.tool} result was very large; switch to narrower inputs or summarize only top failures.`);
      constraints.push('Keep subsequent tool output small enough to preserve working context.');
    }
    const rawDiagnostic = String(rawText || '')
      .replace(/```(?:json)?/gi, '')
      .replace(/```/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 360);
    if (rawDiagnostic) {
      constraints.push('The planner response was malformed; this is deterministic fallback guidance.');
      next.push(`Planner raw diagnostic: ${rawDiagnostic}`);
    }
    return normalizeAdvice({
      reason: reasons.length ? reasons.join(', ') : 'planner fallback',
      risk: recovery?.active ? 'high' : 'medium',
      goal: 'Recover execution quality by grounding the next step in current workflow evidence.',
      constraints,
      next_actions: next,
      avoid,
      verification,
      escalate_to_planner: false,
    });
  }

  _looksLikeCliTask(content, opts = {}) {
    const text = String(content || '');
    if (/^\s*\[(?:RESEARCH|REVIEW|BUILD_PLAN)\]/.test(text)) return true;
    if (opts.projectContext?.mode === 'plan') return true;
    return /\b(file|code|read|edit|exec|run|build|install|script|create|generate|fix|update|refactor|search|find|query|research|analyze|summarize|compare|add|remove|change|make|configure|modify|replace|test|debug|implement|design|compile|parse|merge|connect|publish|serve|start|enable|disable|optimize)\b/i.test(text);
  }

  _repeatedFailure(toolLog = []) {
    const recent = (Array.isArray(toolLog) ? toolLog : []).slice(-12);
    let start = 0;
    for (let i = recent.length - 1; i >= 0; i -= 1) {
      const item = recent[i];
      if (item?.pending) continue;
      const succeeded = item && item.succeeded !== false && (!Number.isFinite(Number(item.exitCode)) || Number(item.exitCode) === 0);
      if (succeeded && /\b(?:go\s+(?:build|test)\s+\.\/\.\.\.|npm\s+(?:run\s+)?test|pnpm\s+(?:run\s+)?test|yarn\s+(?:run\s+)?test|bun\s+(?:run\s+)?test|cargo\s+(?:test|check))\b/i.test(String(item.input || ''))) {
        start = i + 1;
        break;
      }
    }
    const failed = recent
      .slice(start)
      .filter(t => t && !t.pending && (t.succeeded === false || (Number.isFinite(Number(t.exitCode)) && Number(t.exitCode) !== 0)));
    if (failed.length < 2) return null;
    const counts = new Map();
    for (const item of failed.slice(-8)) {
      const key = failureKey(item);
      const count = (counts.get(key) || 0) + 1;
      counts.set(key, count);
      if (count >= 2) return { tool: item.tool || 'tool', key };
    }
    return null;
  }

  _repeatedRead(toolLog = []) {
    const recent = (Array.isArray(toolLog) ? toolLog : []).slice(-30);
    const counts = new Map();
    for (const item of recent) {
      if (!item || !['read_file', 'read_many_files', 'get_snippet'].includes(item.tool)) continue;
      let parsed = null;
      try { parsed = JSON.parse(item.input || '{}'); } catch { parsed = null; }
      const paths = [];
      if (parsed?.path) paths.push(parsed.path);
      if (Array.isArray(parsed?.paths)) paths.push(...parsed.paths);
      if (!paths.length && parsed?.file) paths.push(parsed.file);
      for (const raw of paths) {
        const path = String(raw || '').replace(/\\/g, '/').trim();
        if (!path) continue;
        const count = (counts.get(path) || 0) + 1;
        counts.set(path, count);
        if (count >= 3) return { path, count };
      }
    }
    return null;
  }

  _largeToolResult(toolLog = []) {
    const recent = (Array.isArray(toolLog) ? toolLog : []).slice(-8);
    for (let i = recent.length - 1; i >= 0; i -= 1) {
      const item = recent[i];
      const chars = Number(item?.resultChars || item?.modelResultChars || 0);
      if (Number.isFinite(chars) && chars >= 20000) {
        return { tool: item.tool || 'tool', chars };
      }
    }
    return null;
  }
}

module.exports = { PlannerAdvisor, DEFAULTS };
