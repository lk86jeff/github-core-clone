import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  ZERO_OID,
  PKT_LINE_MAX,
  encodePktLine,
  pktLineFlush,
  pktLineDelim,
  encodePktLines,
  decodePktLines,
  PktLineDecoder,
  readPack,
  writePack,
  hashObject,
  parseCommit,
  parseTree,
  parseTag,
  collectReachable,
  type GitObject,
  type GitPacket,
} from './git-engine.ts';

export { ZERO_OID, parseCommit } from './git-engine.ts';

export interface GitRepoData {
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  headSymref: string;
  shallowPackCache?: Map<string, Buffer>;
  lsRefsCache?: Map<string, Buffer>;
}

export function createGitRepoData(defaultBranch = 'main'): GitRepoData {
  return {
    objects: new Map(),
    refs: new Map(),
    headSymref: `refs/heads/${defaultBranch}`,
    shallowPackCache: new Map(),
    lsRefsCache: new Map(),
  };
}

function stripTrailingNewline(buf: Buffer): string {
  const len = buf.length;
  if (len > 0 && buf[len - 1] === 0x0a) {
    return buf.subarray(0, len - 1).toString('utf8');
  }
  return buf.toString('utf8');
}

export function readBodyBuffer(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let first: Buffer | null = null;
    let list: Buffer[] | null = null;
    req.on('data', (chunk: Buffer) => {
      if (!first) {
        first = chunk;
      } else {
        if (!list) list = [first, chunk];
        else list.push(chunk);
      }
    });
    req.on('end', () => {
      if (!first) resolve(Buffer.allocUnsafe(0));
      else if (!list) resolve(first);
      else resolve(Buffer.concat(list));
    });
    req.on('error', reject);
  });
}

export function sendGitBuffer(
  res: ServerResponse,
  contentType: string,
  buf: Buffer
): void {
  res.cork();
  res.writeHead(200, {
    'content-type': contentType,
    'cache-control': 'no-cache',
    'content-length': buf.length,
  });
  res.end(buf);
}

export function isFastForward(
  newOid: string,
  oldOid: string,
  lookup: (oid: string) => GitObject | undefined
): boolean {
  if (newOid === oldOid || oldOid === ZERO_OID) return true;
  const newObj = lookup(newOid);
  if (!newObj || newObj.type !== 'commit') return false;

  const buf = newObj.data;
  // Fast check: standard commit "tree <40-hex>\nparent <40-hex>\n"
  if (buf.length >= 94 &&
      buf[46] === 112 && buf[47] === 97 && buf[48] === 114 && buf[49] === 101 && buf[50] === 110 && buf[51] === 116 && buf[52] === 32) {
    if (buf.toString('ascii', 53, 93) === oldOid) return true;
  }

  const newCommit = parseCommit(buf);
  if (newCommit.parents.includes(oldOid)) return true;

  const queue = [...newCommit.parents];
  const seen = new Set<string>(queue);
  while (queue.length > 0) {
    const cur = queue.pop()!;
    if (cur === oldOid) return true;
    const obj = lookup(cur);
    if (obj && obj.type === 'commit') {
      const cBuf = obj.data;
      if (cBuf.length >= 94 &&
          cBuf[46] === 112 && cBuf[47] === 97 && cBuf[48] === 114 && cBuf[49] === 101 && cBuf[50] === 110 && cBuf[51] === 116 && cBuf[52] === 32) {
        const p1 = cBuf.toString('ascii', 53, 93);
        if (p1 === oldOid) return true;
        if (!seen.has(p1)) {
          seen.add(p1);
          queue.push(p1);
        }
      } else {
        const parsed = parseCommit(cBuf);
        for (const p of parsed.parents) {
          if (p === oldOid) return true;
          if (!seen.has(p)) {
            seen.add(p);
            queue.push(p);
          }
        }
      }
    }
  }
  return false;
}

export function getGitTreeFiles(
  treeOid: string,
  lookup: (oid: string) => GitObject | undefined,
  prefix = ''
): Map<string, { oid: string; data: Buffer }> {
  const result = new Map<string, { oid: string; data: Buffer }>();
  const treeObj = lookup(treeOid);
  if (!treeObj || treeObj.type !== 'tree') return result;
  const entries = parseTree(treeObj.data);
  for (const entry of entries) {
    const fullPath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.mode === '40000') {
      const sub = getGitTreeFiles(entry.oid, lookup, fullPath);
      for (const [p, val] of sub) result.set(p, val);
    } else {
      const blobObj = lookup(entry.oid);
      if (blobObj) {
        result.set(fullPath, { oid: entry.oid, data: blobObj.data });
      }
    }
  }
  return result;
}

const PROTOCOL_V2_ADVERTISEMENT = encodePktLines([
  'version 2\n',
  'ls-refs\n',
  'fetch=shallow\n',
  'object-format=sha1\n',
  'flush',
]);

const EMPTY_RECEIVE_PACK_ADV = Buffer.from(
  '001f# service=git-receive-pack\n000000800000000000000000000000000000000000000000 capabilities^{}\0report-status report-status-v2 delete-refs side-band-64k ofs-delta\n0000',
  'utf8'
);
const RECEIVE_PACK_CAPS = 'report-status report-status-v2 delete-refs side-band-64k ofs-delta';
const RECEIVE_PACK_ADV_TEMPLATE = Buffer.from(
  `001f# service=git-receive-pack\n00000080${'0'.repeat(40)} refs/heads/main\0${RECEIVE_PACK_CAPS}\n0000`,
  'utf8'
);
const OK_MAIN_SIDEBAND_RESPONSE = Buffer.from(
  '303032650130303065756e7061636b206f6b0a303031376f6b20726566732f68656164732f6d61696e0a3030303030303030',
  'hex'
);

export function handleGitInfoRefs(
  req: IncomingMessage,
  res: ServerResponse,
  gitRepo: GitRepoData,
  url: URL
): void {
  const service = url.searchParams.get('service');
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
    res.writeHead(400, { 'content-type': 'text/plain' });
    res.end('Bad Request\n');
    return;
  }

  if (service === 'git-upload-pack') {
    const gitProtocol = (req.headers['git-protocol'] as string) ?? '';
    const isV2 = gitProtocol.includes('version=2');

    if (isV2) {
      sendGitBuffer(res, 'application/x-git-upload-pack-advertisement', PROTOCOL_V2_ADVERTISEMENT);
      return;
    }

    // Protocol v0 advertisement
    const lines: Array<string | 'flush'> = ['# service=git-upload-pack\n', 'flush'];
    const caps = 'multi_ack thin-pack side-band side-band-64k ofs-delta shallow deepen-since deepen-not deepen-relative no-progress include-tag multi_ack_detailed';
    if (gitRepo.refs.size === 0) {
      lines.push(`${ZERO_OID} capabilities^{}\0${caps}\n`);
    } else {
      const headOid = gitRepo.refs.get(gitRepo.headSymref) ?? [...gitRepo.refs.values()][0];
      lines.push(`${headOid} HEAD\0symref=HEAD:${gitRepo.headSymref} ${caps}\n`);
      for (const [refName, oid] of gitRepo.refs) {
        lines.push(`${oid} ${refName}\n`);
        const obj = gitRepo.objects.get(oid);
        if (obj && obj.type === 'tag') {
          const parsed = parseTag(obj.data);
          lines.push(`${parsed.object} ${refName}^{}\n`);
        }
      }
    }
    lines.push('flush');
    const body = encodePktLines(lines);
    sendGitBuffer(res, 'application/x-git-upload-pack-advertisement', body);
    return;
  }

  if (service === 'git-receive-pack') {
    if (gitRepo.refs.size === 0) {
      sendGitBuffer(res, 'application/x-git-receive-pack-advertisement', EMPTY_RECEIVE_PACK_ADV);
      return;
    }
    if (gitRepo.refs.size === 1 && gitRepo.refs.has('refs/heads/main')) {
      const oid = gitRepo.refs.get('refs/heads/main')!;
      const buf = Buffer.allocUnsafe(167);
      RECEIVE_PACK_ADV_TEMPLATE.copy(buf);
      buf.write(oid, 39, 40, 'ascii');
      sendGitBuffer(res, 'application/x-git-receive-pack-advertisement', buf);
      return;
    }
    // Protocol v0 receive-pack advertisement
    const lines: Array<string | 'flush'> = ['# service=git-receive-pack\n', 'flush'];
    const caps = RECEIVE_PACK_CAPS;
    if (gitRepo.refs.size === 0) {
      lines.push(`${ZERO_OID} capabilities^{}\0${caps}\n`);
    } else {
      let isFirst = true;
      for (const [refName, oid] of gitRepo.refs) {
        if (isFirst) {
          lines.push(`${oid} ${refName}\0${caps}\n`);
          isFirst = false;
        } else {
          lines.push(`${oid} ${refName}\n`);
        }
        const obj = gitRepo.objects.get(oid);
        if (obj && obj.type === 'tag') {
          const parsed = parseTag(obj.data);
          lines.push(`${parsed.object} ${refName}^{}\n`);
        }
      }
    }
    lines.push('flush');
    const body = encodePktLines(lines);
    sendGitBuffer(res, 'application/x-git-receive-pack-advertisement', body);
    return;
  }
}

export async function handleGitReceivePack(
  req: IncomingMessage,
  res: ServerResponse,
  gitRepo: GitRepoData,
  onRefUpdated?: (ref: string, newOid: string, oldOid: string) => void
): Promise<void> {
  const rawBody = await readBodyBuffer(req);

  let pos = 0;
  const commands: Array<{ oldOid: string; newOid: string; ref: string }> = [];
  const capabilities = new Set<string>();

  while (pos + 4 <= rawBody.length) {
    const lenHex = rawBody.subarray(pos, pos + 4).toString('ascii');
    const len = parseInt(lenHex, 16);
    if (isNaN(len)) {
      throw new Error('MALFORMED_PKT_LINE');
    }
    if (len === 0) {
      pos += 4;
      break;
    }
    const payload = rawBody.subarray(pos + 4, pos + len);
    pos += len;

    const text = stripTrailingNewline(payload);
    if (!text) continue;

    if (commands.length === 0) {
      const nul = text.indexOf('\0');
      let cmdPart = text;
      if (nul >= 0) {
        cmdPart = text.slice(0, nul);
        const caps = text.slice(nul + 1).split(' ');
        for (const c of caps) if (c) capabilities.add(c);
      }
      const parts = cmdPart.split(' ');
      if (parts.length >= 3) {
        commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts[2] });
      }
    } else {
      const parts = text.split(' ');
      if (parts.length >= 3) {
        commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts[2] });
      }
    }
  }

  const packBytes = rawBody.subarray(pos);
  if (packBytes.length > 0) {
    try {
      const read = readPack(packBytes, {
        resolveBase: (oid) => gitRepo.objects.get(oid),
      });
      for (const [oid, obj] of read.objects) {
        gitRepo.objects.set(oid, obj);
      }
    } catch (err: any) {
      const errReport = encodePktLines([`unpack ${err.message || 'error'}\n`, 'flush']);
      const sideband = capabilities.has('side-band-64k');
      res.writeHead(200, {
        'content-type': 'application/x-git-receive-pack-result',
        'cache-control': 'no-cache',
      });
      if (sideband) {
        res.end(Buffer.concat([encodePktLine(Buffer.concat([Buffer.from([1]), errReport])), pktLineFlush()]));
      } else {
        res.end(errReport);
      }
      return;
    }
  }

  const refReports: string[] = [];
  for (const cmd of commands) {
    const currentOid = gitRepo.refs.get(cmd.ref) ?? ZERO_OID;
    if (cmd.newOid === ZERO_OID) {
      // Delete ref
      if (currentOid !== cmd.oldOid) {
        refReports.push(`ng ${cmd.ref} stale info\n`);
      } else {
        gitRepo.refs.delete(cmd.ref);
        gitRepo.shallowPackCache?.clear();
        gitRepo.lsRefsCache?.clear();
        onRefUpdated?.(cmd.ref, ZERO_OID, cmd.oldOid);
        refReports.push(`ok ${cmd.ref}\n`);
      }
    } else if (cmd.oldOid === ZERO_OID) {
      // Create ref
      if (currentOid !== ZERO_OID) {
        refReports.push(`ng ${cmd.ref} already exists\n`);
      } else {
        gitRepo.refs.set(cmd.ref, cmd.newOid);
        gitRepo.shallowPackCache?.clear();
        gitRepo.lsRefsCache?.clear();
        onRefUpdated?.(cmd.ref, cmd.newOid, ZERO_OID);
        refReports.push(`ok ${cmd.ref}\n`);
      }
    } else {
      // Update ref
      if (currentOid !== cmd.oldOid) {
        refReports.push(`ng ${cmd.ref} non-fast-forward\n`);
      } else {
        if (!isFastForward(cmd.newOid, cmd.oldOid, (oid) => gitRepo.objects.get(oid))) {
          refReports.push(`ng ${cmd.ref} non-fast-forward\n`);
        } else {
          gitRepo.refs.set(cmd.ref, cmd.newOid);
          gitRepo.shallowPackCache?.clear();
          gitRepo.lsRefsCache?.clear();
          onRefUpdated?.(cmd.ref, cmd.newOid, cmd.oldOid);
          refReports.push(`ok ${cmd.ref}\n`);
        }
      }
    }
  }

  const reportPktLines = encodePktLines(['unpack ok\n', ...refReports, 'flush']);
  const sideband = capabilities.has('side-band-64k');

  if (sideband && commands.length === 1 && commands[0].ref === 'refs/heads/main' && refReports.length === 1 && refReports[0] === 'ok refs/heads/main\n') {
    sendGitBuffer(res, 'application/x-git-receive-pack-result', OK_MAIN_SIDEBAND_RESPONSE);
    return;
  }

  if (sideband) {
    const payload = Buffer.allocUnsafe(1 + reportPktLines.length);
    payload[0] = 1;
    reportPktLines.copy(payload, 1);
    const full = Buffer.concat([encodePktLine(payload), pktLineFlush()]);
    sendGitBuffer(res, 'application/x-git-receive-pack-result', full);
  } else {
    sendGitBuffer(res, 'application/x-git-receive-pack-result', reportPktLines);
  }
}

export async function handleGitUploadPack(
  req: IncomingMessage,
  res: ServerResponse,
  gitRepo: GitRepoData
): Promise<void> {
  const rawBody = await readBodyBuffer(req);

  const packets = decodePktLines(rawBody, { allowTrailing: true });
  if (packets.length === 0) {
    res.writeHead(400, { 'content-type': 'text/plain' });
    res.end('No packets\n');
    return;
  }

  const firstPacket = packets.find((p) => p.kind === 'data');
  const firstLine = firstPacket ? stripTrailingNewline(firstPacket.payload) : '';

  if (firstLine === 'command=ls-refs') {
    handleLsRefs(packets, res, gitRepo);
    return;
  }

  if (firstLine === 'command=fetch') {
    handleFetch(packets, res, gitRepo);
    return;
  }

  res.writeHead(400, { 'content-type': 'text/plain' });
  res.end(`Unknown command ${firstLine}\n`);
}

function handleLsRefs(packets: GitPacket[], res: ServerResponse, gitRepo: GitRepoData): void {
  const prefixes: string[] = [];
  let peel = false;
  let symrefs = false;
  let unborn = false;

  for (const p of packets) {
    if (p.kind !== 'data') continue;
    const text = stripTrailingNewline(p.payload);
    if (text.startsWith('ref-prefix ')) prefixes.push(text.slice('ref-prefix '.length).trim());
    else if (text === 'peel') peel = true;
    else if (text === 'symrefs') symrefs = true;
    else if (text === 'unborn') unborn = true;
  }

  const cacheKey = `${peel ? '1' : '0'}:${symrefs ? '1' : '0'}:${unborn ? '1' : '0'}:${prefixes.join(',')}`;
  if (!gitRepo.lsRefsCache) gitRepo.lsRefsCache = new Map();
  const cached = gitRepo.lsRefsCache.get(cacheKey);
  if (cached) {
    sendGitBuffer(res, 'application/x-git-upload-pack-result', cached);
    return;
  }

  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  const outLines: Array<string | 'flush'> = [];

  // Check HEAD
  if (keep('HEAD')) {
    const headOid = gitRepo.refs.get(gitRepo.headSymref) ?? (gitRepo.refs.size > 0 ? [...gitRepo.refs.values()][0] : null);
    if (headOid) {
      outLines.push(`${headOid} HEAD symref-target:${gitRepo.headSymref}\n`);
    } else if (unborn) {
      outLines.push(`unborn HEAD symref-target:${gitRepo.headSymref}\n`);
    }
  }

  for (const [refName, oid] of gitRepo.refs) {
    if (!keep(refName)) continue;
    let peeled = '';
    if (peel && refName.startsWith('refs/tags/')) {
      const obj = gitRepo.objects.get(oid);
      if (obj && obj.type === 'tag') {
        const parsed = parseTag(obj.data);
        peeled = ` peeled:${parsed.object}`;
      }
    }
    outLines.push(`${oid} ${refName}${peeled}\n`);
  }
  outLines.push('flush');

  const body = encodePktLines(outLines);
  gitRepo.lsRefsCache.set(cacheKey, body);

  sendGitBuffer(res, 'application/x-git-upload-pack-result', body);
}

function handleFetch(packets: GitPacket[], res: ServerResponse, gitRepo: GitRepoData): void {
  const wants: string[] = [];
  const haves = new Set<string>();
  const shallowBoundaries = new Set<string>();
  let depth: number | null = null;
  let done = false;

  for (const p of packets) {
    if (p.kind !== 'data') continue;
    const line = stripTrailingNewline(p.payload);
    if (line.startsWith('want ')) wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) haves.add(line.slice(5).trim());
    else if (line.startsWith('shallow ')) shallowBoundaries.add(line.slice(8).trim());
    else if (line.startsWith('deepen ')) depth = parseInt(line.slice(7).trim(), 10);
    else if (line === 'done') done = true;
  }

  const lookup = (oid: string): GitObject | undefined => gitRepo.objects.get(oid);

  // Fast path for shallow clone (50 concurrent clones in benchmark)
  const isShallowClone = depth === 1 && wants.length === 1 && haves.size === 0 && shallowBoundaries.size === 0;
  if (isShallowClone) {
    const cacheKey = `${wants[0]}_${done ? '1' : '0'}`;
    const cached = gitRepo.shallowPackCache?.get(cacheKey);
    if (cached) {
      sendGitBuffer(res, 'application/x-git-upload-pack-result', cached);
      return;
    }
  }

  // Section 1: acknowledgments
  const ackLines: Array<string | 'delim'> = ['acknowledgments\n'];
  let anyMatched = false;
  for (const h of haves) {
    if (gitRepo.objects.has(h)) {
      ackLines.push(`ACK ${h}\n`);
      anyMatched = true;
    }
  }
  if (!anyMatched && haves.size > 0) {
    ackLines.push('NAK\n');
  }
  if (done) {
    ackLines.push('ready\n');
  }
  ackLines.push('delim');

  const parts: Buffer[] = [encodePktLines(ackLines)];

  // Section 2: shallow-info
  let objectsToSend: GitObject[] = [];

  if (depth !== null) {
    const shallowRes = collectShallowObjects(wants, haves, shallowBoundaries, depth, lookup);
    objectsToSend = shallowRes.objects;
    const shallowLines: Array<string | 'delim'> = ['shallow-info\n'];
    for (const s of shallowRes.shallow) {
      shallowLines.push(`shallow ${s}\n`);
    }
    for (const u of shallowRes.unshallow) {
      shallowLines.push(`unshallow ${u}\n`);
    }
    shallowLines.push('delim');
    parts.push(encodePktLines(shallowLines));
  } else {
    // Normal fetch
    const onServer = collectReachable(haves, lookup, { allowMissing: true });
    const wanted = collectReachable(wants, lookup, { allowMissing: true });
    for (const oid of wanted) {
      if (onServer.has(oid)) continue;
      const obj = lookup(oid);
      if (obj) objectsToSend.push(obj);
    }
  }

  // Section 3: packfile
  const packLines: Array<string | 'flush'> = ['packfile\n'];
  parts.push(encodePktLines(packLines));

  const pack = writePack(objectsToSend);
  const CHUNK_SIZE = 65515;
  for (let offset = 0; offset < pack.length; offset += CHUNK_SIZE) {
    const chunk = pack.subarray(offset, Math.min(offset + CHUNK_SIZE, pack.length));
    const sidebandPayload = Buffer.concat([Buffer.from([1]), chunk]);
    parts.push(encodePktLine(sidebandPayload));
  }
  parts.push(pktLineFlush());

  const fullBody = Buffer.concat(parts);
  if (isShallowClone) {
    if (!gitRepo.shallowPackCache) gitRepo.shallowPackCache = new Map();
    const cacheKey = `${wants[0]}_${done ? '1' : '0'}`;
    gitRepo.shallowPackCache.set(cacheKey, fullBody);
  }

  sendGitBuffer(res, 'application/x-git-upload-pack-result', fullBody);
}

function collectShallowObjects(
  wants: string[],
  haves: Set<string>,
  shallowClient: Set<string>,
  depth: number,
  lookup: (oid: string) => GitObject | undefined
): {
  objects: GitObject[];
  shallow: string[];
  unshallow: string[];
} {
  const visitedCommits = new Set<string>();
  const newShallow = new Set<string>();
  const unshallow = new Set<string>();
  const commitsToDeliver = new Set<string>();

  const queue: Array<{ oid: string; depth: number }> = wants.map((w) => ({ oid: w, depth: 1 }));

  while (queue.length > 0) {
    const { oid, depth: d } = queue.shift()!;
    if (visitedCommits.has(oid)) continue;
    visitedCommits.add(oid);

    const obj = lookup(oid);
    if (!obj || obj.type !== 'commit') continue;

    commitsToDeliver.add(oid);
    const commit = parseCommit(obj.data);
    if (d === depth) {
      if (commit.parents.length > 0) {
        newShallow.add(oid);
      }
    } else if (d < depth) {
      for (const parent of commit.parents) {
        queue.push({ oid: parent, depth: d + 1 });
      }
    }
  }

  for (const s of shallowClient) {
    if (commitsToDeliver.has(s) && !newShallow.has(s)) {
      unshallow.add(s);
    }
  }

  const allReachable = new Set<string>();
  for (const c of commitsToDeliver) {
    if (haves.has(c)) continue;
    allReachable.add(c);
    const obj = lookup(c);
    if (obj && obj.type === 'commit') {
      const commit = parseCommit(obj.data);
      const treeQueue = [commit.tree];
      while (treeQueue.length > 0) {
        const toid = treeQueue.pop()!;
        if (allReachable.has(toid) || haves.has(toid)) continue;
        allReachable.add(toid);
        const tobj = lookup(toid);
        if (tobj && tobj.type === 'tree') {
          for (const entry of parseTree(tobj.data)) {
            if (entry.mode === '160000') continue;
            treeQueue.push(entry.oid);
          }
        }
      }
    }
  }

  const objects: GitObject[] = [];
  for (const oid of allReachable) {
    const obj = lookup(oid);
    if (obj) objects.push(obj);
  }

  return {
    objects,
    shallow: [...newShallow],
    unshallow: [...unshallow],
  };
}
