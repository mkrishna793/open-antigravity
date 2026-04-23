// ═══════════════════════════════════════════════════════════════
// OpenGravity — Agent (single autonomous unit of work)
// Plan → Execute → Verify lifecycle with Z3 integration.
// ═══════════════════════════════════════════════════════════════

import { EventEmitter } from 'events';
import type {
  AgentConfig, AgentState, AgentStatus, ChatMessage,
  CompletionRequest, ExecutionPlan, PlanStep, ToolResult,
  ToolContext, EngineEvent,
} from '../types/index.js';
import type { ModelGateway } from '../gateway/index.js';
import type { ToolRegistry } from '../tools/index.js';
import type { ArtifactStore } from '../artifacts/index.js';
import type { AuditLogger } from '../audit/index.js';
import type { PolicyEngine } from '../policy/index.js';

const SYSTEM_PROMPT = `You are an expert software engineering agent in the OpenGravity Engine.

Your role:
- Plan, implement, and verify code changes autonomously
- Use tools to read/write files, run commands, search code
- Use Z3 verification to prove correctness before committing changes
- Generate structured execution plans as JSON
- Always verify your work with tests or Z3 constraints

CRITICAL PARADIGMS:
1. TOKEN REDUCTION: Never read huge files or dump massive data. Use \`semantic_search\` (Tool-Level RAG) to find only the exact lines you need.
2. PASS-BY-REFERENCE: Never pass large datasets in your responses. If analyzing data, use \`python_sandbox\` to write data to a file (e.g., /workspace/data.csv), then in your next step, tell the sandbox to read that file. Do NOT print large datasets to stdout.

When asked to create a plan, respond with JSON matching this schema:
{
  "taskDescription": "...",
  "reasoning": "...",
  "estimatedComplexity": "low|medium|high",
  "steps": [
    { "id": 1, "description": "...", "tool": "tool_name", "toolInput": {...}, "dependsOn": [] }
  ]
}

Available tools: read_file, write_file, list_directory, run_command, search_code, semantic_search, python_sandbox, git_operation, lint_code, type_check, z3_verify

CRITICAL: For every code change, consider using z3_verify to check:
- Array bounds safety
- Null/undefined safety
- Integer overflow
- Pre/post condition correctness`;

export class Agent extends EventEmitter {
  readonly id: string;
  readonly config: AgentConfig;
  private state: AgentState = 'idle';
  private messages: ChatMessage[] = [];
  private plan: ExecutionPlan | null = null;
  private currentStep = 0;
  private artifactIds: string[] = [];
  private startedAt = 0;
  private updatedAt = 0;

  constructor(
    config: AgentConfig,
    private gateway: ModelGateway,
    private tools: ToolRegistry,
    private artifacts: ArtifactStore,
    private audit: AuditLogger,
    private policy: PolicyEngine,
  ) {
    super();
    this.id = config.id;
    this.config = config;
    this.messages = [{ role: 'system', content: SYSTEM_PROMPT }];
  }

  getStatus(): AgentStatus {
    return {
      id: this.id,
      state: this.state,
      task: this.config.task,
      model: this.config.model,
      currentStep: this.currentStep,
      totalSteps: this.plan?.steps.length ?? 0,
      artifacts: this.artifactIds,
      startedAt: this.startedAt,
      updatedAt: this.updatedAt,
      error: this.state === 'failed' ? this.messages[this.messages.length - 1]?.content : undefined,
    };
  }

  async run(): Promise<AgentStatus> {
    this.startedAt = Date.now();
    this.audit.log({ agentId: this.id, action: 'agent:start', target: this.config.task, result: 'success', details: '', durationMs: 0 });

    try {
      // Phase 1: Planning
      await this.setState('planning');
      this.plan = await this.createPlan();
      const planArtifact = this.artifacts.createPlanArtifact(this.id, this.plan as any);
      this.artifactIds.push(planArtifact.id);
      this.emitEvent({ type: 'agent:artifact_created', agentId: this.id, artifact: planArtifact });

      // Phase 2: Execution
      await this.setState('executing');
      await this.executeSteps();

      // Phase 3: Verification
      await this.setState('verifying');
      await this.verify();

      // Done
      await this.setState('completed');
      this.audit.log({ agentId: this.id, action: 'agent:complete', target: this.config.task, result: 'success', details: `${this.plan.steps.length} steps completed`, durationMs: Date.now() - this.startedAt });

    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      await this.setState('failed');
      this.emitEvent({ type: 'agent:error', agentId: this.id, error });
      this.audit.log({ agentId: this.id, action: 'agent:error', target: this.config.task, result: 'failure', details: error, durationMs: Date.now() - this.startedAt });
    }

    return this.getStatus();
  }

  // ── Phase 1: Planning ──

  private async createPlan(): Promise<ExecutionPlan> {
    this.messages.push({ role: 'user', content: `Create a detailed execution plan for this task:\n\n${this.config.task}\n\nRespond with a JSON execution plan.` });

    const response = await this.gateway.complete({
      model: this.config.model,
      messages: this.messages,
      temperature: 0.3, // Lower temp for structured output
      maxTokens: 4096,
    });

    this.messages.push({ role: 'assistant', content: response.content });
    this.emitEvent({ type: 'gateway:response', model: response.model, latencyMs: response.latencyMs });

    // Parse the plan from the response
    try {
      const jsonMatch = response.content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error('No JSON found in planning response');
      const plan = JSON.parse(jsonMatch[0]) as ExecutionPlan;

      // Validate plan structure
      if (!plan.steps || !Array.isArray(plan.steps)) {
        throw new Error('Plan missing steps array');
      }

      // Normalize steps
      plan.steps = plan.steps.map((step, i) => ({
        ...step,
        id: step.id ?? i + 1,
        status: 'pending' as const,
        dependsOn: step.dependsOn ?? [],
      }));

      return plan;
    } catch (err) {
      // Fallback: create a simple single-step plan
      return {
        taskDescription: this.config.task,
        reasoning: 'Direct execution - could not parse structured plan',
        estimatedComplexity: 'low',
        steps: [{
          id: 1,
          description: this.config.task,
          tool: 'run_command',
          toolInput: { command: `echo "Executing: ${this.config.task}"` },
          dependsOn: [],
          status: 'pending',
        }],
      };
    }
  }

  // ── Phase 2: Execution ──

  private async executeSteps(): Promise<void> {
    if (!this.plan) throw new Error('No plan to execute');

    const toolContext: ToolContext = {
      workspaceDir: this.config.workspaceDir,
      agentId: this.id,
      policyEngine: this.policy,
      auditLog: this.audit,
    };

    for (let i = 0; i < this.plan.steps.length; i++) {
      const step = this.plan.steps[i];
      this.currentStep = i + 1;

      // Check dependencies
      for (const depId of step.dependsOn) {
        const depStep = this.plan.steps.find(s => s.id === depId);
        if (depStep && depStep.status !== 'completed') {
          step.status = 'skipped';
          continue;
        }
      }

      step.status = 'running';
      this.emitEvent({ type: 'agent:step_started', agentId: this.id, step: step.id, description: step.description });

      // Execute the tool
      let result: ToolResult;

      if (step.tool && this.tools.get(step.tool)) {
        result = await this.tools.execute(step.tool, step.toolInput, toolContext);
      } else {
        // Use LLM to determine what to do
        result = await this.executeLLMStep(step, toolContext);
      }

      step.result = result;
      step.status = result.success ? 'completed' : 'failed';

      this.emitEvent({ type: 'agent:step_completed', agentId: this.id, step: step.id, result });

      // If step failed and we have retries, let the LLM fix it
      if (!result.success && this.config.maxRetries > 0) {
        const fixed = await this.retryStep(step, result, toolContext);
        if (fixed) {
          step.status = 'completed';
          step.result = fixed;
        }
      }

      // Log result
      this.artifacts.createLogArtifact(this.id, `Step ${step.id}: ${step.description}`, 
        `Tool: ${step.tool}\nStatus: ${step.status}\nOutput: ${(step.result?.output ?? '').slice(0, 2000)}\n${step.result?.error ? `Error: ${step.result.error}` : ''}`
      );
    }
  }

  private async executeLLMStep(step: PlanStep, toolContext: ToolContext): Promise<ToolResult> {
    // Ask the LLM to execute using available tools
    this.messages.push({
      role: 'user',
      content: `Execute step ${step.id}: ${step.description}\n\nUse one of the available tools to accomplish this.`,
    });

    const toolDefs = this.tools.getDefinitions(this.config.tools.length > 0 ? this.config.tools : undefined);

    const response = await this.gateway.complete({
      model: this.config.model,
      messages: this.messages,
      tools: toolDefs,
      temperature: 0.2,
      maxTokens: 4096,
    });

    this.messages.push({ role: 'assistant', content: response.content, toolCalls: response.toolCalls });

    // If the LLM wants to call a tool
    if (response.toolCalls && response.toolCalls.length > 0) {
      for (const tc of response.toolCalls) {
        const input = JSON.parse(tc.function.arguments);
        const result = await this.tools.execute(tc.function.name, input, toolContext);

        this.messages.push({ role: 'tool', content: result.output || result.error || '', name: tc.function.name, toolCallId: tc.id });

        if (!result.success) return result;
      }
      return { success: true, output: 'Tool calls executed successfully.' };
    }

    return { success: true, output: response.content };
  }

  private async retryStep(step: PlanStep, failedResult: ToolResult, toolContext: ToolContext): Promise<ToolResult | null> {
    this.messages.push({
      role: 'user',
      content: `Step ${step.id} failed with error: ${failedResult.error}\n\nPlease fix the issue and try again.`,
    });

    const toolDefs = this.tools.getDefinitions();
    const response = await this.gateway.complete({
      model: this.config.model,
      messages: this.messages,
      tools: toolDefs,
      temperature: 0.2,
      maxTokens: 4096,
    });

    this.messages.push({ role: 'assistant', content: response.content, toolCalls: response.toolCalls });

    if (response.toolCalls?.length) {
      for (const tc of response.toolCalls) {
        const input = JSON.parse(tc.function.arguments);
        const result = await this.tools.execute(tc.function.name, input, toolContext);
        if (result.success) return result;
      }
    }

    return null;
  }

  // ── Phase 3: Verification ──

  private async verify(): Promise<void> {
    if (!this.plan) return;

    const completedSteps = this.plan.steps.filter(s => s.status === 'completed');
    const failedSteps = this.plan.steps.filter(s => s.status === 'failed');

    const verificationLog = [
      `═══ Verification Report ═══`,
      `Task: ${this.config.task}`,
      `Steps completed: ${completedSteps.length}/${this.plan.steps.length}`,
      `Steps failed: ${failedSteps.length}`,
      `Total time: ${Date.now() - this.startedAt}ms`,
      ``,
    ];

    for (const step of this.plan.steps) {
      const icon = step.status === 'completed' ? '✅' : step.status === 'failed' ? '❌' : '⏭️';
      verificationLog.push(`${icon} Step ${step.id}: ${step.description} [${step.status}]`);
    }

    const artifact = this.artifacts.createLogArtifact(this.id, 'Verification Report', verificationLog.join('\n'));
    this.artifactIds.push(artifact.id);
    this.emitEvent({ type: 'agent:artifact_created', agentId: this.id, artifact });
  }

  // ── Helpers ──

  private async setState(state: AgentState): Promise<void> {
    const from = this.state;
    this.state = state;
    this.updatedAt = Date.now();
    this.emitEvent({ type: 'agent:state_changed', agentId: this.id, from, to: state });
  }

  private emitEvent(event: EngineEvent): void {
    this.emit(event.type, event);
    this.emit('event', event);
  }

  sendFeedback(feedback: string): void {
    this.messages.push({ role: 'user', content: `[User Feedback]: ${feedback}` });
  }
}
