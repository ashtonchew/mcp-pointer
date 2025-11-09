import ReconnectingWebSocket from 'reconnecting-websocket';
import {
  RawPointedDOMElement,
  PointerMessage,
  PointerMessageType,
  ConnectionStatus,
  ScreenshotRequestMessage,
  ScreenshotResponseMessage,
  ScreenshotErrorMessage,
} from '@mcp-pointer/shared/types';
import logger from '../utils/logger';

export type StatusCallback = (status: ConnectionStatus, error?: string) => void;
export type MessageHandler = (message: PointerMessage) => void;

export class ElementSenderService {
  private ws: ReconnectingWebSocket | null = null;

  private currentPort: number | null = null;

  private idleTimeout: NodeJS.Timeout | null = null;

  private messageHandler: MessageHandler | null = null;

  private readonly IDLE_DURATION = 10000; // 10 seconds of inactivity

  private readonly CONNECTION_TIMEOUT = 10000; // 5 seconds to wait for connection

  private readonly MAX_RECONNECTION_DELAY = 10000; // 10 seconds max delay

  private readonly MIN_RECONNECTION_DELAY = 1000; // 1 second min delay

  private readonly RECONNECTION_DELAY_GROW_FACTOR = 1.5; // Exponential backoff factor

  private readonly MAX_RETRIES = 10; // Maximum connection retry attempts

  /**
   * Set handler for incoming messages from server
   */
  public setMessageHandler(handler: MessageHandler): void {
    this.messageHandler = handler;
  }

  async sendElement(
    element: RawPointedDOMElement,
    port: number,
    statusCallback?: StatusCallback,
  ): Promise<void> {
    try {
      // Clear any existing idle timer
      this.clearIdleTimer();

      // Ensure we have a connection
      const connected = await this.ensureConnection(port, statusCallback);
      if (!connected) return;

      // NOTE: Idle timer disabled for screenshot feature
      // Keep WebSocket connection alive for bidirectional communication
      // this.startIdleTimer();

      // Now sending the element
      statusCallback?.(ConnectionStatus.SENDING);

      const message: PointerMessage = {
        type: PointerMessageType.DOM_ELEMENT_POINTED,
        data: element,
        timestamp: Date.now(),
      };

      this.ws!.send(JSON.stringify(message));
      logger.info('📤 Element sent:', element);

      // Successfully sent
      statusCallback?.(ConnectionStatus.SENT);
    } catch (error) {
      logger.error('Failed to send element:', error);
      statusCallback?.(ConnectionStatus.ERROR, (error as Error).message);
    }
  }

  /**
   * Send a screenshot response back to the server
   */
  async sendScreenshotResponse(
    data: ScreenshotResponseMessage | ScreenshotErrorMessage,
    messageType: PointerMessageType.SCREENSHOT_RESPONSE | PointerMessageType.SCREENSHOT_ERROR,
  ): Promise<void> {
    if (!this.isConnected) {
      logger.error('Cannot send screenshot response - not connected');
      return;
    }

    try {
      const message: PointerMessage = {
        type: messageType,
        data,
        timestamp: Date.now(),
      };

      this.ws!.send(JSON.stringify(message));
      logger.info('📸 Screenshot response sent');
    } catch (error) {
      logger.error('Failed to send screenshot response:', error);
    }
  }

  /**
   * Send a generic message to the server (e.g., PONG for heartbeat)
   */
  public sendMessage(message: PointerMessage): void {
    if (!this.isConnected) {
      logger.debug('Cannot send message - not connected');
      return;
    }

    try {
      this.ws!.send(JSON.stringify(message));
      logger.debug(`Message sent: ${message.type}`);
    } catch (error) {
      logger.error('Failed to send message:', error);
    }
  }

  private handlePortChange(port: number, statusCallback?: StatusCallback): boolean {
    if (!port || port <= 0 || port > 65535) {
      statusCallback?.(ConnectionStatus.ERROR, 'Invalid port number');
      return false;
    }

    const portInitialization = this.currentPort === null;

    if (portInitialization) {
      this.currentPort = port;
      return true;
    }

    const portChanged = this.currentPort !== port;

    // Check if port changed - if so, disconnect old connection
    if (portChanged) {
      logger.info(`Port changed from ${this.currentPort} to ${port}, reconnecting...`);
      this.disconnect();
      this.currentPort = port;
    }

    return true;
  }

  private async ensureConnection(port: number, statusCallback?: StatusCallback): Promise<boolean> {
    // Handle port change or initialization
    const portHandled = this.handlePortChange(port, statusCallback);
    if (!portHandled) return false;

    // Create connection if needed
    if (!this.isConnected) {
      statusCallback?.(ConnectionStatus.CONNECTING);

      // Create ReconnectingWebSocket with options
      this.ws = new ReconnectingWebSocket(`ws://localhost:${port}`, [], {
        maxReconnectionDelay: this.MAX_RECONNECTION_DELAY,
        minReconnectionDelay: this.MIN_RECONNECTION_DELAY,
        reconnectionDelayGrowFactor: this.RECONNECTION_DELAY_GROW_FACTOR,
        connectionTimeout: this.CONNECTION_TIMEOUT,
        maxRetries: this.MAX_RETRIES,
      });

      this.setupHandlers();

      // Wait for connection to open
      const connected = await this.waitForConnection();
      if (!connected) {
        statusCallback?.(ConnectionStatus.ERROR, 'Connection timeout');
        this.disconnect();
        return false;
      }
    }

    // Connection established
    statusCallback?.(ConnectionStatus.CONNECTED);

    return true;
  }

  private waitForConnection(): Promise<boolean> {
    return new Promise((resolve) => {
      if (!this.ws) {
        resolve(false);
        return;
      }

      if (this.ws.readyState === WebSocket.OPEN) {
        resolve(true);
        return;
      }

      const timeout = setTimeout(() => {
        resolve(false);
      }, this.CONNECTION_TIMEOUT);

      const handleOpen = () => {
        clearTimeout(timeout);
        resolve(true);
      };

      this.ws.addEventListener('open', handleOpen);
    });
  }

  private setupHandlers(): void {
    if (!this.ws) return;

    this.ws.addEventListener('open', () => {
      logger.info('✅ WebSocket connected');
    });

    this.ws.addEventListener('close', () => {
      logger.info('WebSocket closed');
    });

    this.ws.addEventListener('error', (error) => {
      logger.error('WebSocket error:', error);
    });

    this.ws.addEventListener('message', (event) => {
      try {
        const message = JSON.parse(event.data) as PointerMessage;
        logger.debug('📨 Received message:', message.type);

        if (this.messageHandler) {
          this.messageHandler(message);
        }
      } catch (error) {
        logger.error('Failed to parse incoming message:', error);
      }
    });
  }

  private startIdleTimer(): void {
    this.idleTimeout = setTimeout(() => {
      this.disconnect();
      logger.info('🔌 Connection idle, disconnecting');
    }, this.IDLE_DURATION);
  }

  private clearIdleTimer(): void {
    if (this.idleTimeout) {
      clearTimeout(this.idleTimeout);
      this.idleTimeout = null;
    }
  }

  private disconnect(): void {
    this.clearIdleTimer();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    logger.debug('🔌 WS client disconnected');
  }

  private get isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }
}
