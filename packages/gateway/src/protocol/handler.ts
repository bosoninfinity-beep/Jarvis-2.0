import WebSocket from 'ws';
import {
  type RequestFrame,
  type ResponseFrame,
  type EventFrame,
  type Frame,
  Frame as FrameSchema,
  ErrorCode,
  createLogger,
} from '@jarvis/shared';

const log = createLogger('gateway:protocol');

export type MethodHandler = (params: unknown, clientId: string) => Promise<unknown>;

export class ProtocolHandler {
  private readonly methods: Map<string, MethodHandler> = new Map();
  private readonly clients: Map<string, WebSocket> = new Map();

  /** Register a gateway method handler */
  registerMethod(method: string, handler: MethodHandler): void {
    this.methods.set(method, handler);
  }

  /** Register a client WebSocket connection */
  registerClient(clientId: string, ws: WebSocket): void {
    this.clients.set(clientId, ws);
    log.info(`Client registered: ${clientId}`);
  }

  /** Remove a client */
  removeClient(clientId: string): void {
    this.clients.delete(clientId);
    log.info(`Client removed: ${clientId}`);
  }

  /** Handle an incoming message from a client */
  async handleMessage(clientId: string, raw: string): Promise<void> {
    let frame: Frame;

    try {
      const parsed: unknown = JSON.parse(raw);
      const result = FrameSchema.safeParse(parsed);
      if (!result.success) {
        this.sendError(clientId, 'unknown', ErrorCode.INVALID_REQUEST, 'Invalid frame format');
        return;
      }
      frame = result.data;
    } catch {
      this.sendError(clientId, 'unknown', ErrorCode.INVALID_REQUEST, 'Invalid JSON');
      return;
    }

    if (frame.type === 'req') {
      await this.handleRequest(clientId, frame);
    }
    // Events and responses from clients are ignored for now
  }

  /** Handle a request frame */
  private async handleRequest(clientId: string, req: RequestFrame): Promise<void> {
    const handler = this.methods.get(req.method);

    if (!handler) {
      this.sendError(clientId, req.id, ErrorCode.METHOD_NOT_FOUND, `Unknown method: ${req.method}`);
      return;
    }

    try {
      const result = await handler(req.params, clientId);
      this.sendResponse(clientId, req.id, result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(`Method ${req.method} failed`, { error: message, clientId });
      this.sendError(clientId, req.id, ErrorCode.INTERNAL_ERROR, message);
    }
  }

  /** Send a response to a specific client */
  private sendResponse(clientId: string, requestId: string, result: unknown): void {
    const frame: ResponseFrame = {
      type: 'res',
      id: requestId,
      result,
    };
    this.sendToClient(clientId, frame);
  }

  /** Send an error response to a specific client */
  private sendError(clientId: string, requestId: string, code: number, message: string): void {
    const frame: ResponseFrame = {
      type: 'res',
      id: requestId,
      error: { code, message },
    };
    this.sendToClient(clientId, frame);
  }

  /** Broadcast an event to all connected clients */
  broadcast(event: string, payload: unknown): void {
    const frame: EventFrame = {
      type: 'event',
      event,
      payload,
    };
    const json = JSON.stringify(frame);
    for (const [id, ws] of this.clients) {
      if (ws.readyState !== WebSocket.OPEN) {
        this.clients.delete(id);
        continue;
      }
      try {
        ws.send(json);
      } catch (err) {
        log.error(`Failed to send to client ${id}, removing`, { error: String(err) });
        this.clients.delete(id);
      }
    }
  }

  /** Send an event to a specific client */
  sendEvent(clientId: string, event: string, payload: unknown): void {
    const frame: EventFrame = {
      type: 'event',
      event,
      payload,
    };
    this.sendToClient(clientId, frame);
  }

  /** Send raw frame to a client */
  private sendToClient(clientId: string, frame: ResponseFrame | EventFrame): void {
    const ws = this.clients.get(clientId);
    if (ws && ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify(frame));
    }
  }

  /** Get number of connected clients */
  get clientCount(): number {
    return this.clients.size;
  }

  /** Get all client IDs */
  get clientIds(): string[] {
    return [...this.clients.keys()];
  }
}
