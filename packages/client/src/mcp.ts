import {
  deserializeMessage,
  McpServer,
  type JSONRPCMessage,
  type ServerContext,
  type Transport,
} from "@modelcontextprotocol/server"

export type ClientMcpOptions = {
  /** Base URL of the opencode server, for example `http://127.0.0.1:4096`. Its query params are kept. */
  readonly url: string
  /** Client name, `[a-zA-Z0-9_-]+`. Tools are exposed to the model as `<name>_<tool>`. */
  readonly name: string
  /** Sent as `location[directory]`. */
  readonly directory?: string
  /** Handshake headers, such as `authorization`. Browsers cannot send them; use a ticket in `url` instead. */
  readonly headers?: Record<string, string>
  /** Adds tools to a fresh `McpServer`. Called once per connection, including after every reconnect. */
  readonly register: (server: McpServer) => void
  readonly WebSocket?: typeof WebSocket
}

export type ClientMcpConnection = {
  close(): Promise<void>
}

const SESSION_ID_META_KEY = "ai.opencode/sessionID"
const RECONNECT_MIN = 500
const RECONNECT_MAX = 10_000

/**
 * Exposes tools to the opencode server: opens a WebSocket to `/api/experimental/client-mcp` and serves an
 * MCP server over it, so the opencode server is the MCP client. Reconnects with backoff until `close()`.
 */
export function connectClientMcp(options: ClientMcpOptions): ClientMcpConnection {
  const state: { disposed: boolean; delay: number; timer?: ReturnType<typeof setTimeout>; server?: McpServer } = {
    disposed: false,
    delay: RECONNECT_MIN,
  }

  const connect = () => {
    if (state.disposed) return
    const Socket = options.WebSocket ?? WebSocket
    const socket = options.headers
      ? // Bun and Node accept a `{ headers }` init as the second argument; the DOM typings only know protocols.
        new Socket(endpoint(options), { headers: options.headers } as unknown as string[])
      : new Socket(endpoint(options))
    const server = new McpServer({ name: options.name, version: "1.0.0" })
    state.server = server
    options.register(server)
    // Reset backoff only once the opencode server finished initializing, so a failed attach keeps backing off.
    server.server.oninitialized = () => {
      state.delay = RECONNECT_MIN
    }
    void server.connect(createTransport(socket)).catch(() => socket.close())
    socket.addEventListener("close", () => {
      if (state.server === server) state.server = undefined
      if (state.disposed) return
      state.timer = setTimeout(connect, state.delay)
      state.delay = Math.min(state.delay * 2, RECONNECT_MAX)
    })
  }

  connect()

  return {
    async close() {
      state.disposed = true
      clearTimeout(state.timer)
      await state.server?.close()
    },
  }
}

/** The opencode session that issued a tool call, read from the request `_meta`. */
export function sessionID(ctx: Pick<ServerContext, "mcpReq">) {
  const value = ctx.mcpReq._meta?.[SESSION_ID_META_KEY]
  return typeof value === "string" ? value : undefined
}

function endpoint(options: ClientMcpOptions) {
  const base = new URL(options.url)
  if (!base.pathname.endsWith("/")) base.pathname += "/"
  const url = new URL("api/experimental/client-mcp", base)
  url.search = base.search
  if (options.directory) url.searchParams.set("location[directory]", options.directory)
  url.searchParams.set("name", options.name)
  url.protocol = url.protocol === "https:" || url.protocol === "wss:" ? "wss:" : "ws:"
  return url
}

/**
 * One JSON-RPC message per text frame. Frames that arrive before `start()` are buffered. Invalid frames are
 * reported through `onerror` and the connection stays open. Nothing is replayed after a disconnect.
 */
function createTransport(socket: WebSocket) {
  const state: { started: boolean; closed: boolean; buffer: string[] } = { started: false, closed: false, buffer: [] }

  const end = () => {
    if (state.closed) return
    state.closed = true
    state.buffer.length = 0
    transport.onclose?.()
  }

  const receive = (text: string) => {
    const message = parse(text)
    if (message instanceof Error) return transport.onerror?.(message)
    transport.onmessage?.(message)
  }

  const transport: Transport = {
    async start() {
      state.started = true
      while (!state.closed && state.buffer.length > 0) receive(state.buffer.shift()!)
    },
    async send(message: JSONRPCMessage) {
      if (state.closed || socket.readyState !== socket.OPEN) throw new Error("Not connected")
      socket.send(JSON.stringify(message))
    },
    async close() {
      if (state.closed) return
      socket.close(1000)
      end()
    },
  }

  socket.addEventListener("message", (event) => {
    if (state.closed) return
    if (typeof event.data !== "string") return transport.onerror?.(new Error("Expected a text frame"))
    if (!state.started) return void state.buffer.push(event.data)
    receive(event.data)
  })
  socket.addEventListener("close", end)
  return transport
}

function parse(text: string) {
  try {
    return deserializeMessage(text)
  } catch (cause) {
    return new Error("Invalid JSON-RPC frame", { cause })
  }
}
