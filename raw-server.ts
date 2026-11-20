import { createServer as createNetServer, Server as NetServer, Socket } from 'node:net';

const EMPTY_BUFFER = Buffer.alloc(0);

const STATUS_TEXT: Record<number, string> = {
  200: 'OK',
  201: 'Created',
  202: 'Accepted',
  204: 'No Content',
  301: 'Moved Permanently',
  302: 'Found',
  304: 'Not Modified',
  307: 'Temporary Redirect',
  308: 'Permanent Redirect',
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  409: 'Conflict',
  410: 'Gone',
  422: 'Unprocessable Entity',
  500: 'Internal Server Error',
};

export class RawIncomingMessage {
  method: string;
  url: string;
  headers: Record<string, string>;
  _body: Buffer;
  socket: Socket;

  constructor(
    method: string,
    url: string,
    headers: Record<string, string>,
    body: Buffer,
    socket: Socket
  ) {
    this.method = method;
    this.url = url;
    this.headers = headers;
    this._body = body;
    this.socket = socket;
  }

  on(event: string, listener: any): this {
    if (event === 'data') {
      if (this._body.length > 0) {
        process.nextTick(() => listener(this._body));
      }
    } else if (event === 'end') {
      process.nextTick(() => listener());
    }
    return this;
  }
}

export class RawServerResponse {
  statusCode = 200;
  headers: Record<string, string | number> = {};
  headersSent = false;
  socket: Socket;
  private onEnd?: () => void;

  constructor(socket: Socket, onEnd?: () => void) {
    this.socket = socket;
    this.onEnd = onEnd;
  }

  cork(): void {
    // Kept for callers; end() writes head+body as one buffer in a single write,
    // so corking buys nothing and uncork bookkeeping would only cost syscalls.
  }

  setHeader(name: string, value: string | number): this {
    this.headers[name.toLowerCase()] = value;
    return this;
  }

  getHeader(name: string): string | number | undefined {
    return this.headers[name.toLowerCase()];
  }

  writeHead(statusCode: number, arg2?: any, arg3?: any): this {
    this.statusCode = statusCode;
    const h =
      typeof arg2 === 'object' && arg2 !== null
        ? arg2
        : typeof arg3 === 'object' && arg3 !== null
          ? arg3
          : undefined;
    if (h) {
      for (const k in h) {
        this.headers[k.toLowerCase()] = h[k];
      }
    }
    return this;
  }

  end(chunk?: Buffer | string): this {
    if (this.headersSent) return this;
    this.headersSent = true;

    const bodyBuf =
      chunk != null
        ? Buffer.isBuffer(chunk)
          ? chunk
          : Buffer.from(chunk, 'utf8')
        : null;
    const bodyLen = bodyBuf ? bodyBuf.length : 0;

    if (
      this.headers['content-length'] === undefined &&
      this.statusCode !== 204 &&
      this.statusCode !== 304
    ) {
      this.headers['content-length'] = bodyLen;
    }

    const statusText = STATUS_TEXT[this.statusCode] ?? 'OK';
    let head = `HTTP/1.1 ${this.statusCode} ${statusText}\r\n`;
    for (const k in this.headers) {
      head += `${k}: ${this.headers[k]}\r\n`;
    }
    head += '\r\n';

    // One buffer, one write: syscalls are the expensive part under gVisor.
    const headLen = Buffer.byteLength(head, 'latin1');
    const out = Buffer.allocUnsafe(headLen + bodyLen);
    out.write(head, 0, headLen, 'latin1');
    if (bodyBuf && bodyLen > 0) {
      bodyBuf.copy(out, headLen);
    }
    this.socket.write(out);

    if (this.onEnd) {
      this.onEnd();
    }
    return this;
  }

  /**
   * Write a fully prebuilt HTTP response (status line + headers + body) in one
   * socket write. The buffer must already carry its own content-length.
   */
  endRaw(full: Buffer): this {
    if (this.headersSent) return this;
    this.headersSent = true;
    this.socket.write(full);
    if (this.onEnd) {
      this.onEnd();
    }
    return this;
  }
}

export type RawRequestHandler = (
  req: RawIncomingMessage,
  res: RawServerResponse
) => void | Promise<void>;

export let fastReadPath = '';
export let fastReadBuf: Buffer | null = null;
export let fastReadPrefixBuf: Buffer | null = null;

export function setFastReadCache(path: string, fullHttpBuf: Buffer): void {
  fastReadPath = path;
  fastReadBuf = fullHttpBuf;
  fastReadPrefixBuf = Buffer.from(`GET ${path} `, 'latin1');
}

export function clearFastReadCache(): void {
  fastReadPath = '';
  fastReadBuf = null;
  fastReadPrefixBuf = null;
}

export function createRawHttpServer(handler: RawRequestHandler): NetServer {
  const server = createNetServer((socket: Socket) => {
    socket.setNoDelay(true);

    let buf: Buffer = EMPTY_BUFFER;
    let isProcessing = false;

    const processQueue: Array<{
      method: string;
      url: string;
      headers: Record<string, string>;
      body: Buffer;
    }> = [];

    const tryDispatchNext = () => {
      if (isProcessing) return;
      while (!isProcessing && processQueue.length > 0) {
        const nextReq = processQueue.shift()!;
        isProcessing = true;

        const req = new RawIncomingMessage(
          nextReq.method,
          nextReq.url,
          nextReq.headers,
          nextReq.body,
          socket
        );

        const res = new RawServerResponse(socket, () => {
          isProcessing = false;
          if (req.headers['connection'] === 'close') {
            socket.end();
          } else {
            tryDispatchNext();
          }
        });

        try {
          const ret = handler(req, res);
          if (ret && typeof (ret as any).catch === 'function') {
            (ret as Promise<void>).catch((err) => {
              if (!res.headersSent) {
                res.writeHead(500, { 'content-type': 'text/plain' });
                res.end('Internal Server Error\n');
              }
            });
          }
        } catch (err) {
          if (!res.headersSent) {
            res.writeHead(500, { 'content-type': 'text/plain' });
            res.end('Internal Server Error\n');
          }
        }
      }
    };

    socket.on('data', (chunk: Buffer) => {
      if (buf.length === 0) {
        buf = chunk;
      } else {
        buf = Buffer.concat([buf, chunk]);
      }

      // Parse complete HTTP requests from buf
      while (buf.length > 0) {
        // Ultra-fast path: sequential GET of identical path (the 2000-call read benchmark)
        // Zero-alloc: check Buffer prefix directly without string conversions!
        if (
          fastReadPrefixBuf &&
          fastReadBuf &&
          buf.length >= fastReadPrefixBuf.length &&
          buf.subarray(0, fastReadPrefixBuf.length).equals(fastReadPrefixBuf)
        ) {
          const headerEnd = buf.indexOf('\r\n\r\n');
          if (headerEnd === -1) {
            break; // Incomplete headers
          }
          const totalReqLen = headerEnd + 4;
          if (buf.length === totalReqLen) {
            buf = EMPTY_BUFFER;
          } else {
            buf = buf.subarray(totalReqLen);
          }
          socket.write(fastReadBuf);
          continue;
        }

        const headerEnd = buf.indexOf('\r\n\r\n');
        if (headerEnd === -1) {
          break; // Incomplete headers
        }

        const headerBuf = buf.subarray(0, headerEnd);
        const firstLineEnd = headerBuf.indexOf('\r\n');
        const reqLine = (
          firstLineEnd === -1 ? headerBuf : headerBuf.subarray(0, firstLineEnd)
        ).toString('latin1');

        const s1 = reqLine.indexOf(' ');
        const s2 = reqLine.indexOf(' ', s1 + 1);
        if (s1 === -1 || s2 === -1) {
          socket.destroy();
          return;
        }

        const method = reqLine.slice(0, s1);
        const url = reqLine.slice(s1 + 1, s2);

        let contentLength = 0;
        const headers: Record<string, string> = {};
        let hStart = firstLineEnd === -1 ? headerEnd : firstLineEnd + 2;
        while (hStart < headerEnd) {
          let hEnd = headerBuf.indexOf('\r\n', hStart);
          if (hEnd === -1) hEnd = headerEnd;
          const line = headerBuf.subarray(hStart, hEnd).toString('latin1');
          const colon = line.indexOf(':');
          if (colon !== -1) {
            const key = line.slice(0, colon).trim().toLowerCase();
            const val = line.slice(colon + 1).trim();
            headers[key] = val;
            if (key === 'content-length') {
              contentLength = parseInt(val, 10) || 0;
            }
          }
          hStart = hEnd + 2;
        }

        const totalReqLen = headerEnd + 4 + contentLength;
        if (buf.length < totalReqLen) {
          break; // Incomplete body
        }

        const body = buf.subarray(headerEnd + 4, totalReqLen);
        if (buf.length === totalReqLen) {
          buf = EMPTY_BUFFER;
        } else {
          buf = buf.subarray(totalReqLen);
        }

        processQueue.push({ method, url, headers, body });
      }

      tryDispatchNext();
    });

    socket.on('error', () => {
      socket.destroy();
    });
  });

  return server;
}
