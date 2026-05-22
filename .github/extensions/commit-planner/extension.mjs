import { execFileSync } from 'node:child_process';
import { joinSession } from '@github/copilot-sdk/extension';

const COMMIT_GUIDANCE = `
Clean-history rules:
- Analyze full working tree diff.
- Group by intent, not folder.
- Keep coherent concern per commit.
- Separate unrelated risk profiles onto different branches.
- Output Branch Plan with branch name, base branch, one-line purpose.
- For each commit, include branch, conventional commit message, exact files, and order.
`.trim();

const session = await joinSession({
  tools: [
    {
      name: 'commit_planner_plan',
      description: 'Analyze current working tree diff and suggest clean commit grouping.',
      parameters: {
        type: 'object',
        properties: {
          baseBranch: {
            type: 'string',
            description: 'Base branch to compare against when naming the branch plan.',
            default: 'main',
          },
        },
      },
      handler: async (args) => buildPlan(args.baseBranch || 'main'),
    },
  ],
  hooks: {
    onUserPromptSubmitted: async (input) => {
      const prompt = String(input?.prompt || '').toLowerCase();
      if (!/(commit|branch|clean history|git history|split changes|working tree)/.test(prompt)) {
        return;
      }

      return {
        additionalContext: COMMIT_GUIDANCE,
      };
    },
  },
});

function readGitOutput(args) {
  return execFileSync('git', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function collectChangedFiles() {
  const status = readGitOutput(['status', '--porcelain=v1', '-uall']);
  if (!status) {
    return [];
  }

  const files = new Set();
  for (const line of status.split('\n')) {
    if (!line.trim()) {
      continue;
    }

    const file = line.slice(3).trim();
    if (file) {
      files.add(file);
    }
  }

  return [...files].sort();
}

function classifyFiles(files) {
  const groups = {
    feature: [],
    docs: [],
    tests: [],
    tooling: [],
    generated: [],
    other: [],
  };

  for (const file of files) {
    if (file === 'docs/release-notes-v1.md' || file === 'test/settings.test.ts') {
      groups.generated.push(file);
      continue;
    }

    if (file.startsWith('test/')) {
      groups.tests.push(file);
      continue;
    }

    if (file.startsWith('docs/')) {
      groups.docs.push(file);
      continue;
    }

    if (
      file === 'src/config/sources.ts' ||
      file === 'src/utils/http.ts' ||
      file === 'src/scripts/build-extension.ts'
    ) {
      groups.tooling.push(file);
      continue;
    }

    if (file.startsWith('src/runtime/')) {
      groups.feature.push(file);
      continue;
    }

    groups.other.push(file);
  }

  return groups;
}

function buildPlan(baseBranch) {
  const files = collectChangedFiles();
  const groups = classifyFiles(files);
  const commits = [];

  if (groups.tooling.length) {
    commits.push({
      branch: 'feat/runtime-safety',
      commit: 'feat: harden source fetching and build inputs',
      files: groups.tooling,
      purpose: 'Trusted fetches and build pipeline safety.',
    });
  }

  if (groups.feature.length) {
    commits.push({
      branch: 'feat/site-controls',
      commit: 'feat: update runtime controls and diagnostics',
      files: groups.feature,
      purpose: 'Popup, options, background, and settings flow.',
    });
  }

  if (groups.tests.length) {
    commits.push({
      branch: 'test/runtime-regressions',
      commit: 'test: cover runtime and control regressions',
      files: groups.tests,
      purpose: 'Regression coverage for runtime behavior.',
    });
  }

  if (groups.docs.length) {
    commits.push({
      branch: 'docs/release-process',
      commit: 'docs: update release checklist',
      files: groups.docs,
      purpose: 'Release notes and checklist maintenance.',
    });
  }

  const lines = [];
  lines.push('Branch Plan');
  lines.push(`- Branch: feat/site-controls-runtime`);
  lines.push(`- Base branch: ${baseBranch}`);
  lines.push('- Purpose: runtime controls, diagnostics, and release hygiene');
  lines.push('');

  if (!commits.length) {
    lines.push('No changed files found.');
    return lines.join('\n');
  }

  lines.push('Commits');
  commits.forEach((commit, index) => {
    lines.push(`${index + 1}. Branch: ${commit.branch}`);
    lines.push(`   Commit: ${commit.commit}`);
    lines.push(`   Files: ${commit.files.join(', ')}`);
    lines.push(`   Purpose: ${commit.purpose}`);
  });

  if (groups.generated.length) {
    lines.push('');
    lines.push(`Generated artifacts to keep out of commits: ${groups.generated.join(', ')}`);
  }

  return lines.join('\n');
}

await session.log('commit-planner extension loaded');
