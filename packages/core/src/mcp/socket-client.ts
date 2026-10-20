export * as McpSocketClient from "./socket-client.js"

import { deserializeMessage, type JSONRPCMessage, type Transport } from "@modelcontextprotocol/client"
import { Effect } from "effect"

/** The side of an incoming WebSocket the transport writes to. */
export interface Socket {
  readonly send: (text: string) => void
  readonly close: (code?: number, reason?: string) => void
}

export interface SocketTransport extends Transport {
  /** Feeds one inbound text frame. */
  readonly deliver: (text: string) => void
  /** Reports that the socket closed; fires `onclose` once. */
  readonly ended: () => void
}

/**
 * MCP client transport over a WebSocket that a client app opened to the server. The app runs the
 * MCP server and opencode runs the MCP client, so only the connection direction is inverted: the
 * transport is only ever made for an incoming socket and never dials out.
 *
 * Framing: one JSON-RPC 2.0 message per text frame, JSON-encoded, without batching. A frame that is
 * not valid JSON or not a JSON-RPC message is reported through `onerror` and the connection stays
 * open. Frames that arrive before `start()` are buffered and delivered on start.
 *
 * Closing: `close()` closes the socket with 1000 (normal). The endpoint closes with 1011 on internal
 * errors and 1008 on policy or auth failures. Either way `onclose` fires exactly once, and nothing
 * is replayed after a disconnect: a reconnecting client starts a fresh MCP session.
 */
export function make(socket: Socket): SocketTransport {
  const pending: string[] = []
  let phase: "ready" | "open" | "closed" = "ready"

  const finish = () => {
    if (phase === "closed") return
    phase = "closed"
    pending.length = 0
    transport.onclose?.()
  }

  const receive = (text: string) =>
    Effect.runSync(
      Effect.try({
        try: () => deserializeMessage(text),
        catch: (cause) => new Error("Invalid MCP socket frame", { cause }),
      }).pipe(
        Effect.match({
          onFailure: (error) => transport.onerror?.(error),
          onSuccess: (message) => transport.onmessage?.(message),
        }),
      ),
    )

  const transport: SocketTransport = {
    start: () => {
      if (phase === "closed") return Promise.reject(new Error("Not connected"))
      if (phase === "open") return Promise.reject(new Error("Socket transport already started"))
      phase = "open"
      pending.splice(0).forEach(receive)
      return Promise.resolve()
    },
    send: (message: JSONRPCMessage) =>
      phase !== "open"
        ? Promise.reject(new Error("Not connected"))
        : Effect.runPromise(
            Effect.try({
              try: () => socket.send(JSON.stringify(message)),
              catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
            }),
          ),
    close: () => {
      if (phase === "closed") return Promise.resolve()
      finish()
      socket.close(1000)
      return Promise.resolve()
    },
    deliver: (text) => {
      if (phase === "closed") return
      if (phase === "ready") {
        pending.push(text)
        return
      }
      receive(text)
    },
    ended: finish,
  }

  return transport
}
