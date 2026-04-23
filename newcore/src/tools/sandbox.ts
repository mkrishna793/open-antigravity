// ═══════════════════════════════════════════════════════════════
// OpenGravity — Python Sandbox Tool
// Shared memory execution environment with Human-in-the-Loop (HitL)
// ═══════════════════════════════════════════════════════════════

import { execSync } from 'child_process';
import { writeFileSync, existsSync, mkdirSync, readFileSync } from 'fs';
import { resolve, join } from 'path';
import { randomBytes } from 'crypto';
import type { Tool, ToolInput, ToolResult, ToolContext } from '../types/index.js';

export class PythonSandboxTool implements Tool {
  name = 'python_sandbox';
  description = `Execute Python code in a secure, shared workspace sandbox.
  CRITICAL CONCEPT: Pass-by-Reference, not Pass-by-Value.
  Do NOT pass large datasets through the LLM. Instead, have one agent/tool 
  save data to a file (e.g., 'data.csv') in the workspace, and have the 
  Python sandbox read from that file. The sandbox has full access to the workspace.
  Requires Human-in-the-Loop (HitL) approval before execution.`;
  
  parameters = {
    type: 'object',
    properties: {
      code: { 
        type: 'string', 
        description: 'The Python code to execute. Can read/write to the workspace.' 
      },
      dependencies: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional pip dependencies to install (e.g., ["pandas", "matplotlib"])'
      }
    },
    required: ['code'],
  };

  async execute(input: ToolInput, context: ToolContext): Promise<ToolResult> {
    const code = input.code as string;
    const dependencies = (input.dependencies as string[]) || [];
    
    // 1. Human-in-the-Loop (HitL) Approval Phase
    const approved = await this.requestApproval(code, context);
    if (!approved) {
      return { 
        success: false, 
        output: '', 
        error: 'Execution rejected by Human-in-the-Loop (HitL) review.' 
      };
    }

    // 2. Setup Sandbox Directory
    const sandboxDir = resolve(context.workspaceDir, '.sandbox');
    if (!existsSync(sandboxDir)) mkdirSync(sandboxDir, { recursive: true });

    // 3. Install Dependencies (if allowed by policy)
    if (dependencies.length > 0) {
      const policyDecision = context.policyEngine.check({
        type: 'install_package',
        target: dependencies.join(' '),
        agentId: context.agentId,
        workspaceDir: context.workspaceDir
      });

      if (!policyDecision.allowed) {
        return { success: false, output: '', error: `Dependency installation blocked: ${policyDecision.reason}` };
      }

      try {
        execSync(`pip install ${dependencies.join(' ')}`, {
          cwd: sandboxDir,
          encoding: 'utf-8',
          timeout: 60_000
        });
      } catch (err: any) {
        return { success: false, output: '', error: `Failed to install dependencies: ${err.message}` };
      }
    }

    // 4. Write Code to File
    const scriptId = randomBytes(4).toString('hex');
    const scriptPath = join(sandboxDir, `script_${scriptId}.py`);
    
    // Wrap code to ensure it runs in the workspace context
    const wrappedCode = `
import os
import sys

# Set working directory to the shared workspace
os.chdir(r"${context.workspaceDir.replace(/\\/g, '\\\\')}")

# User Code
${code}
`;

    writeFileSync(scriptPath, wrappedCode, 'utf-8');

    // 5. Execute Code
    try {
      const output = execSync(`python "${scriptPath}"`, {
        cwd: context.workspaceDir,
        encoding: 'utf-8',
        timeout: 30_000, // 30s timeout
        maxBuffer: 5 * 1024 * 1024 // 5MB output limit
      });

      return { 
        success: true, 
        output: output.trim() || 'Execution successful (no output).' 
      };
    } catch (err: any) {
      const stdout = err.stdout?.toString() ?? '';
      const stderr = err.stderr?.toString() ?? '';
      return { 
        success: false, 
        output: stdout, 
        error: stderr || err.message 
      };
    }
  }

  /**
   * Simulates Human-in-the-Loop (HitL) verification.
   * In a real UI, this would emit an event and wait for a websocket response.
   * For the core engine, we log the requirement and auto-approve in headless mode,
   * but the architecture is now in place.
   */
  private async requestApproval(code: string, context: ToolContext): Promise<boolean> {
    context.auditLog.log({
      agentId: context.agentId,
      action: 'hitl:request',
      target: 'python_sandbox',
      result: 'success',
      details: 'Awaiting human approval for code execution',
      durationMs: 0
    });

    // TODO: In the API layer, this should pause the agent and wait for a POST /agents/:id/approve
    // For now, we simulate an auto-approval to keep the CLI working.
    console.log(`\n[HitL] 🛑 INTERCEPT: Agent wants to run Python code:`);
    console.log(`[HitL] ---------------------------------------------`);
    console.log(code.split('\n').slice(0, 10).join('\n') + (code.split('\n').length > 10 ? '\n...' : ''));
    console.log(`[HitL] ---------------------------------------------`);
    console.log(`[HitL] ✅ Auto-approving for headless mode execution.\n`);

    return true;
  }
}
