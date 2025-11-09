import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { version } from 'process';
import { CSS_DETAIL_OPTIONS, TEXT_DETAIL_OPTIONS } from '@mcp-pointer/shared/detail';
import { ScreenshotFormat } from '@mcp-pointer/shared/types';
import SharedStateService from './shared-state-service';
import WebSocketService from './websocket-service';
import {
  normalizeDetailParameters,
  serializeElement,
  type DetailParameters,
  type NormalizedDetailParameters,
} from '../utils/element-detail';
import { scaleScreenshot } from '../utils/screenshot-transformer';
import logger from '../logger';

enum MCPToolName {
  GET_POINTED_ELEMENT = 'get-pointed-element',
  GET_ELEMENT_SCREENSHOT = 'get-element-screenshot',
}

enum MCPServerName {
  MCP_POINTER = 'mcp-pointer',
}

export default class MCPService {
  private server: Server;

  private sharedState: SharedStateService;

  private websocketService: WebSocketService;

  constructor(sharedState: SharedStateService, websocketService: WebSocketService) {
    this.sharedState = sharedState;
    this.websocketService = websocketService;
    this.server = new Server(
      {
        name: MCPServerName.MCP_POINTER,
        version,
      },
      {
        capabilities: {
          tools: {},
        },
      },
    );

    this.setupHandlers();
  }

  private setupHandlers(): void {
    this.server.setRequestHandler(ListToolsRequestSchema, this.handleListTools.bind(this));
    this.server.setRequestHandler(CallToolRequestSchema, this.handleCallTool.bind(this));
  }

  private async handleListTools() {
    return {
      tools: [
        {
          name: MCPToolName.GET_POINTED_ELEMENT,
          description: 'Get information about the currently pointed/shown DOM element. Control returned payload size with optional textDetail (0 none | 1 visible | 2 full) and cssLevel (0-3).',
          inputSchema: {
            type: 'object',
            properties: {
              textDetail: {
                type: 'integer',
                enum: [...TEXT_DETAIL_OPTIONS],
                description: 'Controls how much text is returned. 2 (default) includes hidden text fallback, 1 uses only rendered text, 0 omits text fields.',
              },
              cssLevel: {
                type: 'integer',
                enum: [...CSS_DETAIL_OPTIONS],
                description: 'Controls CSS payload detail. 0 omits CSS, 1 includes layout basics, 2 adds box model, 3 returns the full computed style.',
              },
            },
            required: [],
          },
        },
        {
          name: MCPToolName.GET_ELEMENT_SCREENSHOT,
          description: 'Capture a screenshot of the currently pointed DOM element. Returns a cropped image of the element with optional format conversion and scaling. The element must be visible in the viewport and previously pointed using Option+Click.',
          inputSchema: {
            type: 'object',
            properties: {
              format: {
                type: 'string',
                enum: ['png', 'jpeg', 'webp'],
                description: 'Image format for the screenshot. Default: png',
              },
              quality: {
                type: 'integer',
                minimum: 1,
                maximum: 100,
                description: 'Quality setting for JPEG/WebP (1-100). Higher = better quality but larger file. Default: 90. Ignored for PNG.',
              },
              maxWidth: {
                type: 'integer',
                minimum: 1,
                description: 'Maximum width in pixels. Image will be scaled down if larger, maintaining aspect ratio.',
              },
              maxHeight: {
                type: 'integer',
                minimum: 1,
                description: 'Maximum height in pixels. Image will be scaled down if larger, maintaining aspect ratio.',
              },
              timeout: {
                type: 'integer',
                minimum: 1000,
                maximum: 30000,
                description: 'Request timeout in milliseconds (1000-30000). Default: 5000',
              },
            },
            required: [],
          },
        },
      ],
    };
  }

  private async handleCallTool(request: any) {
    if (request.params.name === MCPToolName.GET_POINTED_ELEMENT) {
      const normalized = normalizeDetailParameters(
        request.params.arguments as DetailParameters | undefined,
      );
      return this.getPointedElement(normalized);
    }

    if (request.params.name === MCPToolName.GET_ELEMENT_SCREENSHOT) {
      return this.getElementScreenshot(request.params.arguments || {});
    }

    throw new Error(`Unknown tool: ${request.params.name}`);
  }

  private async getPointedElement(details: NormalizedDetailParameters) {
    const processedElement = await this.sharedState.getPointedElement();

    if (!processedElement) {
      return {
        content: [
          {
            type: 'text',
            text: 'No element is currently pointed. '
              + 'The user needs to point an element in their browser using Option+Click.',
          },
        ],
      };
    }

    const shapedElement = serializeElement(
      processedElement,
      details.textDetail,
      details.cssLevel,
    );

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(shapedElement, null, 2),
        },
      ],
    };
  }

  private async getElementScreenshot(args: any) {
    const startTime = Date.now();

    try {
      // Check if LEADER (has direct browser connection) or FOLLOWER (proxies to LEADER)
      const isLeader = this.websocketService.isLeaderInstance();

      // For LEADER: Validate extension is connected with retry logic for race conditions
      if (isLeader) {
        const maxRetries = 3;
        const retryDelay = 150; // ms
        let hasConnection = false;

        for (let attempt = 0; attempt < maxRetries; attempt += 1) {
          if (this.websocketService.hasActiveClients()) {
            hasConnection = true;
            break;
          }

          if (attempt < maxRetries - 1) {
            logger.debug(`Waiting for extension connection (attempt ${attempt + 1}/${maxRetries})...`);
            await new Promise(resolve => setTimeout(resolve, retryDelay));
          }
        }

        if (!hasConnection) {
          const totalClients = this.websocketService.hasConnectedClients() ? 'connected but not ready' : 'not connected';
          return {
            content: [
              {
                type: 'text',
                text: `No active browser extension connection (${totalClients}). Ensure MCP Pointer extension is running and connected.`,
              },
            ],
            isError: true,
          };
        }
      }

      // Validate pointed element exists
      const processedElement = await this.sharedState.getPointedElement();
      if (!processedElement) {
        return {
          content: [
            {
              type: 'text',
              text: 'No element is currently pointed. The user needs to point an element in their browser using Option+Click before capturing a screenshot.',
            },
          ],
          isError: true,
        };
      }

      // Normalize and validate parameters
      const format = (args.format as ScreenshotFormat) || ScreenshotFormat.PNG;
      const quality = args.quality ? Math.max(1, Math.min(100, args.quality)) : 90;
      const maxWidth = args.maxWidth ? Math.max(1, args.maxWidth) : undefined;
      const maxHeight = args.maxHeight ? Math.max(1, args.maxHeight) : undefined;
      const timeout = args.timeout ? Math.max(1000, Math.min(30000, args.timeout)) : 5000;

      logger.info('📸 Screenshot request:', {
        format,
        quality,
        maxWidth,
        maxHeight,
        timeout,
        role: isLeader ? 'LEADER' : 'FOLLOWER',
        activeClients: isLeader ? this.websocketService.getActiveClientCount() : undefined,
      });

      // Request screenshot from extension
      // LEADER: Direct request to browser via WebSocket
      // FOLLOWER: Proxy request to LEADER via HTTP
      let screenshotData = isLeader
        ? await this.websocketService.requestScreenshot({
            format,
            quality,
            maxWidth,
            maxHeight,
            timeout,
          })
        : await this.websocketService.requestScreenshotFromLeader({
            format,
            quality,
            maxWidth,
            maxHeight,
            timeout,
          });

      // Apply server-side scaling if needed
      if (maxWidth || maxHeight) {
        screenshotData = await scaleScreenshot(screenshotData, { maxWidth, maxHeight });
      }

      const duration = Date.now() - startTime;

      // Log metrics
      logger.info('✅ Screenshot captured successfully:', {
        format: screenshotData.format,
        width: screenshotData.width,
        height: screenshotData.height,
        byteSize: screenshotData.byteSize,
        duration: `${duration}ms`,
      });

      // Prepare metadata for text fallback
      const metadata = {
        selector: screenshotData.elementSelector || processedElement.selector,
        tagName: processedElement.tagName,
        width: screenshotData.width,
        height: screenshotData.height,
        format: screenshotData.format,
        byteSize: screenshotData.byteSize,
        capturedAt: new Date(screenshotData.capturedAt).toISOString(),
        url: processedElement.url,
      };

      // Warn if payload is large
      const warnings: string[] = [];
      if (screenshotData.byteSize > 2_000_000) {
        warnings.push(`Warning: Screenshot size is ${Math.round(screenshotData.byteSize / 1024 / 1024)}MB. Consider using JPEG format with lower quality or smaller maxWidth/maxHeight to reduce size.`);
      }

      // Get MIME type
      const mimeType = this.getMimeType(screenshotData.format);

      // Return image + metadata
      return {
        content: [
          {
            type: 'image',
            data: screenshotData.base64.split(',')[1] || screenshotData.base64, // Remove data URL prefix if present
            mimeType,
          },
          {
            type: 'text',
            text: JSON.stringify(
              {
                ...metadata,
                warnings: warnings.length > 0 ? warnings : undefined,
              },
              null,
              2,
            ),
          },
        ],
      };
    } catch (error) {
      const duration = Date.now() - startTime;
      logger.error('❌ Screenshot capture failed:', error);

      return {
        content: [
          {
            type: 'text',
            text: `Screenshot capture failed: ${error instanceof Error ? error.message : 'Unknown error'}\n\nDuration: ${duration}ms`,
          },
        ],
        isError: true,
      };
    }
  }

  private getMimeType(format: ScreenshotFormat): string {
    switch (format) {
      case ScreenshotFormat.PNG:
        return 'image/png';
      case ScreenshotFormat.JPEG:
        return 'image/jpeg';
      case ScreenshotFormat.WEBP:
        return 'image/webp';
      default:
        return 'image/png';
    }
  }

  public async start(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
  }
}
