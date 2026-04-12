/**
 * data-poller.js — Secure Scheduled SSH Data Poller
 *
 * Runs predefined read-only commands on SSH hosts at configurable intervals
 * and writes parsed JSON output to the web serve directory for dashboards.
 *
 * Security model:
 *   - Commands come from a hardcoded template registry (not LLM-composable)
 *   - Uses SSHManager.remoteExec() — keys stay in the encrypted keystore
 *   - Minimum poll interval enforced in code (60s)
 *   - Maximum concurrent pollers enforced (3)
 *   - All operations audit-logged
 *   - Poller configs are persisted to disk and auto-restored on restart
 */

const fs = require('fs');
const path = require('path');

const MIN_INTERVAL_MS = 60_000;
const MAX_POLLERS = 3;
const MAX_CONSECUTIVE_FAILURES = 5;
const MAX_OUTPUT_BYTES = 65536;
const TEMPLATES = {
  'slurm-status': {
    label: 'Slurm Cluster Status',
    command: [
      'squeue --format="%i|%j|%u|%T|%M|%l|%D|%R" --noheader 2>/dev/null',
      'echo "---SECTION---"',
      'sinfo --format="%P|%a|%l|%D|%T|%N" --noheader 2>/dev/null',
      'echo "---SECTION---"',
      'uptime',
      'echo "---SECTION---"',
      'free -h | head -3',
    ].join('; '),
    parser: 'slurm',
    maxOutputBytes: MAX_OUTPUT_BYTES,
  },
  'node-health': {
    label: 'Login Node Health',
    command: 'uptime; echo "---SECTION---"; free -h | head -3; echo "---SECTION---"; df -h /; echo "---SECTION---"; who | wc -l',
    parser: 'health',
    maxOutputBytes: 4096,
  },
  'gpu-utilization': {
    label: 'GPU Utilization',
    command: 'nvidia-smi --query-gpu=index,name,utilization.gpu,utilization.memory,memory.used,memory.total,temperature.gpu --format=csv,noheader,nounits 2>/dev/null || echo "nvidia-smi not available"',
    parser: 'gpu',
    maxOutputBytes: 16384,
  },
};

class DataPoller {
  constructor(sshManager, log, auditFn, dataDir) {
    this._ssh = sshManager;
    this._log = log;
    this._audit = auditFn || (() => {});
    this._pollers = new Map();
    this._persistFile = path.join(dataDir || '.', '.data-pollers.json');
  }

  getTemplates() {
    return Object.entries(TEMPLATES).map(([id, t]) => ({ id, label: t.label }));
  }

  start(hostId, templateId, intervalMs, outputDir) {
    if (this._pollers.size >= MAX_POLLERS) {
      return { error: `Maximum ${MAX_POLLERS} concurrent pollers reached. Stop one first.` };
    }

    const template = TEMPLATES[templateId];
    if (!template) {
      return { error: `Unknown template "${templateId}". Available: ${Object.keys(TEMPLATES).join(', ')}` };
    }

    const host = this._ssh.hosts?.find(h => h.id === hostId);
    if (!host) {
      return { error: `Unknown host "${hostId}"` };
    }

    const effectiveInterval = Math.max(intervalMs || 120_000, MIN_INTERVAL_MS);
    const pollerId = `poll_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const outputFile = path.join(outputDir || 'web', `${templateId}.json`);

    try {
      const dir = path.dirname(outputFile);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    } catch (e) {
      return { error: `Cannot create output directory: ${e.message}` };
    }

    const state = {
      pollerId,
      hostId,
      hostName: host.name || host.hostname,
      templateId,
      templateLabel: template.label,
      intervalMs: effectiveInterval,
      outputFile,
      consecutiveFailures: 0,
      lastPollAt: null,
      lastSuccess: null,
      lastError: null,
      pollCount: 0,
      timer: null,
    };

    const tick = async () => {
      state.pollCount++;
      state.lastPollAt = new Date().toISOString();

      try {
        const result = await this._ssh.remoteExec(hostId, template.command, {
          timeout: Math.min(30000, effectiveInterval * 0.8),
        });

        let output = (result.stdout || '') + (result.stderr ? '\n' + result.stderr : '');
        if (output.length > (template.maxOutputBytes || MAX_OUTPUT_BYTES)) {
          output = output.substring(0, template.maxOutputBytes || MAX_OUTPUT_BYTES);
        }

        const parsed = this._parse(template.parser, output, result.exitCode);
        parsed._meta = {
          pollerId,
          template: templateId,
          host: state.hostName,
          polledAt: state.lastPollAt,
          pollCount: state.pollCount,
          intervalSeconds: Math.round(effectiveInterval / 1000),
        };

        fs.writeFileSync(outputFile, JSON.stringify(parsed, null, 2));
        state.consecutiveFailures = 0;
        state.lastSuccess = state.lastPollAt;
        state.lastError = null;

        this._audit('poller', 'poll_success', {
          pollerId, templateId, hostId, pollCount: state.pollCount,
        });
      } catch (e) {
        state.consecutiveFailures++;
        state.lastError = e.message;

        this._audit('poller', 'poll_failure', {
          pollerId, templateId, hostId, error: e.message,
          consecutiveFailures: state.consecutiveFailures,
        });
        this._log.warn(`[data-poller] ${pollerId} failed (${state.consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}): ${e.message}`);

        if (state.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          this._log.error(`[data-poller] ${pollerId} stopped after ${MAX_CONSECUTIVE_FAILURES} consecutive failures`);
          this.stop(pollerId);
          return;
        }
      }
    };

    tick();
    state.timer = setInterval(tick, effectiveInterval);
    if (state.timer.unref) state.timer.unref();

    this._pollers.set(pollerId, state);
    this._persist();

    this._audit('poller', 'start', {
      pollerId, templateId, hostId, intervalMs: effectiveInterval, outputFile,
    });
    this._log.info(`[data-poller] Started ${pollerId}: ${template.label} on ${state.hostName} every ${Math.round(effectiveInterval / 1000)}s -> ${outputFile}`);

    return {
      pollerId,
      template: templateId,
      host: state.hostName,
      intervalSeconds: Math.round(effectiveInterval / 1000),
      outputFile,
    };
  }

  stop(pollerId) {
    const state = this._pollers.get(pollerId);
    if (!state) return { error: `No active poller with ID "${pollerId}"` };

    if (state.timer) clearInterval(state.timer);
    this._pollers.delete(pollerId);
    this._persist();

    this._audit('poller', 'stop', { pollerId, pollCount: state.pollCount });
    this._log.info(`[data-poller] Stopped ${pollerId} after ${state.pollCount} polls`);

    return { stopped: pollerId, totalPolls: state.pollCount };
  }

  list() {
    return [...this._pollers.values()].map(s => ({
      pollerId: s.pollerId,
      template: s.templateId,
      host: s.hostName,
      intervalSeconds: Math.round(s.intervalMs / 1000),
      outputFile: s.outputFile,
      pollCount: s.pollCount,
      lastPollAt: s.lastPollAt,
      lastSuccess: s.lastSuccess,
      lastError: s.lastError,
      consecutiveFailures: s.consecutiveFailures,
    }));
  }

  stopAll() {
    for (const [id] of this._pollers) this.stop(id);
  }

  _persist() {
    try {
      const configs = [...this._pollers.values()].map(s => ({
        hostId: s.hostId,
        templateId: s.templateId,
        intervalMs: s.intervalMs,
        outputDir: path.dirname(s.outputFile),
      }));
      fs.writeFileSync(this._persistFile, JSON.stringify(configs, null, 2));
    } catch (e) {
      this._log.warn(`[data-poller] Failed to persist config: ${e.message}`);
    }
  }

  restore() {
    let configs;
    try {
      configs = JSON.parse(fs.readFileSync(this._persistFile, 'utf8'));
    } catch {
      return { restored: 0 };
    }
    if (!Array.isArray(configs) || configs.length === 0) return { restored: 0 };

    let restored = 0;
    const errors = [];
    for (const cfg of configs) {
      const result = this.start(cfg.hostId, cfg.templateId, cfg.intervalMs, cfg.outputDir);
      if (result.error) {
        errors.push(`${cfg.templateId}@${cfg.hostId}: ${result.error}`);
        this._log.warn(`[data-poller] Restore failed for ${cfg.templateId}@${cfg.hostId}: ${result.error}`);
      } else {
        restored++;
        this._log.info(`[data-poller] Restored ${cfg.templateId} on ${result.host} every ${result.intervalSeconds}s`);
      }
    }
    return { restored, total: configs.length, errors: errors.length > 0 ? errors : undefined };
  }

  _parse(parserId, raw, exitCode) {
    const sections = raw.split('---SECTION---').map(s => s.trim());

    if (parserId === 'slurm') {
      return {
        jobs: this._parseSqueueOutput(sections[0] || ''),
        partitions: this._parseSinfoOutput(sections[1] || ''),
        uptime: sections[2] || '',
        memory: sections[3] || '',
        exitCode,
      };
    }

    if (parserId === 'health') {
      return {
        uptime: sections[0] || '',
        memory: sections[1] || '',
        disk: sections[2] || '',
        activeUsers: parseInt(sections[3]) || 0,
        exitCode,
      };
    }

    if (parserId === 'gpu') {
      return {
        gpus: raw.split('\n').filter(Boolean).map(line => {
          const parts = line.split(',').map(s => s.trim());
          return {
            index: +parts[0], name: parts[1],
            gpuUtil: +parts[2], memUtil: +parts[3],
            memUsed: +parts[4], memTotal: +parts[5], temp: +parts[6],
          };
        }),
        exitCode,
      };
    }

    return { raw, exitCode };
  }

  _parseSqueueOutput(text) {
    if (!text) return [];
    return text.split('\n').filter(Boolean).map(line => {
      const [jobId, name, user, state, time, timeLimit, nodes, reason] = line.split('|').map(s => s.trim());
      return { jobId, name, user, state, time, timeLimit, nodes: +nodes || 0, reason };
    });
  }

  _parseSinfoOutput(text) {
    if (!text) return [];
    return text.split('\n').filter(Boolean).map(line => {
      const [partition, avail, timeLimit, nodes, state, nodeList] = line.split('|').map(s => s.trim());
      return { partition, avail, timeLimit, nodes: +nodes || 0, state, nodeList };
    });
  }
}

module.exports = { DataPoller, TEMPLATES };
