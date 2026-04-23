# OpenGravity Core Engine 🌌
Note :- the V2 of this will come next with the some more updates stay tune with me we build the open source agentic IDE that beaks everything 
> **A headless, infrastructure-first autonomous AI orchestration engine.**

OpenGravity is a production-grade backend engine designed to execute complex, multi-step software engineering tasks autonomously. It sits between user interfaces (like a CLI or VS Code extension) and Large Language Models, providing a robust sandbox, verifiable execution, and massive token reduction.

## ✨ Key Features

### 1. 📉 Tool-Level RAG (Semantic Token Reduction)
Standard agents dump entire codebases into the LLM context, causing massive token burn and severe hallucinations. OpenGravity uses **Tool-Level RAG** (`semantic_search`). When the LLM needs to understand how a component works, the tool searches the local codebase, ranks the chunks by relevance, and returns *only the exact lines needed*. 
*Result: 50,000 token queries reduced to 500 tokens.*

### 2. 🐍 Python Sandbox (Pass-by-Reference Memory)
Passing large datasets (e.g., 100k-row CSV files) through an LLM chat window will crash the engine. OpenGravity enforces a **Pass-by-Reference** paradigm. 
Agents write and execute Python scripts within a shared, secure `python_sandbox`. One agent can pull data and save it to `/workspace/data.csv`. The next agent can write a script to read that exact file and generate a chart. The LLM acts purely as a workflow manager, never touching the raw data itself.
*Includes **Human-in-the-Loop (HitL)** interception to verify code before sandbox execution.*

### 3. ⚡ Z3 Formal Verification (Hallucination Killer)
LLMs guess code. OpenGravity **proves** it. Before committing generated code, the engine uses the `z3_verify` tool to formally check:
- Array bounds safety (preventing out-of-bounds errors)
- Null and undefined safety
- Integer overflows
- Contract pre/post-conditions

If a constraint fails, Z3 generates a mathematical counterexample and forces the agent to fix the bug before proceeding.

### 4. 🧠 Universal Model Gateway
Zero vendor lock-in. OpenGravity supports plug-and-play LLM routing with built-in fallback chains:
- **Mock Provider:** For rapid, cost-free local testing.
- **Google Gemini:** `gemini-2.5-flash`, `gemini-2.5-pro`
- **OpenAI:** `gpt-4o`, `gpt-4o-mini`
- **Anthropic:** `claude-sonnet-4`
- **Ollama:** Run open-source models completely offline (`llama3`, `deepseek-coder`).

## 🏗️ Architecture

```mermaid
graph TB
    CLI["CLI (Commander.js)"] --> ORCH
    API["REST API (Fastify :3777)"] --> ORCH
    
    subgraph Engine Core
        ORCH["Agent Orchestrator"]
        AGENT["Agent (Plan→Execute→Verify)"]
        ORCH --> AGENT
    end
    
    subgraph AI Layer
        GW["Model Gateway"]
        GW --> MOCK["Mock"]
        GW --> GEMINI["Gemini"]
        GW --> OLLAMA["Ollama"]
        GW --> OPENAI["OpenAI"]
    end
    
    subgraph "Tools Layer"
        FS["read_file / write_file"]
        TERM["run_command"]
        RAG["semantic_search 📉"]
        SANDBOX["python_sandbox 🐍"]
        Z3["z3_verify ⚡"]
        OTHER["git, lint, type_check"]
    end
    
    subgraph Security & Trust
        ART["Artifact Store"]
        AUDIT["Audit Logger"]
        POLICY["Policy Engine"]
    end
    
    AGENT --> GW
    AGENT --> FS & TERM & RAG & SANDBOX & Z3
    AGENT --> ART & AUDIT
    POLICY --> FS & TERM & SANDBOX
```

## 🚀 Quick Start

### Installation

```bash
# Clone the repository
git clone https://github.com/mkrishna793/open-antigravity.git
cd open-antigravity

# Install dependencies
npm install

# Setup environment variables
cp .env.example .env
```

### Usage (CLI)

The engine ships with a powerful CLI. You can use the `mock` provider instantly without any API keys.

```bash
# Check engine status and available tools
npm run cli info
npm run cli tools

# Run an autonomous agent
npm run cli run "Create a new Express API with authentication"

# Start interactive chat
npm run cli chat
```

### Using Real Models (Gemini, OpenAI, etc.)

1. Open the `.env` file.
2. Add your API key (e.g., `GEMINI_API_KEY="your_key"`).
3. Set the default model: `DEFAULT_MODEL=gemini:gemini-2.5-flash`.
4. Run your tasks!

### API Server

OpenGravity can be controlled programmatically by any frontend (like a VS Code extension) via its REST API.

```bash
# Start the Fastify server on port 3777
npm run cli serve
```

## 🛡️ Security & Sandboxing

The **Policy Engine** operates on a default-deny principle for destructive operations:
- Blocks dangerous shell commands (`rm -rf`, `DROP TABLE`).
- Prevents writing outside of the designated workspace directory.
- Blocks elevated privilege requests (`sudo`).
- Human-in-the-Loop interception for sandbox Python execution.

## 📜 License
MIT License
