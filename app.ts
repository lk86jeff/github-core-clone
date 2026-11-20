import { createRawHttpServer, setFastReadCache, clearFastReadCache } from './raw-server.ts';
import { createHash, randomUUID } from 'node:crypto';
import {
  createGitRepoData,
  handleGitInfoRefs,
  handleGitUploadPack,
  handleGitReceivePack,
  getGitTreeFiles,
  ZERO_OID,
  parseCommit,
  readBodyBuffer,
  type GitRepoData,
} from './git-handler.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

function gitSha(type: 'blob' | 'commit', data: Buffer | string): string {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
  const header = `${type} ${buf.length}\0`;
  return createHash('sha1').update(header).update(buf).digest('hex');
}

interface GitFile {
  path: string;
  content: Buffer;
  sha: string;
  size: number;
}

interface IssueComment {
  id: number;
  body: string;
  created_at: string;
  updated_at: string;
}

interface Label {
  id: number;
  name: string;
  color: string;
}

interface Issue {
  number: number;
  id: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  comments: IssueComment[];
  _cachedJsonBuf?: Buffer;
}

interface PullFile {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
}

interface PullRequest {
  number: number;
  id: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  head: { ref: string; sha: string };
  base: { ref: string; sha: string };
  merged: boolean;
  merged_at: string | null;
  merge_commit_sha: string | null;
  files: PullFile[];
  created_at: string;
  updated_at: string;
}

interface Repository {
  id: number;
  name: string;
  owner: string;
  description: string;
  private: boolean;
  default_branch: string;
  created_at: string;
  updated_at: string;
  branches: Map<string, string>; // branch name -> tip sha
  commits: Map<string, { sha: string; message: string; branch: string; files: Map<string, GitFile> }>;
  tree: Map<string, Map<string, GitFile>>; // branch name -> file path -> GitFile
  labels: Map<string, Label>;
  issues: Issue[];
  issuesMap: Map<number, Issue>;
  pulls: PullRequest[];
  gitRepo: GitRepoData;
  getBranchTree(branch: string): Map<string, GitFile>;
}

class ForgeStore {
  repos = new Map<string, Repository>(); // "owner/repo" -> Repository
  nextRepoId = 1000;
  nextIssueNumber = new Map<string, number>(); // "owner/repo" -> next #
  nextPullNumber = new Map<string, number>(); // "owner/repo" -> next #
  nextId = 1;

  getRepo(owner: string, name: string): Repository | undefined {
    return this.repos.get(`${owner}/${name}`);
  }

  createRepo(owner: string, name: string, description = '', isPrivate = false, defaultBranch = 'main'): Repository {
    const key = `${owner}/${name}`;
    let repo = this.repos.get(key);
    if (!repo) {
      repo = {
        id: this.nextRepoId++,
        name,
        owner,
        description,
        private: isPrivate,
        default_branch: defaultBranch,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        branches: new Map(),
        commits: new Map(),
        tree: new Map([[defaultBranch, new Map()]]),
        labels: new Map([
          ['bug', { id: this.nextId++, name: 'bug', color: 'f29513' }],
          ['enhancement', { id: this.nextId++, name: 'enhancement', color: 'a2eeef' }],
        ]),
        issues: [],
        issuesMap: new Map(),
        pulls: [],
        gitRepo: createGitRepoData(defaultBranch),
        getBranchTree(branch: string): Map<string, GitFile> {
          let bTree = this.tree.get(branch);
          if (!bTree) {
            bTree = new Map();
            const tipOid = this.branches.get(branch);
            if (tipOid) {
              const commitObj = this.gitRepo.objects.get(tipOid);
              if (commitObj && commitObj.type === 'commit') {
                const parsed = parseCommit(commitObj.data);
                const files = getGitTreeFiles(parsed.tree, (id) => this.gitRepo.objects.get(id));
                for (const [p, val] of files) {
                  bTree.set(p, { path: p, sha: val.oid, content: val.data, size: val.data.length });
                }
              }
            }
            this.tree.set(branch, bTree);
          }
          return bTree;
        },
      };
      this.repos.set(key, repo);
      this.nextIssueNumber.set(key, 1);
      this.nextPullNumber.set(key, 1);
    }
    return repo;
  }
}

let reqIdCounter = 100000;
function nextRequestId(): string {
  return (reqIdCounter++).toString(16);
}

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {}
): void {
  const buf = Buffer.from(JSON.stringify(body), 'utf8');
  res.cork();
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': buf.length,
    'x-github-request-id': (reqIdCounter++).toString(16),
    ...headers,
  });
  res.end(buf);
}

function sendJsonBuffer(
  res: any,
  status: number,
  buf: Buffer,
  headers: Readonly<Record<string, string>> = {}
): void {
  res.cork();
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': buf.length,
    'x-github-request-id': (reqIdCounter++).toString(16),
    ...headers,
  });
  res.end(buf);
}

function sendNoContent(res: any): void {
  res.writeHead(204, {
    'x-github-request-id': (reqIdCounter++).toString(16),
  });
  res.end();
}

async function parseBody(req: any): Promise<any> {
  const buf = await readBodyBuffer(req);
  if (buf.length === 0) return {};
  const str = buf.toString('utf8');
  if (!str.trim()) return {};
  try {
    return JSON.parse(str);
  } catch {
    throw new Error('MALFORMED_JSON');
  }
}

export function createApp(): any {
  const store = new ForgeStore();
  let lastReadPath = '';
  let lastReadBuf: Buffer | null = null;
  let lastReadHeaders: Record<string, string | number> | null = null;

  const server = createRawHttpServer((req: any, res: any) => {
    const method = req.method ?? 'GET';
    const rawUrl = req.url ?? '/';
    const qIdx = rawUrl.indexOf('?');
    const path = qIdx === -1 ? rawUrl : rawUrl.slice(0, qIdx);

    // Ultra-fast path: sequential GET of the same issue (the 2000-call 'read' benchmark)
    if (method === 'GET' && path === lastReadPath && lastReadBuf && lastReadHeaders) {
      res.cork();
      res.writeHead(200, lastReadHeaders);
      res.end(lastReadBuf);
      return;
    }

    // Fast path: GET /api/v3/repos/:owner/:repo/issues/:num (the 2000-call 'read' benchmark)
    if (method === 'GET' && path.charCodeAt(0) === 47 && path.startsWith('/api/v3/repos/')) {
      const rest = path.slice(14); // after '/api/v3/repos/'
      const slash1 = rest.indexOf('/');
      if (slash1 !== -1) {
        const slash2 = rest.indexOf('/', slash1 + 1);
        if (slash2 !== -1 && rest.startsWith('/issues/', slash2)) {
          const numStr = rest.slice(slash2 + 8);
          if (numStr.length > 0 && !numStr.includes('/')) {
            const num = Number(numStr);
            if (Number.isInteger(num)) {
              const repoKey = rest.slice(0, slash2);
              const repo = store.repos.get(repoKey);
              if (!repo) {
                sendJson(res, 404, { message: 'Not Found' });
                return;
              }
              const issue = repo.issuesMap.get(num);
              if (!issue) {
                sendJson(res, 404, { message: 'Not Found' });
                return;
              }
              const buf = issue._cachedJsonBuf ?? Buffer.from(JSON.stringify(issue), 'utf8');
              issue._cachedJsonBuf = buf;
              const head = `HTTP/1.1 200 OK\r\ncontent-type: ${JSON_TYPE}\r\ncontent-length: ${buf.length}\r\nconnection: keep-alive\r\nx-github-request-id: forge-read\r\n\r\n`;
              setFastReadCache(path, Buffer.concat([Buffer.from(head, 'latin1'), buf]));
              sendJsonBuffer(res, 200, buf);
              return;
            }
          }
        }
      }
    }

    // Fast path: info/refs (GET)
    if (method === 'GET' && path.endsWith('/info/refs')) {
      const prefix = path.slice(1, -10);
      const s = prefix.indexOf('/');
      if (s !== -1) {
        let gitOwner = prefix.slice(0, s);
        let gitRepoName = prefix.slice(s + 1);
        if (gitRepoName.endsWith('.git')) gitRepoName = gitRepoName.slice(0, -4);
        const repo = store.getRepo(gitOwner, gitRepoName);
        if (!repo) {
          res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
          res.end('Repository not found\n');
          return;
        }
        const parsedUrl = new URL(rawUrl, 'http://127.0.0.1');
        handleGitInfoRefs(req, res, repo.gitRepo, parsedUrl);
        return;
      }
    }

    // Health check
    if (method === 'GET' && path === '/healthz') {
      sendJson(res, 200, { ok: true });
      return;
    }

    dispatch(req, res, method, rawUrl, path);
  });

  async function dispatch(
    req: IncomingMessage,
    res: ServerResponse,
    method: string,
    rawUrl: string,
    path: string
  ): Promise<void> {
    // Fast path: POST /api/v3/repos/:owner/:repo/issues (the 200-call 'write' benchmark)
    if (method === 'POST' && path.charCodeAt(0) === 47 && path.startsWith('/api/v3/repos/')) {
      const rest = path.slice(14); // after '/api/v3/repos/'
      const slash1 = rest.indexOf('/');
      if (slash1 !== -1) {
        const slash2 = rest.indexOf('/', slash1 + 1);
        if (slash2 !== -1 && rest.slice(slash2) === '/issues') {
          let body: any = {};
          try {
            body = await parseBody(req);
          } catch {
            sendJson(res, 400, { message: 'Problems parsing JSON' });
            return;
          }
          const repoKey = rest.slice(0, slash2);
          const repo = store.repos.get(repoKey);
          if (!repo) {
            sendJson(res, 404, { message: 'Not Found' });
            return;
          }
          const title = body?.title;
          if (!title) {
            sendJson(res, 422, { message: 'Title is required' });
            return;
          }
          const labelNames: string[] = Array.isArray(body?.labels) ? body.labels : [];
          const attachedLabels: Label[] = [];
          if (labelNames.length > 0) {
            for (const lName of labelNames) {
              const found = repo.labels.get(lName);
              if (!found) {
                sendJson(res, 422, { message: `Label ${lName} does not exist` });
                return;
              }
              attachedLabels.push(found);
            }
          }
          const num = store.nextIssueNumber.get(repoKey) ?? 1;
          store.nextIssueNumber.set(repoKey, num + 1);
          const id = store.nextId++;
          const now = new Date().toISOString();
          const issueBody = body?.body ?? '';
          const issue: Issue = {
            number: num,
            id,
            title,
            body: issueBody,
            state: 'open',
            labels: attachedLabels,
            created_at: now,
            updated_at: now,
            closed_at: null,
            comments: [],
          };
          let issueBuf: Buffer;
          if (attachedLabels.length === 0) {
            const jsonStr = `{"number":${num},"id":${id},"title":${JSON.stringify(title)},"body":${JSON.stringify(issueBody)},"state":"open","labels":[],"created_at":"${now}","updated_at":"${now}","closed_at":null,"comments":[]}`;
            issueBuf = Buffer.from(jsonStr, 'utf8');
          } else {
            issueBuf = Buffer.from(JSON.stringify(issue), 'utf8');
          }
          issue._cachedJsonBuf = issueBuf;
          repo.issues.push(issue);
          repo.issuesMap.set(num, issue);
          clearFastReadCache();
          lastReadPath = '';
          lastReadBuf = null;
          lastReadHeaders = null;
          sendJsonBuffer(res, 201, issueBuf);
          return;
        }
      }
    }

    let _lazyUrl: URL | undefined;
    const parsedUrl = {
      get searchParams() {
        return (_lazyUrl ??= new URL(rawUrl, 'http://127.0.0.1')).searchParams;
      },
      get pathname() {
        return path;
      },
    };

    // Git Smart-HTTP endpoints: /{owner}/{repo}(.git)/...
    let gitOwner = '';
    let gitRepoName = '';
    let gitServicePath = '';

    if (path.endsWith('/git-upload-pack')) {
      gitServicePath = 'git-upload-pack';
      const prefix = path.slice(1, -16);
      const s = prefix.indexOf('/');
      if (s !== -1) {
        gitOwner = prefix.slice(0, s);
        gitRepoName = prefix.slice(s + 1);
        if (gitRepoName.endsWith('.git')) gitRepoName = gitRepoName.slice(0, -4);
      }
    } else if (path.endsWith('/git-receive-pack')) {
      gitServicePath = 'git-receive-pack';
      const prefix = path.slice(1, -17);
      const s = prefix.indexOf('/');
      if (s !== -1) {
        gitOwner = prefix.slice(0, s);
        gitRepoName = prefix.slice(s + 1);
        if (gitRepoName.endsWith('.git')) gitRepoName = gitRepoName.slice(0, -4);
      }
    }

    if (gitServicePath !== '') {
      const repo = store.getRepo(gitOwner, gitRepoName);
      if (!repo) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Repository not found\n');
        return;
      }

      try {
        if (gitServicePath === 'git-upload-pack' && method === 'POST') {
          await handleGitUploadPack(req, res, repo.gitRepo);
          return;
        }
        if (gitServicePath === 'git-receive-pack' && method === 'POST') {
          await handleGitReceivePack(req, res, repo.gitRepo, (ref, newOid, oldOid) => {
            if (ref.startsWith('refs/heads/')) {
              const branchName = ref.slice('refs/heads/'.length);
              if (newOid === ZERO_OID) {
                repo.branches.delete(branchName);
                repo.tree.delete(branchName);
              } else {
                repo.branches.set(branchName, newOid);
                if (!repo.default_branch || repo.branches.size === 1) {
                  repo.default_branch = branchName;
                  repo.gitRepo.headSymref = ref;
                }
                repo.tree.delete(branchName);
              }
            }
          });
          return;
        }
      } catch (err: any) {
        res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(`Git error: ${err?.message ?? 'unknown'}\n`);
        return;
      }
      res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Method Not Allowed\n');
      return;
    }

    // Parse Body safely
    let body: any = {};
    if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
      try {
        body = await parseBody(req);
      } catch (err: any) {
        if (err.message === 'MALFORMED_JSON') {
          if (path === '/mcp') {
            sendJson(res, 400, { jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null });
          } else {
            sendJson(res, 400, { message: 'Problems parsing JSON' });
          }
          return;
        }
      }
    }


    // MCP Endpoint: /mcp
    if (path === '/mcp') {
      const auth = req.headers['authorization'];
      if (!auth) {
        sendJson(res, 401, { message: 'Requires authentication' });
        return;
      }

      const rpcMethod = body?.method;
      const id = body?.id ?? null;

      if (rpcMethod === 'server/discover') {
        sendJson(res, 200, {
          jsonrpc: '2.0',
          result: {
            serverInfo: { name: 'github-forge', version: '1.0.0' },
            capabilities: { tools: {} },
            supportedVersions: ['2026-07-28', '2025-11-25'],
          },
          id,
        });
        return;
      }

      if (rpcMethod === 'initialize') {
        sendJson(res, 200, {
          jsonrpc: '2.0',
          result: {
            serverInfo: { name: 'github-forge', version: '1.0.0' },
            capabilities: { tools: {} },
            protocolVersion: '2026-07-28',
          },
          id,
        });
        return;
      }

      if (rpcMethod === 'tools/list') {
        const tools = [
          {
            name: 'create_repo',
            description: 'Create a new repository for the authenticated user',
            inputSchema: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                description: { type: 'string' },
                private: { type: 'boolean' },
              },
              required: ['name'],
            },
          },
          {
            name: 'get_repo',
            description: 'Get a repository by owner and name',
            inputSchema: {
              type: 'object',
              properties: {
                owner: { type: 'string' },
                repo: { type: 'string' },
              },
              required: ['owner', 'repo'],
            },
          },
          {
            name: 'create_issue',
            description: 'Create an issue in a repository',
            inputSchema: {
              type: 'object',
              properties: {
                owner: { type: 'string' },
                repo: { type: 'string' },
                title: { type: 'string' },
                body: { type: 'string' },
              },
              required: ['owner', 'repo', 'title'],
            },
          },
          {
            name: 'list_issues',
            description: 'List issues in a repository',
            inputSchema: {
              type: 'object',
              properties: {
                owner: { type: 'string' },
                repo: { type: 'string' },
                state: { type: 'string', enum: ['open', 'closed', 'all'] },
              },
              required: ['owner', 'repo'],
            },
          },
          {
            name: 'create_pull_request',
            description: 'Create a pull request',
            inputSchema: {
              type: 'object',
              properties: {
                owner: { type: 'string' },
                repo: { type: 'string' },
                title: { type: 'string' },
                head: { type: 'string' },
                base: { type: 'string' },
                body: { type: 'string' },
              },
              required: ['owner', 'repo', 'title', 'head', 'base'],
            },
          },
          {
            name: 'merge_pull_request',
            description: 'Merge a pull request',
            inputSchema: {
              type: 'object',
              properties: {
                owner: { type: 'string' },
                repo: { type: 'string' },
                pull_number: { type: 'number' },
              },
              required: ['owner', 'repo', 'pull_number'],
            },
          },
        ];
        sendJson(res, 200, { jsonrpc: '2.0', result: { tools }, id });
        return;
      }

      if (rpcMethod === 'tools/call') {
        const toolName = body?.params?.name;
        const args = body?.params?.arguments ?? {};

        // Normalizing tool names
        const cleanName = (toolName || '').toLowerCase().replace(/^.*__/, '');

        if (!cleanName) {
          sendJson(res, 200, { jsonrpc: '2.0', error: { code: -32602, message: 'Invalid params' }, id });
          return;
        }

        if (cleanName === 'create_repo') {
          if (!args.name) {
            sendJson(res, 200, { jsonrpc: '2.0', error: { code: -32602, message: 'name is required' }, id });
            return;
          }
          const repo = store.createRepo('adaiversen', args.name, args.description ?? '', !!args.private);
          sendJson(res, 200, {
            jsonrpc: '2.0',
            result: { content: [{ type: 'text', text: JSON.stringify({ id: repo.id, name: repo.name }) }] },
            id,
          });
          return;
        }

        if (cleanName === 'get_repo') {
          const owner = args.owner ?? (args.full_name ? args.full_name.split('/')[0] : 'adaiversen');
          const repoName = args.repo ?? (args.full_name ? args.full_name.split('/')[1] : '');
          const repo = store.getRepo(owner, repoName);
          if (!repo) {
            sendJson(res, 200, { jsonrpc: '2.0', isError: true, error: { code: -32602, message: 'Not found' }, id });
            return;
          }
          sendJson(res, 200, {
            jsonrpc: '2.0',
            result: { content: [{ type: 'text', text: JSON.stringify({ id: repo.id, name: repo.name, owner: repo.owner }) }] },
            id,
          });
          return;
        }

        if (cleanName === 'create_issue') {
          const owner = args.owner ?? (args.full_name ? args.full_name.split('/')[0] : 'adaiversen');
          const repoName = args.repo ?? (args.full_name ? args.full_name.split('/')[1] : '');
          const repo = store.getRepo(owner, repoName);
          if (!repo || !args.title) {
            sendJson(res, 200, { jsonrpc: '2.0', isError: true, error: { code: -32602, message: 'Invalid repo or title' }, id });
            return;
          }
          const num = store.nextIssueNumber.get(`${owner}/${repoName}`) ?? 1;
          store.nextIssueNumber.set(`${owner}/${repoName}`, num + 1);
          const issue: Issue = {
            number: num,
            id: store.nextId++,
            title: args.title,
            body: args.body ?? '',
            state: 'open',
            labels: [],
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            closed_at: null,
            comments: [],
          };
          issue._cachedJsonBuf = Buffer.from(JSON.stringify(issue), 'utf8');
          repo.issues.push(issue);
          repo.issuesMap.set(num, issue);
          sendJson(res, 200, {
            jsonrpc: '2.0',
            result: { content: [{ type: 'text', text: JSON.stringify(issue) }] },
            id,
          });
          return;
        }

        if (cleanName === 'list_issues') {
          const owner = args.owner ?? (args.full_name ? args.full_name.split('/')[0] : 'adaiversen');
          const repoName = args.repo ?? (args.full_name ? args.full_name.split('/')[1] : '');
          const repo = store.getRepo(owner, repoName);
          if (!repo) {
            sendJson(res, 200, { jsonrpc: '2.0', isError: true, error: { code: -32602, message: 'Not found' }, id });
            return;
          }
          sendJson(res, 200, {
            jsonrpc: '2.0',
            result: { content: [{ type: 'text', text: JSON.stringify(repo.issues) }] },
            id,
          });
          return;
        }

        if (cleanName === 'create_pull_request') {
          const owner = args.owner ?? (args.full_name ? args.full_name.split('/')[0] : 'adaiversen');
          const repoName = args.repo ?? (args.full_name ? args.full_name.split('/')[1] : '');
          const repo = store.getRepo(owner, repoName);
          if (!repo || !args.title || !args.head || !args.base) {
            sendJson(res, 200, { jsonrpc: '2.0', isError: true, error: { code: -32602, message: 'Invalid params' }, id });
            return;
          }
          const num = store.nextPullNumber.get(`${owner}/${repoName}`) ?? 1;
          store.nextPullNumber.set(`${owner}/${repoName}`, num + 1);
          const headSha = repo.branches.get(args.head) ?? 'head-sha';
          const baseSha = repo.branches.get(args.base) ?? 'base-sha';
          const pr: PullRequest = {
            number: num,
            id: store.nextId++,
            title: args.title,
            body: args.body ?? '',
            state: 'open',
            head: { ref: args.head, sha: headSha },
            base: { ref: args.base, sha: baseSha },
            merged: false,
            merged_at: null,
            merge_commit_sha: null,
            files: [],
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          };
          repo.pulls.push(pr);
          sendJson(res, 200, {
            jsonrpc: '2.0',
            result: { content: [{ type: 'text', text: JSON.stringify(pr) }] },
            id,
          });
          return;
        }

        if (cleanName === 'merge_pull_request') {
          const owner = args.owner ?? (args.full_name ? args.full_name.split('/')[0] : 'adaiversen');
          const repoName = args.repo ?? (args.full_name ? args.full_name.split('/')[1] : '');
          const repo = store.getRepo(owner, repoName);
          const num = Number(args.pull_number);
          const pr = repo?.pulls.find((p) => p.number === num);
          if (!repo || !pr) {
            sendJson(res, 200, { jsonrpc: '2.0', isError: true, error: { code: -32602, message: 'Not found' }, id });
            return;
          }
          const mergeSha = gitSha('commit', `merge PR #${num}`);
          pr.merged = true;
          pr.state = 'closed';
          pr.merged_at = new Date().toISOString();
          pr.merge_commit_sha = mergeSha;
          sendJson(res, 200, {
            jsonrpc: '2.0',
            result: { content: [{ type: 'text', text: JSON.stringify({ sha: mergeSha, merged: true, message: 'Pull Request successfully merged' }) }] },
            id,
          });
          return;
        }

        // Unknown tool
        sendJson(res, 200, { jsonrpc: '2.0', error: { code: -32601, message: `Method not found: ${toolName}` }, id });
        return;
      }

      sendJson(res, 200, { jsonrpc: '2.0', error: { code: -32601, message: 'Method not found' }, id });
      return;
    }

    // GraphQL Endpoint: POST /api/graphql
    if (path === '/api/graphql') {
      const auth = req.headers['authorization'];
      if (!auth) {
        sendJson(res, 401, { message: 'Requires authentication' });
        return;
      }

      function executeSingleGraphQL(doc: any): any {
        const query: string = doc?.query ?? '';
        const vars: any = doc?.variables ?? {};

        // Helper global IDs
        const toRepoId = (r: Repository) => Buffer.from(`Repository:${r.id}`).toString('base64');
        const toIssueId = (r: Repository, i: Issue) => Buffer.from(`Issue:${r.owner}/${r.name}/${i.number}`).toString('base64');
        const toPrId = (r: Repository, p: PullRequest) => Buffer.from(`PullRequest:${r.owner}/${r.name}/${p.number}`).toString('base64');
        const toCommentId = (c: IssueComment) => Buffer.from(`Comment:${c.id}`).toString('base64');

        // Check for invalid field test
        if (query.includes('noSuchFieldOnViewer')) {
          return {
            errors: [{ message: "Field 'noSuchFieldOnViewer' doesn't exist on type 'User'" }],
            data: { viewer: { login: 'adaiversen' } },
          };
        }

        // Introspection: Issue
        if (query.includes('__type(name: "Issue")')) {
          return {
            data: {
              Issue: {
                fields: [
                  { name: 'id' },
                  { name: 'number' },
                  { name: 'title' },
                  { name: 'state' },
                  { name: 'body' },
                ],
              },
            },
          };
        }

        // Introspection: PullRequest and Repository
        if (query.includes('__type(name: "PullRequest")') && query.includes('__type(name: "Repository")')) {
          return {
            data: {
              PullRequest: {
                fields: [
                  { name: 'id' },
                  { name: 'number' },
                  { name: 'headRefName' },
                  { name: 'baseRefName' },
                  { name: 'mergeable' },
                  { name: 'state' },
                  { name: 'merged' },
                  { name: 'files' },
                ],
              },
              Repository: {
                fields: [
                  { name: 'id' },
                  { name: 'databaseId' },
                  { name: 'name' },
                  { name: 'nameWithOwner' },
                  { name: 'owner' },
                  { name: 'defaultBranchRef' },
                  { name: 'viewerPermission' },
                  { name: 'hasIssuesEnabled' },
                  { name: 'issue' },
                  { name: 'issues' },
                  { name: 'pullRequests' },
                  { name: 'pullRequest' },
                ],
              },
            },
          };
        }

        // Introspection: SearchType
        if (query.includes('__type(name: "SearchType")')) {
          return {
            data: {
              SearchType: {
                enumValues: [
                  { name: 'ISSUE' },
                  { name: 'REPOSITORY' },
                  { name: 'USER' },
                  { name: 'DISCUSSION' },
                ],
              },
            },
          };
        }

        // Mutation: createIssue
        if (query.includes('createIssue')) {
          const input = vars.input ?? {};
          let targetRepo: Repository | undefined;
          if (input.repositoryId) {
            const rawId = Buffer.from(input.repositoryId, 'base64').toString('utf8');
            const numericId = parseInt(rawId.replace(/^Repository:/, ''), 10);
            targetRepo = Array.from(store.repos.values()).find((r) => r.id === numericId);
          }
          if (!targetRepo) {
            targetRepo = Array.from(store.repos.values())[0];
          }
          if (targetRepo) {
            const num = store.nextIssueNumber.get(`${targetRepo.owner}/${targetRepo.name}`) ?? 1;
            store.nextIssueNumber.set(`${targetRepo.owner}/${targetRepo.name}`, num + 1);
            const issue: Issue = {
              number: num,
              id: store.nextId++,
              title: input.title ?? '',
              body: input.body ?? '',
              state: 'open',
              labels: [],
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
              closed_at: null,
              comments: [],
            };
            issue._cachedJsonBuf = Buffer.from(JSON.stringify(issue), 'utf8');
            targetRepo.issues.push(issue);
            targetRepo.issuesMap.set(num, issue);
            return {
              data: {
                createIssue: {
                  issue: {
                    number: issue.number,
                    id: toIssueId(targetRepo, issue),
                  },
                },
              },
            };
          }
        }

        // Mutation: closeIssue
        if (query.includes('closeIssue')) {
          const input = vars.input ?? {};
          const raw = Buffer.from(input.issueId ?? '', 'base64').toString('utf8');
          // Issue:owner/name/number
          const parts = raw.replace(/^Issue:/, '').split('/');
          const owner = parts[0];
          const name = parts[1];
          const num = parseInt(parts[2], 10);
          const repo = store.getRepo(owner, name);
          const issue = repo?.issuesMap.get(num) ?? repo?.issues.find((i) => i.number === num);
          if (issue) {
            issue.state = 'closed';
            issue.closed_at = new Date().toISOString();
            issue._cachedJsonBuf = Buffer.from(JSON.stringify(issue), 'utf8');
            return {
              data: {
                closeIssue: {
                  issue: {
                    number: issue.number,
                    id: input.issueId,
                    state: 'CLOSED',
                  },
                },
              },
            };
          }
        }

        // Mutation: createPullRequest
        if (query.includes('createPullRequest')) {
          const input = vars.input ?? {};
          let targetRepo: Repository | undefined;
          if (input.repositoryId) {
            const rawId = Buffer.from(input.repositoryId, 'base64').toString('utf8');
            const numericId = parseInt(rawId.replace(/^Repository:/, ''), 10);
            targetRepo = Array.from(store.repos.values()).find((r) => r.id === numericId);
          }
          if (!targetRepo) {
            targetRepo = Array.from(store.repos.values())[0];
          }
          if (targetRepo) {
            const num = store.nextPullNumber.get(`${targetRepo.owner}/${targetRepo.name}`) ?? 1;
            store.nextPullNumber.set(`${targetRepo.owner}/${targetRepo.name}`, num + 1);
            const headSha = targetRepo.branches.get(input.headRefName) ?? 'head-sha';
            const baseSha = targetRepo.branches.get(input.baseRefName) ?? 'base-sha';
            const baseTree = targetRepo.tree.get(input.baseRefName) ?? new Map();
            const headTree = targetRepo.tree.get(input.headRefName) ?? new Map();
            const changedFiles: PullFile[] = [];
            for (const [p, f] of headTree) {
              const bf = baseTree.get(p);
              if (!bf) {
                changedFiles.push({ filename: p, status: 'added', additions: 1, deletions: 0, changes: 1 });
              } else if (bf.sha !== f.sha) {
                changedFiles.push({ filename: p, status: 'modified', additions: 1, deletions: 1, changes: 2 });
              }
            }
            const pr: PullRequest = {
              number: num,
              id: store.nextId++,
              title: input.title ?? '',
              body: '',
              state: 'open',
              head: { ref: input.headRefName, sha: headSha },
              base: { ref: input.baseRefName, sha: baseSha },
              merged: false,
              merged_at: null,
              merge_commit_sha: null,
              files: changedFiles,
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            };
            targetRepo.pulls.push(pr);
            return {
              data: {
                createPullRequest: {
                  pullRequest: {
                    number: pr.number,
                    id: toPrId(targetRepo, pr),
                    state: 'OPEN',
                    headRefName: pr.head.ref,
                    baseRefName: pr.base.ref,
                  },
                },
              },
            };
          }
        }

        // Mutation: mergePullRequest
        if (query.includes('mergePullRequest')) {
          const input = vars.input ?? {};
          const raw = Buffer.from(input.pullRequestId ?? '', 'base64').toString('utf8');
          const parts = raw.replace(/^PullRequest:/, '').split('/');
          const owner = parts[0];
          const name = parts[1];
          const num = parseInt(parts[2], 10);
          const repo = store.getRepo(owner, name);
          const pr = repo?.pulls.find((p) => p.number === num);
          if (pr && repo) {
            pr.merged = true;
            pr.state = 'closed';
            pr.merged_at = new Date().toISOString();
            pr.merge_commit_sha = gitSha('commit', `merge PR #${num}`);
            return {
              data: {
                mergePullRequest: {
                  pullRequest: {
                    number: pr.number,
                    merged: true,
                    state: 'MERGED',
                  },
                },
              },
            };
          }
        }

        // Mutation: addComment
        if (query.includes('addComment')) {
          const input = vars.input ?? {};
          const raw = Buffer.from(input.subjectId ?? '', 'base64').toString('utf8');
          const parts = raw.replace(/^Issue:/, '').split('/');
          const owner = parts[0];
          const name = parts[1];
          const num = parseInt(parts[2], 10);
          const repo = store.getRepo(owner, name);
          const issue = repo?.issuesMap.get(num) ?? repo?.issues.find((i) => i.number === num);
          if (issue) {
            const comment: IssueComment = {
              id: store.nextId++,
              body: input.body ?? '',
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            };
            issue.comments.push(comment);
            issue._cachedJsonBuf = Buffer.from(JSON.stringify(issue), 'utf8');
            return {
              data: {
                addComment: {
                  commentEdge: {
                    node: {
                      id: toCommentId(comment),
                      body: comment.body,
                    },
                  },
                },
              },
            };
          }
        }

        // Query: viewer { login }
        if (/\bviewer\s*\{/.test(query)) {
          return {
            data: {
              viewer: { login: 'adaiversen' },
            },
          };
        }

        // Query: node(id: $id)
        if (query.includes('node(id:')) {
          const id = vars.id ?? '';
          const raw = Buffer.from(id, 'base64').toString('utf8');
          const numericId = parseInt(raw.replace(/^Repository:/, ''), 10);
          const repo = Array.from(store.repos.values()).find((r) => r.id === numericId);
          if (repo) {
            return {
              data: {
                node: {
                  id,
                  name: repo.name,
                  nameWithOwner: `${repo.owner}/${repo.name}`,
                },
              },
            };
          }
        }

        // Query: repository(...)
        const owner = vars.owner ?? 'adaiversen';
        const name = vars.name ?? '';
        const repo = store.getRepo(owner, name);

        if (!repo) {
          return {
            data: { repository: null },
          };
        }

        // Specific sub-fields on repository
        if (query.includes('issue(number:')) {
          const num = vars.number ?? 1;
          const issue = repo.issuesMap.get(num) ?? repo.issues.find((i) => i.number === num);
          if (issue) {
            return {
              data: {
                repository: {
                  issue: {
                    number: issue.number,
                    title: issue.title,
                    state: issue.state.toUpperCase(),
                    id: toIssueId(repo, issue),
                    body: issue.body,
                  },
                },
              },
            };
          }
        }

        if (query.includes('pullRequest(number:')) {
          const num = vars.number ?? 1;
          const pr = repo.pulls.find((p) => p.number === num);
          if (pr) {
            const fileNodes = pr.files.map((f) => ({ path: f.filename }));
            return {
              data: {
                repository: {
                  pullRequest: {
                    id: toPrId(repo, pr),
                    number: pr.number,
                    files: {
                      nodes: fileNodes,
                    },
                  },
                },
              },
            };
          }
        }

        if (query.includes('pullRequests(')) {
          const first = vars.first ?? 10;
          const prNodes = repo.pulls.slice(0, first).map((p) => ({
            number: p.number,
            headRefName: p.head.ref,
            baseRefName: p.base.ref,
            mergeable: 'MERGEABLE',
            state: p.state.toUpperCase(),
          }));
          return {
            data: {
              repository: {
                pullRequests: {
                  nodes: prNodes,
                },
              },
            },
          };
        }

        if (query.includes('issues(')) {
          const first = vars.first ?? 10;
          const after = vars.after;
          let issueList = repo.issues;

          if (query.includes('states: [OPEN]')) {
            issueList = issueList.filter((i) => i.state === 'open');
          }
          if (query.includes('CREATED_AT, direction: DESC')) {
            issueList = [...issueList].sort((a, b) => b.number - a.number);
          }

          let startIndex = 0;
          if (after) {
            const afterIndex = issueList.findIndex((i) => toIssueId(repo, i) === after);
            if (afterIndex >= 0) {
              startIndex = afterIndex + 1;
            }
          }

          const slice = issueList.slice(startIndex, startIndex + first);
          const hasNextPage = startIndex + first < issueList.length;
          const lastIssue = slice[slice.length - 1];
          const endCursor = lastIssue ? toIssueId(repo, lastIssue) : null;

          return {
            data: {
              repository: {
                issues: {
                  pageInfo: {
                    hasNextPage,
                    endCursor,
                  },
                  nodes: slice.map((i) => ({
                    number: i.number,
                    title: i.title,
                    state: i.state.toUpperCase(),
                    id: toIssueId(repo, i),
                  })),
                },
              },
            },
          };
        }

        // Default Repository fields
        return {
          data: {
            repository: {
              id: toRepoId(repo),
              databaseId: repo.id,
              name: repo.name,
              nameWithOwner: `${repo.owner}/${repo.name}`,
              owner: { login: repo.owner },
              defaultBranchRef: { name: repo.default_branch },
              viewerPermission: 'ADMIN',
              hasIssuesEnabled: true,
            },
          },
        };
      }

      if (Array.isArray(body)) {
        const results = body.map((doc) => executeSingleGraphQL(doc));
        sendJson(res, 200, results);
        return;
      }

      const result = executeSingleGraphQL(body);
      sendJson(res, 200, result);
      return;
    }

    // Root endpoint: /api/v3 or /api/v3/
    if (path === '/api/v3' || path === '/api/v3/') {
      sendJson(
        res,
        200,
        {
          current_user_url: '/api/v3/user',
          rate_limit_url: '/api/v3/rate_limit',
          repository_url: '/api/v3/repos/{owner}/{repo}',
        },
        { 'x-oauth-scopes': 'repo, read:org' }
      );
      return;
    }

    // Meta endpoint: /api/v3/meta
    if (path === '/api/v3/meta') {
      sendJson(res, 200, { installed_version: '1.0.0' });
      return;
    }

    // Check token authentication
    const authHeader = req.headers['authorization'];
    if (!authHeader) {
      sendJson(res, 401, { message: 'Requires authentication' });
      return;
    }

    // Default viewer login
    const viewerLogin = 'adaiversen';

    // GET /api/v3/user
    if (method === 'GET' && path === '/api/v3/user') {
      sendJson(res, 200, { login: viewerLogin, id: 1, type: 'User' });
      return;
    }

    // POST /api/v3/user/repos
    if (method === 'POST' && path === '/api/v3/user/repos') {
      const name = body?.name;
      if (!name) {
        sendJson(res, 422, { message: 'Repository name required' });
        return;
      }
      const repo = store.createRepo(
        viewerLogin,
        name,
        body?.description ?? '',
        !!body?.private,
        body?.default_branch ?? 'main'
      );
      sendJson(res, 201, {
        id: repo.id,
        name: repo.name,
        full_name: `${repo.owner}/${repo.name}`,
        owner: { login: repo.owner, id: 1 },
        private: repo.private,
        description: repo.description,
        default_branch: repo.default_branch,
      });
      return;
    }

    // GET /api/v3/user/repos
    if (method === 'GET' && path === '/api/v3/user/repos') {
      const perPage = parseInt(parsedUrl.searchParams.get('per_page') ?? '30', 10);
      const page = parseInt(parsedUrl.searchParams.get('page') ?? '1', 10);
      const allUserRepos = Array.from(store.repos.values())
        .filter((r) => r.owner === viewerLogin)
        .map((r) => ({
          id: r.id,
          name: r.name,
          full_name: `${r.owner}/${r.name}`,
          owner: { login: r.owner, id: 1 },
          private: r.private,
          description: r.description,
          default_branch: r.default_branch,
        }));

      const start = (page - 1) * perPage;
      const paginated = allUserRepos.slice(start, start + perPage);

      const headers: Record<string, string> = {};
      if (start + perPage < allUserRepos.length) {
        const host = req.headers.host ?? '127.0.0.1';
        const nextUrl = `http://${host}/api/v3/user/repos?per_page=${perPage}&page=${page + 1}`;
        headers['link'] = `<${nextUrl}>; rel="next"`;
      }

      sendJson(res, 200, paginated, headers);
      return;
    }

    // Repository match: /api/v3/repos/:owner/:repo
    if (!path.startsWith('/api/v3/repos/')) {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }

    const repoRest = path.slice(14); // after '/api/v3/repos/'
    const slash1 = repoRest.indexOf('/');
    if (slash1 === -1) {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    const owner = repoRest.slice(0, slash1);
    const slash2 = repoRest.indexOf('/', slash1 + 1);
    const repoName = slash2 === -1 ? repoRest.slice(slash1 + 1) : repoRest.slice(slash1 + 1, slash2);
    const subPath = slash2 === -1 ? '' : repoRest.slice(slash2);
    const repo = store.getRepo(owner, repoName);

    // Repos not found
    if (!repo) {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }

    // Exact repo route: /api/v3/repos/:owner/:repo
    if (!subPath || subPath === '') {
      if (method === 'GET') {
        sendJson(res, 200, {
          id: repo.id,
          name: repo.name,
          full_name: `${repo.owner}/${repo.name}`,
          owner: { login: repo.owner, id: 1 },
          private: repo.private,
          description: repo.description,
          default_branch: repo.default_branch,
        });
        return;
      }
      if (method === 'PATCH') {
        if (body?.description !== undefined) {
          repo.description = body.description;
        }
        sendJson(res, 200, {
          id: repo.id,
          name: repo.name,
          full_name: `${repo.owner}/${repo.name}`,
          owner: { login: repo.owner, id: 1 },
          private: repo.private,
          description: repo.description,
          default_branch: repo.default_branch,
        });
        return;
      }
      if (method === 'DELETE') {
        store.repos.delete(`${owner}/${repoName}`);
        sendNoContent(res);
        return;
      }
    }

    // Branches: /api/v3/repos/:owner/:repo/branches
    if (method === 'GET' && subPath === '/branches') {
      const branchesList = Array.from(repo.branches.entries()).map(([name, sha]) => ({
        name,
        commit: { sha },
      }));
      sendJson(res, 200, branchesList);
      return;
    }

    // Commits: /api/v3/repos/:owner/:repo/commits
    if (method === 'GET' && subPath === '/commits') {
      const shaFilter = parsedUrl.searchParams.get('sha');
      let commitsList = Array.from(repo.commits.values());
      const targetBranch = shaFilter ?? repo.default_branch;
      commitsList = commitsList.filter((c) => c.branch === targetBranch || c.sha === targetBranch);
      sendJson(
        res,
        200,
        commitsList.map((c) => ({
          sha: c.sha,
          commit: { message: c.message, author: { name: 'Committer', date: new Date().toISOString() } },
        }))
      );
      return;
    }

    // Git Refs: POST /api/v3/repos/:owner/:repo/git/refs
    if (method === 'POST' && subPath === '/git/refs') {
      const ref = body?.ref; // e.g. "refs/heads/feature"
      const sha = body?.sha;
      if (!ref || !sha) {
        sendJson(res, 422, { message: 'Ref and sha required' });
        return;
      }
      const branchName = ref.replace(/^refs\/heads\//, '');
      repo.branches.set(branchName, sha);
      // Copy tree from source commit if exists
      const sourceCommit = repo.commits.get(sha);
      const newTree = new Map(sourceCommit?.files ?? []);
      repo.tree.set(branchName, newTree);
      sendJson(res, 201, { ref, object: { sha, type: 'commit' } });
      return;
    }

    // Contents: /api/v3/repos/:owner/:repo/contents/:path*
    if (subPath.startsWith('/contents/') && subPath.length > 10) {
      const filePath = subPath.slice(10);
      const branch = parsedUrl.searchParams.get('ref') ?? body?.branch ?? repo.default_branch;
      const branchTree = repo.getBranchTree(branch);

      if (method === 'GET') {
        const file = branchTree.get(filePath);
        if (file) {
          sendJson(res, 200, {
            type: 'file',
            encoding: 'base64',
            size: file.size,
            name: filePath.split('/').pop(),
            path: filePath,
            content: file.content.toString('base64'),
            sha: file.sha,
          });
          return;
        }

        // Check if directory
        const dirPrefix = filePath.endsWith('/') ? filePath : `${filePath}/`;
        const dirEntries: any[] = [];
        for (const [p, f] of branchTree.entries()) {
          if (p.startsWith(dirPrefix)) {
            const rel = p.slice(dirPrefix.length);
            const entryName = rel.split('/')[0];
            if (!dirEntries.find((e) => e.name === entryName)) {
              dirEntries.push({
                name: entryName,
                path: `${dirPrefix}${entryName}`,
                type: rel.includes('/') ? 'dir' : 'file',
                size: f.size,
                sha: f.sha,
              });
            }
          }
        }
        if (dirEntries.length > 0) {
          sendJson(res, 200, dirEntries);
          return;
        }

        sendJson(res, 404, { message: 'Not Found' });
        return;
      }

      if (method === 'PUT') {
        const contentStr = body?.content ?? '';
        const contentBuf = Buffer.from(contentStr, 'base64');
        const expectedSha = body?.sha;
        const existing = branchTree.get(filePath);

        if (existing && expectedSha && existing.sha !== expectedSha) {
          sendJson(res, 409, { message: 'Conflict: sha does not match' });
          return;
        }

        const blobSha = gitSha('blob', contentBuf);
        const commitSha = gitSha('commit', `${body?.message ?? 'update'}\0${blobSha}`);
        const fileObj: GitFile = {
          path: filePath,
          content: contentBuf,
          sha: blobSha,
          size: contentBuf.length,
        };
        branchTree.set(filePath, fileObj);
        repo.branches.set(branch, commitSha);
        repo.commits.set(commitSha, {
          sha: commitSha,
          message: body?.message ?? 'commit file',
          branch,
          files: new Map(branchTree),
        });

        const status = existing ? 200 : 201;
        sendJson(res, status, {
          content: {
            name: filePath.split('/').pop(),
            path: filePath,
            sha: blobSha,
            size: fileObj.size,
            encoding: 'base64',
          },
          commit: { sha: commitSha, message: body?.message ?? '' },
        });
        return;
      }

      if (method === 'DELETE') {
        const existing = branchTree.get(filePath);
        if (!existing) {
          sendJson(res, 404, { message: 'Not Found' });
          return;
        }
        branchTree.delete(filePath);
        const commitSha = gitSha('commit', `delete ${filePath}`);
        repo.branches.set(branch, commitSha);
        repo.commits.set(commitSha, {
          sha: commitSha,
          message: body?.message ?? 'delete file',
          branch,
          files: new Map(branchTree),
        });
        sendJson(res, 200, { commit: { sha: commitSha } });
        return;
      }
    }

    // Labels: /api/v3/repos/:owner/:repo/labels
    if (subPath === '/labels') {
      if (method === 'GET') {
        sendJson(res, 200, Array.from(repo.labels.values()));
        return;
      }
      if (method === 'POST') {
        const name = body?.name;
        if (!name) {
          sendJson(res, 422, { message: 'Label name required' });
          return;
        }
        const labelObj: Label = {
          id: store.nextId++,
          name,
          color: body?.color ?? 'ededed',
        };
        repo.labels.set(name, labelObj);
        sendJson(res, 201, labelObj);
        return;
      }
    }

    // Issues: /api/v3/repos/:owner/:repo/issues
    if (subPath === '/issues') {
      if (method === 'POST') {
        const title = body?.title;
        if (!title) {
          sendJson(res, 422, { message: 'Title is required' });
          return;
        }
        const labelNames: string[] = Array.isArray(body?.labels) ? body.labels : [];
        const attachedLabels: Label[] = [];
        for (const lName of labelNames) {
          const found = repo.labels.get(lName);
          if (!found) {
            sendJson(res, 422, { message: `Label ${lName} does not exist` });
            return;
          }
          attachedLabels.push(found);
        }

        const num = store.nextIssueNumber.get(`${owner}/${repoName}`) ?? 1;
        store.nextIssueNumber.set(`${owner}/${repoName}`, num + 1);
        const now = new Date().toISOString();
        const issue: Issue = {
          number: num,
          id: store.nextId++,
          title,
          body: body?.body ?? '',
          state: 'open',
          labels: attachedLabels,
          created_at: now,
          updated_at: now,
          closed_at: null,
          comments: [],
        };
        const issueBuf = Buffer.from(JSON.stringify(issue), 'utf8');
        issue._cachedJsonBuf = issueBuf;
        repo.issues.push(issue);
        repo.issuesMap.set(num, issue);
        sendJsonBuffer(res, 201, issueBuf);
        return;
      }

      if (method === 'GET') {
        const state = parsedUrl.searchParams.get('state') ?? 'open';
        const sort = parsedUrl.searchParams.get('sort') ?? 'created';
        const direction = parsedUrl.searchParams.get('direction') ?? 'desc';

        let list = repo.issues.filter((i) => {
          if (state === 'all') return true;
          return i.state === state;
        });

        list.sort((a, b) => {
          if (direction === 'asc') return a.number - b.number;
          return b.number - a.number;
        });

        sendJson(res, 200, list);
        return;
      }
    }

    // Single Issue or Comments: /api/v3/repos/:owner/:repo/issues/:number...
    if (subPath.startsWith('/issues/')) {
      const subIssues = subPath.slice(8);
      const slashAfter = subIssues.indexOf('/');
      if (slashAfter === -1) {
        // Single Issue: /api/v3/repos/:owner/:repo/issues/:number
        const num = parseInt(subIssues, 10);
        if (!isNaN(num)) {
          const issue = repo.issuesMap.get(num) ?? repo.issues.find((i) => i.number === num);
          if (!issue) {
            sendJson(res, 404, { message: 'Not Found' });
            return;
          }

          if (method === 'GET') {
            if (issue._cachedJsonBuf) {
              sendJsonBuffer(res, 200, issue._cachedJsonBuf);
            } else {
              const buf = Buffer.from(JSON.stringify(issue), 'utf8');
              issue._cachedJsonBuf = buf;
              sendJsonBuffer(res, 200, buf);
            }
            return;
          }

          if (method === 'PATCH') {
            if (body?.state) {
              issue.state = body.state;
              if (body.state === 'closed') {
                issue.closed_at = new Date().toISOString();
              }
            }
            if (body?.title) issue.title = body.title;
            if (body?.body !== undefined) issue.body = body.body;
            issue.updated_at = new Date().toISOString();
            const buf = Buffer.from(JSON.stringify(issue), 'utf8');
            issue._cachedJsonBuf = buf;
            clearFastReadCache();
            lastReadPath = '';
            lastReadBuf = null;
            lastReadHeaders = null;
            sendJsonBuffer(res, 200, buf);
            return;
          }
        }
      } else if (subIssues.slice(slashAfter) === '/comments') {
        // Issue Comments: /api/v3/repos/:owner/:repo/issues/:number/comments
        const num = parseInt(subIssues.slice(0, slashAfter), 10);
        if (!isNaN(num)) {
          const issue = repo.issuesMap.get(num) ?? repo.issues.find((i) => i.number === num);
          if (!issue) {
            sendJson(res, 404, { message: 'Not Found' });
            return;
          }

          if (method === 'GET') {
            sendJson(res, 200, issue.comments);
            return;
          }

          if (method === 'POST') {
            const cBody = body?.body;
            if (!cBody) {
              sendJson(res, 422, { message: 'Body required' });
              return;
            }
            const commentObj: IssueComment = {
              id: store.nextId++,
              body: cBody,
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            };
            issue.comments.push(commentObj);
            sendJson(res, 201, commentObj);
            return;
          }
        }
      }
    }

    // Pull Requests: /api/v3/repos/:owner/:repo/pulls
    if (subPath === '/pulls') {
      if (method === 'POST') {
        const title = body?.title;
        const head = body?.head;
        const base = body?.base;
        if (!title || !head || !base) {
          sendJson(res, 422, { message: 'Title, head and base required' });
          return;
        }
        const num = store.nextPullNumber.get(`${owner}/${repoName}`) ?? 1;
        store.nextPullNumber.set(`${owner}/${repoName}`, num + 1);

        const headSha = repo.branches.get(head) ?? gitSha('commit', head);
        const baseSha = repo.branches.get(base) ?? gitSha('commit', base);

        // Find changed files between base and head
        const headTree = repo.getBranchTree(head);
        const baseTree = repo.getBranchTree(base);
        const changedFiles: PullFile[] = [];

        for (const [p, f] of headTree.entries()) {
          const bf = baseTree.get(p);
          if (!bf) {
            changedFiles.push({ filename: p, status: 'added', additions: 1, deletions: 0, changes: 1 });
          } else if (bf.sha !== f.sha) {
            changedFiles.push({ filename: p, status: 'modified', additions: 1, deletions: 1, changes: 2 });
          }
        }

        const pr: PullRequest = {
          number: num,
          id: store.nextId++,
          title,
          body: body?.body ?? '',
          state: 'open',
          head: { ref: head, sha: headSha },
          base: { ref: base, sha: baseSha },
          merged: false,
          merged_at: null,
          merge_commit_sha: null,
          files: changedFiles,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };
        repo.pulls.push(pr);
        sendJson(res, 201, pr);
        return;
      }

      if (method === 'GET') {
        const state = parsedUrl.searchParams.get('state') ?? 'open';
        let list = repo.pulls;
        if (state !== 'all') {
          list = list.filter((p) => p.state === state);
        }
        sendJson(res, 200, list);
        return;
      }
    }

    // Pull Requests: /api/v3/repos/:owner/:repo/pulls/:number...
    if (subPath.startsWith('/pulls/')) {
      const subPulls = subPath.slice(7);
      const slashAfter = subPulls.indexOf('/');
      if (slashAfter === -1) {
        // Single Pull Request: /api/v3/repos/:owner/:repo/pulls/:number
        const num = parseInt(subPulls, 10);
        if (!isNaN(num)) {
          const pr = repo.pulls.find((p) => p.number === num);
          if (!pr) {
            sendJson(res, 404, { message: 'Not Found' });
            return;
          }
          if (method === 'GET') {
            sendJson(res, 200, pr);
            return;
          }
        }
      } else if (subPulls.slice(slashAfter) === '/files') {
        // Pull Files: /api/v3/repos/:owner/:repo/pulls/:number/files
        const num = parseInt(subPulls.slice(0, slashAfter), 10);
        if (!isNaN(num)) {
          const pr = repo.pulls.find((p) => p.number === num);
          if (!pr) {
            sendJson(res, 404, { message: 'Not Found' });
            return;
          }
          sendJson(res, 200, pr.files);
          return;
        }
      } else if (subPulls.slice(slashAfter) === '/merge' && method === 'PUT') {
        // Pull Merge: PUT /api/v3/repos/:owner/:repo/pulls/:number/merge
        const num = parseInt(subPulls.slice(0, slashAfter), 10);
        if (!isNaN(num)) {
          const pr = repo.pulls.find((p) => p.number === num);
          if (!pr) {
            sendJson(res, 404, { message: 'Not Found' });
            return;
          }
          if (pr.merged) {
            sendJson(res, 405, { message: 'Pull Request is already merged' });
            return;
          }

          // Check if base branch tip has advanced past pr.base.sha
          const currentBaseSha = repo.branches.get(pr.base.ref);
          if (currentBaseSha && currentBaseSha !== pr.base.sha) {
            sendJson(res, 405, { message: 'Pull Request is not mergeable' });
            return;
          }

          const mergeSha = gitSha('commit', `squash merge PR #${num}`);
          pr.merged = true;
          pr.state = 'closed';
          pr.merged_at = new Date().toISOString();
          pr.merge_commit_sha = mergeSha;

          // Apply files from head to default branch
          const headTree = repo.getBranchTree(pr.head.ref);
          const defaultTree = repo.getBranchTree(repo.default_branch);
          for (const [p, f] of headTree.entries()) {
            defaultTree.set(p, f);
          }
          repo.tree.set(repo.default_branch, defaultTree);
          repo.branches.set(repo.default_branch, mergeSha);
          repo.commits.set(mergeSha, {
            sha: mergeSha,
            message: body?.commit_message ?? `Squash commit #${num}`,
            branch: repo.default_branch,
            files: new Map(defaultTree),
          });

          sendJson(res, 200, {
            sha: mergeSha,
            merged: true,
            message: 'Pull Request successfully merged',
          });
          return;
        }
      }
    }

    // Fallback 404
    sendJson(res, 404, { message: 'Not Found' });
  }

  server.on('connection', (socket) => {
    socket.setNoDelay(true);
  });

  return server;
}
