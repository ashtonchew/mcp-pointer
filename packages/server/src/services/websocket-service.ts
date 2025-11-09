import { WebSocketServer, WebSocket } from 'ws';
import { createServer, Server as HttpServer, IncomingMessage, ServerResponse } from 'http';
import {
  PointerMessage,
  PointerMessageType,
  ScreenshotOptions,
  ScreenshotResponseMessage,
  ScreenshotErrorMessage,
  ScreenshotData,
} from '@mcp-pointer/shared/types';
import { config } from '../config';
import logger from '../logger';
import { randomUUID } from 'crypto';

// WebSocket constants
const DEFAULT_SCREENSHOT_TIMEOUT = 5000; // 5 seconds

type MessageHandler = (type: string, data: any) => void | Promise<void>;

interface PendingScreenshotRequest {
  resolve: (data: ScreenshotData & { elementSelector?: string }) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

export default class WebSocketService {
  private wss: WebSocketServer | null = null;

  private httpServer: HttpServer | null = null; // For FOLLOWER screenshot proxy requests

  private isLeader = false;

  private port: number;

  private messageHandler: MessageHandler | null = null;

  private connectedClients: Set<WebSocket> = new Set();

  private pendingScreenshotRequests: Map<string, PendingScreenshotRequest> = new Map();

  private serverReady = false;

  private heartbeatInterval: NodeJS.Timeout | null = null;

  private readonly HEARTBEAT_INTERVAL = 25000; // 25 seconds - before Chrome's 30s shutdown

  constructor(port: string | number = config.websocket.port) {
    const intPort = typeof port === 'string' ? parseInt(port, 10) : port;

    this.port = intPort;
  }

  public registerMessageHandler(handler: MessageHandler): void {
    this.messageHandler = handler;
  }

  public async start(): Promise<void> {
    return this.campaignForLeadership();
  }

  private async campaignForLeadership(): Promise<void> {
    try {
      this.wss = new WebSocketServer({ port: this.port });
      this.setupHandlers();
      await this.waitForListening();
      this.isLeader = true;
      this.serverReady = true;
      this.startHeartbeat();
      this.startHttpServer(); // Start HTTP server for FOLLOWER screenshot requests
      logger.info('🎯 This instance is now the LEADER (WebSocket server active)');
    } catch (err) {
      // Clean up failed attempt
      this.stop();

      const error = err as NodeJS.ErrnoException;
      if (error.code === 'EADDRINUSE') {
        this.isLeader = false;
        this.serverReady = false;
        logger.info('👥 Running as FOLLOWER (port busy - will proxy screenshots to LEADER)');
        // FOLLOWER mode: Don't retry, just serve MCP tools and proxy screenshot requests
        return;
      } else {
        logger.error('Failed to start WebSocket server:', err);
        throw err;
      }
    }
  }

  private setupHandlers(): void {
    if (!this.wss) return;

    this.wss.on('connection', this.handleConnection.bind(this));
  }

  private async waitForListening(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.wss!.on('listening', resolve);
      this.wss!.on('error', reject);
    });
  }

  private handleConnection(ws: WebSocket): void {
    // Track connected client
    this.connectedClients.add(ws);

    logger.info('👆 Browser extension connected to WebSocket server', {
      totalClients: this.connectedClients.size,
      clientState: ws.readyState === WebSocket.OPEN ? 'OPEN' : 'OTHER',
    });

    ws.on('message', (data: any) => this.handleWebSocketMessage(ws, data));
    ws.on('close', () => this.handleWebSocketClose(ws));
  }

  private handleWebSocketMessage(_ws: WebSocket, data: any): void {
    try {
      const message: PointerMessage = JSON.parse(data.toString());
      logger.debug('📨 Received message from browser:', message.type);

      // Handle PONG responses (heartbeat)
      if (message.type === PointerMessageType.PONG) {
        logger.debug('💓 Received PONG from extension');
        return;
      }

      // Handle screenshot responses
      if (message.type === PointerMessageType.SCREENSHOT_RESPONSE) {
        this.handleScreenshotResponse(message.data as ScreenshotResponseMessage);
        return;
      }

      if (message.type === PointerMessageType.SCREENSHOT_ERROR) {
        this.handleScreenshotError(message.data as ScreenshotErrorMessage);
        return;
      }

      // Log non-heartbeat messages at info level
      logger.info('📨 Received message from browser:', message.type);

      // Pass other messages to registered handler
      if (this.messageHandler) {
        this.messageHandler(message.type, message.data);
      }
    } catch (error) {
      logger.error('Failed to parse message:', error);
    }
  }

  private handleWebSocketClose(ws: WebSocket): void {
    this.connectedClients.delete(ws);

    logger.info('👆 Browser extension disconnected from WebSocket server', {
      remainingClients: this.connectedClients.size,
    });
  }

  public isLeaderInstance(): boolean {
    return this.isLeader;
  }

  /**
   * Check if the WebSocket server is ready to accept connections
   */
  public isReady(): boolean {
    return this.serverReady;
  }

  /**
   * Check if there are any connected extension clients
   */
  public hasConnectedClients(): boolean {
    return this.connectedClients.size > 0;
  }

  /**
   * Check if there are any actively connected clients (WebSocket OPEN state)
   */
  public hasActiveClients(): boolean {
    for (const client of this.connectedClients) {
      if (client.readyState === WebSocket.OPEN) {
        return true;
      }
    }
    return false;
  }

  /**
   * Get count of clients in OPEN state
   */
  public getActiveClientCount(): number {
    let count = 0;
    for (const client of this.connectedClients) {
      if (client.readyState === WebSocket.OPEN) {
        count += 1;
      }
    }
    return count;
  }

  /**
   * Request a screenshot from the connected extension
   */
  public requestScreenshot(
    options: ScreenshotOptions = {}
  ): Promise<ScreenshotData & { elementSelector?: string }> {
    return new Promise((resolve, reject) => {
      // Check for connected clients
      if (this.connectedClients.size === 0) {
        reject(new Error('No browser extension connected. Ensure MCP Pointer extension is running.'));
        return;
      }

      // Generate request ID
      const requestId = randomUUID();

      // Set timeout
      const timeout = options.timeout || DEFAULT_SCREENSHOT_TIMEOUT;
      const timeoutHandle = setTimeout(() => {
        this.pendingScreenshotRequests.delete(requestId);
        reject(new Error(`Screenshot request timed out after ${timeout}ms`));
      }, timeout);

      // Store pending request
      this.pendingScreenshotRequests.set(requestId, {
        resolve,
        reject,
        timeout: timeoutHandle,
      });

      // Send request to all connected clients (first to respond wins)
      const message: PointerMessage = {
        type: PointerMessageType.SCREENSHOT_REQUEST,
        data: {
          requestId,
          options,
          timestamp: Date.now(),
        },
        timestamp: Date.now(),
      };

      const messageStr = JSON.stringify(message);
      this.connectedClients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(messageStr);
        }
      });

      logger.info('📸 Screenshot request sent:', requestId);
    });
  }

  /**
   * Handle successful screenshot response
   */
  private handleScreenshotResponse(response: ScreenshotResponseMessage): void {
    const pending = this.pendingScreenshotRequests.get(response.requestId);

    if (!pending) {
      logger.warn('Received screenshot response for unknown request:', response.requestId);
      return;
    }

    // Clear timeout and resolve
    clearTimeout(pending.timeout);
    this.pendingScreenshotRequests.delete(response.requestId);

    logger.info('✅ Screenshot received:', {
      requestId: response.requestId,
      width: response.screenshot.width,
      height: response.screenshot.height,
      byteSize: response.screenshot.byteSize,
    });

    pending.resolve({
      ...response.screenshot,
      elementSelector: response.elementSelector,
    });
  }

  /**
   * Handle screenshot error response
   */
  private handleScreenshotError(error: ScreenshotErrorMessage): void {
    const pending = this.pendingScreenshotRequests.get(error.requestId);

    if (!pending) {
      logger.warn('Received screenshot error for unknown request:', error.requestId);
      return;
    }

    // Clear timeout and reject
    clearTimeout(pending.timeout);
    this.pendingScreenshotRequests.delete(error.requestId);

    logger.error('❌ Screenshot error:', error.errorCode, error.errorMessage);

    pending.reject(new Error(`${error.errorCode}: ${error.errorMessage}`));
  }

  /**
   * Start heartbeat to keep Chrome extension service worker alive
   */
  private startHeartbeat(): void {
    // Clear any existing heartbeat
    this.stopHeartbeat();

    // Send PING every 25 seconds to prevent Chrome from shutting down service worker
    this.heartbeatInterval = setInterval(() => {
      this.sendHeartbeat();
    }, this.HEARTBEAT_INTERVAL);

    logger.info('💓 Heartbeat started (25s interval)');
  }

  /**
   * Stop heartbeat interval
   */
  private stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  /**
   * Send PING to all active clients
   */
  private sendHeartbeat(): void {
    const message: PointerMessage = {
      type: PointerMessageType.PING,
      timestamp: Date.now(),
    };

    const messageStr = JSON.stringify(message);
    let sentCount = 0;
    let staleCount = 0;

    // Send to all clients and track stale connections
    const staleClients: WebSocket[] = [];

    this.connectedClients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        try {
          client.send(messageStr);
          sentCount += 1;
        } catch (error) {
          logger.error('Failed to send heartbeat to client:', error);
          staleClients.push(client);
        }
      } else {
        // Client is not in OPEN state, mark as stale
        staleClients.push(client);
        staleCount += 1;
      }
    });

    // Clean up stale connections
    staleClients.forEach((client) => {
      this.connectedClients.delete(client);
    });

    if (sentCount > 0) {
      logger.debug(`💓 Heartbeat sent to ${sentCount} client(s)${staleCount > 0 ? `, removed ${staleCount} stale` : ''}`);
    }
  }

  /**
   * Start HTTP server for LEADER to handle screenshot requests from FOLLOWERs
   */
  private startHttpServer(): void {
    const httpPort = this.port + 1; // Use port + 1 for HTTP (e.g., 7007 -> 7008)

    this.httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
      this.handleHttpRequest(req, res);
    });

    this.httpServer.listen(httpPort, () => {
      logger.info(`📡 HTTP server for FOLLOWER requests listening on port ${httpPort}`);
    });

    this.httpServer.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE') {
        logger.warn(`HTTP port ${httpPort} already in use (non-critical)`);
      } else {
        logger.error('HTTP server error:', error);
      }
    });
  }

  /**
   * Handle HTTP requests from FOLLOWER instances
   */
  private handleHttpRequest(req: IncomingMessage, res: ServerResponse): void {
    // Only accept POST requests to /screenshot
    if (req.method !== 'POST' || req.url !== '/screenshot') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
      return;
    }

    // Read request body
    let body = '';
    req.on('data', (chunk) => {
      body += chunk.toString();
    });

    req.on('end', async () => {
      try {
        const requestData = JSON.parse(body);
        const options: ScreenshotOptions = requestData.options || {};

        // Make screenshot request to browser extension via WebSocket
        const screenshot = await this.requestScreenshot(options);

        // Send response back to FOLLOWER
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, screenshot }));
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        logger.error('Screenshot request from FOLLOWER failed:', errorMessage);

        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: errorMessage }));
      }
    });
  }

  /**
   * FOLLOWER: Request screenshot from LEADER via HTTP
   */
  public async requestScreenshotFromLeader(
    options: ScreenshotOptions = {}
  ): Promise<ScreenshotData & { elementSelector?: string }> {
    return new Promise((resolve, reject) => {
      const httpPort = this.port + 1; // LEADER HTTP server on port + 1

      const requestData = JSON.stringify({ options });

      const httpRequest = require('http').request(
        {
          hostname: 'localhost',
          port: httpPort,
          path: '/screenshot',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(requestData),
          },
        },
        (httpRes: IncomingMessage) => {
          let responseBody = '';

          httpRes.on('data', (chunk) => {
            responseBody += chunk.toString();
          });

          httpRes.on('end', () => {
            try {
              const response = JSON.parse(responseBody);

              if (response.success) {
                logger.info('✅ Screenshot received from LEADER');
                resolve(response.screenshot);
              } else {
                reject(new Error(response.error || 'Screenshot request failed'));
              }
            } catch (error) {
              reject(new Error('Invalid response from LEADER'));
            }
          });
        }
      );

      httpRequest.on('error', (error: Error) => {
        reject(new Error(`Failed to connect to LEADER: ${error.message}`));
      });

      httpRequest.write(requestData);
      httpRequest.end();
    });
  }

  public stop(): void {
    // Stop heartbeat
    this.stopHeartbeat();

    // Stop HTTP server
    if (this.httpServer) {
      this.httpServer.close();
      this.httpServer = null;
    }

    // Clean up pending requests
    this.pendingScreenshotRequests.forEach((request) => {
      clearTimeout(request.timeout);
      request.reject(new Error('WebSocket service stopped'));
    });
    this.pendingScreenshotRequests.clear();

    // Close all client connections
    this.connectedClients.clear();

    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }
    this.isLeader = false;
    this.serverReady = false;
  }
}
