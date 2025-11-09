import {
  ConnectionStatus,
  PointerMessage,
  PointerMessageType,
  ScreenshotRequestMessage,
  ScreenshotErrorCode,
  ScreenshotFormat,
} from '@mcp-pointer/shared/types';
import logger from './utils/logger';
import { ElementSenderService } from './services/element-sender-service';
import { ExtensionConfig } from './utils/config';
import ConfigStorageService from './services/config-storage-service';

let elementSender: ElementSenderService;
let currentConfig: ExtensionConfig;

// Initialize when service worker starts
async function initialize() {
  currentConfig = await ConfigStorageService.load();

  // Create the service (no connection on startup)
  elementSender = new ElementSenderService();

  // Set up handler for incoming WebSocket messages (e.g., screenshot requests)
  elementSender.setMessageHandler(handleIncomingMessage);

  logger.info('🚀 MCP Pointer background script loaded', {
    enabled: currentConfig.enabled,
    port: currentConfig.websocket.port,
  });
}

/**
 * Handle incoming messages from the server via WebSocket
 */
function handleIncomingMessage(message: PointerMessage): void {
  switch (message.type) {
    case PointerMessageType.PING:
      handlePing();
      break;
    case PointerMessageType.SCREENSHOT_REQUEST:
      handleScreenshotRequest(message.data as ScreenshotRequestMessage);
      break;
    default:
      logger.debug('Unhandled message type:', message.type);
  }
}

/**
 * Handle PING from server and respond with PONG
 * This keeps the Chrome service worker alive by exchanging messages
 */
function handlePing(): void {
  logger.debug('💓 Received PING, sending PONG');

  const pongMessage: PointerMessage = {
    type: PointerMessageType.PONG,
    timestamp: Date.now(),
  };

  elementSender.sendMessage(pongMessage);
}

/**
 * Handle screenshot request from server
 */
async function handleScreenshotRequest(request: ScreenshotRequestMessage): Promise<void> {
  try {
    logger.debug('📸 Received screenshot request:', request.requestId);

    const format = request.options.format || ScreenshotFormat.PNG;
    const quality = request.options.quality || 90;

    // Get active tab
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tabs || tabs.length === 0) {
      throw new Error('No active tab found');
    }

    const tabId = tabs[0].id;
    if (!tabId) {
      throw new Error('Active tab has no ID');
    }

    // Step 1: Get element bounds from content script
    logger.debug('📏 Requesting element bounds from content script');

    const boundsResponse = await new Promise<any>((resolve, reject) => {
      chrome.tabs.sendMessage(
        tabId,
        {
          type: 'CAPTURE_SCREENSHOT',
          requestId: request.requestId,
          options: request.options,
        },
        (response) => {
          if (chrome.runtime.lastError) {
            reject(new Error(`Content script error: ${chrome.runtime.lastError.message}`));
          } else {
            resolve(response);
          }
        }
      );
    });

    if (!boundsResponse || !boundsResponse.success) {
      await elementSender.sendScreenshotResponse(
        {
          requestId: request.requestId,
          errorCode: boundsResponse?.errorCode || ScreenshotErrorCode.EXTENSION_ERROR,
          errorMessage: boundsResponse?.errorMessage || 'No response from content script',
          timestamp: Date.now(),
        },
        PointerMessageType.SCREENSHOT_ERROR
      );
      return;
    }

    const { bounds, elementSelector } = boundsResponse;

    // Step 2: Capture visible tab (background script has permission)
    logger.debug('📸 Capturing visible tab');

    const captureFormat = format === ScreenshotFormat.WEBP ? ScreenshotFormat.PNG : format;

    const dataUrl = await new Promise<string>((resolve, reject) => {
      chrome.tabs.captureVisibleTab(
        {
          format: captureFormat as 'png' | 'jpeg',
          quality: format === ScreenshotFormat.JPEG ? quality : undefined,
        },
        (dataUrl) => {
          if (chrome.runtime.lastError) {
            reject(new Error(`Failed to capture tab: ${chrome.runtime.lastError.message}`));
          } else if (!dataUrl) {
            reject(new Error('captureVisibleTab returned no data'));
          } else {
            resolve(dataUrl);
          }
        }
      );
    });

    logger.debug('✅ Tab captured, sending to content script for cropping');

    // Step 3: Send to content script for cropping (background script doesn't have DOM access)
    const cropResponse = await new Promise<any>((resolve, reject) => {
      chrome.tabs.sendMessage(
        tabId,
        {
          type: 'CROP_SCREENSHOT',
          dataUrl,
          bounds: bounds.rect,
          devicePixelRatio: bounds.devicePixelRatio,
          format,
          quality,
        },
        (response) => {
          if (chrome.runtime.lastError) {
            reject(new Error(`Cropping error: ${chrome.runtime.lastError.message}`));
          } else {
            resolve(response);
          }
        }
      );
    });

    if (!cropResponse || !cropResponse.success) {
      throw new Error(cropResponse?.errorMessage || 'Failed to crop screenshot');
    }

    const screenshot = cropResponse.screenshot;

    logger.debug('✅ Screenshot processed', {
      width: screenshot.width,
      height: screenshot.height,
      byteSize: screenshot.byteSize,
    });

    // Step 4: Send success response to server
    await elementSender.sendScreenshotResponse(
      {
        requestId: request.requestId,
        screenshot,
        elementSelector,
        timestamp: Date.now(),
      },
      PointerMessageType.SCREENSHOT_RESPONSE
    );

    logger.info('✅ Screenshot sent to server');
  } catch (error) {
    logger.error('❌ Screenshot request handling failed:', error);

    await elementSender.sendScreenshotResponse(
      {
        requestId: request.requestId,
        errorCode: ScreenshotErrorCode.CAPTURE_FAILED,
        errorMessage: error instanceof Error ? error.message : 'Unknown error',
        timestamp: Date.now(),
      },
      PointerMessageType.SCREENSHOT_ERROR
    );
  }
}

// Listen for config changes
ConfigStorageService.onChange((newConfig: ExtensionConfig) => {
  logger.info('⚙️ Config changed:', newConfig);

  // Simply update the config - ElementSenderService handles port changes automatically
  currentConfig = newConfig;

  if (newConfig.enabled) {
    logger.info('✅ Extension enabled');
  } else {
    logger.info('❌ Extension disabled');
  }
});

// Listen for messages from content script
chrome.runtime.onMessage
  .addListener((request: any, _sender: any, sendResponse: (response: any) => void) => {
    if (request.type === 'DOM_ELEMENT_POINTED' && request.data) {
      // Send element with current port and status callback
      elementSender.sendElement(
        request.data,
        currentConfig.websocket.port,
        (status, error) => {
          // Status flow: CONNECTING -> CONNECTED -> SENDING -> SENT
          switch (status) {
            case ConnectionStatus.CONNECTING:
              logger.info('🔄 Connecting to WebSocket...');
              break;
            case ConnectionStatus.CONNECTED:
              logger.info('✅ Connected');
              break;
            case ConnectionStatus.SENDING:
              logger.info('📤 Sending element...');
              break;
            case ConnectionStatus.SENT:
              logger.info('✓ Element sent successfully');
              break;
            case ConnectionStatus.ERROR:
              logger.error('❌ Failed:', error);
              break;
            default:
              break;
          }
        },
      );

      // Respond immediately since the status callback is for logging only
      sendResponse({ success: true });
    }
  });

// Handle extension install/update
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'update' && details.previousVersion === '0.4.2') {
    const { previousVersion } = details;
    const currentVersion = chrome.runtime.getManifest().version;

    logger.info(`🔄 Extension updated from ${previousVersion} to ${currentVersion}`);

    // Open update notification page
    chrome.tabs.create({
      url: 'https://mcp-pointer.etsd.tech/development-update.html',
      active: true,
    });
  }
});

// Start initialization
initialize();
