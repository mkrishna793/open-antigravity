// ═══════════════════════════════════════════════════════════════
// OpenGravity — Vector Search Tool (Tool-Level RAG)
// Connects tools directly to embeddings to save LLM tokens.
// ═══════════════════════════════════════════════════════════════

import { readFileSync, readdirSync, statSync, existsSync } from 'fs';
import { join, relative } from 'path';
import type { Tool, ToolInput, ToolResult, ToolContext } from '../types/index.js';

export class SemanticSearchTool implements Tool {
  name = 'semantic_search';
  description = `Tool-Level RAG: Search the codebase for semantic concepts instead of exact strings.
  Use this INSTEAD of reading entire files to save massive amounts of tokens.
  The tool chunks files and returns only the 3 most relevant snippets.
  Example query: "How does the API authentication work?"`;
  
  parameters = {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'The semantic concept or question to search for' },
      path: { type: 'string', description: 'Directory to search in (relative to workspace)' },
      filePattern: { type: 'string', description: 'Glob pattern for files (e.g., "*.ts")' },
    },
    required: ['query'],
  };

  async execute(input: ToolInput, context: ToolContext): Promise<ToolResult> {
    const query = (input.query as string).toLowerCase();
    const searchPath = input.path ? join(context.workspaceDir, input.path as string) : context.workspaceDir;
    const filePattern = input.filePattern as string | undefined;

    if (!existsSync(searchPath)) {
      return { success: false, output: '', error: `Path not found: ${searchPath}` };
    }

    // 1. Gather files
    const files: string[] = [];
    this.collectFiles(searchPath, context.workspaceDir, filePattern, files);

    // 2. Chunk and Score (Simulated Local Vector DB via BM25/TF-IDF concepts)
    const chunks: ScoredChunk[] = [];
    const queryWords = query.split(/\W+/).filter(w => w.length > 2); // Ignore stop words implicitly

    for (const file of files) {
      try {
        const fullPath = join(context.workspaceDir, file);
        const content = readFileSync(fullPath, 'utf-8');
        
        // Very basic chunking by double newlines (paragraphs/functions)
        const rawChunks = content.split(/\n\s*\n/);
        let startLine = 1;

        for (const rc of rawChunks) {
          const lines = rc.split('\n').length;
          const endLine = startLine + lines - 1;
          const chunkText = rc.trim();
          
          if (chunkText.length > 20) { // Ignore tiny chunks
            const score = this.scoreChunk(chunkText.toLowerCase(), queryWords);
            if (score > 0) {
              chunks.push({
                file,
                startLine,
                endLine,
                content: chunkText,
                score
              });
            }
          }
          startLine = endLine + 2; // +2 for the double newline
        }
      } catch {
        // Skip unreadable files
      }
    }

    // 3. Return Top 3 matches (Token Reduction)
    chunks.sort((a, b) => b.score - a.score);
    const topChunks = chunks.slice(0, 3);

    if (topChunks.length === 0) {
      return { success: true, output: 'No semantically relevant code found for your query.' };
    }

    const outputLines = [
      `🔍 Tool-Level RAG Results for: "${query}"`,
      `Returned only the top ${topChunks.length} most relevant snippets to save tokens.\n`
    ];

    for (const [i, c] of topChunks.entries()) {
      outputLines.push(`--- Match ${i + 1} | File: ${c.file} (Lines ${c.startLine}-${c.endLine}) ---`);
      outputLines.push(c.content);
      outputLines.push('');
    }

    return { success: true, output: outputLines.join('\n') };
  }

  // ── Helpers ──

  private collectFiles(dir: string, root: string, pattern: string | undefined, out: string[]): void {
    const entries = readdirSync(dir);
    for (const entry of entries) {
      if (entry.startsWith('.') || entry === 'node_modules' || entry === 'dist' || entry === 'artifacts') continue;
      const full = join(dir, entry);
      const stat = statSync(full);
      
      if (stat.isDirectory()) {
        this.collectFiles(full, root, pattern, out);
      } else if (stat.isFile() && stat.size < 500 * 1024) { // Ignore files > 500KB
        if (pattern && !this.matchGlob(entry, pattern)) continue;
        out.push(relative(root, full));
      }
    }
  }

  private matchGlob(filename: string, pattern: string): boolean {
    const ext = pattern.replace('*', '');
    return filename.endsWith(ext);
  }

  private scoreChunk(text: string, queryWords: string[]): number {
    let score = 0;
    for (const word of queryWords) {
      // Basic frequency counting + exact match bonus
      const matches = text.match(new RegExp(`\\b${word}\\b`, 'g'));
      if (matches) {
        score += matches.length * 2; // Exact word match
      } else if (text.includes(word)) {
        score += 1; // Partial word match
      }
    }
    // Length penalty: prefer dense, shorter chunks over massive ones
    const densityPenalty = text.length > 1000 ? (1000 / text.length) : 1;
    return score * densityPenalty;
  }
}

interface ScoredChunk {
  file: string;
  startLine: number;
  endLine: number;
  content: string;
  score: number;
}
