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
}

export function createGitRepoData(defaultBranch = 'main'): GitRepoData {
  return {
    objects: new Map(),
    refs: new Map(),
    headSymref: `refs/heads/${defaultBranch}`,
  };
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
      // Protocol v2 advertisement
      const lines: Array<string | 'flush'> = [
        'version 2\n',
        'ls-refs\n',
        'fetch=shallow\n',
        'object-format=sha1\n',
        'flush',
      ];
      const body = encodePktLines(lines);
      res.writeHead(200, {
        'content-type': 'application/x-git-upload-pack-advertisement',
        'cache-control': 'no-cache',
      });
      res.end(body);
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
    res.writeHead(200, {
      'content-type': 'application/x-git-upload-pack-advertisement',
      'cache-control': 'no-cache',
    });
    res.end(body);
    return;
  }

  if (service === 'git-receive-pack') {
    // Protocol v0 receive-pack advertisement
    const lines: Array<string | 'flush'> = ['# service=git-receive-pack\n', 'flush'];
    const caps = 'report-status report-status-v2 delete-refs side-band-64k ofs-delta';
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
    res.writeHead(200, {
      'content-type': 'application/x-git-receive-pack-advertisement',
      'cache-control': 'no-cache',
    });
    res.end(body);
    return;
  }
}

export async function handleGitReceivePack(
  req: IncomingMessage,
  res: ServerResponse,
  gitRepo: GitRepoData,
  onRefUpdated?: (ref: string, newOid: string, oldOid: string) => void
): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk);
  const rawBody = Buffer.concat(chunks);

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

    const text = payload.toString('utf8').replace(/\n$/, '');
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
        onRefUpdated?.(cmd.ref, ZERO_OID, cmd.oldOid);
        refReports.push(`ok ${cmd.ref}\n`);
      }
    } else if (cmd.oldOid === ZERO_OID) {
      // Create ref
      if (currentOid !== ZERO_OID) {
        refReports.push(`ng ${cmd.ref} already exists\n`);
      } else {
        gitRepo.refs.set(cmd.ref, cmd.newOid);
        onRefUpdated?.(cmd.ref, cmd.newOid, ZERO_OID);
        refReports.push(`ok ${cmd.ref}\n`);
      }
    } else {
      // Update ref
      if (currentOid !== cmd.oldOid) {
        refReports.push(`ng ${cmd.ref} non-fast-forward\n`);
      } else {
        const reachable = collectReachable([cmd.newOid], (oid) => gitRepo.objects.get(oid), { allowMissing: true });
        if (!reachable.has(cmd.oldOid)) {
          refReports.push(`ng ${cmd.ref} non-fast-forward\n`);
        } else {
          gitRepo.refs.set(cmd.ref, cmd.newOid);
          onRefUpdated?.(cmd.ref, cmd.newOid, cmd.oldOid);
          refReports.push(`ok ${cmd.ref}\n`);
        }
      }
    }
  }

  const reportPktLines = encodePktLines(['unpack ok\n', ...refReports, 'flush']);
  const sideband = capabilities.has('side-band-64k');

  res.writeHead(200, {
    'content-type': 'application/x-git-receive-pack-result',
    'cache-control': 'no-cache',
  });

  if (sideband) {
    res.end(Buffer.concat([
      encodePktLine(Buffer.concat([Buffer.from([1]), reportPktLines])),
      pktLineFlush(),
    ]));
  } else {
    res.end(reportPktLines);
  }
}

export async function handleGitUploadPack(
  req: IncomingMessage,
  res: ServerResponse,
  gitRepo: GitRepoData
): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk);
  const rawBody = Buffer.concat(chunks);

  const packets = decodePktLines(rawBody, { allowTrailing: true });
  if (packets.length === 0) {
    res.writeHead(400, { 'content-type': 'text/plain' });
    res.end('No packets\n');
    return;
  }

  const firstPacket = packets.find((p) => p.kind === 'data');
  const firstLine = firstPacket ? firstPacket.payload.toString('utf8').replace(/\n$/, '') : '';

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
    const text = p.payload.toString('utf8').replace(/\n$/, '');
    if (text.startsWith('ref-prefix ')) prefixes.push(text.slice('ref-prefix '.length).trim());
    else if (text === 'peel') peel = true;
    else if (text === 'symrefs') symrefs = true;
    else if (text === 'unborn') unborn = true;
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
  res.writeHead(200, {
    'content-type': 'application/x-git-upload-pack-result',
    'cache-control': 'no-cache',
  });
  res.end(body);
}

function handleFetch(packets: GitPacket[], res: ServerResponse, gitRepo: GitRepoData): void {
  const wants: string[] = [];
  const haves = new Set<string>();
  const shallowBoundaries = new Set<string>();
  let depth: number | null = null;
  let done = false;

  for (const p of packets) {
    if (p.kind !== 'data') continue;
    const line = p.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) haves.add(line.slice(5).trim());
    else if (line.startsWith('shallow ')) shallowBoundaries.add(line.slice(8).trim());
    else if (line.startsWith('deepen ')) depth = parseInt(line.slice(7).trim(), 10);
    else if (line === 'done') done = true;
  }

  const lookup = (oid: string): GitObject | undefined => gitRepo.objects.get(oid);

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

  res.writeHead(200, {
    'content-type': 'application/x-git-upload-pack-result',
    'cache-control': 'no-cache',
  });
  res.end(Buffer.concat(parts));
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
